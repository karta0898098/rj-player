// REST + WebSocket helpers for the Rust backend (dsd.md §3.1 / §3.2).
// All calls use same-origin relative paths — the Vite dev server proxy
// (vite.config.js) forwards /api and /media to http://127.0.0.1:8080.

async function parseErrorMessage(res) {
  try {
    const body = await res.json();
    return body?.error?.message || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

/** POST /api/videos — dsd.md §3.1. */
export async function createVideo(url) {
  const res = await fetch('/api/videos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, auto_pipeline: true }),
  });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res));
  }
  return res.json();
}

/** GET /api/videos/:id — dsd.md §3.1. */
export async function getVideo(id) {
  const res = await fetch(`/api/videos/${id}`);
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res));
  }
  return res.json();
}

/** WS URL for GET /api/videos/:id/events (dsd.md §3.2). */
export function videoEventsUrl(id) {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/api/videos/${id}/events`;
}

/** <video src> for GET /media/:id/video (Range-served mp4, dsd.md §3.1). */
export function mediaUrl(id) {
  return `/media/${id}/video`;
}

/**
 * POST /api/videos/:id/pipeline {force:true, ...settings} — dsd.md §3.1,
 * re-runs the whole subtitle pipeline from scratch (used by the "重新產生
 * 字幕" button). `settings` carries the Whisper/VAD/prompt knobs from the
 * "進階：字幕產生設定" section (already snake_case — see
 * buildGenerationSettingsPayload in utils.js — so this stays a thin,
 * shape-agnostic passthrough plus `force`). All fields are optional; the
 * backend falls back to its own config/defaults for anything omitted.
 * Progress/completion is reported over the existing WS events endpoint, not
 * in this response.
 */
export async function regeneratePipeline(id, settings = {}) {
  const res = await fetch(`/api/videos/${id}/pipeline`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ force: true, ...settings }),
  });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res));
  }
  return res.json();
}

/**
 * GET /api/videos/:id/subtitles — the canonical SubtitleDoc (dsd.md §3.1,
 * §5.1). Throws (with the backend's error message) on any non-2xx,
 * including the `409 { status }` the backend returns while the pipeline
 * hasn't reached `ready` yet — callers should only call this once they know
 * (via GET /api/videos/:id or a WS `done`/status event) that status is
 * `ready`.
 */
export async function getSubtitles(id) {
  const res = await fetch(`/api/videos/${id}/subtitles`);
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res));
  }
  return res.json();
}
