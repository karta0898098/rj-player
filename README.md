# rj-player

A personal macOS video player that downloads YouTube videos and generates **three-layer Japanese subtitles** — Japanese (with furigana ruby) · romaji · Traditional-Chinese translation — precisely aligned to the audio.

Built because existing players (IINA, VLC) only overlay a single subtitle layer and have no built-in AI transcription/translation pipeline. Personal-use tool; not a packaged product.

> The design docs are in Traditional Chinese: [`spec.md`](spec.md) (規格書) and [`dsd.md`](dsd.md) (詳細設計). The frontend visual spec is under [`design_handoff_youtube_subtitle_player/`](design_handoff_youtube_subtitle_player/).

## What it does

- Paste a YouTube URL → `yt-dlp` downloads the video + audio locally.
- Generate the Japanese subtitle text + timing from the **best available source** (precedence):
  1. **Reference lyrics** you paste → **forced alignment** (`stable-ts`): your exact text, precisely timed. Best for songs.
  2. **The video's official (manual) Japanese CC**, fetched at download time → used directly.
  3. **Whisper ASR** (`faster-whisper`) → free transcription (fallback; large-v3 by default).
- Then, on whatever Japanese text the above produced: tokenize + furigana (MeCab/fugashi) → romaji (pykakasi) → **translate to zh-TW** (Gemini / OpenAI / Anthropic, pluggable) → cache as `subtitles.json`.
- The web player overlays the three layers with `<ruby>` furigana, synced via `requestAnimationFrame`, with per-layer toggles, styling, a manual time-offset, and a **regenerate** button that exposes all the knobs above.

## Architecture

```
Frontend SPA (Vite + React)  ──HTTP/WS──▶  Rust backend (axum)  ──JSON lines (stdin/stdout)──▶  Python AI worker
  player · 3-layer overlay                  yt-dlp · Range serve                                  faster-whisper / stable-ts
  advanced generation settings              job queue · pipeline                                  fugashi · pykakasi · LLM translate
```

The Rust backend keeps business logic in `core/` with a thin `http/` adapter, so it can later become the core of a Tauri app without a rewrite (see `dsd.md` §10).

## Tech stack

| Part | Stack |
|---|---|
| Backend | Rust · axum · tokio · tower-http |
| AI worker | Python 3.12 · faster-whisper · stable-ts · fugashi(+unidic-lite) · pykakasi · google-genai / openai / anthropic |
| Frontend | Vite 5 · React 18 |
| External tools | `yt-dlp`, `ffmpeg` |

## Prerequisites

- **Rust** (1.89+), **Node 18+**, **Python 3.12**
- **`yt-dlp`** and **`ffmpeg`** on `PATH` (`brew install yt-dlp ffmpeg`)

## Setup

```bash
# 1. config — copy the template and add your LLM API key(s)
cp config.example.toml config.toml
#    then edit config.toml:  [llm] provider + the matching api key

# 2. Python AI worker venv
python3.12 -m venv ai/.venv
ai/.venv/bin/pip install -r ai/requirements.txt

# 3. frontend deps (dev.sh also does this on first run)
cd frontend && npm install && cd ..
```

> `config.toml` holds your API keys and is **gitignored** — never commit it. Everything is configurable there (model, provider, keys, paths); env vars override the file.

## Run

```bash
./dev.sh          # starts backend (:8080) + frontend (:5173); open http://127.0.0.1:5173
```

Ctrl-C stops both. See [`backend/README.md`](backend/README.md), [`ai/README.md`](ai/README.md), [`frontend/README.md`](frontend/README.md) for per-service details.

## Project layout

```
backend/     Rust axum service (download, media serve, pipeline orchestration, REST/WS)
ai/          Python AI worker (ASR / forced-align / CC → tokenize → romaji → translate)
frontend/    Vite + React player (three-layer subtitle overlay, controls, settings)
config.example.toml   config template (copy to config.toml, gitignored)
dev.sh       one-command launcher
spec.md · dsd.md      spec + detailed design (zh-TW)
```

## Notes

- ASR/alignment run on CPU (CTranslate2 has no Metal/CoreML acceleration on Apple Silicon), so `large-v3` transcription is slow; forced alignment and CC are much faster.
- Whisper models download to `~/.cache/huggingface` on first use.
- Subtitle translation needs a funded LLM key; without one, the pipeline still produces the Japanese + romaji layers and marks the Chinese layer as incomplete.
