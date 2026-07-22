export function formatTime(t) {
  if (!Number.isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Human labels for pipeline stages (dsd.md §3.2 `stage` value domain, used
// on `progress` events — fine-grained, carries a `pct`).
export const STAGE_LABELS = {
  download: '下載中',
  asr: '辨識中',
  tokenize: '分詞中',
  romaji: '注音中',
  translate: '翻譯中',
  assemble: '組裝中',
};

// Human labels for the coarser VideoStatus values (dsd.md §5.3, used on
// `status`/`done` events — no pct). Phase 3 (B3.4) falls back to these when
// no `progress` event for the current stage has arrived yet.
export const PIPELINE_STATUS_LABELS = {
  queued: '排隊中',
  downloading: '下載中',
  downloaded: '準備字幕中',
  transcribing: '辨識中',
  tokenizing: '分詞中',
  translating: '翻譯中',
  assembling: '組裝中',
  ready: '字幕就緒',
  pipeline_failed: '字幕處理失敗',
  download_failed: '下載失敗',
  cancelled: '已取消',
};

// dsd.md §5.3 `VideoStatus` values the AI pipeline can be in after a video
// has finished downloading (i.e. excludes the terminal `ready`/`*_failed`
// states) — used to decide whether the B3.4 "in progress" pill should show.
// `queued` (the queue feature) is included too: an item waiting for the
// single worker is just as much "in progress" as one actively downloading.
export const PIPELINE_ACTIVE_STATUSES = new Set([
  'queued',
  'downloading',
  'downloaded',
  'transcribing',
  'tokenizing',
  'translating',
  'assembling',
]);

// Unobtrusive "辨識中… (asr 70%)"-style label for the B3.4 pipeline-progress
// pill: prefers the fine-grained `stage`+`pct` from the latest `progress`
// event when available, else falls back to the coarser `status` label.
export function formatPipelineStatusLabel(status, stage, pct) {
  if (stage && STAGE_LABELS[stage]) {
    return pct != null ? `${STAGE_LABELS[stage]}… (${stage} ${pct}%)` : `${STAGE_LABELS[stage]}…`;
  }
  return `${PIPELINE_STATUS_LABELS[status] || '處理中'}…`;
}

// Whisper sometimes assigns a cue a very long end_ms that actually extends
// into trailing silence/non-speech audio (e.g. a cue spanning 44s-74s),
// keeping the subtitle pinned on screen far longer than the line itself
// needs. Lines rarely need more than ~8s on screen, so the overlay caps how
// long any single cue is *displayed* to start_ms + MAX_CUE_DISPLAY_MS,
// regardless of how far out its end_ms actually is — see SubtitleOverlay.jsx.
export const MAX_CUE_DISPLAY_MS = 8000;

// Binary-search `cues` (must already be sorted by start_ms) for the cue
// active at `timeMs`: the cue with `start_ms <= timeMs < end_ms` (dsd.md
// §6.2). Returns `null` when `timeMs` falls in a gap between cues, or
// before/after every cue — the overlay renders nothing in that case.
export function findActiveCue(cues, timeMs) {
  let lo = 0;
  let hi = cues.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const cue = cues[mid];
    if (timeMs < cue.start_ms) {
      hi = mid - 1;
    } else if (timeMs >= cue.end_ms) {
      lo = mid + 1;
    } else {
      return cue;
    }
  }
  return null;
}

// CJK ideograph ranges (common + extension-A + a couple of iteration marks)
// — used by the §4.2 ruby rule below.
const KANJI_RE = /[一-鿿㐀-䶿々〆〤]/;
export function hasKanji(s) {
  return KANJI_RE.test(s);
}

// dsd.md §4.2 tokens render rule: a token renders as <ruby>t<rt>reading</rt></ruby>
// only when it both has a `reading` AND its surface text `t` contains kanji;
// otherwise it's plain text.
export function isRubyToken(token) {
  return Boolean(token.reading) && hasKanji(token.t);
}

// ---- subtitle-generation settings (Whisper/VAD/prompt knobs) --------------
// The "進階：字幕產生設定" section in SettingsPopover lets the user override
// the Whisper model/temperature, VAD tuning, and an initial_prompt before
// hitting "重新產生字幕". Defaults below mirror the backend's own current
// defaults, so an untouched UI reproduces the exact same request as the
// SHARED CONTRACT the backend agent implements for
// POST /api/videos/:id/pipeline.
export const GENERATION_SETTINGS_DEFAULTS = {
  whisperModel: 'large-v3',
  whisperTemperature: 0,
  initialPrompt: '',
  referenceLyrics: '',
  vadEnabled: false,
  vadThreshold: 0.45,
  vadMinSilenceMs: 400,
  vadSpeechPadMs: 200,
  vadMaxSpeechS: 15,
};

// Applied on top of GENERATION_SETTINGS_DEFAULTS in the add-to-queue form
// when a video is auto-detected (or manually flagged) as a music MV: hints
// Whisper this is sung lyrics rather than speech, and loosens two VAD knobs
// since sung phrases have longer natural pauses and often run longer before
// a break than a spoken sentence. threshold/speech_pad are left unchanged --
// no evidence a different value helps for either case.
export const MUSIC_GENERATION_PRESET = {
  initialPrompt: 'これは音楽ビデオです。日本語の歌詞をできるだけ正確に書き起こしてください。',
  vadMinSilenceMs: 500,
  vadMaxSpeechS: 20,
};

const GENERATION_SETTINGS_STORAGE_KEY = 'rj-player.generationSettings';

// Loads persisted generation settings from localStorage. Tolerant of a
// missing key, corrupt/non-JSON value, a non-object value, or a partially
// shaped object (e.g. saved by an older app version with fewer fields) —
// always returns a fully-populated object by filling gaps from
// GENERATION_SETTINGS_DEFAULTS, and never throws.
export function loadGenerationSettings() {
  try {
    const raw = localStorage.getItem(GENERATION_SETTINGS_STORAGE_KEY);
    if (!raw) return { ...GENERATION_SETTINGS_DEFAULTS };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ...GENERATION_SETTINGS_DEFAULTS };
    }
    return { ...GENERATION_SETTINGS_DEFAULTS, ...parsed };
  } catch {
    return { ...GENERATION_SETTINGS_DEFAULTS };
  }
}

// Persists generation settings to localStorage. Best-effort: swallows
// failures (private browsing, quota exceeded, localStorage unavailable)
// since losing this convenience shouldn't break the app.
export function saveGenerationSettings(settings) {
  try {
    localStorage.setItem(GENERATION_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // ignore — storage unavailable or full
  }
}

// Maps the camelCase UI state onto the exact snake_case request-body shape
// the backend's POST /api/videos/:id/pipeline endpoint expects (see
// regeneratePipeline in api.js), e.g. { whisperModel: 'medium', ... } ->
// { whisper_model: 'medium', ... }. Deliberately excludes `force` (added by
// the caller) and has no dependency on React/DOM, so it's testable
// standalone with plain Node.
export function buildGenerationSettingsPayload(settings) {
  return {
    whisper_model: settings.whisperModel,
    whisper_temperature: settings.whisperTemperature,
    initial_prompt: settings.initialPrompt,
    reference_lyrics: settings.referenceLyrics,
    vad: {
      enabled: settings.vadEnabled,
      threshold: settings.vadThreshold,
      min_silence_duration_ms: settings.vadMinSilenceMs,
      speech_pad_ms: settings.vadSpeechPadMs,
      max_speech_duration_s: settings.vadMaxSpeechS,
    },
  };
}

// ---- playlist (queue-feature add-on) --------------------------------------
// Ordered list of video_ids the user has added via "加入佇列", independent of
// each video's processing status -- lets you browse/reorder/switch between
// everything you've queued this way, unlike the transient Queue strip which
// only shows items still in flight. Persisted to localStorage (same pattern
// as generation settings) so manual reordering survives a reload; tolerant
// of a missing/corrupt value the same way loadGenerationSettings is.
const PLAYLIST_STORAGE_KEY = 'rj-player.playlist';

export function loadPlaylist() {
  try {
    const raw = localStorage.getItem(PLAYLIST_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export function savePlaylist(videoIds) {
  try {
    localStorage.setItem(PLAYLIST_STORAGE_KEY, JSON.stringify(videoIds));
  } catch {
    // ignore — storage unavailable or full
  }
}

// ---- resume playback position (queue-feature add-on) ----------------------
// Per-video "where you left off" in seconds, so reopening a video seeks back
// there. Object map { video_id: seconds }, localStorage, same tolerant
// pattern as loadGenerationSettings. Single-machine personal tool, so
// localStorage (not the backend) is the right home.
const RESUME_POSITIONS_STORAGE_KEY = 'rj-player.resumePositions';
// Companion map { video_id: epochMs } stamped whenever a resume position is
// saved, so the video library can sort by "most recently watched" and show a
// "繼續看" affordance. Kept as a sibling map (not folded into the positions
// value) so the existing `{ video_id: seconds }` shape stays untouched for
// the resume-seek path in App.jsx.
const LAST_PLAYED_STORAGE_KEY = 'rj-player.lastPlayedAt';

export function loadResumePositions() {
  try {
    const raw = localStorage.getItem(RESUME_POSITIONS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function loadLastPlayedMap() {
  try {
    const raw = localStorage.getItem(LAST_PLAYED_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function saveResumePosition(videoId, seconds) {
  try {
    const all = loadResumePositions();
    all[videoId] = seconds;
    localStorage.setItem(RESUME_POSITIONS_STORAGE_KEY, JSON.stringify(all));
    const played = loadLastPlayedMap();
    played[videoId] = Date.now();
    localStorage.setItem(LAST_PLAYED_STORAGE_KEY, JSON.stringify(played));
  } catch {
    // ignore — storage unavailable or full
  }
}

export function clearResumePosition(videoId) {
  try {
    const all = loadResumePositions();
    if (videoId in all) {
      delete all[videoId];
      localStorage.setItem(RESUME_POSITIONS_STORAGE_KEY, JSON.stringify(all));
    }
    // Deliberately keep the lastPlayedAt stamp: "recently watched" should
    // survive finishing a video (which clears its resume position via
    // handleVideoEnded), so a just-finished video still sorts to the top.
  } catch {
    // ignore
  }
}

// ---- subtitle export (SRT / LRC / bilingual TXT) --------------------------
// `formatTime` above is only M:SS (playback UI), so these are separate,
// export-shaped timestamp formatters taking milliseconds (the unit on every
// cue's start_ms/end_ms).

// SRT timestamp: "HH:MM:SS,mmm".
export function msToSrtTime(ms) {
  const clamped = Math.max(0, Math.round(ms));
  const h = Math.floor(clamped / 3600000);
  const m = Math.floor((clamped % 3600000) / 60000);
  const s = Math.floor((clamped % 60000) / 1000);
  const millis = clamped % 1000;
  const p2 = (n) => String(n).padStart(2, '0');
  return `${p2(h)}:${p2(m)}:${p2(s)},${String(millis).padStart(3, '0')}`;
}

// LRC timestamp: "[mm:ss.xx]" (centiseconds), the lyric-file convention.
export function msToLrcTime(ms) {
  const clamped = Math.max(0, Math.round(ms));
  const m = Math.floor(clamped / 60000);
  const s = Math.floor((clamped % 60000) / 1000);
  const cs = Math.floor((clamped % 1000) / 10);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${p2(m)}:${p2(s)}.${p2(cs)}`;
}

// Build an SRT string. `layers` picks which text lines each cue emits, in
// order, e.g. ['ja'] or ['ja','zh']; a cue with no content for any requested
// layer is still emitted with whatever it has (SRT viewers tolerate it).
export function buildSrt(cues, { layers = ['ja', 'zh'] } = {}) {
  return cues
    .map((cue, i) => {
      const lines = [];
      for (const layer of layers) {
        if (layer === 'ja' && cue.source_text) lines.push(cue.source_text);
        else if (layer === 'zh' && cue.target_text) lines.push(cue.target_text);
        else if (layer === 'romaji' && cue.phonetic) lines.push(cue.phonetic);
      }
      return `${i + 1}\n${msToSrtTime(cue.start_ms)} --> ${msToSrtTime(cue.end_ms)}\n${lines.join('\n')}\n`;
    })
    .join('\n');
}

// Build an LRC string (one timestamped line per cue, single layer — LRC is a
// single-line-per-timestamp format). Default layer is 'ja' (the lyrics).
export function buildLrc(cues, { layer = 'ja' } = {}) {
  return cues
    .map((cue) => {
      const text = layer === 'zh' ? cue.target_text : layer === 'romaji' ? cue.phonetic : cue.source_text;
      return `[${msToLrcTime(cue.start_ms)}]${text || ''}`;
    })
    .join('\n');
}

// Build a plain-text bilingual transcript: each cue's ja line followed by its
// zh line (when present), cues separated by a blank line. No timestamps.
export function buildBilingualTxt(cues) {
  return cues
    .map((cue) => (cue.target_text ? `${cue.source_text}\n${cue.target_text}` : cue.source_text))
    .join('\n\n');
}

// Trigger a browser download of `text` as `filename`. Uses a Blob + object URL
// + a synthetic <a download> click, revoking the URL afterward. No such helper
// existed in the app before.
export function downloadTextFile(filename, text, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Make a video title safe for use as a download filename (strip path-hostile
// chars, collapse whitespace, cap length). Falls back to the video_id.
export function safeFilename(title, fallback) {
  const base = (title || fallback || 'subtitles').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
  return (base || fallback || 'subtitles').slice(0, 80);
}
