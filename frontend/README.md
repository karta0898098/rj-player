# frontend — YouTube 字幕播放器 (Phase 1)

Vite + React SPA implementing the **Phase 1 batch B1.6** scope from
`../dsd.md` §11: full macOS-window visual shell (from
`../design_handoff_youtube_subtitle_player/`), real `<video>` playback, and
the download flow (`POST /api/videos` → WebSocket progress → play). No
subtitle sync yet — that's Phase 3; see `src/components/SubtitleOverlay.jsx`
for the stubbed seam.

## Requirements

- Node **18.13.0** (or any Node 18/20+). Vite is pinned to `^5` and React to
  `^18` specifically because Vite 7 requires Node 20+ and this machine runs
  Node 18.

## Run it

```bash
npm install
npm run dev      # starts the Vite dev server on http://localhost:5173
```

The app expects the Rust backend to be running on **`http://127.0.0.1:8080`**
(see `../backend`). Start the backend first (or in parallel); the frontend
alone will load and show the shell, but 「載入」submissions will fail until
the backend is reachable.

```bash
npm run build     # production build to dist/
npm run preview   # serve the production build locally
```

## Proxy setup

`vite.config.js` proxies same-origin so the app never needs CORS:

- `/api/**` → `http://127.0.0.1:8080` (REST + the `/api/videos/:id/events`
  WebSocket, via `ws: true`)
- `/media/**` → `http://127.0.0.1:8080` (the Range-served `<video src>`)

The app code only ever calls relative paths (`fetch('/api/...')`,
`<video src="/media/:id/video">`, `ws://<host>/api/videos/:id/events`) — see
`src/api.js`. To point at a different backend host/port, edit the proxy
`target` values in `vite.config.js`.

## Download + playback flow

1. Titlebar 「載入」submits the URL pill → `POST /api/videos { url,
   auto_pipeline: true }` → `{ video_id, status }`.
2. If `status` is already `downloaded`/`ready` (cache hit), skip straight to
   step 4.
3. Otherwise open `GET /api/videos/:id/events` (WebSocket) and show the
   download progress bar driven by `{"type":"progress","stage":"download",
   "pct":N}` events, until a `{"type":"done","status":"downloaded"}` (or
   `"ready"`) or `{"type":"error",...}` message arrives.
4. On success, `GET /api/videos/:id` fills in the title/channel info row,
   and `<video src="/media/:id/video">` is set, enabling playback.

## Structure

```
src/
  App.jsx                 top-level state + wiring (load flow, playback, theming)
  api.js                  REST/WS helpers (relative paths only)
  theme.js                design tokens (light/dark), from the handoff README
  utils.js                time formatting, pipeline-stage labels
  components/
    Titlebar.jsx           traffic lights, dark toggle, URL pill, 載入 button
    VideoInfo.jsx           title + channel row (hidden in theater mode)
    VideoStage.jsx          16:9 video area: <video>, download/error overlay, play button
    SubtitleOverlay.jsx     Phase 3 seam — empty 3-layer structure, no cue data
    ProgressTrack.jsx       custom scrub bar (pointer-capture drag + hover tooltip)
    ControlBar.jsx          play/pause, time, volume, 日/中/拼 chips, theater, gear
    SettingsPopover.jsx     liquid-glass popover: speed, font scale, JP color
    MacTrafficLights.jsx    macOS traffic-light dots
```
