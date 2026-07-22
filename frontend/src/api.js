// REST + WebSocket helpers for the Rust backend (dsd.md §3.1 / §3.2).
// All calls use same-origin relative paths — the Vite dev server proxy
// (vite.config.js) forwards /api and /media to http://127.0.0.1:8080.

import { buildGenerationSettingsPayload } from './utils.js';

async function parseErrorMessage(res) {
  try {
    const body = await res.json();
    return body?.error?.message || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

/**
 * POST /api/videos — dsd.md §3.1, extended by the queue feature to carry
 * per-item generation options + the music-MV flag chosen in the add-to-queue
 * form. `options` is the same camelCase settings shape used by
 * regeneratePipeline (see buildGenerationSettingsPayload in utils.js) so
 * there's one shaping function for both call sites; `isMusicVideo` defaults
 * to false. Omitting `options` entirely still works — every field is
 * optional backend-side and falls back to config/asr.py defaults.
 */
export async function createVideo(url, options = {}, isMusicVideo = false) {
  const res = await fetch('/api/videos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url,
      auto_pipeline: true,
      is_music_video: isMusicVideo,
      ...buildGenerationSettingsPayload(options),
    }),
  });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res));
  }
  return res.json();
}

/**
 * POST /api/videos/preview — metadata-only lookup (title/channel/duration/
 * is_music) for a URL, with no side effects on the backend (no job
 * enqueued, nothing persisted). Used by the add-to-queue form to show the
 * auto-detected music-MV flag as the user pastes a URL, before they commit
 * to queuing it. Safe to call repeatedly on a debounce.
 */
export async function previewVideo(url) {
  const res = await fetch('/api/videos/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
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

/**
 * GET /api/videos — the video library listing, doubling as the queue list
 * (the queue feature derives pending/processing/recent buckets from this
 * same call rather than a separate endpoint — see QueueList.jsx).
 */
export async function listVideos() {
  const res = await fetch('/api/videos');
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res));
  }
  return res.json();
}

/**
 * POST /api/videos/:id/cancel — cancel a video that's still queued (not
 * yet picked up by the worker). 400s for any other status.
 */
export async function cancelQueueItem(id) {
  const res = await fetch(`/api/videos/${id}/cancel`, { method: 'POST' });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res));
  }
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
 * POST /api/videos/:id/retranslate — re-runs ONLY the translate stage
 * against the video's existing subtitles.json (no ASR). Used by "只重新翻譯"
 * to recover from a stuck/degraded translation (e.g. an LLM provider
 * blocking output on song lyrics) without redoing the slow/expensive
 * Whisper pass. 400s if there's no existing subtitles.json yet — the full
 * pipeline needs to have run at least once first. Progress/completion is
 * reported over the existing WS events endpoint, not in this response.
 */
export async function retranslateSubtitles(id) {
  const res = await fetch(`/api/videos/${id}/retranslate`, { method: 'POST' });
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

/**
 * PUT /api/videos/:id/subtitles/cues/:cueId — persist an in-place manual edit
 * to one cue's text. `patch` is `{ ja_text?, zh_text? }`; only the field being
 * edited is sent. Editing ja_text clears that cue's furigana/romaji
 * server-side (they'd be stale). Returns the updated Cue so the caller can
 * refresh in place without a full refetch.
 */
export async function patchCue(id, cueId, patch) {
  const res = await fetch(`/api/videos/${id}/subtitles/cues/${cueId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res));
  }
  return res.json();
}
