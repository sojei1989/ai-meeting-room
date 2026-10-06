# 三方開發會議室

[English](#english)

在你自己的 Mac 上，讓 Claude Code 和 Codex 在同一個畫面裡幫你開發。你用白話說要做什麼，兩個 AI 討論、提方案、做事，每一個會動到檔案的步驟都要你按下核准才會執行。

這是個人開發的開源工具，和 Anthropic、OpenAI 沒有隸屬或合作關係。

## 這間會議室是一家公司

這不是一套固定的 AI 組合，而是一間由你經營的公司。

一家公司不會要求每個進來的人都長得一樣，每個人訂閱的 AI 也不一樣。你有哪些 AI，就雇用哪些成員，再照它們的特長安排職位。AI 負責提方案、做事、互相檢查，最後由你決定。每個人的會議室，都會長成不一樣的樣子。

這是我把會議室開源的原因。

目前的版本先從 Claude 和 Codex 兩位成員開始。接下來的方向是讓更多 AI 的命令列工具加入，例如 Gemini CLI：新成員先參加討論和審查，確認接得上核准與還原機制之後，才開放修改檔案。

## 關於作者

我是平面設計師，不會寫程式。

AI 是我的工作夥伴。我負責視覺和最後的判斷，程式的部分交給 AI 完成。這間會議室本身，也是我和 Claude、Codex 一起做出來的。

我同時也做行銷，還在持續學習。平常會同時用好幾家 AI，想知道每一家擅長什麼、怎麼讓它們互相補位。這間會議室就是我自己每天在用的工具。

## 適合誰

- 不寫程式，但會指揮 AI 做網站、工具、小系統的人，例如設計師、行銷、小團隊老闆
- 同時有 Claude 和 ChatGPT 方案，想讓兩邊一起做事、互相檢查的人

## 它會做什麼

- 你寫下目標，Claude 讀你的專案，提出規劃、方案選項和風險
- Codex 檢查專案，回報能不能做、要改哪些檔案，把操作一張一張列成工作卡
- 每張卡標好風險等級，你核准才執行；核准前會自動存一個 git 還原點，隨時可以回到執行前
- 做完由 Claude 再審查一次，會議結束時存成一份 markdown 紀錄
- 每則訊息都能按「用白話解釋」翻成不含技術詞的中文
- 需要圖片素材時會開「等你交件」卡片，寫清楚尺寸、格式和存放位置，等你交件
- 跑完一輪會出聲提醒；也可以設定 Telegram 推播，或用 Tailscale 從手機連進來

目前的版本由 Claude 負責規劃、Codex 負責執行，介面是繁體中文，只支援 macOS。

## 需要準備

- macOS
- Node.js 20 以上、Git
- Claude Code（`claude` 指令），用你自己的帳號登入
- Codex CLI（`codex` 指令），用你自己的帳號登入
- 選用：Tailscale（手機入口）、Telegram（推播）、Gemini CLI 或 Ollama（白話解釋）

## 安裝與第一次啟動

1. 下載這個專案（GitHub 頁面的 Code > Download ZIP，或 Releases 裡的壓縮檔），解壓縮到你習慣放工具的地方。
2. 在 Finder 雙擊 `start.command`。如果 macOS 說無法打開，按右鍵選「打開」，或到「系統設定 > 隱私權與安全性」按「強制打開」。
3. 第一次啟動會有設定精靈，問你三件事：你的專案都放在哪個資料夾、要不要開手機入口（可以留空）、會議室的登入密碼。
4. 設定完成後，瀏覽器會自動打開 `http://127.0.0.1:4477`，輸入剛剛設定的密碼就能開始。

想用終端機也可以：進到會議室資料夾，執行 `npm start`。要關掉時在終端機按 `Control + C`。

畫面左下角的「環境檢查」會告訴你 claude 和 codex 叫不叫得動，兩個都有版本號就沒問題。上方的「模型狀態」會列出這次偵測到的模型；沒驗證過、或這次沒有提供的模型會標示原因並禁止選用。

### 模型會自己跟上更新

Claude Code 或 Codex 改版、推出新模型時，不用改程式：

- 會議室啟動時、每次 AI 開工前（最多每 5 分鐘一次）都會比對 `claude` 和 `codex` 的版本；版本變了，或 Codex 的模型清單超過一小時，就自動重新偵測。閒置時每 30 分鐘也會看一次。
- CLI 新列出的模型會出現在設定裡，標成「待你開放」。你按「開放」才會被使用，避免在不知情的情況下換成更貴的模型；不想用了可以「收回」。
- 你選的模型如果這次沒有提供（例如官方下架），會暫時改用最接近、而且不比原本高階（不會更貴）的模型，設定區和會議紀錄都會寫明換成了什麼。原本的模型恢復後自動換回，你的設定不會被改掉。如果剩下的模型都比原本高階，會停下來請你在設定裡選，不會自己升級。
- Codex 執行時如果回報模型不能用，會議室會立刻重新偵測。唯讀的討論會自動換模型重試一次；會改檔的工單不會自動重跑，改成提示你按「重試」。

## 安全設計

- 會議室只聽本機 `127.0.0.1`。手機入口只接受 Tailscale 網段（100.64.0.0/10）的位址，填錯會直接不開放。
- 登入密碼存在本機 `.secrets/passcode.txt`，不會出現在畫面、log 或會議紀錄。登入八小時後、按登出、或伺服器重啟後都要重新登入。
- Claude 全程只能讀。Codex 只有在你核准之後、而且只能寫入工作卡上列出的檔案，越界會停下來並還原本次變更。
- 每次核准前自動存 git 還原點，右下角「回到執行前」可以一鍵回復。
- 附件或交件檔如果是 HTML、SVG 這類會執行程式的檔案，一律改成下載，不在會議室裡直接打開。

| 階段 | Claude | Codex |
|---|---|---|
| 討論中 | 只能讀 | 只能讀（`--sandbox read-only`） |
| 待核准 | 只能讀 | 只能讀 |
| 你按核准後 | 只能讀 | 可寫（`--sandbox workspace-write`） |

不要設定路由器轉發或公開反向代理，也不要把監聽位址改成 `0.0.0.0`。用完請按畫面上的「登出」，只關分頁不會立刻撤銷登入。

## 帳號、費用與條款

- 會議室只會呼叫你自己電腦上的 `claude` 與 `codex` 指令，用的是你自己的登入。本專案不收集、不儲存、也不轉送任何帳號登入資料。
- 用量算在你自己的 Claude 與 ChatGPT 方案裡。Anthropic 的說明是 Pro、Max 方案的額度以一般個人使用來估算；會議室一輪常常要跑十幾二十分鐘，長時間連續使用會比較快用到上限。
- 使用時請遵守 Anthropic 與 OpenAI 各自的使用條款。
- Claude 與 Claude Code 是 Anthropic 的商標；Codex 與 ChatGPT 是 OpenAI 的商標。

---

## 一場會議長什麼樣

1. 你用白話寫下想做什麼，按「開始會議」
2. Claude 讀你的專案，提出規劃、方案選項、風險
3. Codex 檢查專案，回報能不能做、要改哪些檔案，把操作一項一項列出來
4. 你在左欄選方案
5. 右欄一張一張核准或拒絕
   - 低風險：只新增檔案或改樣式
   - 中風險：會動到現有功能
   - 高風險：刪檔、裝套件、部署
   - 卡片有兩張以上時，欄位標題會出現「核准全部低風險」和「核准全部」。按一下會變成「確定？再按一次」，再按才會開跑。批次是一張接一張做，每一張照樣先存還原點；中途有一張失敗就停下來，後面的留在待處理，你看完失敗原因再決定重試或跳過
6. 每次核准前會自動存一個 git 還原點，右下角「回到執行前」可一鍵回復
7. 全部做完 Claude 會再審查一次
8. 按「結束並產出決議」，存成 `meetings/` 裡的 markdown

## 要在哪個專案上工作

畫面最上方會分開顯示「讀取根目錄」與「目前處理專案」。讀取根目錄是你在設定精靈填的資料夾，Claude 與 Codex 可以從這裡讀取跨專案資料；「切換」只改變目前處理的子專案，不會縮小讀取範圍。

子專案有三種選法：

1. 從 Finder 直接把資料夾拖進來（最快）
2. 從家目錄開始一層層點進去找。有 git 或 package.json 的資料夾會標成橘色，一眼看得出哪個是專案
3. 直接貼路徑，只接受讀取根目錄裡面的資料夾

選過的子專案會記在「最近用過」，下次一鍵切回。標籤旁邊的綠色 `GIT` 表示這個資料夾已經有版本控制，還原點可以正常運作；沒有的話第一次執行時會自動建立。

看得到全部專案不代表能任意修改；Codex 只能寫入你已核准工單明列的檔案，越界時會停止並回復本次變更。

## 會議中隨時插話

對話欄下面有發言框，整場會議都在。送出前先選這句話是說給誰聽的：

- Claude（策劃者）：問方向、改需求、要他重新規劃
- Codex（執行者）：問專案的事、要他多做或改做某件事。如果你的話代表要多做操作，右欄會自動長出新的待核准卡片
- 只記錄，不問：單純留一句話在會議紀錄裡，不呼叫任何 AI

Enter 送出，Shift + Enter 換行。AI 正在跑的時候發言框會暫時鎖住，跑完自動解開。

## 做完會叫你一聲

AI 一輪動輒十幾二十分鐘，你不用一直盯著畫面。這三個時刻會響一聲：

- AI 跑完一輪
- 有新的事情需要你決定
- 素材做好了等你看

右下角「提示音」可以關掉。瀏覽器規定網站要先被點過一下才能發出聲音，所以剛重新整理時那顆會顯示「提示音 點一下啟用」。分頁切到背景時，除了聲音還會閃動分頁標題；允許系統通知的話也會跳一則。

音檔放在 `public/assets/sfx/yes-my-lord.mp3`，想換聲音就用同名檔案蓋掉。

### 不在電腦前也收得到（Telegram）

需要你決定、Codex 做完一張卡、出錯了，這三個時刻可以推一則訊息到你的 Telegram。設定是兩個檔案，放在 `.secrets/`（跟密碼一樣不進 git）：

```
.secrets/telegram-token.txt     BotFather 給你的 bot token
.secrets/telegram-chat-id.txt   你自己的 chat id（純數字）
```

存好之後重啟伺服器，啟動訊息會顯示「Telegram 通知：已啟用」；頁尾的「測試通知」可以立刻收一則試試。token 的內容不會出現在畫面、log 或會議紀錄裡。

## 看不懂的時候

每則訊息下面都有「用白話解釋」，會把那段翻成不含技術詞彙的中文，程式碼一律收在「展開技術細節」裡。

翻譯的順序是 Ollama（本機模型，免費）、Gemini、Claude：前面的連不上、逾時或沒回東西就自動往後退，白話版最後一行會寫是誰翻的。想跳過 Ollama 就把 `config.json` 的 `explainBy` 改成 `gemini`，全部交給 Claude 就改成 `claude`。

**Ollama**：`config.json` 的 `ollama.url` 填你的 Ollama 位址，例如 `http://100.x.x.x:11434`；`model` 留空就用第一個模型。Ollama 如果裝在另一台電腦，請把那台的 `OLLAMA_HOST` 設成它自己的 Tailscale IP，只讓 Tailscale 網路連得到；不要設成 `0.0.0.0`，那會讓同一個 Wi-Fi 裡的人也連得到。

**Gemini**：`gemini` 指令改用 API 金鑰。到 Google AI Studio 建一把金鑰，存成 `.secrets/gemini-api-key.txt`（一行，只有金鑰本身）。伺服器只會在啟動 `gemini` 時把它當環境變數傳進去，不會進 log、畫面或會議紀錄。沒有金鑰時會自動退回 Claude。

## 需要圖的時候

Claude 和 Codex 在會議室裡都不會產圖。需要素材時右欄會出現「等你交件」卡片，寫清楚尺寸、格式、數量、檔名和存放路徑，卡片建立時會先準備好收件資料夾。

- 「開啟資料夾」：在 Mac 上直接打開收件位置
- 「把檔案拖到這裡」：直接拖入或按一下選檔，每個檔案上限 25MB，同名檔不會被覆蓋
- 「複製產圖工單」：複製完整規格，貼到你慣用的產圖工具
- 自己用 Finder 放好之後，按「我自己放好了」，會議室確認檔案存在才會讓 Codex 接手

## 出問題的時候

- 畫面顯示「連線中斷」：伺服器關掉了，重新雙擊 `start.command`
- 被送回登入頁：登入逾時、已登出，或伺服器剛重啟；重新輸入密碼即可
- 顯示錯誤次數過多：依登入頁顯示的時間等待，期間即使輸入正確密碼也不會放行
- 手機網址打不開：看啟動視窗寫的原因，確認 Mac 的 Tailscale 已連線；本機仍可用 `http://127.0.0.1:4477`
- Claude 或 Codex 沒回應：按「環境檢查」，通常是登入過期，在終端機執行一次 `claude` 或 `codex` 重新登入
- 還原點建不起來，說 .git 被鎖住：在專案資料夾執行 `rm -f .git/*.lock .git/objects/maintenance.lock`，再按一次核准
- 回覆格式跑掉：畫面會直接顯示原始回覆，不會當掉
- 模型突然不能用（CLI 剛改版）：會議室會自己重新偵測，必要時暫時改用最接近的模型，設定區會說明換成了什麼；想立刻重抓就按「模型狀態」裡的「重新檢查」
- CLI 改版導致參數失效：改 `config.json` 裡的 `args`，不用動程式碼

## 給想改程式的人

- 改畫面（`public/index.html`）重新整理瀏覽器就好；改 `server/` 或 `config.json` 要按左下角「重新啟動」
- `npm run dev` 會在程式變動時自動重啟，但執行核准工作時不要用，監看器會把 Codex 執行到一半的工作砍掉
- 測試：`node --test test/*.test.js`
- 可用的模型由 `codex debug models` 和 `claude --help` 即時偵測（`server/model-discovery.js`）；`server/model-config.js` 只放已知模型的中文名稱、說明和高低排序。新模型不用改程式，在設定裡按「開放」即可
- 工單的模型上限依「Astra > Sol > Terra > Luna，同家族比版本」判斷；不認得的新家族一律當成最高檔，思考深度也一樣，CLI 新出現的深度視為最深
- 打包 Mac 版：`node scripts/build-release.mjs --platform mac --out dist/ai-meeting-room-mac.zip`

```
server/
  index.js          伺服器、登入保護與 API
  auth.js           密碼核對、登入憑證、限速與逾時
  safe-path.js      素材與附件的白名單路徑檢查
  orchestrator.js   會議流程控制
  prompts.js        給兩個 AI 的指令與輸出格式
  capabilities.js   職能分工表
  git.js            還原點與 diff
  adapters/         呼叫 claude / codex / gemini / ollama 的封裝
public/index.html   登入後的會議主畫面
public/login.html   登入頁
config.example.json 設定範本（實際設定 config.json 由精靈產生，不進 git）
meetings/           會議紀錄（不進 git）
```

## 素材來源

介面裡的頭像、圖示與提示音，由作者自行製作或用 AI 工具產生，隨本專案一起以 Apache 2.0 授權釋出。

## 授權

Apache License 2.0，全文見 [LICENSE](LICENSE)，著作權聲明見 [NOTICE](NOTICE)。

---

## English

**AI Meeting Room** is a local app for macOS where Claude Code and Codex CLI work together on your project in one window, and you make the final call.

> **Note:** the interface is currently in Traditional Chinese only.

### The idea: your meeting room is a company

This is not a fixed AI lineup. It is a company you run.

No company expects every hire to be the same, and no two people subscribe to the same set of AI tools. You hire the AIs you already pay for, give each one a role that fits its strengths, and keep the final decision for yourself. Every meeting room ends up shaped differently. That is why I open-sourced it.

The current version starts with two members, Claude Code and Codex CLI. The plan is to let more AI CLIs join (Gemini CLI first). New members start in discussion and review only, and get write access once they work with the approval and rollback system.

### How a meeting works

1. Describe what you want in plain language.
2. Claude reads your project and proposes a plan, options, and risks.
3. Codex checks feasibility and lists each change as an approval card, marked low, medium, or high risk.
4. Nothing touches your files until you approve a card. A git restore point is saved before each run, so you can roll back in one click.
5. Codex can only write to the files listed on the approved card. Going out of scope stops the run and reverts it.
6. Claude reviews the result, and the meeting is saved as a markdown record.

Other features: an "explain in plain words" button on every message, asset hand-off cards when the AIs need images from you, sound alerts, and optional Telegram notifications.

### Requirements

- macOS, Node.js 20+, Git
- Claude Code and Codex CLI, each signed in with your own account
- Usage counts against your own Claude and ChatGPT plans. This project never collects, stores, or forwards your login credentials.

Download the repo, double-click `start.command`, and a setup wizard walks you through the rest. The app only listens on `127.0.0.1`.

### About the author

I'm a graphic designer, and I don't write code. AI is my working partner: I handle the visuals and the decisions, and AI handles the code. This meeting room was built that way too, with Claude and Codex.

I also work in marketing and I'm still learning. I use several AI tools every day, and I built this to see what each one is good at and how they can cover for each other.

This is an independent open-source project, not affiliated with Anthropic or OpenAI. Claude and Claude Code are trademarks of Anthropic; Codex and ChatGPT are trademarks of OpenAI.

Licensed under Apache 2.0.
