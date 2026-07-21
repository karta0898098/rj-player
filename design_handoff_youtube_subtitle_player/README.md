# Handoff: macOS YouTube 多層字幕播放器

## Overview
一個 macOS 原生桌面 App 的主播放畫面原型：內嵌播放 YouTube 影片，並為日文影片顯示三層字幕（日文原文／中文翻譯／羅馬拼音），支援逐層開關、字幕樣式自訂、深色模式與劇院模式。Spotify／音樂整合本輪不做（YouTube 內容平台 DRM 限制，音訊無法接入自製播放器，僅能做播放狀態顯示/控制，暫緩）。

## About the Design Files
本資料夾內的 `.dc.html` 檔案是**設計參考原型**（用 HTML/React 風格語法快速原型化的工具產出），並非要直接複製進產品程式碼。請將它理解為視覺與互動規格，在目標專案既有的技術環境中重新實作——這是一個 **macOS 原生桌面 App**，建議用 SwiftUI（或既有專案已採用的框架，例如 Electron/Tauri + Web 前端）重建，並用系統原生的 WKWebView／AVPlayer 或 YouTube iframe/Player API 承載實際影片播放，而非直接嵌入這份 HTML。

## Fidelity
**High-fidelity（高保真）**。顏色、字級、間距、互動行為均已定案，開發時應盡量還原；若目標平台是 SwiftUI 原生介面，色值/字重/圓角等數值應對應轉換為原生元件參數。

## Screens / Views
本原型僅一個畫面：**主播放畫面**。

### 版面結構（由上到下）
1. **標題列 (Titlebar)**：高度自適應，`padding: 12px 16px`，底部 1px 分隔線。左側為 macOS 紅黃綠三顆交通燈（14px 圓點，間距 9px），接著 App 名稱「YouTube 字幕播放器」（13px, weight 700）。右側依序為：深色模式切換（文字「深色」+ 40×22px 藥丸開關）、YouTube 連結輸入框（灰底圓角 pill，寬 280px，內含 16×11px 紅色小圖示模擬 YouTube icon + 文字輸入）、紅色「載入」按鈕。
2. **影片資訊列**（劇院模式時隱藏）：`padding: 14px 20px 6px`。影片標題（18px, weight 700）；下方一列含 32px 圓形頻道頭像（顯示頻道名首字）+ 頻道名稱（13px, weight 600）。**注意：這是本機播放器，不需要「訂閱」按鈕或「觀看次數/發布日期」等 YouTube 社群互動資訊 —— 已在最新版本中移除，開發時不要加回。**
3. **影片播放區**：16:9 比例容器，`margin: 12px 20px 0`（劇院模式時 `12px 0 0`，且 border-radius 由 12px 變 0）。背景近黑 `#0b0b0c`。實作時這裡應替換為真正的 YouTube 播放元件（iframe Player API 或原生 WebView）。
   - **暫停時**顯示置中播放按鈕：64px 圓形半透明黑底 + 白色三角形。
   - **字幕疊層**：絕對定位於底部（`bottom: 22px`），置中對齊，三層由上到下、由大到小、由亮到暗：
     - 日文原文：`Noto Sans JP`, weight 700, 基準字級 30px（隨使用者字級滑桿縮放），顏色可由使用者在 4 個色板中選擇（白/暖黃/淺藍/淺綠），文字陰影 `0 2px 6px rgba(0,0,0,0.6)`。
     - 中文翻譯：`Noto Sans TC`, weight 500, 基準字級 19px，顏色 `rgba(255,255,255,0.82)`。
     - 羅馬拼音：系統字體斜體, weight 400, 基準字級 14px，顏色 `rgba(255,255,255,0.55)`，字距 0.3px。
   - 每層可透過控制列的「日/中/拼」三個切換鈕獨立顯示/隱藏。
4. **控制列**：`margin: 14px 20px 20px`。
   - **進度條**：6px 高圓角軌道，自訂（非原生 `<input type=range>`）以支援：拖曳 seek（pointer capture）、hover 時在軌道上方顯示浮動提示（顯示該時間點的日文字幕預覽文字 + 時間碼），播放頭為 12px 白色圓點。填充色為強調色（預設 `#e0453f`，可調整）。
   - **按鈕列**：播放/暫停圓形按鈕（34px，黑底白圖示）、時間標籤 `mm:ss / mm:ss`、靜音圖示 + 音量滑桿（原生 range，accent-color 為強調色）、字幕切換三顆藥丸鈕（日/中/拼，啟用時填強調色）、「劇院模式」按鈕（同樣藥丸樣式）、齒輪設定按鈕。
5. **設定彈出視窗**（點齒輪開啟，錨定右下角，230px 寬，使用毛玻璃背板）：
   - 播放速率：0.5x / 1x / 1.25x / 1.5x / 2x 分段按鈕（**已從主控制列移入此處**）。
   - 字幕字級大小：滑桿 0.7–1.6 倍。
   - 日文字幕顏色：4 個圓形色板（白/暖黃/淺藍/淺綠），選中狀態外框為強調色。
   - 底部小字說明字幕資料來源：「字幕來源：本地 Whisper 辨識＋翻譯 API（示範資料）」。

## Interactions & Behavior
- **播放/暫停**：點擊播放鈕或影片區中央的播放圖示切換；播放中每 100ms 依目前速率推進進度，抵達結尾自動暫停。
- **進度條拖曳**：`pointerdown` 開始拖曳並立即 seek；`pointermove` 中持續 seek 並更新 hover 字幕預覽；`pointerup`/`pointerleave` 結束。
- **字幕層開關**：三個獨立布林狀態（日/中/羅馬拼音），互不影響。
- **字幕樣式**：字級（乘數）、日文字幕顏色（4色板）即時套用到字幕疊層。
- **深色模式**：切換整個 App 外觀（視窗背景、文字色、面板底色、進度軌道底色等），影片播放區維持近黑不受影響。
- **劇院模式**：放大播放區、隱藏影片標題/頻道資訊列，視窗寬度由 1040px 增為 1280px。
- **YouTube 連結載入**：輸入框 + 「載入」按鈕，提交後模擬切換到下一支示範影片（真實實作應解析網址並呼叫 YouTube Player API 載入對應影片 ID）。

## State Management
需要的狀態變數：
- `isPlaying: boolean`
- `currentTime: number`（秒）／`duration: number`（真實實作應來自 YouTube Player 的實際時長，原型中為固定 138 秒示範值）
- `volume: number (0-100)`, `lastVolume`（供靜音還原）
- `speed: number`（0.5/1/1.25/1.5/2）
- `subJP / subCN / subRomaji: boolean`（三層字幕開關）
- `fontScale: number`（0.7–1.6）、`jpColor: string`（日文字幕顏色）
- `darkMode: boolean`
- `theaterMode: boolean`
- `urlInput: string`、`videoTitle`、`channelName`
- `showSettings: boolean`（設定彈窗開關）
- 字幕資料：一組 caption cue 陣列 `{ start, end, jp, cn, romaji }`，依 `currentTime` 查找目前應顯示的 cue。真實資料應來自本機 Whisper 語音辨識 + 翻譯 API 產生的時間軸字幕（原型中為手寫示範資料）。

## Design Tokens
- **強調色（可調）**：預設 `#e0453f`（近似 YouTube 紅，但為原創色值，非直接取用品牌色），也提供 `#3478f6` `#34a853` `#f5a623` 作為替代選項。
- **淺色模式**：視窗底色 `#ffffff`；主要文字 `rgba(0,0,0,0.88)`；次要文字 `rgba(0,0,0,0.55)`；三級文字 `rgba(0,0,0,0.45)`；面板/分段底色 `#f2f2f4`；分隔線 `rgba(0,0,0,0.08)`。
- **深色模式**：視窗底色 `#1e1e20`；主要文字 `rgba(255,255,255,0.92)`；次要文字 `rgba(255,255,255,0.6)`；三級文字 `rgba(255,255,255,0.4)`；面板底色 `rgba(255,255,255,0.1)`；分隔線 `rgba(255,255,255,0.08)`。
- **字級**：App UI 12–18px；字幕日文 30px 基準／中文 19px／羅馬拼音 14px（× fontScale）。
- **圓角**：視窗 20px；播放區 12px（劇院模式 0）；按鈕/藥丸 6–16px；毛玻璃面板 14px。
- **字型**：UI 用 `-apple-system, BlinkMacSystemFont, "SF Pro", "Helvetica Neue", sans-serif`；日文字幕 `Noto Sans JP`；中文字幕 `Noto Sans TC`。

## Assets
無外部圖片素材。播放區目前為 CSS 條紋佔位圖（`repeating-linear-gradient`），需替換為實際 YouTube 播放器畫面。macOS 交通燈與毛玻璃面板樣式取自專案內 `macos-window.jsx` 參考元件（純 CSS 實作，無外部依賴）。

## Files
- `YouTube 字幕播放器.dc.html` — 完整原型（含互動邏輯），可直接用瀏覽器開啟預覽。
- `macos-window.jsx` — macOS 視窗外觀元件參考（交通燈、毛玻璃面板樣式）。
