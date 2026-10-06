#!/bin/bash
cd "$(dirname "$0")"
PORT=$(node -e "const fs=require('fs'); let out=4477; try{ out=JSON.parse(fs.readFileSync('config.json','utf8')).port||4477 }catch{} console.log(out)")
LOCAL_HOST=$(node -e "const fs=require('fs'); let out='127.0.0.1'; try{ out=JSON.parse(fs.readFileSync('config.json','utf8')).listen?.local||'127.0.0.1' }catch{} console.log(out)")

# 清掉所有還在跑這個會議室的程序（不只佔 port 的那個）
# 兩個程序同時跑會互相把 meetings/_current.json 蓋回舊狀態，看起來就是「決定一直回朔」
HERE="$(pwd)"
OLD=$(lsof -ti:$PORT 2>/dev/null)
STRAY=$(pgrep -f "$HERE/server/(index|launcher).js" 2>/dev/null)
ALL=$(printf '%s\n%s\n' "$OLD" "$STRAY" | sort -u | grep -v '^$' | grep -v "^$$\$")
if [ -n "$ALL" ]; then
  echo "清掉還在跑的舊程序：$(echo $ALL | tr '\n' ' ')"
  kill $ALL 2>/dev/null
  sleep 1
  LEFT=$(printf '%s\n%s\n' "$(lsof -ti:$PORT 2>/dev/null)" "$(pgrep -f "$HERE/server/(index|launcher).js" 2>/dev/null)" | sort -u | grep -v '^$' | grep -v "^$$\$")
  if [ -n "$LEFT" ]; then
    echo "有程序沒關掉，強制結束…"
    kill -9 $LEFT 2>/dev/null
    sleep 1
  fi
fi

# 稍後自動開瀏覽器。
# Chrome 已經在跑的時候不要再 open：macOS 26 上 Chrome 收到第二次啟動會在
# TransformProcessType 直接 abort，每重啟一次伺服器就跳一份當機報告。
# 這時只印網址，你在現有的分頁重新整理就好。
if pgrep -xq "Google Chrome"; then
  echo "Chrome 已在執行，請直接開 http://$LOCAL_HOST:$PORT （或重新整理現有分頁）"
else
  ( sleep 1.5; open "http://$LOCAL_HOST:$PORT" ) &
fi

echo "啟動三方開發會議室"
echo "要完全結束請按 Control + C"
echo ""

# 為什麼是這個迴圈，而不是 node --watch：
# 以前 npm start 開的是 node --watch-path=./server，只要 server/ 底下有檔案變動就自動重啟。
# 但 Codex 核准後做的事情正是「改 server/ 底下的檔案」——它一寫檔，伺服器就重啟，
# 把 Codex 自己執行到一半的工作砍掉。u4（密碼鎖）連續四次都是這樣死的：
# 每次寫到一半就被自己的監看器殺掉，卡片退回待處理，看起來像「過不了」。
# 現在改成：伺服器正常結束就跳出，結束碼 89（畫面上的「重新啟動」按鈕）才重開。
while true; do
  node server/launcher.js
  code=$?
  if [ "$code" != "89" ]; then
    exit $code
  fi
  echo ""
  echo "重新啟動中…"
  sleep 0.5
done
