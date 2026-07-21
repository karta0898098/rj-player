# 個人 macOS 影片播放器（YouTube + AI 多語字幕）規格書

版本：v0.1（草稿）
用途：個人使用，非產品化交付
狀態：架構定案前的技術規格

---

## 1. 背景與問題

想要一個 macOS 上的影片播放器，能播放 YouTube 影片（先聚焦這裡，Spotify 音樂整合先不做，因平台 DRM 限制無法把音訊接進自製播放器，僅能做播放狀態顯示/控制，暫緩），並且能對日文影片自動產生多層字幕：

- 日文原文
- 中文翻譯
- 羅馬拼音（讀音輔助）

現有播放器（IINA、VLC 等）字幕引擎只支援單層文字疊加，無法做這種多語言 ruby 式排版，也沒有內建 AI 語音辨識/翻譯 pipeline，因此需要自己做。

---

## 2. 目標（Goals）

1. 能輸入 YouTube 網址，下載/串流影片並在本地播放
2. 對日文影片自動產生「日文 + 中文 + 羅馬拼音」三層字幕，並精確對齊時間軸
3. 字幕排版清楚可讀（日文漢字上方標假名/羅馬拼音，不干擾中文翻譯行）
4. 架構保留未來遷移到 Tauri 打包成獨立 App 的路徑，不做會卡死遷移的技術選型
5. 開發迭代速度優先於效能極致優化（自用工具，先求能動、好改）

## 3. 非目標（Non-Goals，本階段不做）

- Spotify 音訊接入播放器內（技術上不可行，見背景說明）
- 打包成 .app 或安裝檔（目前不考慮發佈，本機跑就好）
- 多使用者/雲端同步
- 除日文外的其他語言辨識與字幕生成（架構上不擋，但不是本階段目標）
- 即時串流播放（先用「下載後播放」，不處理 YouTube 直播）

---

## 4. 系統架構

### 4.1 高層架構圖（文字描述）

```
瀏覽器前端（本機開發階段：純網頁 SPA）
   │  HTTP / WebSocket
   ▼
Rust 後端（axum）─── 保留為未來 Tauri 的 core 層
   │
   ├── YouTube 下載模組：呼叫 yt-dlp（subprocess）
   ├── 影片檔案伺服器：HTTP Range Request serve 本地 mp4
   ├── 字幕 Pipeline 協調器
   │      │  RPC（本階段：本地 subprocess + stdin/stdout JSON，或本地 HTTP）
   │      ▼
   │   Python AI 服務（獨立進程）
   │      ├── 語音辨識：whisper.cpp / faster-whisper
   │      ├── 日文分詞注音：MeCab / Sudachi
   │      ├── 羅馬拼音轉換：pykakasi 或等價套件
   │      └── 翻譯：呼叫 LLM API（中文翻譯）
   │
   └── 字幕資料存放：本地 JSON 檔（每支影片一份）
```

### 4.2 為什麼現階段用「純網頁前端」而非 Tauri

- 目前不考慮打包發佈，Tauri 的核心價值（原生視窗殼、打包成 .app、選單列整合）用不到
- 純網頁前端開發迭代快（改前端不用重編 Rust）
- 瀏覽器 `<video>` 標籤本身就是成熟播放引擎，先不需要 libmpv 綁定
- **保留遷移路徑**：Rust 後端邏輯（yt-dlp 呼叫、字幕 pipeline 協調、資料格式）與前端解耦，未來要換成 Tauri 時，只需把「瀏覽器前端」換成「Tauri WebView 前端」，Rust 後端邏輯基本不用大改

### 4.3 Rust 呼叫 Python 的兩種方式比較

| 方式 | 說明 | 優點 | 缺點 |
|---|---|---|---|
| **RPC / subprocess（本階段採用）** | Rust 用 `std::process::Command` 起一個 Python 子進程，透過 stdin/stdout 傳 JSON，或起一個本地 HTTP 服務用 REST 溝通 | 進程隔離、Python 崩潰不拖垮 Rust 主程式；Python 環境/套件版本獨立管理；換 AI 工具（如換 Whisper 實作）不影響 Rust 端；開發時兩邊可分別重啟測試 | 有序列化/IPC 開銷（對長影片語音辨識這種本來就是秒級任務，開銷可忽略）；需要自己定義好 RPC 協議 |
| **PyO3（嵌入 CPython 直接呼叫）** | 用 [`pyo3`](https://pyo3.rs) crate 在 Rust 進程內嵌入 Python 解譯器，直接呼叫 Python 函式、共享記憶體物件 | 沒有 IPC 開銷、呼叫延遲最低；可直接傳遞 Rust/Python 物件不用序列化 | Rust 進程與 Python GIL 綁在一起，Python 端出錯容易影響整個 Rust 程式穩定性；打包/部署時要一起管理 Python 直譯器版本與依賴，複雜度較高；对本專案這種「批次跑一次語音辨識」的場景，效能優勢不明顯 |

**決策**：本階段用 subprocess/RPC。理由：
- 這個 pipeline 是「影片下載完後，批次跑一次語音辨識+翻譯」的離線任務，不是即時互動，IPC 開銷不是瓶頸
- Python 生態（whisper、MeCab、pykakasi）版本更新快，獨立進程比較好管理依賴
- 如果之後真的遇到效能瓶頸（例如想做即時字幕），再評估把熱路徑用 PyO3 重寫，屆時 RPC 協議定義好的 JSON schema 可以直接沿用當作函式簽名參考，遷移成本可控

---

## 5. 資料格式：三層字幕 JSON

不採用 SRT/ASS 這類單層字幕格式，自訂 JSON 結構以支援多層疊字：

```json
{
  "video_id": "xxxx",
  "language_source": "ja",
  "cues": [
    {
      "start_ms": 12000,
      "end_ms": 14500,
      "ja_text": "今日は良い天気ですね",
      "ja_ruby": [
        { "base": "今日", "reading": "きょう" },
        { "base": "天気", "reading": "てんき" }
      ],
      "romaji": "kyou wa ii tenki desu ne",
      "zh_text": "今天天氣真好呢"
    }
  ]
}
```

- `ja_ruby`：只標漢字部分的讀音，供前端用 `<ruby><rt>` 疊在漢字正上方
- `romaji`：整句羅馬拼音，前端可選擇顯示/隱藏
- `zh_text`：中文翻譯，獨立一行顯示

前端字幕疊層不透過 mpv/video 標籤內建字幕渲染，而是用 HTML overlay（絕對定位在 `<video>` 上方的 DOM 層），透過 `timeupdate` 事件比對 `cues` 陣列即時渲染，才能做到 ruby 排版。

---

## 6. 功能需求（Requirements）

### P0（必須有）
- [ ] 輸入 YouTube 網址 → yt-dlp 下載影片 + 音訊到本地
- [ ] 本地影片檔案透過 Rust HTTP server（支援 Range Request）播放
- [ ] Whisper 對日文音軌做語音辨識，輸出帶時間戳的日文文字
- [ ] MeCab/Sudachi 對日文文字做分詞，取得漢字讀音（假名）
- [ ] 假名 → 羅馬拼音轉換
- [ ] LLM API 翻譯日文 → 中文
- [ ] 前端播放器疊加三層字幕（日文+ruby、羅馬拼音、中文），時間軸同步準確
- [ ] 字幕結果快取成 JSON 檔，同一支影片不用重跑 pipeline

### P1（重要但非必要）
- [ ] 字幕顯示層可個別開關（例如只看中文、只看日文+ruby）
- [ ] 手動微調字幕時間軸偏移
- [ ] 匯出字幕為標準 SRT（供其他播放器使用，僅含單層文字）

### P2（未來考慮，先不做但架構不擋路）
- [ ] 即時字幕（邊看邊生成，非本階段目標）
- [ ] 支援其他來源語言（韓文、英文等）
- [ ] Tauri 打包成獨立 App
- [ ] Spotify 播放狀態顯示面板

---

## 7. 開放問題（Open Questions）

- Whisper 模型大小如何選？（medium/large 準確度較高但本機跑速度慢，需實測日文辨識效果）
- LLM 翻譯要用哪個 API？（會影響翻譯品質、成本、是否需要處理口語/俚語）
- MeCab vs Sudachi：Sudachi 對現代日文分詞通常較準，但套件安裝/維護成本要評估
- yt-dlp 下載的字幕（如果影片本身有官方 CC）要不要也保留一份做比對校正？

---

## 8. 分階段規劃

**Phase 1**：Rust 後端能下載 YouTube 影片並在網頁播放（不含字幕）
**Phase 2**：串起 Python AI pipeline，跑通「日文語音 → 三層字幕 JSON」全流程（單支測試影片）
**Phase 3**：前端 ruby 疊字幕顯示 + 時間軸同步
**Phase 4**：快取、手動校正字幕時間軸等體驗優化
