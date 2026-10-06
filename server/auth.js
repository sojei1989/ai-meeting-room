import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const SESSION_COOKIE_NAME = 'aimr_session';

const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const DEFAULT_FAILURE_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_BLOCK_MS = 15 * 60 * 1000;
const DEFAULT_MAX_FAILURES = 5;
const MAX_PASSCODE_BYTES = 4096;

function digest(value) {
  return createHash('sha256').update(value).digest();
}

function loadPasscodeDigest(file) {
  let fd;
  try {
    const parentBefore = lstatSync(path.dirname(file));
    if (!parentBefore.isDirectory() || parentBefore.isSymbolicLink()) return null;

    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = fstatSync(fd);
    const visible = lstatSync(file);
    const parentAfter = lstatSync(path.dirname(file));
    if (!opened.isFile() || visible.isSymbolicLink()
      || opened.dev !== visible.dev || opened.ino !== visible.ino
      || parentBefore.dev !== parentAfter.dev || parentBefore.ino !== parentAfter.ino
      || opened.size < 1 || opened.size > MAX_PASSCODE_BYTES) return null;

    const raw = readFileSync(fd, 'utf8');
    if (Buffer.byteLength(raw) > MAX_PASSCODE_BYTES) return null;
    const value = raw.replace(/[\r\n]+$/, '');
    if (!value.trim()) return null;
    return digest(value);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
  }
}

function cookieValue(header) {
  if (typeof header !== 'string' || header.length > 8192) return '';
  for (const item of header.split(';')) {
    const part = item.trim();
    const equals = part.indexOf('=');
    if (equals < 1 || part.slice(0, equals) !== SESSION_COOKIE_NAME) continue;
    const value = part.slice(equals + 1);
    return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : '';
  }
  return '';
}

export function createAuthService(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const sessionTtlMs = Math.max(1, Number(options.sessionTtlMs) || DEFAULT_SESSION_TTL_MS);
  const failureWindowMs = Math.max(1, Number(options.failureWindowMs) || DEFAULT_FAILURE_WINDOW_MS);
  const blockMs = Math.max(1, Number(options.blockMs) || DEFAULT_BLOCK_MS);
  const maxFailures = Math.max(1, Number(options.maxFailures) || DEFAULT_MAX_FAILURES);
  const schedule = typeof options.schedule === 'function' ? options.schedule : setTimeout;
  const cancelSchedule = typeof options.cancelSchedule === 'function' ? options.cancelSchedule : clearTimeout;
  const passcodeDigest = loadPasscodeDigest(options.passcodeFile);
  const sessions = new Map();
  const failures = new Map();
  const connections = new Map();

  function revoke(sessionId) {
    const existed = sessions.delete(sessionId);
    const entries = connections.get(sessionId);
    connections.delete(sessionId);
    if (entries) {
      for (const entry of entries) {
        if (entry.timer !== null) {
          try { cancelSchedule(entry.timer); } catch {}
          entry.timer = null;
        }
        try { entry.close(); } catch {}
      }
    }
    return existed;
  }

  function sweepExpired() {
    const current = now();
    for (const [sessionId, session] of sessions) {
      if (session.expiresAt <= current) revoke(sessionId);
    }
    for (const [key, record] of failures) {
      const staleAt = Math.max(record.blockedUntil || 0, record.windowStarted + failureWindowMs);
      if (staleAt <= current) failures.delete(key);
    }
  }

  function failureResult(clientKey) {
    const current = now();
    const key = String(clientKey || 'unknown').slice(0, 256);
    let record = failures.get(key);
    if (!record || current >= record.windowStarted + failureWindowMs) {
      record = { count: 0, windowStarted: current, blockedUntil: 0 };
    }
    record.count += 1;
    if (record.count >= maxFailures) record.blockedUntil = current + blockMs;
    failures.set(key, record);
    if (record.blockedUntil > current) {
      return { ok: false, status: 429, retryAfter: Math.max(1, Math.ceil((record.blockedUntil - current) / 1000)) };
    }
    return { ok: false, status: 401 };
  }

  function login(candidate, clientKey) {
    if (!passcodeDigest) return { ok: false, status: 503 };
    sweepExpired();
    const key = String(clientKey || 'unknown').slice(0, 256);
    const record = failures.get(key);
    const current = now();
    if (record?.blockedUntil > current) {
      return { ok: false, status: 429, retryAfter: Math.max(1, Math.ceil((record.blockedUntil - current) / 1000)) };
    }

    const value = typeof candidate === 'string' && Buffer.byteLength(candidate) <= MAX_PASSCODE_BYTES
      ? candidate
      : '';
    const candidateDigest = digest(value);
    if (!timingSafeEqual(candidateDigest, passcodeDigest)) return failureResult(key);

    failures.delete(key);
    const sessionId = randomBytes(32).toString('base64url');
    sessions.set(sessionId, { expiresAt: current + sessionTtlMs });
    return {
      ok: true,
      status: 200,
      setCookie: SESSION_COOKIE_NAME + '=' + sessionId
        + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + Math.max(1, Math.floor(sessionTtlMs / 1000))
    };
  }

  function authenticate(header) {
    const sessionId = cookieValue(header);
    if (!sessionId) return { ok: false };
    const session = sessions.get(sessionId);
    if (!session) return { ok: false };
    if (session.expiresAt <= now()) {
      revoke(sessionId);
      return { ok: false };
    }
    return { ok: true, sessionId, expiresAt: session.expiresAt };
  }

  function logout(header) {
    const sessionId = cookieValue(header);
    return sessionId ? revoke(sessionId) : false;
  }

  function registerConnection(sessionId, close) {
    const session = sessions.get(sessionId);
    if (!session || typeof close !== 'function') return null;
    const delay = session.expiresAt - now();
    if (delay <= 0) {
      revoke(sessionId);
      return null;
    }

    let entries = connections.get(sessionId);
    if (!entries) {
      entries = new Set();
      connections.set(sessionId, entries);
    }
    const entry = { close, timer: null };
    entries.add(entry);
    entry.timer = schedule(() => revoke(sessionId), delay);
    entry.timer?.unref?.();

    return () => {
      const current = connections.get(sessionId);
      if (!current || !current.delete(entry)) return;
      if (entry.timer !== null) {
        try { cancelSchedule(entry.timer); } catch {}
        entry.timer = null;
      }
      if (!current.size) connections.delete(sessionId);
    };
  }

  function dispose() {
    for (const sessionId of [...sessions.keys()]) revoke(sessionId);
    failures.clear();
  }

  return {
    configured: Boolean(passcodeDigest),
    login,
    authenticate,
    logout,
    registerConnection,
    sweepExpired,
    clearCookie: SESSION_COOKIE_NAME + '=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0',
    dispose
  };
}
