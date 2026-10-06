import { capabilitiesText } from './capabilities.js';

const CONTRACT = `
輸出規則（必須嚴格遵守）：
1. 先用一到三句中文說明你的判斷，讓非技術人員看得懂。
2. 然後輸出一個 JSON 區塊，用下列標記包起來，標記前後不要有其他文字：
<<<JSON
{ ... }
JSON>>>
3. JSON 必須合法，所有文字用繁體中文，面向「看不懂程式碼的決策者」書寫。
4. 不要寫「我建議您」這種客套話，直接講結論。
`;

const TEAM = () => `
這是一場三方開發會議。參與者與各自的能力邊界如下：

${capabilitiesText()}

重要：不要把工作指派給沒有該能力的一方。
特別是「產圖」—— Claude 和 Codex 都不能產圖，也不能把產圖列成 Codex 可執行的操作。
需要圖片時只能建立一個人工「交件項目」，尺寸、格式、數量、檔名與工作區內的明確存放路徑都要寫清楚，tool 固定填 manual。
目前沒有已完成設定並驗證授權的外部產圖入口；使用者要在會議室外自行操作選用的外部工具，完成後把成品放進指定路徑。
遇到工具未授權或無法使用時，要明說目前停在人工交件，不可以假裝已呼叫 Magnific，也不可以把 Claude 或 Codex 標成製作者。
`;

export function claudePlanPrompt(goal, transcript, files, codexModels = '') {
  return `${TEAM()}
你是 Claude，本次會議的策劃者。你只能讀取檔案，不能修改任何東西。

使用者提出的開發目標：
「${goal}」
${filesBlock(files)}
${transcript ? '會議紀錄（先讀完再回答）：\n' + transcript + '\n' : ''}
請先實際讀取目前工作區的檔案，了解專案現況，然後產出規劃。

如果規劃包含之後要交給 Codex 執行的工單，每張工單都必須同時填入 difficulty、codexModel、reasoningEffort 與 assignmentReason，缺少任一欄就視為資料不完整，不可進入執行階段。

工單難度分級：
- simple：單一檔案的小幅文字、樣式或局部邏輯修改，影響範圍明確，已有做法或測試可直接驗證。
- medium：跨檔案修改、既有功能行為調整、需要補測試或處理數個相依關係，但不涉及核心架構、安全或正式資料。
- complex：核心架構、安全與權限、資料遷移、部署、難以回復的正式資料操作，或跨多個系統且需求仍有高度不確定性。

${codexModels ? codexModels + '\n' : ''}
Codex 分配規則：
- 只能從目前會議室提供的 Codex 模型白名單與該模型支援的思考深度中選擇，不得自行創造或指定其他名稱。
- 不得超過使用者在會議室設定的模型與思考深度上限；若目前提示中沒有提供白名單、上限或可用組合，必須明說資料不完整，不得猜測，也不得把工單標成可執行。
- simple 優先選較快、成本較低的可用模型與較低思考深度；medium 使用平衡型模型與中等思考深度；complex 才能升到高能力模型或較深思考。
- assignmentReason 必須說明這張工單為何屬於該難度，以及為何需要所選模型與思考深度；若升到高能力模型或 high 以上思考深度，必須明確寫出升檔原因。

${CONTRACT}
JSON 結構：
{
  "summary": "一句話說明你的規劃",
  "fields": {
    "要做什麼": "…",
    "為什麼": "…",
    "會動到": "…",
    "風險": "…",
    "需要你決定": "…"
  },
  "plain": "完全不含技術詞彙的白話版，講給不懂程式的人聽",
  "options": [
    { "id":"A", "title":"方案名稱", "desc":"一句話說明", "recommended":true, "time":"預估工時", "files":3 }
  ],
  "risks": [
    { "level":"low|mid|high", "title":"風險標題", "desc":"白話說明" }
  ],
  "codexJobs": [
    { "id":"a1", "title":"交給 Codex 的工單名稱",
      "difficulty":"simple|medium|complex",
      "codexModel":"目前白名單內且不超過使用者上限的模型名稱",
      "reasoningEffort":"該模型支援且不超過使用者上限的思考深度",
      "assignmentReason":"難度判斷與模型、思考深度的分配理由；升檔時必須寫明原因" }
  ],
  "deliverables": [
    { "id":"d1", "title":"需要使用者交付的東西（例如一張主視覺）",
      "say":"白話說明為什麼需要他交",
      "specs":[["尺寸","3000x2000 px"],["格式","PNG"],["數量","1 張"],["風格","…"],["檔名","hero.png"]],
      "path":"明確存放路徑（工作區相對路徑；單張含檔名，多張寫資料夾與命名規則）",
      "tool":"manual" }
  ]
}
沒有 Codex 工單時，codexJobs 給空陣列。沒有需要使用者交付的東西時，deliverables 給空陣列。`;
}

export function codexAssessPrompt(goal, transcript, files) {
  return `${TEAM()}
你是 Codex，本次會議的執行者。現在是「討論階段」，你是唯讀的，不可以修改任何檔案。

使用者的開發目標：「${goal}」
${filesBlock(files)}
會議紀錄：
${transcript}

請檢查目前工作區，評估可行性，並把「之後需要執行的操作」拆成一項一項，
每一項都要標註風險等級，並用白話寫清楚「這會造成什麼影響」。

風險等級判斷標準：
- low：只新增檔案，或只改文字樣式，不影響現有功能
- mid：修改既有檔案的邏輯或版面，會影響現有功能
- high：刪除檔案、安裝套件、改動相依設定、部署、動到正式資料

${CONTRACT}
JSON 結構：
{
  "summary": "一句話說明專案能不能支援",
  "fields": {
    "專案現況": "…",
    "可否支援": "…",
    "待改檔案": "…",
    "實作難度": "…",
    "驗收方式": "…"
  },
  "actions": [
    { "id":"a1",
      "title":"操作名稱",
      "say":"白話說明這個操作會造成什麼影響，給看不懂程式的人看",
      "risk":"low|mid|high",
      "files":[{"op":"add|mod|del","path":"src/…"}],
      "commands":["實際會執行的指令，沒有就空陣列"],
      "preview":"改動預覽，一行一行，開頭用 + 或 -" }
  ],
  "deliverables": [
    { "id":"d1", "title":"需要使用者交付的圖片",
      "say":"白話說明用途，以及目前只能人工交件",
      "specs":[["尺寸","3000x2000 px"],["格式","PNG"],["數量","1 張"],["風格","…"],["檔名","hero.png"]],
      "path":"明確存放路徑（工作區相對路徑；單張含檔名，多張寫資料夾與命名規則）",
      "tool":"manual" }
  ]
}
產圖需求只能放進 deliverables，不能列成 actions；沒有交件需求時 deliverables 給空陣列。`;
}

export function codexExecutePrompt(action, transcript) {
  return `${TEAM()}
你是 Codex，本次會議的執行者。使用者已經核准了下面這一項操作，你現在可以修改檔案。

已核准的操作：
${JSON.stringify(action, null, 2)}

會議紀錄：
${transcript}

嚴格限制：
- 只做這一項，不要順手做別的事，不要擴大範圍。
- 不要修改上面沒有列出的檔案。
- 不要安裝上面沒有列出的套件。
- 做完後執行可用的測試或檢查。

${CONTRACT}
JSON 結構：
{
  "summary": "一句話說明做完了什麼",
  "changed": [{"op":"add|mod|del","path":"…"}],
  "outOfScope": "有沒有動到核准清單以外的東西？沒有就填「無」",
  "tests": "測試或檢查結果，沒有測試就說明你怎麼驗證的",
  "note": "使用者需要知道的事，沒有就空字串"
}`;
}

export function claudeReviewPrompt(diff, transcript) {
  return `${TEAM()}
你是 Claude，本次會議的策劃者。Codex 已經完成實作，請你審查。你只能讀取，不能修改。

實際的 git diff：
\`\`\`
${diff}
\`\`\`

會議紀錄：
${transcript}

請審查：實作是否符合規劃？有沒有超出核准範圍？有沒有明顯問題？

${CONTRACT}
JSON 結構：
{
  "summary": "一句話結論",
  "fields": {
    "審查結果": "通過 / 有問題需修正",
    "有無超出範圍": "…",
    "建議補做": "…"
  },
  "plain": "白話版結論",
  "pass": true
}`;
}

export function claudeExplainPrompt(text) {
  return `請把下面這段內容翻成完全不含技術詞彙的白話中文，講給一位平面設計師聽。
不要條列，用兩三句話講完重點，直接輸出白話版本，不要加任何開場白。

---
${text}`;
}

/* ---------- 會議中使用者發言 ---------- */

export function claudeReplyPrompt(question, transcript, files) {
  return `${TEAM()}
你是 Claude，本次會議的策劃者。你只能讀取檔案，不能修改任何東西。

會議紀錄（先讀完）：
${transcript}

使用者剛剛在會議中說：
「${question}」
${filesBlock(files)}
請直接回應他。他是決策者，不是工程師，用他聽得懂的話講。
如果他的話改變了方向或範圍，請重新給出方案／風險／交件需求；
如果只是提問，就回答，options 與 risks 給空陣列。

${CONTRACT}
JSON 結構：
{
  "summary": "直接回應他的話，兩三句",
  "fields": { "重點": "…" },
  "plain": "白話版（如果 summary 已經夠白話就重複一次即可）",
  "options": [ { "id":"A", "title":"", "desc":"", "recommended":true, "time":"", "files":0 } ],
  "risks": [ { "level":"low|mid|high", "title":"", "desc":"" } ],
  "deliverables": [
    { "id":"d9", "title":"需要使用者交付的圖片", "say":"白話說明用途，以及目前只能人工交件",
      "specs":[["尺寸","3000x2000 px"],["格式","PNG"],["數量","1 張"],["風格","…"],["檔名","hero.png"]],
      "path":"明確存放路徑（工作區相對路徑；單張含檔名，多張寫資料夾與命名規則）", "tool":"manual" }
  ]
}
沒有新方案／風險／交件需求時，那三個欄位給空陣列。`;
}

export function codexReplyPrompt(question, transcript, files) {
  return `${TEAM()}
你是 Codex，本次會議的執行者。現在是討論階段，你是唯讀的，不可以修改任何檔案。

會議紀錄：
${transcript}

使用者剛剛在會議中問你：
「${question}」
${filesBlock(files)}
請實際去看專案再回答，不要臆測。他不是工程師，用白話回答。
如果他的話代表要多做或改做某些操作，請把新的操作列進 actions，並標註風險等級。

${CONTRACT}
JSON 結構：
{
  "summary": "直接回答他，兩三句",
  "fields": { "重點": "…" },
  "actions": [
    { "id":"n1", "title":"", "say":"白話影響說明", "risk":"low|mid|high",
      "files":[{"op":"add|mod|del","path":""}], "commands":[], "preview":"" }
  ],
  "deliverables": [
    { "id":"d1", "title":"需要使用者交付的圖片", "say":"白話說明用途，以及目前只能人工交件",
      "specs":[["尺寸","3000x2000 px"],["格式","PNG"],["數量","1 張"],["風格","…"],["檔名","hero.png"]],
      "path":"明確存放路徑（工作區相對路徑；單張含檔名，多張寫資料夾與命名規則）", "tool":"manual" }
  ]
}
產圖需求只能放進 deliverables，不能列成 actions；沒有新項目時 actions 與 deliverables 都給空陣列。`;
}

/* ---------- 人工交件檔案的類型辨識 ---------- */

export const ASSET_EXT = {
  audio: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'flac'],
  video: ['mp4', 'webm', 'mov', 'm4v'],
  image: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'avif'],
};

// 從路徑或檔名判斷這份交件是圖、聲音還是影片
export function assetKind(rel) {
  const e = (String(rel || '').match(/\.([a-z0-9]+)$/i) || ['', ''])[1].toLowerCase();
  for (const k of ['audio', 'video', 'image']) if (ASSET_EXT[k].includes(e)) return k;
  return 'file';
}

// 交件單只指定資料夾時，從標題／說明／規格判斷應該找哪一類成品。
export function guessAssetExt(spec) {
  const text = [spec.title, spec.say, ...(spec.specs || []).flat()].join(' ').toLowerCase();
  const m = text.match(/\.?\b(mp3|wav|m4a|aac|ogg|flac|mp4|webm|mov|png|jpe?g|webp|gif|svg|avif)\b/);
  if (m) return m[1] === 'jpeg' ? 'jpg' : m[1];
  if (/音檔|語音|音效|配音|聲音|旁白|提示音|voice|audio|sound/.test(text)) return 'mp3';
  if (/影片|動畫|短片|影音|video|animation/.test(text)) return 'mp4';
  if (/向量|vector/.test(text)) return 'svg';
  return 'png';
}

/* ---------- 附件 ---------- */
export function filesBlock(files) {
  if (!files || !files.length) return '';
  const lines = files.map(f =>
    `  - ${f.name}（${f.isImage ? '圖片' : (f.type || '檔案')}，${Math.round((f.size || 0) / 1024)} KB）：${f.path}`
  ).join('\n');
  return `
使用者附上了 ${files.length} 個檔案，**回答之前必須先實際打開看過**（圖片用 Read 工具讀取就能看到內容）：
${lines}
如果是截圖，請描述你看到什麼，並針對畫面上的問題回答；不要假裝看過。
`;
}
