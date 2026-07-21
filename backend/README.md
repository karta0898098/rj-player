# rj-player backend (Phase 1 + 2)

Rust/axum HTTP service that downloads YouTube videos with `yt-dlp`, serves
them locally with HTTP Range support, and drives a three-layer (Japanese /
romaji / Chinese) subtitle pipeline through a persistent Python AI worker
subprocess. **Phase 1** (`dsd.md` §11) is download + local playback; **Phase
2** adds the subtitle pipeline wiring on the Rust side (RPC client +
orchestrator + endpoints) — the actual ASR/tokenize/translate Python
pipeline lives in a separate `ai/` service and is out of scope here.

## Requirements

- Rust (edition 2021 toolchain, tested with 1.89)
- [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) on `PATH` (or set `YT_DLP_PATH`)
- `ffmpeg` on `PATH` (or set `FFMPEG_PATH`) — used for the 16kHz mono
  `audio.wav` extraction that feeds the AI worker's ASR step
- A Python AI worker at `{AI_DIR}/.venv/bin/python {AI_DIR}/worker.py`
  (default `AI_DIR=../ai`, i.e. a sibling `ai/` directory) implementing the
  dsd.md §3.3 RPC protocol. Without one configured/working, downloads and
  playback still work fine — the pipeline step will fail per-video with
  `pipeline_failed` rather than affecting anything else.

## Run

```bash
cargo run
```

By default the server binds `127.0.0.1:8080` and stores data under
`./data` (relative to the process's current working directory).

## Configuration

Config comes from three layers, highest precedence first:

1. **Environment variables** — always win, so existing run scripts and
   one-off overrides (`WHISPER_MODEL=tiny cargo run`) keep working exactly
   as before.
2. **`config.toml`** — an optional file for setting things once instead of
   exporting env vars every run.
3. **Built-in defaults** — used for anything neither of the above sets.

### `config.toml`

Search path (first match wins):

1. `$RJ_CONFIG`, if that env var is set — used as an exact path; if it
   doesn't point at a real file, no config file is used at all (it does
   *not* fall through to 2/3 below).
2. `./config.toml` — the process's current working directory.
3. `../config.toml` — the repo root, since `cargo run` is normally run
   from `backend/`, one level below the repo root.

A missing file is fine (env vars/defaults are used as-is). A
present-but-malformed file logs a `WARN` and is ignored rather than
crashing the backend.

Copy [`../config.example.toml`](../config.example.toml) to
`../config.toml` (repo root) and fill in what you need — see that file for
every available key, well-commented. **`config.toml` is gitignored** (it's
where your LLM API keys live) — never commit it; only
`config.example.toml` is checked in.

| Var | TOML path | Default | Purpose |
|---|---|---|---|
| `PORT` | `port` | `8080` | HTTP port (always binds `127.0.0.1`) |
| `DATA_DIR` | `data_dir` | `./data` | Root directory for per-video folders |
| `YT_DLP_PATH` | `[tools] yt_dlp_path` | `yt-dlp` | Path/name of the yt-dlp binary |
| `FFMPEG_PATH` | `[tools] ffmpeg_path` | `ffmpeg` | Path/name of the ffmpeg binary (audio extraction) |
| `YT_DLP_FORMAT` | `[tools] yt_dlp_format` | H.264 ≤1080p selector | yt-dlp `-f` string. Default prefers avc1/AAC ≤1080p for universal `<video>` playback (Safari/WKWebView can't reliably decode AV1). Set to `bv*+ba/b` for best available quality. |
| `AI_DIR` | `[ai] ai_dir` | `../ai` | Base directory for the Python AI worker; `AI_PYTHON`/`AI_WORKER` default off of this (backend runs from `backend/`, so `../ai` is the sibling AI service dir) |
| `AI_PYTHON` | *(env-only)* | `{AI_DIR}/.venv/bin/python` | Python interpreter used to launch the AI worker. Overridable independently of `AI_DIR`; no `config.toml` equivalent because it derives from `ai_dir` by default. |
| `AI_WORKER` | *(env-only)* | `{AI_DIR}/worker.py` | AI worker entrypoint script, passed as the interpreter's sole argument. Overridable independently of `AI_DIR`; no `config.toml` equivalent, same reason as `AI_PYTHON`. |
| `WHISPER_MODEL` | `[ai] whisper_model` | `medium` | faster-whisper model size/name, passed through as `whisper_model` in the `generate_subtitles` RPC params. `medium` trades a bit of speed for meaningfully better accuracy than `small`; still much faster than `large-v3`. |
| `RUST_LOG` | *(env-only)* | `info,rj_player_backend=debug,tower_http=info` | `tracing` filter |

#### `[llm]` — translation provider settings

These are resolved the same way (env > `config.toml` > default/unset) and
then **injected into the AI worker subprocess's environment** by the
backend when it spawns `{AI_PYTHON} {AI_WORKER}` (`core/pipeline/rpc.rs`),
since `ai/pipeline/translate.py` reads them from its own process env. Only
vars that resolved to a non-empty value are set on the child — anything
left unset is left to the worker's normal degradation behavior (missing
key/provider → skip translation, `translate_partial: true`, job still
succeeds).

| Var | TOML path | Purpose |
|---|---|---|
| `LLM_PROVIDER` | `[llm] provider` | Forces `gemini`\|`openai`\|`anthropic`. Unset → the worker auto-detects from whichever key below is present (gemini preferred). |
| `LLM_MODEL` | `[llm] model` | Overrides the provider's default model name. |
| `GEMINI_API_KEY` | `[llm] gemini_api_key` | Gemini API key. |
| `OPENAI_API_KEY` | `[llm] openai_api_key` | OpenAI API key. |
| `ANTHROPIC_API_KEY` | `[llm] anthropic_api_key` | Anthropic API key. |

With these set (via either env or `config.toml`), `cargo run` with no env
vars at all is enough to get working translation — e.g. put this in
`config.toml`:

```toml
[llm]
provider = "gemini"
gemini_api_key = "..."
```

Example (pure env-var style still works exactly as before):

```bash
PORT=9090 DATA_DIR=/tmp/rj-player-data RUST_LOG=debug cargo run
```

## Storage layout

```
<DATA_DIR>/videos/<video_id>/
  meta.json        # title, channel, duration_ms, status, last_stage, last_error, created_at
  video.mp4        # downloaded by yt-dlp
  audio.wav        # 16kHz mono, extracted via ffmpeg (feeds the AI worker's ASR step)
  subtitles.json   # canonical SubtitleDoc (dsd.md §5.1), written once the pipeline succeeds
```

`video_id` is the YouTube 11-character id and doubles as the cache key at
two levels: `POST /api/videos` short-circuits re-downloading once
`meta.json` reports `downloaded` (or later), and the subtitle pipeline
short-circuits re-running once `subtitles.json` exists with a `version`
matching the backend's current schema version (bypass either with
`force`/re-POSTing a new URL).

## Subtitle pipeline flow

1. `POST /api/videos` (with `auto_pipeline: true`, the default) or
   `POST /api/videos/:id/pipeline` enqueues work onto the single-worker job
   queue (`core/pipeline/queue.rs`) — the same queue used for downloads, so
   a download and a pipeline run for the same (or different) videos never
   overlap (dsd.md §8).
2. Once a video's `video.mp4`/`audio.wav` exist, `core/pipeline/orchestrator.rs`
   checks the cache (`subtitles.json` + matching `version` → skip). On a
   miss, it flips `meta.json`'s `status` to `transcribing` and calls
   `RpcClient::generate_subtitles` (`core/pipeline/rpc.rs`).
3. `RpcClient` lazily spawns `{AI_PYTHON} {AI_WORKER}` on first use and keeps
   it alive across jobs (so a loaded Whisper model stays warm). It writes one
   `{"id","method","params"}` JSON line to the worker's stdin and reads JSON
   event lines back from stdout, forwarding stderr to `tracing` under the
   `ai_worker` target.
4. Every `stage`/`progress` event the worker emits is mirrored onto the
   per-video `EventHub` as a WS event (see the `stage`→`VideoStatus` mapping
   below), so `GET /api/videos/:id/events` shows live pipeline progress.
5. On the worker's terminal `result` event, the canonical `SubtitleDoc` is
   written to `subtitles.json` and `status` becomes `ready`. On a terminal
   `error` event (or a worker crash/EOF/malformed output), `status` becomes
   `pipeline_failed` with `last_stage`/`last_error` recorded; a worker crash
   never takes the backend down — the next pipeline job simply respawns a
   fresh worker process (dsd.md §7).

`Stage` → `VideoStatus` mapping used for the WS `status` events during a
pipeline run (the status machine has no separate "romaji" state, so it folds
into `tokenizing`):

| Worker `stage` | `VideoStatus` |
|---|---|
| `asr` | `transcribing` |
| `tokenize`, `romaji` | `tokenizing` |
| `translate` | `translating` |
| `assemble` | `assembling` |

## API

### `GET /health`

```bash
curl -s http://127.0.0.1:8080/health
# {"status":"ok"}
```

### `POST /api/videos` — start a download

```bash
curl -s -X POST http://127.0.0.1:8080/api/videos \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://www.youtube.com/watch?v=jNQXAC9IVRw","auto_pipeline":true}'
# 202 {"video_id":"jNQXAC9IVRw","status":"downloading"}
# or, if already cached:
# 200 {"video_id":"jNQXAC9IVRw","status":"ready"}
```

Downloads (and, when `auto_pipeline` is true, the subtitle pipeline that
follows) run serially on a single background worker (a bounded `tokio::mpsc`
queue with one consumer task) so concurrent playback/API requests are never
blocked, and Whisper never has to compete with itself or a concurrent
download for CPU/RAM. With `auto_pipeline: true` (the default), the queue
chains straight from a successful download into `generate_subtitles` for the
same video — see [Subtitle pipeline flow](#subtitle-pipeline-flow).

### `GET /api/videos` — library listing

```bash
curl -s http://127.0.0.1:8080/api/videos
# [{"video_id":"...","title":"...","channel":"...","status":"downloaded","duration_ms":19000}]
```

### `GET /api/videos/:id` — full metadata

```bash
curl -s http://127.0.0.1:8080/api/videos/jNQXAC9IVRw
```

### `GET /api/videos/:id/subtitles` — canonical three-layer subtitle doc

```bash
curl -s http://127.0.0.1:8080/api/videos/jNQXAC9IVRw/subtitles
# 200 { "version":1, "video_id":"...", "language_source":"ja", "target_lang":"zh-TW",
#       "duration_ms":..., "cues":[ { "id":0, "start_ms":..., "end_ms":...,
#       "ja_text":"...", "ja_tokens":[{"t":"...","reading":"..."}, ...],
#       "romaji":"...", "zh_text":"..." }, ... ] }
```

`409 { "error": { "code": "not_ready", ... } }` if the video's `status` isn't
`ready` yet (still downloading/transcribing/etc., or `pipeline_failed`).

### `POST /api/videos/:id/pipeline` — (re-)run the subtitle pipeline

```bash
curl -s -X POST http://127.0.0.1:8080/api/videos/jNQXAC9IVRw/pipeline \
  -H 'Content-Type: application/json' -d '{"force":false}'
# 202 {"status":"transcribing"}
```

`force:false` (default; an empty/absent body is also accepted) respects the
`subtitles.json` cache — if it already exists with a matching schema
`version`, the pipeline is skipped and the video is left/marked `ready`
immediately. `force:true` bypasses the cache and always re-runs. `400` if
`video.mp4` hasn't finished downloading yet.

### `GET /media/:id/video` — Range-enabled playback

```bash
curl -s -D - -o /dev/null -H "Range: bytes=0-1023" \
  http://127.0.0.1:8080/media/jNQXAC9IVRw/video
# HTTP/1.1 206 Partial Content
# accept-ranges: bytes
# content-type: video/mp4
# content-range: bytes 0-1023/<file-size>
```

Point a `<video src="http://127.0.0.1:8080/media/<id>/video">` at this and
seeking will work out of the box.

### `GET /api/videos/:id/events` — WebSocket progress feed

Tagged-JSON events pushed while a download and/or pipeline job runs (dsd.md
§3.2):

```
{"type":"status","status":"downloading"}
{"type":"progress","stage":"download","pct":42}
{"type":"log","line":"[download]  42.0% of ..."}
{"type":"done","status":"downloaded"}
{"type":"error","stage":"download","message":"..."}

{"type":"status","status":"transcribing"}
{"type":"progress","stage":"asr","pct":70}
{"type":"status","status":"tokenizing"}
{"type":"status","status":"translating"}
{"type":"status","status":"assembling"}
{"type":"done","status":"ready"}
{"type":"error","stage":"translate","message":"..."}
```

On connect the server immediately sends a `status` snapshot of the video's
current state (from `meta.json`) before streaming further events, so a
client that connects slightly late still sees something right away.

Example with `websocat` (or any WS client):

```bash
websocat "ws://127.0.0.1:8080/api/videos/jNQXAC9IVRw/events"
```

## Errors

All non-2xx JSON responses use the shape:

```json
{ "error": { "code": "download_failed", "message": "..." } }
```

## CORS

A permissive CORS layer is enabled so a Vite dev server on a different
origin/port can call the API directly during local development.

## Testing

```bash
cargo test
```

`tests/fixtures/stub_worker.py` is a throwaway stand-in AI worker (plain
`python3`, stdlib only) that speaks the real dsd.md §3.3 wire protocol —
`ping` -> `pong`, `generate_subtitles` -> a couple of `stage`/`progress`
events then a `result` with one canned cue — plus two failure modes
(`crash_before_reply`, `malformed`) selected via argv, used by
`core/pipeline/rpc.rs`'s and `core/pipeline/orchestrator.rs`'s `#[tokio::test]`
suites to exercise the RPC client and orchestrator (including worker-crash
isolation) without needing the real Python pipeline. It is not part of the
Phase 2 AI service.

You can also drive it manually against the real HTTP server:

```bash
AI_PYTHON=python3 AI_WORKER=$PWD/tests/fixtures/stub_worker.py \
DATA_DIR=/tmp/rj-player-manual-test PORT=18099 cargo run &

# seed a fake "downloaded" video (skip the real yt-dlp download)
mkdir -p /tmp/rj-player-manual-test/videos/testvid001
echo fake > /tmp/rj-player-manual-test/videos/testvid001/video.mp4
echo fake > /tmp/rj-player-manual-test/videos/testvid001/audio.wav
cat > /tmp/rj-player-manual-test/videos/testvid001/meta.json <<'EOF'
{"video_id":"testvid001","source_url":"https://youtu.be/testvid001","title":"t",
 "channel":"c","duration_ms":1000,"status":"downloaded","last_stage":null,
 "last_error":null,"created_at":"2026-01-01T00:00:00Z"}
EOF

curl -X POST localhost:18099/api/videos/testvid001/pipeline -d '{"force":true}'
curl localhost:18099/api/videos/testvid001/subtitles
```
