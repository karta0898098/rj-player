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
  downloading: '下載中',
  downloaded: '準備字幕中',
  transcribing: '辨識中',
  tokenizing: '分詞中',
  translating: '翻譯中',
  assembling: '組裝中',
  ready: '字幕就緒',
  pipeline_failed: '字幕處理失敗',
  download_failed: '下載失敗',
};

// dsd.md §5.3 `VideoStatus` values the AI pipeline can be in after a video
// has finished downloading (i.e. excludes the terminal `ready`/`*_failed`
// states) — used to decide whether the B3.4 "in progress" pill should show.
export const PIPELINE_ACTIVE_STATUSES = new Set([
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

// dsd.md §4.2 ja_tokens render rule: a token renders as <ruby>t<rt>reading</rt></ruby>
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
  whisperModel: 'medium',
  whisperTemperature: 0,
  initialPrompt: '',
  referenceLyrics: '',
  vadEnabled: true,
  vadThreshold: 0.45,
  vadMinSilenceMs: 400,
  vadSpeechPadMs: 200,
  vadMaxSpeechS: 15,
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
