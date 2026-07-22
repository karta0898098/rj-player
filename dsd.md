# DSD — 個人 macOS 影片播放器（YouTube + AI 多語字幕）

Detailed System Design ／ 詳細系統設計
版本：v0.1（對應 `spec.md` v0.1）
狀態：實作前的技術設計定案
上游文件：[`spec.md`](spec.md)、[`design_handoff_youtube_subtitle_player/README.md`](design_handoff_youtube_subtitle_player/README.md)

---

## 0. 本文件範圍與讀法

`spec.md` 回答「要做什麼、為什麼」；本 DSD 回答「怎麼拆模組、模組之間用什麼契約溝通、資料長什麼樣、流程怎麼跑、壞了怎麼辦」。最後一章 §11 是**分批上（incremental delivery）**規劃，把 spec §8 的四個 Phase 再細拆成可獨立實作、可獨立驗收的 batch。

### 0.1 與上游文件的兩處歧異（本 DSD 的裁定）

實作前先把 spec 與 design handoff 的衝突釘死，避免各做各的：

| 議題 | design handoff 的說法 | spec 的說法 | 本 DSD 裁定 | 理由 |
|---|---|---|---|---|
| 影片承載方式 | 建議用 YouTube iframe Player API 或原生 WebView/AVPlayer | yt-dlp 下載本地 mp4，Rust HTTP Range serve，前端 `<video>` 播放 | **以 spec 為準：本地 mp4 + `<video>`** | 三層 ruby overlay 需要能精準對齊本地時間軸；iframe Player API 無法保證 frame 級同步，也拿不到本地音軌餵 Whisper |
| App 形態 | 建議 SwiftUI 原生 macOS App | 本階段純網頁 SPA + Rust 後端，保留 Tauri 遷移路徑 | **以 spec 為準：Web SPA + axum**，SwiftUI 不採用 | spec §4.2 已論證；SwiftUI 會斷掉 Tauri 遷移接縫 |

design handoff 的**視覺與互動規格（顏色、字級、間距、三層字幕排版、控制列、設定彈窗、深色/劇院模式）仍然採用**，只是承載技術改為 Web。

---

## 1. 設計總覽

### 1.1 元件圖

```
┌─────────────────────────────────────────────────────────┐
│  Frontend SPA（Vite + React，瀏覽器；未來 = Tauri WebView）│
│   VideoLoader · Player(<video>) · SubtitleOverlay          │
│   Controls · SettingsPopover · JobProgress                 │
└───────────────┬──────────────────────┬────────────────────┘
      REST/JSON  │        WebSocket      │  <video src=/media/..> (Range)
                 ▼                       ▼
┌─────────────────────────────────────────────────────────┐
│  Rust 後端（axum）  ==  未來 Tauri 的 core 層              │
│   http/（薄 adapter：routes / handlers / ws）              │
│   core/                                                   │
│     ├ downloader   → yt-dlp（tokio subprocess）            │
│     ├ media        → Range serve 本地 mp4                  │
│     ├ pipeline     → orchestrator + job queue（單工）       │
│     │     └ rpc    → Python worker（persistent subprocess）│
│     └ store        → fs：每支影片一個資料夾                 │
└───────────────┬───────────────────────────────────────────┘
    JSON lines   │ stdin/stdout（persistent worker，模型常駐）
                 ▼
┌─────────────────────────────────────────────────────────┐
│  Python AI service（獨立進程）                            │
│   ASR(faster-whisper) → Tokenize(MeCab/Sudachi)           │
│   → Romaji(pykakasi) → Translate(LLM API) → 組裝 canonical │
└─────────────────────────────────────────────────────────┘
```

### 1.2 技術選型定案

| 層 | 選型 | 備註 |
|---|---|---|
| 後端框架 | Rust + axum + tokio | spec §4 定案 |
| 靜態/Range | `tower-http::ServeFile`（原生支援 Range） | 不用自己刻 byte-range parser |
| 子進程 | `tokio::process::Command` | yt-dlp 與 Python worker |
| Rust↔Python | **persistent subprocess + JSON lines**（非 one-shot） | 讓 Whisper 模型常駐，避免每支影片重載模型 |
| ASR | faster-whisper（CTranslate2） | 比 whisper.cpp 好裝 Python 綁定；模型大小見 §9 開放問題 |
| 分詞注音 | 先 fugashi(MeCab)，介面抽象化便於換 SudachiPy | 見 §4.3 抽象 |
| 羅馬拼音 | pykakasi | |
| 翻譯 | LLM API（見 §9） | 批次翻譯，失敗降級 |
| 前端 | Vite + React（或 vanilla，皆可） | 對齊 handoff 原型的 state 模型 |

---

## 2. 元件分解與職責（Rust 後端）

建議檔案佈局（把 business logic 收進 `core/`，`http/` 只做薄轉接 → 這是 Tauri 遷移接縫，見 §10）：

```
src/
  main.rs              bootstrap：載 config、建 AppState、掛 router、啟動 job worker
  config.rs            資料夾路徑、port、python/yt-dlp 路徑、whisper 模型、LLM 設定
  state.rs             AppState { store, job_tx, event_hub }（Arc 共享）
  http/
    router.rs          route table
    videos.rs          POST/GET /api/videos, GET /api/videos/:id, POST .../pipeline
    media.rs           GET /media/:id/video（Range serve）
    subtitles.rs       GET /api/videos/:id/subtitles(.srt), POST .../offset
    ws.rs              GET /api/videos/:id/events（進度推播）
  core/
    domain/
      video.rs         Video, VideoStatus（狀態機）
      subtitle.rs      SubtitleDoc, Cue, JaToken（canonical 型別，見 §5）
      events.rs        JobEvent（WS 推播的事件型別）
    downloader/ytdlp.rs   包 yt-dlp：下載 mp4、抽 audio、解析進度、讀 metadata
    media/range.rs        （多為薄包裝 ServeFile）
    pipeline/
      orchestrator.rs     驅動 download→ASR→token→romaji→translate 狀態機
      queue.rs            單工 job queue（tokio mpsc + 單一 worker task）
      rpc.rs              Python worker RPC client（起進程、送 request、收 event stream）
    store/fs_store.rs     讀寫每支影片資料夾、快取命中判斷
```

各模組職責一句話：
- **downloader**：URL → 本地 `video.mp4` + `audio.wav` + `meta.json`；串流解析 yt-dlp 進度百分比。
- **media**：`GET /media/:id/video` 用 `ServeFile` 回應 Range，支援拖曳 seek。
- **pipeline/orchestrator**：拿 `audio.wav` 走一趟 Python worker，落地 `subtitles.json`，過程推 stage 事件。
- **pipeline/queue**：全域**單工**——同時只跑一個 pipeline job（避免 Whisper 吃爆 CPU/RAM）；下載與播放不受此限。
- **pipeline/rpc**：管理 Python worker 生命週期（lazy 啟動、崩潰偵測、重啟），送 JSON 請求、把 worker 的 event 流轉成 Rust `JobEvent`。
- **store**：檔案系統存取單點；快取判斷（`video_id` + schema `version` 命中則跳過 pipeline）。

---

## 3. 介面契約（Interface Contracts）

### 3.1 REST API（Frontend ↔ Rust）

| Method & Path | 用途 | Request | Response |
|---|---|---|---|
| `POST /api/videos` | 貼網址觸發下載（+可選自動接 pipeline） | `{ "url": "https://…watch?v=ID", "auto_pipeline": true }` | `202 { "video_id":"ID","status":"downloading" }`；若已快取 ready → `200 { "status":"ready" }` |
| `GET /api/videos` | 影片庫列表 | – | `200 [{ video_id, title, channel, status, duration_ms }]` |
| `GET /api/videos/:id` | 單支狀態/metadata | – | `200 { video_id, title, channel, duration_ms, status, last_stage, last_error? }` |
| `POST /api/videos/:id/pipeline` | （重）跑字幕 pipeline | `{ "force": false }` | `202 { "status":"transcribing" }` |
| `GET /media/:id/video` | 影片串流（播放器 `src`） | Header `Range: bytes=…` | `206 Partial Content`，`Accept-Ranges: bytes`, `Content-Type: video/mp4` |
| `GET /api/videos/:id/subtitles` | 取三層字幕 canonical JSON | – | `200 SubtitleDoc`（§5）；未完成 → `409 { status }` |
| `GET /api/videos/:id/subtitles.srt` | 匯出單層 SRT（P1） | `?layer=zh\|ja` | `200 text/plain` |
| `POST /api/videos/:id/subtitles/offset` | 時間軸偏移（P1） | `{ "offset_ms": -300 }` | `200 SubtitleDoc` |

錯誤格式統一：`{ "error": { "code": "download_failed", "message": "…" } }`（沿用房規的 error model 精神，本專案簡化為此形狀）。

### 3.2 WebSocket 進度（Frontend ↔ Rust）

`GET /api/videos/:id/events`（升級為 WS）。Server 單向推播，事件型別（tagged JSON）：

```jsonc
{ "type": "status",   "status": "transcribing" }
{ "type": "progress", "stage": "download",  "pct": 42 }
{ "type": "progress", "stage": "asr",       "pct": 70 }
{ "type": "log",      "line": "[yt-dlp] 12.3MiB/45.0MiB" }
{ "type": "done",     "status": "ready" }
{ "type": "error",    "stage": "translate", "message": "LLM 429 rate limited" }
```
`stage` 值域：`download | asr | tokenize | romaji | translate | assemble`。前端據此畫「辨識中… (asr 70%)」。

### 3.3 RPC 協議（Rust ↔ Python，persistent worker）

Python 端是**常駐 worker**：啟動時載入 Whisper 模型一次，之後 loop 讀 stdin（一行一個 JSON request），把事件與結果寫 stdout（一行一個 JSON）。stderr 保留給人看的 log。

Request（Rust → worker stdin）：
```jsonc
{
  "id": "req-<uuid>",
  "method": "generate_subtitles",
  "params": {
    "video_id": "abc123",
    "audio_path": "/…/videos/abc123/audio.wav",
    "source_lang": "ja",
    "whisper_model": "large-v3",
    "translate": true,
    "target_lang": "zh-TW"
  }
}
```
Event stream（worker stdout → Rust，同一 `id` 可有多筆，最後恰一筆 `result` 或 `error`）：
```jsonc
{ "id":"req-…", "event":"stage",    "stage":"asr",      "status":"start" }
{ "id":"req-…", "event":"progress", "stage":"asr",      "pct":30 }
{ "id":"req-…", "event":"stage",    "stage":"translate","status":"start" }
{ "id":"req-…", "event":"result",   "subtitles": { /* canonical SubtitleDoc，見 §5 */ } }
// 或
{ "id":"req-…", "event":"error",    "stage":"translate","message":"…","partial": { /* 可選：ja+romaji 已完成的 doc */ } }
```
其他 method：`ping`（健康檢查 / 開發期 echo）、`shutdown`。

> 設計理由（呼應 spec §4.3）：這組 JSON schema 就是未來若改用 PyO3 的函式簽名藍本；換 IPC 機制時契約不變，遷移成本可控。

---

## 4. Python AI service 內部設計

### 4.1 Pipeline 四段

1. **ASR**：`faster-whisper` `transcribe(audio, language="ja")` → segments `[{start, end, text}]`（秒→轉 ms）。可選 `word_timestamps` 供更細對齊。
2. **Tokenize**：對每個 segment 的 `text` 用 MeCab/Sudachi 斷詞，取得 surface + reading（片假名→轉平假名）。
3. **Romaji**：pykakasi 對整句 `text` 轉 `romaji`。
4. **Translate**：把多個 segment 批次（例如 10~20 句一批，帶 index）丟 LLM API，回填每句 `zh_text`；保留 index 對應避免錯位。

### 4.2 ja_tokens 的設計改良（重要）

spec §5 的 `ja_ruby` 只列「有讀音的漢字詞」，但前端要渲染 `<ruby>` 需要知道每個詞在句中的**位置**，只給漢字詞會無法重建原句排版。**本 DSD 改為輸出覆蓋全句的 token 序列 `ja_tokens`**：把 `t` 依序串接必須等於 `ja_text`，有漢字者附 `reading`。

```jsonc
"ja_tokens": [
  { "t": "今日", "reading": "きょう" },
  { "t": "は" },
  { "t": "良い", "reading": "よい" },
  { "t": "天気", "reading": "てんき" },
  { "t": "です" }, { "t": "ね" }
]
```
前端渲染規則：token 有 `reading` 且 `t` 含漢字 → `<ruby>t<rt>reading</rt></ruby>`；否則純文字輸出。`ja_text` 仍保留供複製、SRT 匯出與 fallback。

### 4.3 可替換介面

分詞器抽象成 `Tokenizer` protocol（`tokenize(text) -> list[Token]`），MeCab / Sudachi 各一實作，用 config 切換 → 呼應 spec §7 的 MeCab vs Sudachi 未定，設計上不擋。翻譯抽象成 `Translator.translate_batch(texts) -> list[str]`，換 LLM 供應商不動 pipeline。

---

## 5. 資料模型與儲存

### 5.1 Canonical SubtitleDoc（落地 `subtitles.json`）

在 spec §5 基礎上補 `version` / `duration_ms` / 每句 `id`，並以 §4.2 的 `ja_tokens` 取代 `ja_ruby`：

```jsonc
{
  "version": 1,
  "video_id": "abc123",
  "language_source": "ja",
  "target_lang": "zh-TW",
  "duration_ms": 138000,
  "cues": [
    {
      "id": 0,
      "start_ms": 12000,
      "end_ms": 14500,
      "ja_text": "今日は良い天気ですね",
      "ja_tokens": [ { "t":"今日","reading":"きょう" }, { "t":"は" }, … ],
      "romaji": "kyou wa ii tenki desu ne",
      "zh_text": "今天天氣真好呢"
    }
  ]
}
```
`version` 用於快取失效：schema 或 pipeline 改版時 bump，命中判斷會強制重跑。翻譯失敗降級時 `zh_text` 可為 `null`（前端該層留白，不擋日文/羅馬拼音）。

### 5.2 每支影片的資料夾

```
<data_dir>/videos/<video_id>/
  meta.json        { video_id, source_url, title, channel, duration_ms,
                     status, last_stage, last_error, created_at }
  video.mp4        yt-dlp 下載
  audio.wav        抽出的音軌（餵 Whisper；16kHz mono）
  subtitles.json   canonical SubtitleDoc（含 version）
  pipeline.log     人看的執行紀錄
```
`video_id` = YouTube 的 11 碼 video id，天然當快取 key（同一支影片不重跑，呼應 P0 快取需求）。

### 5.3 影片狀態機（`VideoStatus`）

```
new ──▶ downloading ──▶ downloaded ──▶ transcribing ──▶ tokenizing
                 │                                          │
                 ▼                                          ▼
          download_failed                              translating
                                                            │
        （任何 pipeline 階段失敗）                            ▼
                 └───────────▶ pipeline_failed ◀──────── assembling ──▶ ready
```
`meta.json` 記 `status` + `last_stage` + `last_error`，重啟後可回復顯示、可從失敗處重跑。

---

## 6. 關鍵流程時序

### 6.1 下載 + pipeline（POST /api/videos, auto_pipeline=true）

```
Frontend        Rust(http)      JobQueue        downloader        PyWorker         store
   │ POST url ──────▶│                                                              │
   │                 │ video_id 已 ready? ──────────────────────────── store.get ──▶│
   │  202 status ◀───│ (否) enqueue job                                            │
   │ WS connect ────▶│                                                             │
   │                 │        job ──▶│ yt-dlp 下載（串流 %）──▶ 落地 mp4/wav/meta ──▶│
   │  progress ◀═════╪═══════════════ download pct 事件                            │
   │                 │        │ 送 generate_subtitles ─────────▶│ ASR/token/romaji  │
   │  progress ◀═════╪═══════════════ stage/pct 事件 ◀══════════ /translate         │
   │                 │        │ ◀──────────── result(SubtitleDoc) ─┤                │
   │                 │        │ 寫 subtitles.json ─────────────────────────────────▶│
   │  done: ready ◀══╪════════╡                                                     │
   │ GET subtitles ─▶│ ─────────────────────────────────────────── store.read ────▶│
```

### 6.2 播放 + 字幕同步（前端）

- `<video src="/media/:id/video">`，瀏覽器對 Range server 發 `206`。
- 載入 `subtitles.json` → cues 依 `start_ms` 排序。
- **同步用 `requestAnimationFrame` loop 讀 `video.currentTime`**（非 spec 提的 `timeupdate`——後者只 ~4次/秒，切句會鈍）；對 cues 做 binary search 找 `start_ms <= t < end_ms` 的 cue，變更才重繪 overlay。
- overlay 三層依 design tokens 排版；`ja_tokens` 決定 ruby，逐層開關互不影響。

---

## 7. 錯誤處理與失敗隔離

| 失敗點 | 偵測 | 處理 |
|---|---|---|
| yt-dlp 下載失敗 | 子進程非 0 退出、stderr | status=`download_failed`，WS 推 error，保留可重試 |
| Python worker 崩潰 | stdout EOF / 進程退出 | 標記 job `pipeline_failed@stage`；**Rust 主程式不受影響**（進程隔離＝spec §4.3 選 RPC 的核心理由）；下次請求 lazy 重啟 worker |
| Whisper OOM | worker 退出 / 記憶體錯誤 | 建議降模型大小（config），單工 queue 已避免並發爆量 |
| LLM API 失敗 / 429 | HTTP 狀態、逾時 | 指數退避重試 N 次；仍失敗 → **降級**：保留 ja + romaji，`zh_text=null`，doc 仍落地並標 `translate_partial`（不因翻譯掛掉丟掉整份辨識成果） |
| 快取/schema 過期 | `subtitles.json.version != 當前` | 視為 miss，重跑 pipeline |

冪等性：以 `video_id` 為 key；`subtitles.json` 存在且 `version` 相符即跳過 pipeline，除非 `force=true`。

---

## 8. 併發、效能與設定

- **併發模型**：pipeline **單工**（tokio mpsc + 單 worker task 消化 job queue）；HTTP media 串流與 REST 查詢並發不受限。單使用者本機工具，簡單優先（呼應 spec §2 目標 5）。
- **Whisper 模型常駐**：persistent worker 讓大模型只載一次，多支影片攤平載入成本。
- **設定來源**：config 檔 + 環境變數 —— `DATA_DIR`、`PORT`、`YT_DLP_PATH`、`PYTHON_BIN`、`WHISPER_MODEL`、`LLM_API_KEY`（僅環境變數，不落 config 檔）、`LLM_MODEL`、`LLM_ENDPOINT`、`TOKENIZER=mecab|sudachi`。
- **安全**：純本機、預設只 bind `127.0.0.1`；LLM 金鑰不進版控。

---

## 9. 開放問題 → 設計掛鉤（呼應 spec §7）

| 開放問題 | 設計上如何不擋路 |
|---|---|
| Whisper 模型大小 | `whisper_model` 走 config/RPC params，可隨時換；worker 重啟即換模型 |
| 用哪個 LLM 翻譯 | `Translator` 介面 + `LLM_ENDPOINT/MODEL` config，換供應商不動 pipeline |
| MeCab vs Sudachi | `Tokenizer` protocol 雙實作，config 切換 |
| 是否保留官方 CC 做校正 | yt-dlp 可同時下載官方字幕存 `official.<lang>.vtt`；未來當校正輸入的接縫先留，本階段不接 |

---

## 10. Tauri 遷移接縫（呼應 spec §4.2、目標 4）

刻意設計、不做會卡死遷移的選型：
1. **business logic 全在 `core/`，不依賴 axum**：`http/` 只是把 HTTP request 轉呼叫 `core` 的薄殼。遷 Tauri 時，改寫成 `#[tauri::command]` 呼叫同一組 `core` 函式即可，`core` 不動。
2. **媒體串流接縫**：Tauri 可用 asset protocol 或續用 localhost Range server；前端 `<video src>` 的 base URL 抽成設定值。
3. **前端 API base URL 可切換**：`fetch` / WS 的 host 集中一處，Web 版指向 `localhost:PORT`，Tauri 版指向對應來源。
4. **Rust↔Python RPC 契約不變**：不論 Web 或 Tauri，Python worker 與 JSON schema 完全沿用。

---

## 11. 分批上（Incremental Delivery Plan）

原則：**每個 batch 都能獨立跑起來、獨立驗收**；每個 Phase 收尾一定有一個「端到端可 demo」的 batch。後端先於前端，但盡量做垂直切片（每 batch 有可看到的結果）。此專案目前非 git repo，建議先 `git init`，每個 batch 一個 commit / 分支，方便回溯。

驗收標準用「怎麼證明這批做完了」的具體動作描述。

### Phase 1 — Rust 後端下載 + 網頁播放（無字幕）

| Batch | 範圍 | 依賴 | 驗收（怎麼證明） |
|---|---|---|---|
| **B1.1 骨架** | axum 起服務、`config.rs`、data dir 初始化、`tracing` log、`GET /health` | – | `curl /health` 回 200；log 有結構化輸出 |
| **B1.2 下載封裝** | `downloader/ytdlp.rs`：URL→`video.mp4`+`audio.wav`+`meta.json`（title/duration/video_id）。先做成一個 CLI 子命令或單元測試入口，**還不接 HTTP** | B1.1 | 跑一次真的下載成功，三個檔案落地、meta 欄位正確 |
| **B1.3 Range serve** | `GET /media/:id/video` 用 `ServeFile` 支援 Range | B1.2 | 瀏覽器直接開 `<video src>` 能播、拖曳 seek 不卡；DevTools 看到 `206` |
| **B1.4 影片 REST** | `POST /api/videos`（觸發下載回 video_id/status）、`GET /api/videos`、`GET /api/videos/:id`；接上 job queue 骨架 | B1.2 | `curl` 貼網址→查狀態走完 `downloading→downloaded` |
| **B1.5 下載進度 WS** | `GET /api/videos/:id/events`；解析 yt-dlp stdout 百分比推 `progress` 事件 | B1.4 | `wscat` 連上看到 download pct 遞增到 done |
| **B1.6 最小前端** | Vite/React：URL 輸入→載入→`<video>` 播放＋下載進度條（用 handoff 視覺骨架，但只接播放） | B1.3, B1.5 | **端到端**：貼網址→看到下載進度→影片能播 ✅ Phase 1 完成 |

### Phase 2 — Python AI pipeline（單支影片跑通三層字幕 JSON）

| Batch | 範圍 | 依賴 | 驗收 |
|---|---|---|---|
| **B2.1 RPC 骨架** | Python persistent worker（讀 stdin JSON、寫 stdout JSON）＋ `pipeline/rpc.rs` client；先實作 `ping`/echo | B1.1 | Rust 送 `ping` 收到 worker 回應；worker 崩潰能被偵測 |
| **B2.2 ASR** | worker 接 faster-whisper：`audio.wav`→帶時間戳 segments（先不分詞/翻譯） | B2.1 | 對單支測試影片印出正確日文 + 時間戳 segments |
| **B2.3 分詞注音** | MeCab/Sudachi → `ja_tokens`（覆蓋全句，含 reading） | B2.2 | 串接 `ja_tokens[].t` == `ja_text`；漢字詞有 reading |
| **B2.4 羅馬拼音** | pykakasi → `romaji` | B2.3 | 抽查數句 romaji 正確 |
| **B2.5 翻譯 + 降級** | LLM API 批次翻譯→`zh_text`；含重試與失敗降級（保留 ja+romaji） | B2.4 | 正常得到 zh；模擬 API 失敗時 doc 仍落地、`zh_text=null` |
| **B2.6 串接 + 快取** | `orchestrator`：download→pipeline 全自動；寫 canonical `subtitles.json`；狀態機 + WS stage 事件；`video_id` 快取命中跳過 | B1.4, B2.5 | **端到端**：POST 一支影片→自動產出 `subtitles.json`；再 POST 同影片秒回（命中快取）✅ Phase 2 完成 |

### Phase 3 — 前端三層 ruby 字幕 + 時間軸同步

| Batch | 範圍 | 依賴 | 驗收 |
|---|---|---|---|
| **B3.1 取字幕 + 同步** | `GET subtitles`→cues；rAF loop 讀 currentTime，binary search 當前 cue | B1.6, B2.6 | 底部顯示當前日文字幕，換句時機準確、不抖 |
| **B3.2 三層 ruby 排版** | `<ruby><rt>` + 中文行 + 羅馬拼音行；套 design tokens（字型/字級/顏色/陰影/字距） | B3.1 | 視覺對齊 handoff §Screens（30/19/14px、色板、陰影） |
| **B3.3 互動齊全** | 逐層開關（日/中/拼）、字級滑桿、日文色板、設定彈窗、深色/劇院模式 | B3.2 | 對齊 handoff 的 Interactions & State（含毛玻璃設定面板、速率鈕） |
| **B3.4 pipeline 進行中 UX** | 字幕未就緒時接 WS 顯示「辨識中… (stage/pct)」，就緒自動載入 | B3.1, B2.6 | 新影片從下載到字幕出現全程有回饋 ✅ Phase 3 完成 |

### Phase 4 — 快取與體驗優化

| Batch | 範圍 | 依賴 | 驗收 |
|---|---|---|---|
| **B4.1 影片庫** | 列出已處理影片、可重選；`force` 重跑 pipeline | B2.6 | 列表顯示歷史影片，點擊即載入既有字幕 |
| **B4.2 時間軸偏移** | `POST .../offset`，前端即時套用 + 存回 `subtitles.json` | B3.1 | 拉偏移，字幕整體位移並持久化 |
| **B4.3 SRT 匯出** | `GET subtitles.srt?layer=zh\|ja`（單層） | B2.6 | 匯出的 SRT 可被 IINA/VLC 正常載入 |
| **B4.4 韌性** | worker 崩潰自動重啟、失敗重試、部分結果、pipeline log 檢視 | B2.1 | 殺掉 worker 後下一個 job 仍能跑；失敗有清楚訊息 |

> **P2 留白（本階段不做，架構已留接縫）**：即時字幕、其他來源語言、Tauri 打包、Spotify 狀態面板 —— 見 §10 遷移接縫與 §4.3 可替換介面。

### 11.1 分批上的節奏建議

- **一個 Phase 內**：後端 batch 先落地並用 `curl`/`wscat` 驗，再上前端 batch → 前端永遠對著「已能動的 API」開發。
- **跨 Phase 的最小可用點**：B1.6（能播）、B2.6（有字幕檔）、B3.4（畫面上看到字幕）—— 這三個是最有感的里程碑，適合各自停下來實際用一陣子再往下。
- **風險先行**：B2.2（Whisper 日文辨識效果）與 B2.5（翻譯品質/成本）是 spec §7 最大未知數，建議在 Phase 2 早期就拿真實影片實測，結果會回頭影響模型/LLM 選型。

---

## 12. 多語來源與 CC 優先序（實現 spec §6 P2「支援其他來源語言」）

### 12.0 範圍與裁定

把「來源語言只有日文、目標只有中文」這個貫穿全 stack 的假設收斂成**語言中立 + profile 分流**，並讓 CC 從單一 `ja` 軌泛化成「多軌 + 優先序」，使部分影片能同時省掉 ASR 與 LLM 翻譯。本階段交付兩種來源：

- **日文** → 三層：原文（漢字上 ruby 假名）＋ 羅馬拼音 ＋ 中文（現況，不退步）
- **英文** → 兩層：原文 ＋ 中文（中英雙字幕）

兩項已定案的裁定（其餘留白見 §12.8）：

| 議題 | 裁定 | 理由 |
|---|---|---|
| Cue schema 如何中立化 | **欄位改名 + `serde(alias)` 保留舊名** | 名字不再說謊；舊 `subtitles.json` 靠 alias 零遷移載入，不用重跑昂貴的 ASR |
| 自動生成 CC（auto-subs）是否納入 | **只用人工 CC，維持現狀** | 沿用 `--write-subs`（非 `--write-auto-subs`）的品質底線；命中率換品質，日後用開關放寬（§12.8） |

### 12.1 Cue schema 中立化（改名 + alias）

`Cue` 欄位從日文專屬改為語言中立，每個新欄位掛 `#[serde(alias = "舊名")]`，舊快取原地相容（不 bump `SUBTITLE_DOC_VERSION`，因為 alias 已讓舊 doc 正常反序列化，無需觸發 cache-miss 重生）：

```jsonc
// 之前（ja 專屬）→ 之後（中立，括號為 serde alias）
{
  "ja_text":   "…",   // → "source_text"   (alias "ja_text")
  "ja_tokens": [ … ],  // → "tokens"        (alias "ja_tokens")；EN 為 []
  "romaji":    "…",   // → "phonetic"      (alias "romaji")；EN 為 null/省略
  "zh_text":   "…"    // → "target_text"   (alias "zh_text")
}
```

`SubtitleDoc` 沿用既有 `language_source` / `target_lang`（前端據此決定渲染幾層），並新增一個非破壞欄位標示翻譯來源，供徽章顯示：

- `source`（既有）：`"asr" | "cc" | "align"` — 誰產生原文/時間軸
- `target_source`（新增，`serde(default)`）：`"llm" | "cc"` — 中文層來自 AI 翻譯或官方字幕

> `Cue.target_text` 維持 `Option`（`null` = 該 cue 尚無譯文），沿用 §7 的 translate-partial 降級語意。`tokens` 空陣列、`phonetic` 為 `None` 即代表「這個語言沒有讀音層」，前端不需要另外的旗標。

### 12.2 語言 Profile 矩陣

pipeline 依「來源語言」查一張 profile 表，決定跑哪些 stage、產生哪些層：

| source | ASR 語言 | 讀音 stage（tokenize + phonetic） | 翻譯 | 產生的層 |
|---|---|---|---|---|
| `ja` 日文 | ja | ✅ fugashi 注音 → pykakasi 羅馬拼音 | zh-TW | 原文(ruby)・羅馬拼音・中文 |
| `en` 英文 | en | ❌ 跳過（`tokens=[]`, `phonetic=None`） | zh-TW | 原文・中文 |
| *(未來 ko…)* | ko | 視語言而定 | zh-TW | 原文・中文 |

新增來源語言 = 表加一列 + 該語言的讀音實作（可選），pipeline 骨架不動。

### 12.3 Pipeline 依 profile 分流（`ai/worker.py`）

現況「ASR → 一定 tokenize → 一定 romaji → translate」改為讀 profile：只有 `profile.reading == true` 才跑 tokenize/phonetic 兩段；否則 ASR 後直接進 translate → assemble。ASR 段的優先序也一併泛化成「任何來源語言」而非只認 `ja`（見 §12.4）。stage 名稱與 WS 事件維持不變（`asr/tokenize/romaji/translate/assemble`），狀態機（§5.3）不動。

### 12.4 CC 多軌抓取 + 優先序 resolver

**抓取**：`downloader/ytdlp.rs` 的 `fetch_manual_ja_subs` 泛化為 `fetch_captions`——**一次** `yt-dlp --write-subs` pass，把 `--sub-langs` 從 `ja,ja-orig` 放寬成「來源語（含 `-orig`）＋ 中文各變體（`zh-Hant,zh-TW,zh,zh-Hans`）」，各軌落地為 `captions/<lang>.srt` 並寫一份 `captions.json` manifest（`[{lang, kind:"manual", path}]`）。維持人工 CC only。

**resolver（兩個獨立決策）**：

① **來源軌**（決定原文＋時間軸，命中即**略過 ASR**）
```
reference_lyrics(音樂,既有) ＞ 人工 CC(來源語) ＞ Whisper ASR
```
② **目標軌**（決定中文層，命中即**略過 LLM 翻譯**）← 「有些甚至不用翻譯」
```
人工 CC(zh-Hant / zh-TW) ＞ 人工 CC(zh 泛) ＞ LLM 翻譯
```

實際效果：

| 影片手上有 | ASR | LLM | 結果 |
|---|---|---|---|
| 來源語人工 CC ＋ 中文人工 CC | 略過 | 略過 | 兩層全免費（日文再本地補 romaji，很便宜）|
| 只有來源語人工 CC | 略過 | 走 LLM | 原文用官方、中文照翻 |
| 什麼官方字幕都沒有 | Whisper | LLM | 今天的行為 |

**雙軌時間對齊（v1 保守法）**：來源軌與目標軌時間軸各自獨立。v1 以**來源軌為主時間軸**，目標軌用「時間重疊最大」把中文文字塞回對應 cue；對不上的 cue 退回 LLM 翻譯（或留空）。精準雙軌對齊留待日後（§12.8）。簡體（`zh-Hans`）→ 繁中需經 OpenCC 轉換，v1 先只認繁中/泛中軌，簡中軌暫不當免費譯文（§12.8）。

### 12.5 後端契約調整

- **`VideoMeta`**：新增 `source_lang: Option<String>`（`serde(default)`；`None` 視為 `"ja"`，舊 meta 相容）。來源語言是「每支影片」的屬性，於 `POST /api/videos` 決定並持久化，`regenerate` 時沿用。
- **`POST /api/videos` body**：新增 `source_lang`；前端來源語選擇器帶入。
- **RPC `GenerateSubtitlesParams`**：`cc_path` 語意泛化為「來源語人工 CC」，新增 `target_cc_path`（目標語人工 CC）。Rust orchestrator 依 §12.4 resolver 挑好軌路徑傳入；worker 維持「最終優先序在自己這邊判」的既有分工（`reference_lyrics > source_cc > ASR`、`target_cc > LLM`）。
- **`orchestrator.rs`**：不再硬填 `ja`/`zh-TW`——`source_lang` 讀自 `meta`，`target_lang` 維持 `zh-TW`，caption 軌由 resolver 提供。

### 12.6 前端 UI

- **來源語言選擇器**：加在 `GenerationOptionsForm.jsx`（add-to-queue 與 regenerate 兩處）。選英文時隱藏日文專屬選項（羅馬拼音相關、正確歌詞、音樂 MV 歌詞提示）。
- **疊字層 data-driven**：`SubtitleOverlay.jsx` 依 `language_source`（或 `phonetic`/`tokens` 是否存在）決定顯示層；英文只有 原文＋中文，羅馬拼音 toggle 自動隱藏。props `subJP/subCN/subRomaji` → `subSource/subTarget/subPhonetic`。
- **側欄與樣式**：`SubtitleList.jsx` 編輯改用中立欄位、標籤中性化；`SettingsPopover.jsx` 的「字幕樣式」三個 slot 對應 原文/讀音/譯文，讀音 slot 對無讀音層的語言隱藏。
- **狀態徽章**：依 `doc.source` / `doc.target_source` 標示「官方字幕 vs AI 辨識」「官方翻譯 vs AI 翻譯」，一眼看出這支有沒有吃到免費 CC。
- （可選）匯出新增「雙語 SRT」。

### 12.7 分批上（Phase 5 — 多語來源）

沿用 §11 格式，每個 batch 可獨立驗收；後端先行、前端對著已能動的 API 開發。

| Batch | 範圍 | 依賴 | 驗收（怎麼證明） |
|---|---|---|---|
| **B5.1 Schema 中立化** | `Cue` 欄位改名 + `serde(alias)`；`assemble.py` 輸出鍵同步；前端引用點改名。行為不變 | B2.6/B3.x | 舊 `subtitles.json` 照載不重跑；日文影片端到端與改動前一致；測試綠 |
| **B5.2 Profile 分流 + 英文後端** | profile 表；worker 依表跳過讀音段；`source_lang` 穿過 meta/RPC/orchestrator；translate en→zh | B5.1 | `POST` 一支英文影片（`source_lang:"en"`）→ 產出 原文＋中文 doc、`tokens=[]` |
| **B5.3 前端來源語選擇器 + 疊字 data-driven** | 選擇器、英文隱藏日文選項、overlay 依語言渲染層 | B5.2 | UI 選英文 → 播放看到中英雙層、羅馬拼音 toggle 消失 |
| **B5.4 來源軌 CC 略過 ASR** | 下載時抓取**來源語**人工 CC（`fetch_manual_ja_subs` → `fetch_source_captions(source_lang)`，仍存單一 `cc.srt`）；worker 用來源 CC 跳過 Whisper。**不含** manifest／多軌／中文軌（移到 B5.5，因為要 B5.5 才會消費） | B5.2 | 有人工來源 CC 的影片略過 ASR，`doc.source="cc"`（已完成） |
| **B5.5 多軌抓取 + 目標軌略過翻譯** | 泛化成多軌抓取（來源語 + zh 各變體）+ manifest／per-lang 儲存；resolver 目標軌 + 時間重疊 merge；`target_source` 標示 | B5.4 | 同時有 來源＋中文人工 CC 的影片：零 LLM 呼叫、`doc.target_source="cc"`、徽章顯示「官方翻譯」 |

最小可用里程碑：**B5.3**（畫面上看到英文中英雙字幕）、**B5.5**（吃到全免費官方字幕）。

### 12.8 開放問題 → 設計掛鉤

| 開放問題 | 設計上如何不擋路 |
|---|---|
| 自動 CC（auto-subs）品質夠不夠好 | resolver 留 `allow_auto_captions` 開關；開啟時在人工軌之後、ASR/LLM 之前各插一層 auto，不動結構 |
| 簡中 → 繁中轉換 | 目標軌 resolver 先只認繁中/泛中；未來在 merge 前接 OpenCC，`zh-Hans` 軌才升級為可用免費譯文 |
| 雙軌精準對齊 | v1 用時間重疊 heuristic；未來可用來源/目標 CC 的字級時間做更精細對齊，或提供手動微調 |
| 更多來源語言（韓、其他） | profile 表加列 + 該語言讀音實作（可選）；pipeline/schema/前端渲染皆已中立化，不需再改骨架 |
