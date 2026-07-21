# ai/ — Python AI service (Phase 2)

Persistent worker that turns a Japanese audio track into the canonical
three-layer `SubtitleDoc` (Japanese + ruby readings, romaji, Chinese
translation). Implements the RPC contract in `dsd.md` §3.3 and the pipeline
design in `dsd.md` §4. This directory is Python-only; the Rust RPC client
(`backend/src/core/pipeline/rpc.rs`) is owned separately.

## Setup

```bash
cd ai
python3.12 -m venv .venv        # already created in this repo
.venv/bin/pip install -r requirements.txt
```

Verify the four top-level deps import:

```bash
ai/.venv/bin/python -c "import faster_whisper, fugashi, pykakasi, anthropic"
```

## Running

The worker is a persistent process: one JSON request per line on **stdin**,
one JSON event per line on **stdout**. **stderr** is for human logs only —
never mix logs into stdout.

```bash
echo '{"id":"1","method":"ping"}' | ai/.venv/bin/python ai/worker.py
```

Standalone self-test (no Rust side needed) — runs one `generate_subtitles`
synchronously against a local audio file and prints the resulting doc plus
a pass/fail summary to stderr:

```bash
ai/.venv/bin/python ai/worker.py --selftest /path/to/clip.wav
```

## RPC protocol (dsd.md §3.3)

Request (one line of JSON on stdin):

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

Event stream (stdout; the same `id` may appear on multiple lines, always
ending in exactly one `result` or `error`):

```jsonc
{ "id":"req-…", "event":"stage",    "stage":"asr",       "status":"start" }
{ "id":"req-…", "event":"progress", "stage":"asr",       "pct":30 }
{ "id":"req-…", "event":"stage",    "stage":"asr",       "status":"done" }
{ "id":"req-…", "event":"stage",    "stage":"tokenize",  "status":"start" }
{ "id":"req-…", "event":"progress", "stage":"tokenize",  "pct":100 }
{ "id":"req-…", "event":"stage",    "stage":"tokenize",  "status":"done" }
{ "id":"req-…", "event":"stage",    "stage":"romaji",    "status":"start" }
{ "id":"req-…", "event":"stage",    "stage":"romaji",    "status":"done" }
{ "id":"req-…", "event":"stage",    "stage":"translate", "status":"start" }
{ "id":"req-…", "event":"progress", "stage":"translate", "pct":100 }
{ "id":"req-…", "event":"stage",    "stage":"translate", "status":"done" }
{ "id":"req-…", "event":"stage",    "stage":"assemble",  "status":"start" }
{ "id":"req-…", "event":"stage",    "stage":"assemble",  "status":"done" }
{ "id":"req-…", "event":"result",   "subtitles": { /* canonical SubtitleDoc, dsd.md §5.1 */ } }
```

or, on a fatal (non-translation) failure:

```jsonc
{ "id":"req-…", "event":"error", "stage":"asr", "message":"…", "partial": { /* optional: whatever segments/tokens/romaji completed before the failure */ } }
```

Other methods:
- `ping` → `{"id":..,"event":"result","pong":true}`, immediately, without
  touching the Whisper model (it's lazy-loaded only inside
  `generate_subtitles`, so `ping` stays fast and cheap for health checks).
- `shutdown` → `{"id":..,"event":"result","ok":true}`, then the worker
  exits its stdin loop and the process ends cleanly.

## Translation graceful degradation (dsd.md §7)

Translation is abstracted behind `pipeline.translate.Translator`
(`translate_batch(texts, target_lang) -> list[str]`), so the LLM provider
can be swapped without touching the rest of the pipeline. The only
implementation today is `AnthropicTranslator` (Anthropic Claude via the
`anthropic` SDK).

If `ANTHROPIC_API_KEY` is unset, or the API keeps failing after retries
(3 attempts, exponential backoff: 1s/2s/4s), the job is **not** failed:
the affected cues get `zh_text: null`, a warning is logged to stderr, and
the worker still emits a valid `result`. When this happens for a job that
requested translation, the assembled doc gets an additive
`"translate_partial": true` field (per dsd.md §7's "doc 仍落地並標
translate_partial") — omitted entirely when translation wasn't requested
or fully succeeded, so it never changes the "happy path" doc shape.

Translation is batched (default 15 segments per LLM call) with explicit
index mapping back onto cues, so a failure in one batch degrades only that
batch's cues, not the whole job.

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `LLM_PROVIDER` | auto | `gemini` or `anthropic`. If unset, auto-detects: Gemini when `GEMINI_API_KEY` is present, else Anthropic when `ANTHROPIC_API_KEY` is present, else degrade. |
| `GEMINI_API_KEY` | – (unset ⇒ degrade) | Google Gemini API key (google-genai SDK). Never commit this. |
| `ANTHROPIC_API_KEY` | – (unset ⇒ degrade) | Anthropic Claude API key. Never commit this. |
| `LLM_MODEL` | per-provider | Overrides the model. Provider defaults: Gemini `gemini-flash-lite-latest`, Anthropic `claude-sonnet-5`. |
| `WHISPER_MODEL` | `small` | Default faster-whisper model size when a request doesn't specify `whisper_model`. `small` is a speed-first default to validate the pipeline quickly; `large-v3` gives noticeably better Japanese ASR accuracy at the cost of speed (spec.md §7 open question) — set this once accuracy needs outweigh iteration speed. |

> **Free-tier quota note (Gemini):** the free tier caps requests-per-day per model (e.g. ~20/day). Batches default to 40 lines/request to keep whole videos within a handful of calls; if you hit `429 RESOURCE_EXHAUSTED`, either switch `LLM_MODEL` to another flash-lite model (separate quota bucket), enable billing on the API project, or wait for the daily reset. Cues that can't be translated degrade to `zh_text: null` (the job still completes and marks `translate_partial: true`).

`whisper_model` and `target_lang` can also be set per-request via RPC
`params`, which take precedence over the environment defaults above.

## Notes / implementation details worth knowing

- **Whisper**: `device="cpu", compute_type="int8"` (no CUDA on Apple
  Silicon). The model is cached per size for the life of the worker
  process; the first transcription with a given size downloads it from
  HuggingFace (~500MB for `small`).
- **Tokenize**: `fugashi` + `unidic-lite` (self-contained, no external
  MeCab/dictionary install). Every token's surface is emitted, so
  concatenating `ja_tokens[].t` always reproduces `ja_text` exactly — this
  is asserted in code (`pipeline/tokenizer.py` raises if violated) and
  exercised by `--selftest`. `reading` is attached only when a token's
  surface contains at least one kanji character, converted from unidic's
  katakana reading to hiragana.
- **Romaji**: built from the same `ja_tokens` (not the raw sentence)
  rather than calling `pykakasi.convert()` on the whole sentence directly.
  Reason: pykakasi has a built-in idiom dictionary that hijacks common
  substrings — e.g. it converts the leading "今日は" in
  "今日は良い天気ですね" to the greeting "konnichiha" instead of the
  contextually-correct "kyou wa", regardless of what follows. Deriving
  romaji token-by-token from the already-correct kanji readings avoids
  that failure mode and keeps romaji consistent with what the ruby
  overlay shows.
- **Tokenizer/Translator abstractions** (dsd.md §4.3): `pipeline/tokenizer.py`
  exposes a `Tokenizer` protocol (only `FugashiTokenizer` implemented so
  far; a SudachiPy implementation can be added later without touching the
  pipeline). `pipeline/translate.py` exposes the `Translator` ABC the same
  way.
