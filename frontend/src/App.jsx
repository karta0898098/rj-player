import { useEffect, useRef, useState } from 'react';
import AmbientBackground from './components/AmbientBackground.jsx';
import Titlebar from './components/Titlebar.jsx';
import VideoInfo from './components/VideoInfo.jsx';
import VideoStage from './components/VideoStage.jsx';
import ControlBar from './components/ControlBar.jsx';
import SubtitleList from './components/SubtitleList.jsx';
import SidebarPanel from './components/SidebarPanel.jsx';
import PlaylistPanel from './components/PlaylistPanel.jsx';
import SettingsPopover from './components/SettingsPopover.jsx';
import AddToQueuePopover from './components/AddToQueuePopover.jsx';
import QueueList from './components/QueueList.jsx';
import LibraryView from './components/LibraryView.jsx';
import ConfirmDialog from './components/ConfirmDialog.jsx';
import SetupWizard from './components/SetupWizard.jsx';
import AppSettingsPanel from './components/AppSettingsPanel.jsx';
import { getTheme } from './theme.js';
import { isTauri, toggleWindowFullscreen, startDragging, toggleMaximizeWindow, saveTextFile } from './tauri.js';
import {
  formatTime,
  PIPELINE_ACTIVE_STATUSES,
  GENERATION_SETTINGS_DEFAULTS,
  musicPresetFor,
  loadGenerationSettings,
  saveGenerationSettings,
  buildGenerationSettingsPayload,
  loadPlaylist,
  savePlaylist,
  buildSrt,
  buildLrc,
  buildBilingualTxt,
  downloadTextFile,
  safeFilename,
  loadResumePositions,
  saveResumePosition,
  clearResumePosition,
} from './utils.js';
import {
  createVideo,
  getVideo,
  getSubtitles,
  videoEventsUrl,
  mediaUrl,
  regeneratePipeline,
  retranslateSubtitles as retranslateSubtitlesApi,
  previewVideo,
  listVideos,
  cancelQueueItem,
  deleteVideo,
  patchCue,
} from './api.js';

// ---- fullscreen helpers (module-level; guard for browsers without the
// unprefixed API — Safari historically only exposes the webkit-prefixed
// forms for arbitrary elements) --------------------------------------------
function currentFullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}
function requestFullscreenOn(el) {
  const fn = el.requestFullscreen || el.webkitRequestFullscreen;
  if (fn) fn.call(el);
}
function exitFullscreen() {
  const fn = document.exitFullscreen || document.webkitExitFullscreen;
  if (fn) fn.call(document);
}

export default function App() {
  // ---- appearance ---------------------------------------------------
  const [darkMode, setDarkMode] = useState(true); // dark by default
  const [theaterMode, setTheaterMode] = useState(false);
  const theme = getTheme(darkMode);


  // ---- load / download flow ------------------------------------------
  const [urlInput, setUrlInput] = useState('');
  const [videoId, setVideoId] = useState(null);
  const [videoTitle, setVideoTitle] = useState('');
  const [channelName, setChannelName] = useState('');
  const [videoSrc, setVideoSrc] = useState(null);
  // 'idle' | 'connecting' | 'downloading' | 'downloaded' | 'error'
  const [loadStatus, setLoadStatus] = useState('idle');
  const [downloadPct, setDownloadPct] = useState(null);
  const [stageLabel, setStageLabel] = useState(null);
  const [errorMessage, setErrorMessage] = useState(null);
  const wsRef = useRef(null);
  // true while a ws.close() call was initiated by us (done/error/reset) —
  // lets onclose tell an intentional close apart from a dropped connection.
  const expectCloseRef = useRef(true);

  // ---- playback ---------------------------------------------------
  const videoRef = useRef(null);
  // Throttle resume-position writes (onTimeUpdate fires ~4/s; we only need to
  // persist every couple of seconds). Millisecond timestamp of the last save.
  const lastResumeSaveRef = useRef(0);
  // VideoStage's outer 16:9 container (video + SubtitleOverlay) — the
  // fullscreen target (README change #4), so the ruby subtitle overlay is
  // included in fullscreen instead of just the bare <video>.
  const stageContainerRef = useRef(null);
  // Set (just before) advancing to the next playlist item on `ended` (see
  // handleVideoEnded); consumed by handleLoadedMetadata to decide whether to
  // skip the resume-position restore (an auto-advance always starts the next
  // track from the beginning, every other load resumes where you left off).
  // Deliberately NOT reset by resetPlaybackState/selectPlaylistItem -- it
  // must survive their state resets so it's still true when the new video's
  // `loadedmetadata` fires.
  const autoAdvanceRef = useRef(false);
  // Set just before any load that should auto-play once ready (auto-advance
  // AND a manual click from the library/playlist) and consumed by
  // handleCanPlay once the freshly-loaded video has buffered enough to
  // start. Separate from autoAdvanceRef because the two loads still differ
  // on resume-position handling above.
  const shouldAutoplayRef = useRef(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // First-run setup wizard (dsd.md §13.5) — desktop app only, until completed once.
  const [showWizard, setShowWizard] = useState(() => {
    try {
      // `?setup` forces it (re-run / testing); otherwise desktop-only, once.
      const forced = new URLSearchParams(window.location.search).has('setup');
      return forced || (isTauri() && !localStorage.getItem('rj_setup_done'));
    } catch {
      return false;
    }
  });
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  // Real width/height ratio of the loaded video's actual pixels, read from
  // <video>'s loadedmetadata event. Many source clips (TV broadcast rips,
  // pillarboxed uploads, etc.) aren't exactly 16:9 — forcing the stage box
  // to 16:9 regardless left a visible pillarbox gap between the video's
  // actual content and the box edge (doubling up with the sidebar gutter
  // into one big awkward blank strip). VideoStage sizes itself to this
  // instead so the box always matches the video exactly, no letterboxing.
  const [videoAspectRatio, setVideoAspectRatio] = useState(null);
  const [volume, setVolume] = useState(70);
  const lastVolumeRef = useRef(70);
  const [speed, setSpeed] = useState(1);

  // ---- subtitle layer toggles + style (B3.3 — wired to SubtitleOverlay) ----
  // On/off + appearance are independently adjustable per layer (size/color/
  // shadow) rather than one shared fontScale/jpColor for all three — see
  // SettingsPopover.jsx's "字幕樣式" section (SubtitleLayerPanel). `shadow`
  // is 0..1 intensity; phonetic defaults to 0 (no shadow) matching its
  // pre-existing look, source/target default to 0.6 matching their old fixed
  // values. Prop/state names are language-neutral (dsd.md §12.6/§12.7 B5.3:
  // the old JP/CN/Romaji-suffixed names became Source/Target/Phonetic) since
  // the source layer isn't always Japanese (e.g. an English video's source
  // is English) — content-gating (a language with no reading layer just
  // never populates `phonetic`) already made the underlying behavior
  // language-agnostic; this rename just makes the names match.
  const [subSource, setSubSource] = useState(true);
  const [subTarget, setSubTarget] = useState(true);
  const [subPhonetic, setSubPhonetic] = useState(true);
  const [sourceStyle, setSourceStyle] = useState({ scale: 1, color: '#ffffff', shadow: 0.6 });
  // Default colors match the pre-existing fixed values for target/phonetic
  // (dimmer than source by design) — not one of the swatch presets, so the
  // swatch row just shows no active selection until the user picks one.
  const [targetStyle, setTargetStyle] = useState({ scale: 1, color: 'rgba(255,255,255,0.82)', shadow: 0.6 });
  const [phoneticStyle, setPhoneticStyle] = useState({ scale: 1, color: 'rgba(255,255,255,0.55)', shadow: 0 });
  // Each SubtitleLayerPanel control (size/color/shadow) calls its layer's
  // onXxxStyleChange with just the one field that changed — these merge it
  // into the existing style object rather than requiring the caller to
  // spread the other two fields itself.
  function updateSourceStyle(partial) {
    setSourceStyle((s) => ({ ...s, ...partial }));
  }
  function updateTargetStyle(partial) {
    setTargetStyle((s) => ({ ...s, ...partial }));
  }
  function updatePhoneticStyle(partial) {
    setPhoneticStyle((s) => ({ ...s, ...partial }));
  }
  // manual subtitle time-offset ("字幕時間校正"), ms; positive = later/delayed
  // (see SubtitleOverlay.jsx for the direction derivation).
  const [subtitleOffsetMs, setSubtitleOffsetMs] = useState(0);
  // subtitle readability background ("字幕背景"), 0..1 opacity — 0 (default)
  // renders no box at all, exactly like before this control existed.
  const [subtitleBg, setSubtitleBg] = useState(0);

  // ---- subtitle data + AI pipeline progress (B3.1/B3.4) ---------------------
  const [cues, setCues] = useState([]);
  // 'idle' | 'failed' | 'ready' | one of PIPELINE_ACTIVE_STATUSES (dsd.md §5.3
  // VideoStatus values from 'downloading' through 'assembling')
  const [subtitleStatus, setSubtitleStatus] = useState('idle');
  const [subtitleStage, setSubtitleStage] = useState(null); // raw Stage, e.g. 'asr' — from `progress` events
  const [subtitlePct, setSubtitlePct] = useState(null);
  const [subtitleError, setSubtitleError] = useState(null);
  const [translatePartial, setTranslatePartial] = useState(false);
  // The loaded doc's `language_source` (dsd.md §12.5/§12.7 B5.3), captured
  // when subtitles are fetched (see loadSubtitles) — used for SettingsPopover's
  // source-layer label ('ja' -> 日文, 'en' -> 英文, fallback 原文). Distinct
  // from queueDraft.sourceLang (the add-to-queue form's pre-submission
  // choice for a NEW video) — this is the currently-loaded video's actual
  // stored language.
  const [docSourceLang, setDocSourceLang] = useState('ja');
  // The loaded doc's `source`/`target_source` provenance fields (dsd.md
  // §12.6 B5.5): 'cc' (manual CC) | 'align' (forced alignment) | 'asr'
  // (Whisper) for `docSource`; 'cc' (manual CC merged in) | 'llm' (machine-
  // translated) for `docTargetSource`. Both absent -> null. Captured
  // alongside docSourceLang in loadSubtitles; purely informational, shown as
  // a small badge in SubtitleList's export bar.
  const [docSource, setDocSource] = useState(null);
  const [docTargetSource, setDocTargetSource] = useState(null);

  // ---- subtitle-generation settings (Whisper/VAD/prompt knobs) ------------
  // Backs the "進階：字幕產生設定" section in SettingsPopover — sent to the
  // backend on "重新產生字幕" (see regenerateSubtitles below) and persisted
  // to localStorage (utils.js) so they survive reloads. Lazy useState
  // initializers mean loadGenerationSettings() only runs once, on mount.
  const [whisperModel, setWhisperModel] = useState(() => loadGenerationSettings().whisperModel);
  const [whisperTemperature, setWhisperTemperature] = useState(() => loadGenerationSettings().whisperTemperature);
  const [initialPrompt, setInitialPrompt] = useState(() => loadGenerationSettings().initialPrompt);
  const [referenceLyrics, setReferenceLyrics] = useState(() => loadGenerationSettings().referenceLyrics);
  const [vadEnabled, setVadEnabled] = useState(() => loadGenerationSettings().vadEnabled);
  const [vadThreshold, setVadThreshold] = useState(() => loadGenerationSettings().vadThreshold);
  const [vadMinSilenceMs, setVadMinSilenceMs] = useState(() => loadGenerationSettings().vadMinSilenceMs);
  const [vadSpeechPadMs, setVadSpeechPadMs] = useState(() => loadGenerationSettings().vadSpeechPadMs);
  const [vadMaxSpeechS, setVadMaxSpeechS] = useState(() => loadGenerationSettings().vadMaxSpeechS);

  // ---- settings popover ---------------------------------------------------
  const [showSettings, setShowSettings] = useState(false);
  const settingsAnchorRef = useRef(null);

  // ---- persistent app settings panel (dsd.md §13.7 B6.6) ------------------
  const [showAppSettings, setShowAppSettings] = useState(false);

  // ---- queue feature: add-to-queue draft + queue list --------------------
  // `queueDraft` is the per-item ASR/generation options (+ music-MV flag +
  // source-language choice, dsd.md §12.6/§12.7 B5.3) for whatever URL
  // currently sits in the Titlebar input, independent of the `whisperModel`/
  // etc. state above (which is scoped to "regenerate the CURRENTLY LOADED
  // video" and must not be silently mutated just because the user pasted a
  // new URL). Starts from the same persisted localStorage defaults so a
  // user's preferred whisper model etc. carries over, but is otherwise a
  // fresh, independently-editable draft per URL. `sourceLang` isn't part of
  // GENERATION_SETTINGS_DEFAULTS/localStorage — it always starts at 'ja'
  // like isMusicVideo does.
  const [queueDraft, setQueueDraft] = useState(() => ({
    ...loadGenerationSettings(),
    isMusicVideo: false,
    sourceLang: 'ja',
    maxHeight: 1080,
  }));
  // Set on any manual edit to a draft field; blocks a late (debounced)
  // preview response from clobbering an edit the user already made for
  // this same URL. Reset to false whenever a genuinely new URL is drafted.
  const queueTouchedRef = useRef(false);
  const lastQueuedUrlRef = useRef('');
  const [queuePreview, setQueuePreview] = useState(null); // { video_id, title, channel, is_music }
  const [queuePreviewLoading, setQueuePreviewLoading] = useState(false);
  const [queuePreviewError, setQueuePreviewError] = useState(null);
  const [queueSubmitting, setQueueSubmitting] = useState(false);
  const [showQueueOptions, setShowQueueOptions] = useState(false);
  const queueOptionsAnchorRef = useRef(null);
  // Bucketed GET /api/videos poll -- doubles as the queue list (queued +
  // in-progress + ready-but-not-currently-loaded items). See refreshQueue.
  const [queueItems, setQueueItems] = useState([]);
  // video_id -> Date.now() of submission. Once cached models make a short
  // clip's whole pipeline finish in a second or two, an item can go
  // queued -> ready between one 3s poll and the next -- without this, it
  // would never render even once, making a successful add look like it
  // silently did nothing. Keeps a just-added item visible for a few
  // seconds regardless of status so the user actually sees it land.
  const recentlyAddedRef = useRef(new Map());
  // video_id -> latest VideoSummary (title/channel/status/duration_ms/
  // is_music_video), refreshed by the same GET /api/videos poll that drives
  // QueueList -- reused so PlaylistPanel doesn't need a second network call.
  const [videoLookup, setVideoLookup] = useState({});

  // ---- playlist (sidebar tab, separate from the transient Queue strip) ----
  // Ordered video_ids added via "加入佇列", independent of processing status;
  // persisted to localStorage so manual reordering survives a reload.
  const [playlistIds, setPlaylistIds] = useState(() => loadPlaylist());
  // 'collection' (收藏 — the merged download-queue + playlist tab, handoff §6)
  // is the default active tab. Was 'playlist' before the queue/playlist merge.
  const [sidebarTab, setSidebarTab] = useState('collection'); // 'subtitles' | 'collection'

  // ---- main view: player vs. video library --------------------------------
  // The Titlebar's library button swaps the whole body between the normal
  // player and the LibraryView grid. Kept as a plain string toggle (no
  // routing) — this is a single-window desktop-style tool.
  const [view, setView] = useState('player'); // 'player' | 'library'

  // Pending library delete awaiting confirmation via the custom ConfirmDialog
  // (replaces native window.confirm) — `{ video_id, title }` or null.
  const [confirmDelete, setConfirmDelete] = useState(null);
  // Transient in-app toast (replaces native window.alert) for action errors.
  const [notice, setNotice] = useState(null);
  const noticeTimerRef = useRef(0);
  function showNotice(message) {
    setNotice(message);
    clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => setNotice(null), 4000);
  }
  useEffect(() => () => clearTimeout(noticeTimerRef.current), []);

  useEffect(() => {
    savePlaylist(playlistIds);
  }, [playlistIds]);

  function addToPlaylist(id) {
    setPlaylistIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }

  function removeFromPlaylist(id) {
    setPlaylistIds((prev) => prev.filter((existing) => existing !== id));
  }

  function reorderPlaylist(fromIndex, toIndex) {
    setPlaylistIds((prev) => {
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  }

  // Playlist row click -- switches playback to that video regardless of its
  // current status (finalizeReady already handles both "already ready" and
  // "still mid-pipeline" gracefully, reopening the WS in the latter case).
  // A user-initiated selection should always start playing once it's ready.
  async function selectPlaylistItem(id) {
    if (!id || id === videoId) return;
    shouldAutoplayRef.current = true;
    resetPlaybackState();
    setLoadStatus('connecting');
    setVideoId(id);
    await finalizeReady(id);
  }

  // ---- video library actions (LibraryView) --------------------------------
  // Play a library card: switch back to the player view and load it (unless
  // it's already the active video, in which case just return to the player).
  async function handleLibraryPlay(id) {
    setView('player');
    if (id && id !== videoId) {
      await selectPlaylistItem(id);
    }
  }

  // Re-run the whole subtitle pipeline for a library item. If it's the
  // currently-loaded video, route through regenerateSubtitles() so it rides
  // the same WS/progress machinery as the settings-popover button; otherwise
  // fire the pipeline in the background (the GET /api/videos poll +
  // QueueList reflect its progress) using the persisted generation settings.
  async function handleLibraryRegenerate(id) {
    if (!id) return;
    if (id === videoId) {
      await regenerateSubtitles();
      return;
    }
    try {
      recentlyAddedRef.current.set(id, Date.now());
      await regeneratePipeline(id, buildGenerationSettingsPayload(loadGenerationSettings()));
      refreshQueue();
    } catch (err) {
      showNotice(err.message || '重新產生字幕失敗');
    }
  }

  // Delete a library item (its whole on-disk folder). Opens the custom
  // ConfirmDialog (not native confirm) since it's irreversible + frees the
  // mp4; `performDelete` runs once the user confirms.
  function handleLibraryDelete(id) {
    if (!id) return;
    const item = videoLookup[id];
    setConfirmDelete({ video_id: id, title: item?.title || id });
  }

  // Runs the actual delete after ConfirmDialog confirmation. Cleans up the
  // video's playlist entry + resume position, and unloads the player if it
  // was the active video.
  async function performDelete() {
    const target = confirmDelete;
    if (!target) return;
    setConfirmDelete(null);
    try {
      await deleteVideo(target.video_id);
      if (target.video_id === videoId) resetPlaybackState();
      removeFromPlaylist(target.video_id);
      clearResumePosition(target.video_id);
      recentlyAddedRef.current.delete(target.video_id);
      refreshQueue();
    } catch (err) {
      showNotice(err.message || '刪除失敗');
    }
  }

  function updateQueueDraft(partial) {
    queueTouchedRef.current = true;
    setQueueDraft((d) => ({ ...d, ...partial }));
  }

  function setQueueMusicVideo(checked) {
    // Toggling the checkbox (auto-detect or manual) is itself the
    // intentional choice to apply the music preset -- doesn't count as a
    // "touch" that should block re-applying it for a later, different URL.
    setQueueDraft((d) => ({
      ...d,
      isMusicVideo: checked,
      // Language-aware prompt: the MV may be Japanese or English, so key the
      // preset off the currently-chosen 來源語言 (dsd §12.7).
      ...(checked ? musicPresetFor(d.sourceLang) : {}),
    }));
  }

  function resetQueueDraft() {
    queueTouchedRef.current = false;
    setQueueDraft({ ...GENERATION_SETTINGS_DEFAULTS, isMusicVideo: false, sourceLang: 'ja', maxHeight: 1080 });
  }

  function closeWs() {
    expectCloseRef.current = true;
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  }
  useEffect(() => () => closeWs(), []);

  // Titlebar now shows the loaded video's title (README change #2) — keep
  // the browser tab title in sync with it too.
  useEffect(() => {
    document.title = videoTitle || 'rj-player';
  }, [videoTitle]);

  // Track fullscreen state (README change #4) so ControlBar's button can
  // swap its icon/label and so we know which way to toggle on click. Uses a
  // document-level listener (not element-level) since exiting via Esc or a
  // browser chrome control doesn't go through our own handler.
  useEffect(() => {
    function onFullscreenChange() {
      setIsFullscreen(Boolean(currentFullscreenElement()));
    }
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', onFullscreenChange);
    };
  }, []);

  // Desktop app: exit native window fullscreen on Esc. macOS window fullscreen
  // (unlike the browser's element fullscreen, which the `fullscreenchange`
  // listener above already tracks) doesn't respond to Esc on its own, so the
  // user would otherwise be stuck. Only armed while fullscreen in Tauri.
  useEffect(() => {
    if (!isFullscreen || !isTauri()) return;
    function onKeyDown(e) {
      if (e.key === 'Escape') {
        toggleWindowFullscreen().then((next) => {
          if (next !== null) setIsFullscreen(next);
        });
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isFullscreen]);

  // In the video library, Esc returns to the player (parity with the Titlebar
  // "播放器" back button). Skipped while an overlay that owns Esc is open (the
  // delete ConfirmDialog, the app-settings panel) so Esc dismisses that first
  // instead of jumping views out from under it.
  useEffect(() => {
    if (view !== 'library') return undefined;
    function onKeyDown(e) {
      if (e.key !== 'Escape') return;
      if (confirmDelete || showAppSettings) return;
      setView('player');
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [view, confirmDelete, showAppSettings]);

  // Global media shortcuts (player view only): Space = play/pause, M = mute.
  // Ignored while a text field is focused (URL box, initial-prompt, cue editor)
  // so their normal spacebar / 'm' still type. Space is preventDefault'd so it
  // drives the <video> YouTube-style instead of scrolling the page or
  // re-triggering whatever button happens to be focused. `e.code` (physical
  // key) is layout-independent. Skipped when a modifier is held (e.g. ⌘Space).
  useEffect(() => {
    if (view !== 'player') return undefined;
    function onKeyDown(e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return;
      if (e.code === 'Space') {
        e.preventDefault();
        togglePlay();
      } else if (e.code === 'KeyM') {
        e.preventDefault();
        toggleMute();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, loadStatus]);

  // Persist generation settings to localStorage on every change (including
  // the initial mount, which harmlessly re-saves whatever was just loaded).
  useEffect(() => {
    saveGenerationSettings({
      whisperModel,
      whisperTemperature,
      initialPrompt,
      referenceLyrics,
      vadEnabled,
      vadThreshold,
      vadMinSilenceMs,
      vadSpeechPadMs,
      vadMaxSpeechS,
    });
  }, [whisperModel, whisperTemperature, initialPrompt, referenceLyrics, vadEnabled, vadThreshold, vadMinSilenceMs, vadSpeechPadMs, vadMaxSpeechS]);

  // "回復預設" — restores the backend's own defaults (GENERATION_SETTINGS_DEFAULTS).
  function resetGenerationSettings() {
    setWhisperModel(GENERATION_SETTINGS_DEFAULTS.whisperModel);
    setWhisperTemperature(GENERATION_SETTINGS_DEFAULTS.whisperTemperature);
    setInitialPrompt(GENERATION_SETTINGS_DEFAULTS.initialPrompt);
    setReferenceLyrics(GENERATION_SETTINGS_DEFAULTS.referenceLyrics);
    setVadEnabled(GENERATION_SETTINGS_DEFAULTS.vadEnabled);
    setVadThreshold(GENERATION_SETTINGS_DEFAULTS.vadThreshold);
    setVadMinSilenceMs(GENERATION_SETTINGS_DEFAULTS.vadMinSilenceMs);
    setVadSpeechPadMs(GENERATION_SETTINGS_DEFAULTS.vadSpeechPadMs);
    setVadMaxSpeechS(GENERATION_SETTINGS_DEFAULTS.vadMaxSpeechS);
  }

  // close settings popover on outside click
  useEffect(() => {
    if (!showSettings) return;
    function onDocPointerDown(e) {
      if (settingsAnchorRef.current && !settingsAnchorRef.current.contains(e.target)) {
        setShowSettings(false);
      }
    }
    document.addEventListener('pointerdown', onDocPointerDown);
    return () => document.removeEventListener('pointerdown', onDocPointerDown);
  }, [showSettings]);

  // close add-to-queue popover on outside click (same pattern as settings)
  useEffect(() => {
    if (!showQueueOptions) return;
    function onDocPointerDown(e) {
      if (queueOptionsAnchorRef.current && !queueOptionsAnchorRef.current.contains(e.target)) {
        setShowQueueOptions(false);
      }
    }
    document.addEventListener('pointerdown', onDocPointerDown);
    return () => document.removeEventListener('pointerdown', onDocPointerDown);
  }, [showQueueOptions]);

  // Debounced POST /api/videos/preview as the user pastes/edits the URL
  // (queue feature's music-MV auto-detect + source-language auto-detect): on
  // a genuinely new URL, resets the draft to persisted defaults, then --
  // once the preview resolves -- auto-applies the music preset if is_music
  // is true and the user hasn't already hand-edited a field for this same
  // URL, and pre-selects the 來源語言 picker from the preview's detected
  // `source_lang` (still user-overridable in the form either way).
  useEffect(() => {
    const url = urlInput.trim();
    if (!url) {
      setQueuePreview(null);
      setQueuePreviewError(null);
      lastQueuedUrlRef.current = '';
      return;
    }
    const handle = setTimeout(async () => {
      if (url === lastQueuedUrlRef.current) return;
      lastQueuedUrlRef.current = url;
      queueTouchedRef.current = false;
      setQueueDraft({ ...loadGenerationSettings(), isMusicVideo: false, sourceLang: 'ja', maxHeight: 1080 });
      setQueuePreviewLoading(true);
      setQueuePreviewError(null);
      try {
        const data = await previewVideo(url);
        setQueuePreview(data);
        // Pre-select the detected source language first, then key the music
        // preset off it: the MV may be English, not Japanese, so the prompt
        // must match what was actually detected (dsd §12.7) -- not the stale
        // 'ja' default the draft still holds at this point.
        const detectedLang = data.source_lang || 'ja';
        if (data.source_lang) {
          setQueueDraft((d) => ({ ...d, sourceLang: data.source_lang }));
        }
        if (data.is_music && !queueTouchedRef.current) {
          setQueueDraft((d) => ({ ...d, isMusicVideo: true, ...musicPresetFor(detectedLang) }));
        }
      } catch (err) {
        setQueuePreview(null);
        setQueuePreviewError(err.message || '無法讀取影片資訊');
      } finally {
        setQueuePreviewLoading(false);
      }
    }, 600);
    return () => clearTimeout(handle);
  }, [urlInput]);

  // Polls the video library listing every few seconds to drive QueueList --
  // reuses GET /api/videos rather than a separate queue endpoint (list_meta
  // is already sorted FIFO by created_at server-side). Excludes the
  // currently-loaded video (already shown in the main player) and terminal
  // `cancelled`/`new` records.
  async function refreshQueue() {
    try {
      const all = await listVideos();
      const now = Date.now();
      for (const [id, addedAt] of recentlyAddedRef.current) {
        if (now - addedAt > 6000) recentlyAddedRef.current.delete(id);
      }
      // In-flight items (`queued` or an active pipeline status, dsd.md
      // §5.3) plus anything added in the last few seconds regardless of
      // status -- a short clip can go queued -> ready between polls once
      // Whisper/the LLM call are warmed up, and without the grace window
      // it would never render even once. Still excludes stale
      // `ready`/failed/cancelled records from the general library.
      setQueueItems(
        all.filter(
          (v) =>
            v.video_id !== videoId &&
            (v.status === 'queued' || PIPELINE_ACTIVE_STATUSES.has(v.status) || recentlyAddedRef.current.has(v.video_id))
        )
      );
      // Same poll doubles as PlaylistPanel's data source (title/channel/
      // status/is_music_video for whatever's in playlistIds) -- avoids a
      // second network round-trip just to render the playlist tab.
      const lookup = {};
      for (const v of all) lookup[v.video_id] = v;
      setVideoLookup(lookup);
    } catch {
      // best-effort -- keep the last known list on a transient failure
    }
  }
  useEffect(() => {
    refreshQueue();
    const interval = setInterval(refreshQueue, 3000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId]);

  // apply playbackRate / volume to the real <video> element — re-applied
  // whenever videoSrc changes too, since a fresh <video> mount resets both
  // to browser defaults (rate 1.0, volume 1.0).
  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = speed;
  }, [speed, videoSrc]);
  useEffect(() => {
    if (videoRef.current) videoRef.current.volume = volume / 100;
  }, [volume, videoSrc]);

  // Autoplay a freshly-loaded video (auto-advance to the next queued track, or
  // a manual playlist/library pick) the moment its <video> mounts with the new
  // src -- driven off `videoSrc` rather than the <video>'s `canplay` event.
  // `preload="metadata"` means the browser fetches only metadata and then
  // suspends, so `canplay` (readyState >= HAVE_FUTURE_DATA) may never fire on
  // its own; waiting for it left the next track loaded-but-paused. Calling
  // play() directly kicks off buffering AND playback (and, in turn, makes
  // `canplay` eventually fire so handleCanPlay can still clear autoAdvanceRef).
  // The desktop app additionally needs the webview's `autoplay(true)`
  // (src-tauri/src/lib.rs) for this play() to be allowed without a gesture.
  useEffect(() => {
    if (!videoSrc || !shouldAutoplayRef.current) return;
    shouldAutoplayRef.current = false;
    videoRef.current?.play().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoSrc]);

  // ---- subtitle pipeline status (B3.4) ---------------------------------
  // Maps a backend VideoStatus (from a WS `status`/`done` event, or from a
  // fresh GET /api/videos/:id) onto the overlay's pipeline-progress state.
  // Kept independent of `loadStatus`: the video is already playable once
  // `loadStatus === 'downloaded'`, but the AI pipeline (transcribing ->
  // ... -> ready) can still be running for a while after that.
  function applyPipelineStatus(status, lastError) {
    if (status === 'ready') {
      setSubtitleStatus('ready');
    } else if (status === 'pipeline_failed' || status === 'download_failed') {
      setSubtitleStatus('failed');
      setSubtitleError(lastError || '字幕處理失敗');
    } else if (PIPELINE_ACTIVE_STATUSES.has(status)) {
      setSubtitleStatus(status);
    }
  }

  // GET /api/videos/:id/subtitles once status is known to be `ready`
  // (dsd.md §3.1, B3.1). Sorts cues by start_ms per dsd.md §6.2 so the
  // overlay's binary search is valid.
  async function loadSubtitles(id) {
    try {
      const doc = await getSubtitles(id);
      setCues([...doc.cues].sort((a, b) => a.start_ms - b.start_ms));
      setTranslatePartial(Boolean(doc.translate_partial));
      setDocSourceLang(doc.language_source || 'ja');
      setDocSource(doc.source || null);
      setDocTargetSource(doc.target_source || null);
      setSubtitleStatus('ready');
    } catch (err) {
      setSubtitleStatus('failed');
      setSubtitleError(err.message || '字幕載入失敗');
    }
  }

  // ---- inline subtitle edit (P1) ----------------------------------------
  // Persist a manual edit to one cue's source_text/target_text, then replace
  // that cue in `cues` with the backend's returned (canonicalized) version so
  // both the list and the on-video overlay refresh in place — no refetch.
  // Editing source_text clears its furigana/romaji server-side (they'd be
  // stale), which the returned cue reflects.
  async function editCue(cueId, patch) {
    if (!videoId) return;
    try {
      const updated = await patchCue(videoId, cueId, patch);
      setCues((prev) => prev.map((c) => (c.id === cueId ? updated : c)));
    } catch (err) {
      setSubtitleError(err.message || '字幕儲存失敗');
    }
  }

  // ---- subtitle export (P1) ---------------------------------------------
  // Builds the chosen format client-side from the loaded cues, then saves it.
  // On desktop (Tauri) a native "Save as…" panel is used, because the browser
  // `<a download>` + Blob path silently no-ops inside WKWebView; on the web it
  // falls back to that Blob download. No backend call either way.
  async function handleExportSubtitles(format) {
    if (!cues.length) return;
    const base = safeFilename(videoTitle, videoId || 'subtitles');
    let filename;
    let text;
    let mime;
    if (format === 'srt') {
      filename = `${base}.srt`;
      text = buildSrt(cues, { layers: ['ja', 'zh'] });
      mime = 'application/x-subrip;charset=utf-8';
    } else if (format === 'lrc') {
      filename = `${base}.lrc`;
      text = buildLrc(cues, { layer: 'ja' });
      mime = 'text/plain;charset=utf-8';
    } else if (format === 'txt') {
      filename = `${base}.txt`;
      text = buildBilingualTxt(cues);
      mime = 'text/plain;charset=utf-8';
    } else {
      return;
    }
    const savedNatively = await saveTextFile(filename, text);
    if (!savedNatively) downloadTextFile(filename, text, mime);
  }

  // ---- regenerate subtitles ---------------------------------------------
  // "重新產生字幕": re-runs the whole AI pipeline via POST
  // /api/videos/:id/pipeline {force:true} (dsd.md §3.1) and then rides the
  // EXISTING WS/progress machinery (connectEvents -> progress/status/done ->
  // finalizeReady -> loadSubtitles) back to `ready`, same as a fresh
  // download would — no separate progress plumbing needed.
  async function regenerateSubtitles() {
    if (!videoId || PIPELINE_ACTIVE_STATUSES.has(subtitleStatus)) return;

    // Flip to an active pipeline state first, synchronously — this makes a
    // second click while the POST is still in flight get caught by the guard
    // above, and makes the "辨識中…" pill show immediately instead of waiting
    // on the network round trip. NOTE: we deliberately do NOT clear `cues`
    // here — the previous subtitles stay on screen during the (possibly
    // multi-minute) re-run so the player doesn't look empty/broken; they're
    // replaced only once the new ones load on completion.
    setSubtitleError(null);
    setSubtitleStage(null);
    setSubtitlePct(null);
    setSubtitleStatus('transcribing');

    try {
      const settings = buildGenerationSettingsPayload({
        whisperModel,
        whisperTemperature,
        initialPrompt,
        referenceLyrics,
        vadEnabled,
        vadThreshold,
        vadMinSilenceMs,
        vadSpeechPadMs,
        vadMaxSpeechS,
      });
      await regeneratePipeline(videoId, settings);
      connectEvents(videoId);
    } catch (err) {
      setSubtitleStatus('failed');
      setSubtitleError(err.message || '重新產生字幕失敗');
    }
  }

  // ---- retranslate only ---------------------------------------------------
  // "只重新翻譯": re-runs ONLY the translate stage (POST
  // /api/videos/:id/retranslate) against the video's EXISTING subtitles.json
  // -- no ASR -- then rides the same WS/progress machinery back to `ready`.
  // Needs cues to already exist (the backend 400s otherwise: nothing to
  // retranslate without a prior full pipeline run).
  async function retranslateSubtitles() {
    if (!videoId || PIPELINE_ACTIVE_STATUSES.has(subtitleStatus) || !cues.length) return;

    // Same synchronous-flip reasoning as regenerateSubtitles above, and same
    // "don't clear cues" — the current (possibly partial) translation stays
    // visible during the re-run.
    setSubtitleError(null);
    setSubtitleStage(null);
    setSubtitlePct(null);
    setSubtitleStatus('translating');

    try {
      await retranslateSubtitlesApi(videoId);
      connectEvents(videoId);
    } catch (err) {
      setSubtitleStatus('failed');
      setSubtitleError(err.message || '重新翻譯失敗');
    }
  }

  // ---- download flow ---------------------------------------------------
  async function finalizeReady(id) {
    try {
      const meta = await getVideo(id);
      setVideoTitle(meta.title || '');
      setChannelName(meta.channel || '');
      if (meta.duration_ms) setDuration(meta.duration_ms / 1000);
      setVideoSrc(mediaUrl(id));
      setLoadStatus('downloaded');

      applyPipelineStatus(meta.status, meta.last_error);
      if (meta.status === 'ready') {
        await loadSubtitles(id);
      } else if (PIPELINE_ACTIVE_STATUSES.has(meta.status) && !wsRef.current) {
        // Reached here via the POST /api/videos cache-hit path (dsd.md
        // §3.1), which never opened the WS — but the pipeline is still
        // mid-flight (e.g. a video left `transcribing` from an earlier
        // run), so open it now to keep getting progress (B3.4).
        connectEvents(id);
      }
    } catch (err) {
      setLoadStatus('error');
      setErrorMessage(err.message || '無法取得影片資訊');
    }
  }

  function connectEvents(id) {
    closeWs();
    let ws;
    try {
      ws = new WebSocket(videoEventsUrl(id));
    } catch (err) {
      setLoadStatus('error');
      setErrorMessage('無法建立即時連線');
      return;
    }
    wsRef.current = ws;
    expectCloseRef.current = false;

    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      switch (msg.type) {
        case 'progress':
          setStageLabel(msg.stage);
          if (msg.stage === 'download') {
            setDownloadPct(msg.pct);
          } else {
            // Pipeline-stage progress (asr/tokenize/romaji/translate/assemble),
            // dsd.md §3.2 — drives the B3.4 "辨識中… (asr 70%)" pill.
            setSubtitleStage(msg.stage);
            setSubtitlePct(msg.pct);
          }
          break;
        case 'status':
          setStageLabel(msg.status);
          applyPipelineStatus(msg.status, null);
          if (msg.status === 'ready') {
            // We can learn "ready" from a `status` event (not just `done`)
            // when we (re)connect the WS *after* a fast pipeline already
            // finished — the hub replays only a one-shot status snapshot, not
            // the missed `done`. Only `done` used to fetch the subtitles, so
            // that path left the overlay stale. Fetch here too; this is safe
            // because the backend now flips status to `transcribing` the
            // instant a re-run is POSTed, so a `status: ready` genuinely means
            // "finished", never a stale pre-run value. loadSubtitles is an
            // idempotent GET+setCues, fine to run alongside the `done` path.
            loadSubtitles(id);
            closeWs();
          }
          // A status change means we've moved to a new stage; drop the old
          // stage's pct so the pill doesn't show a stale "asr 95%" once
          // we're actually translating.
          setSubtitleStage(null);
          setSubtitlePct(null);
          break;
        case 'log':
          // human-readable log line (e.g. raw yt-dlp output) — no UI seam yet
          break;
        case 'done':
          // Refreshes title/channel/duration (Phase 1) and re-derives
          // pipeline/subtitle state from a fresh GET (fire-and-forget, same
          // as Phase 1's original behavior here).
          finalizeReady(id);
          if (msg.status === 'ready') {
            closeWs();
          }
          // else msg.status === 'downloaded': createVideo() always sends
          // auto_pipeline: true, so the backend chains straight into the AI
          // pipeline on this same job (dsd.md §6.1) — more status/progress
          // events follow on this connection, so keep it open instead of
          // closing (this is the key B3.4 fix vs. Phase 1, which closed
          // here unconditionally and so never saw pipeline progress).
          break;
        case 'error':
          if (msg.stage === 'download') {
            setLoadStatus('error');
            setErrorMessage(msg.message || '發生錯誤');
          } else {
            // Pipeline-stage failure (dsd.md §7 pipeline_failed): the video
            // already downloaded and is playable, so only the subtitle
            // layer degrades — don't touch loadStatus/errorMessage.
            setSubtitleStatus('failed');
            setSubtitleError(msg.message || '字幕處理失敗');
          }
          closeWs();
          break;
        default:
          break;
      }
    };
    ws.onerror = () => {
      // Connection problem; leave loadStatus as-is here — onclose (below)
      // decides whether this was expected, since onerror fires before
      // onclose and doesn't tell us that on its own.
    };
    ws.onclose = () => {
      if (!expectCloseRef.current) {
        // Dropped unexpectedly (not one of our own closeWs() calls) —
        // surface it instead of leaving the progress bar stuck forever.
        setLoadStatus('error');
        setErrorMessage((prev) => prev || '與伺服器的連線中斷，請重新載入');
      }
    };
  }

  function resetPlaybackState() {
    closeWs();
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setVideoAspectRatio(null);
    setVideoSrc(null);
    setVideoTitle('');
    setChannelName('');
    setVideoId(null);
    setDownloadPct(null);
    setStageLabel(null);
    setErrorMessage(null);
    setCues([]);
    setSubtitleStatus('idle');
    setSubtitleStage(null);
    setSubtitlePct(null);
    setSubtitleError(null);
    setTranslatePartial(false);
    setDocSourceLang('ja');
    setDocSource(null);
    setDocTargetSource(null);
  }

  // "加入佇列": always submits through POST /api/videos (now the queue
  // feature's entry point). If nothing is currently loaded (or the current
  // video errored out), this also immediately loads/plays the new one --
  // same UX as before the queue feature existed. If a video IS already
  // loaded/playing, the new item is added silently in the background;
  // QueueList shows it, and playback of the current video is undisturbed
  // (deliberately does NOT call resetPlaybackState in that case).
  async function handleUrlSubmit(e) {
    e.preventDefault();
    const url = urlInput.trim();
    if (!url || queueSubmitting) return;

    setQueueSubmitting(true);
    try {
      const data = await createVideo(url, queueDraft, queueDraft.isMusicVideo, queueDraft.sourceLang, queueDraft.maxHeight);
      recentlyAddedRef.current.set(data.video_id, Date.now());
      addToPlaylist(data.video_id);
      setUrlInput('');
      setQueuePreview(null);
      setShowQueueOptions(false);
      refreshQueue();

      if (!videoId || loadStatus === 'error') {
        resetPlaybackState();
        setLoadStatus('connecting');
        const id = data.video_id;
        setVideoId(id);
        if (data.status === 'downloaded' || data.status === 'ready') {
          // Cached hit — dsd.md §3.1: "若已快取 ready → 200 { status:"ready" }"
          await finalizeReady(id);
        } else {
          setLoadStatus('downloading');
          connectEvents(id);
        }
      }
    } catch (err) {
      setQueuePreviewError(err.message || '加入佇列失敗');
    } finally {
      setQueueSubmitting(false);
    }
  }

  async function handleCancelQueueItem(id) {
    try {
      await cancelQueueItem(id);
    } catch {
      // best-effort -- the next poll reconciles the actual state either way
    } finally {
      refreshQueue();
    }
  }

  // ---- playback controls ---------------------------------------------------
  function togglePlay() {
    const v = videoRef.current;
    if (!v || loadStatus !== 'downloaded') return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  }

  function onSeek(pct) {
    const v = videoRef.current;
    if (!v || !duration) return;
    const t = pct * duration;
    v.currentTime = t;
    setCurrentTime(t);
  }

  function onVolumeChange(val) {
    setVolume(val);
    if (val > 0) lastVolumeRef.current = val;
  }
  function toggleMute() {
    setVolume((prev) => (prev > 0 ? 0 : lastVolumeRef.current || 70));
  }

  // ---- resume position + auto-advance (P2) ------------------------------
  // <video> timeupdate: drive the progress UI (as before) AND persist the
  // playback position for `videoId`, throttled to ~once every 2s.
  function handleTimeUpdate(e) {
    const t = e.target.currentTime;
    setCurrentTime(t);
    const now = performance.now();
    if (videoId && now - lastResumeSaveRef.current > 2000) {
      lastResumeSaveRef.current = now;
      // Don't persist a near-start/near-end position as a "resume point".
      if (t > 5 && e.target.duration && t < e.target.duration - 10) {
        saveResumePosition(videoId, t);
      }
    }
  }

  // <video> loadedmetadata/durationchange: record duration + aspect ratio
  // (as before) AND, on the first metadata load for this src, seek back to a
  // saved resume position if there is a meaningful one.
  function handleLoadedMetadata(e) {
    const v = e.target;
    if (Number.isFinite(v.duration)) setDuration(v.duration);
    if (v.videoWidth && v.videoHeight) {
      setVideoAspectRatio(v.videoWidth / v.videoHeight);
    }
    // A playlist auto-advance starts the next track from the BEGINNING: skip
    // the resume-restore (which fires before `canplay`, so `autoAdvanceRef` is
    // still set here) so the next video doesn't jump to its own previously
    // saved position. Every other load (initial load, manual playlist/library
    // click) still resumes from where you left off.
    if (!autoAdvanceRef.current && videoId && v.duration) {
      const saved = loadResumePositions()[videoId];
      if (typeof saved === 'number' && saved > 5 && saved < v.duration - 10) {
        v.currentTime = saved;
        setCurrentTime(saved);
      }
    }
  }

  // <video> ended: the finished video no longer has a resume point, and if
  // there's a next item in the playlist, auto-advance to it (else just stop).
  function handleVideoEnded() {
    setIsPlaying(false);
    if (videoId) clearResumePosition(videoId);
    const idx = playlistIds.indexOf(videoId);
    const nextId = idx >= 0 && idx + 1 < playlistIds.length ? playlistIds[idx + 1] : null;
    if (nextId) {
      autoAdvanceRef.current = true;
      shouldAutoplayRef.current = true;
      selectPlaylistItem(nextId);
    }
  }

  // <video> canplay: fires once the freshly-loaded video (any src change) has
  // buffered enough to start. Auto-plays whenever this load was flagged as
  // one that should (auto-advance to the next track, or a manual click from
  // the library/playlist) -- everything else (e.g. the very first load on
  // app start) leaves the video paused as before.
  function handleCanPlay() {
    // Both flags have already had their one chance to be read by this point
    // (autoAdvanceRef by handleLoadedMetadata, just before this fires) --
    // clear autoAdvanceRef here too so it doesn't stay stuck true and make
    // every later load (including plain manual clicks) skip resume-restore.
    autoAdvanceRef.current = false;
    if (shouldAutoplayRef.current) {
      shouldAutoplayRef.current = false;
      videoRef.current?.play().catch(() => {});
    }
  }

  // Fullscreens/exits VideoStage's outer container (stageContainerRef), NOT
  // the bare <video> — see the module-level helpers above and README change
  // #4. No-ops (rather than throwing) on browsers without any Fullscreen API.
  async function toggleFullscreen() {
    const el = stageContainerRef.current;
    if (!el) return;
    // In the desktop app WKWebView ignores element-level requestFullscreen, so
    // drive the native window instead and mirror the state ourselves (there's no
    // `fullscreenchange` DOM event for a window toggle). The `isFullscreen` CSS
    // makes the stage fill the now-fullscreen window. In a browser, keep the
    // HTML5 element fullscreen path.
    if (isTauri()) {
      try {
        const next = await toggleWindowFullscreen();
        if (next !== null) {
          setIsFullscreen(next);
          return;
        }
      } catch (err) {
        console.error('[rj-player] native window fullscreen failed:', err);
      }
    }
    if (currentFullscreenElement()) {
      exitFullscreen();
    } else {
      requestFullscreenOn(el);
    }
  }

  // SubtitleList row click (README change #3) — seeks the same way ProgressTrack's
  // onSeek does: set <video>.currentTime directly, then setCurrentTime so the
  // UI (progress bar, active-cue highlight, overlay) updates immediately
  // instead of waiting for the next `timeupdate`/rAF tick.
  function seekToCue(cue) {
    const t = cue.start_ms / 1000;
    const v = videoRef.current;
    if (v) v.currentTime = t;
    setCurrentTime(t);
  }

  // Smooth progress bar while playing (rAF, per dsd.md §6.2's preference for
  // rAF over the coarser `timeupdate` event ~4/s). `currentTime` is also
  // what drives SubtitleOverlay's cue binary-search (B3.1) — it reads this
  // same state via props rather than running a second rAF loop of its own.
  useEffect(() => {
    if (!isPlaying) return;
    let raf;
    const tick = () => {
      if (videoRef.current) setCurrentTime(videoRef.current.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying]);

  const timeLabel = `${formatTime(currentTime)} / ${formatTime(duration)}`;
  // Only reserve the sidebar's column when there's something for it to show
  // (cues, an in-progress pipeline, or a failure) — otherwise (no video
  // loaded yet, or a video with no subtitle run ever started) it's just a
  // wide empty panel dragging the video off-center. VideoStage always
  // centers itself in whatever column width it ends up with.
  const hasCues = Boolean(cues && cues.length);
  // Data-driven signal (dsd.md §12.6/§12.7 B5.3), not a hardcoded language
  // list: true whenever the loaded doc actually has a reading/phonetic layer
  // (ja produces romaji per-cue; en's profile leaves `phonetic: ""` on every
  // cue per B5.2) — drives SettingsPopover hiding the 羅馬拼音 toggle + its
  // 字幕樣式 style slot for a source language with no reading layer.
  const hasPhoneticLayer = cues.some((c) => c.phonetic);
  // The 收藏 sidebar is always present (user request): even with no video,
  // queue, playlist, or cues it shows its empty states + the 影片庫 entry
  // button. This also guarantees the library — whose entry moved from the
  // Titlebar to the sidebar footer (handoff §6) — is always reachable. The
  // queue (處理中) and playlist (播放清單) now live inside its 收藏 tab.
  const showSubtitlePanel = true;
  const showChannelRow = !theaterMode && Boolean(channelName);

  // PlaylistPanel's ordered row data: playlistIds (user-reorderable) enriched
  // with the latest known title/channel/status/is_music_video from
  // videoLookup (the same GET /api/videos poll that drives QueueList). Falls
  // back to a bare video_id for an item whose first poll hasn't landed yet.
  const playlistItems = playlistIds.map(
    (id) => videoLookup[id] || { video_id: id, title: '', channel: '', status: 'new', is_music_video: false }
  );

  // LibraryView's full dataset: every video the GET /api/videos poll knows
  // about (videoLookup is rebuilt fresh each poll, so deleted videos drop out
  // and new downloads appear without extra plumbing). LibraryView does its
  // own search/filter/sort over this.
  const libraryVideos = Object.values(videoLookup);

  // Built once, mounted in exactly ONE of two spots depending on
  // isFullscreen: normal below-video position (this file), or inside
  // VideoStage's fullscreen-target subtree as an auto-hiding overlay (see
  // VideoStage.jsx's `controlBar` prop) — never both, since the settings
  // gear's anchor ref/open-state (settingsAnchorRef/showSettings) are
  // shared singletons that a second simultaneously-mounted instance would
  // fight over.
  const controlBarElement = (
    <ControlBar
      theme={theme}
      currentTime={currentTime}
      duration={duration}
      onSeek={onSeek}
      previewSrc={videoSrc}
      disabled={loadStatus !== 'downloaded'}
      isPlaying={isPlaying}
      onTogglePlay={togglePlay}
      timeLabel={timeLabel}
      volume={volume}
      onVolumeChange={onVolumeChange}
      onToggleMute={toggleMute}
      theaterMode={theaterMode}
      onToggleTheater={() => setTheaterMode((s) => !s)}
      isFullscreen={isFullscreen}
      onToggleFullscreen={toggleFullscreen}
      showSettings={showSettings}
      onToggleSettings={() => setShowSettings((s) => !s)}
      settingsAnchorRef={settingsAnchorRef}
      settingsSlot={
        <SettingsPopover
          theme={theme}
          dark={darkMode}
          speed={speed}
          onSpeedChange={setSpeed}
          subSource={subSource}
          onToggleSubSource={() => setSubSource((s) => !s)}
          subTarget={subTarget}
          onToggleSubTarget={() => setSubTarget((s) => !s)}
          subPhonetic={subPhonetic}
          onToggleSubPhonetic={() => setSubPhonetic((s) => !s)}
          sourceStyle={sourceStyle}
          onSourceStyleChange={updateSourceStyle}
          targetStyle={targetStyle}
          onTargetStyleChange={updateTargetStyle}
          phoneticStyle={phoneticStyle}
          onPhoneticStyleChange={updatePhoneticStyle}
          hasPhoneticLayer={hasPhoneticLayer}
          sourceLang={docSourceLang}
          translatePartial={translatePartial}
          subtitleOffsetMs={subtitleOffsetMs}
          onSubtitleOffsetChange={setSubtitleOffsetMs}
          subtitleBg={subtitleBg}
          onSubtitleBgChange={setSubtitleBg}
          whisperModel={whisperModel}
          onWhisperModelChange={setWhisperModel}
          whisperTemperature={whisperTemperature}
          onWhisperTemperatureChange={setWhisperTemperature}
          initialPrompt={initialPrompt}
          onInitialPromptChange={setInitialPrompt}
          referenceLyrics={referenceLyrics}
          onReferenceLyricsChange={setReferenceLyrics}
          vadEnabled={vadEnabled}
          onVadEnabledChange={setVadEnabled}
          vadThreshold={vadThreshold}
          onVadThresholdChange={setVadThreshold}
          vadMinSilenceMs={vadMinSilenceMs}
          onVadMinSilenceMsChange={setVadMinSilenceMs}
          vadSpeechPadMs={vadSpeechPadMs}
          onVadSpeechPadMsChange={setVadSpeechPadMs}
          vadMaxSpeechS={vadMaxSpeechS}
          onVadMaxSpeechSChange={setVadMaxSpeechS}
          onResetGenerationSettings={resetGenerationSettings}
          onRegenerateSubtitles={regenerateSubtitles}
          regenerateDisabled={!videoId || PIPELINE_ACTIVE_STATUSES.has(subtitleStatus)}
          regenerating={PIPELINE_ACTIVE_STATUSES.has(subtitleStatus)}
          onRetranslateSubtitles={retranslateSubtitles}
          retranslateDisabled={!videoId || PIPELINE_ACTIVE_STATUSES.has(subtitleStatus) || !cues.length}
          retranslating={subtitleStatus === 'translating'}
        />
      }
    />
  );

  return (
    <>
      <AmbientBackground theme={theme} dark={darkMode} videoSrc={videoSrc} videoRef={videoRef} />
      {/* Desktop-only window drag strip. Under macOS `titleBarStyle: Overlay`
          the native traffic-light buttons float over the content but the
          window is NOT draggable on its own — a drag region is required
          (tauri-apps/tauri#9503). The passive `data-tauri-drag-region`
          attribute is unreliable on WKWebView (a missed drag falls through to
          selecting text), so we drive it explicitly on mousedown:
          left-button → startDragging(), double-click → toggleMaximize (native
          title-bar behaviour). Both call window commands that need
          `core:window:allow-start-dragging` / `allow-toggle-maximize` in
          capabilities/default.json. A thin transparent bar pinned to the very
          top; the traffic lights sit above it, the app content below. */}
      {isTauri() && (
        <div
          onMouseDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            if (e.detail === 2) toggleMaximizeWindow();
            else startDragging();
          }}
          // z-index ABOVE every overlay in the app (the setup wizard is
          // 100000) so the top edge stays draggable even while a full-screen
          // modal is up — otherwise the window has NO grabbable title bar
          // during first-run setup (hiddenTitle + Overlay hide the native
          // one, and #9503 makes it non-draggable anyway). Its 40px height is
          // the reserved title-bar band: the traffic lights sit inside it and
          // the card below (wrapper's top padding) clears it, so app content
          // never collides with the close/minimise/zoom buttons.
          style={{ position: 'fixed', top: 0, left: 0, right: 0, height: 40, zIndex: 100001 }}
        />
      )}
      {showWizard && <SetupWizard onComplete={() => setShowWizard(false)} />}
      <div
        style={{
          position: 'relative',
          zIndex: 1,
          width: '100%',
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          // Extra top padding reserves the title-bar band (matching the 40px
          // drag strip) so the centred card never rides up under the macOS
          // traffic lights. Sides/bottom stay tighter.
          padding: '44px 20px 24px',
          boxSizing: 'border-box',
        }}
      >
      <div
        style={{
          background: theme.winBg,
          // A backdrop-filter (like transform/filter) makes this card the
          // containing block for any position:fixed descendant, which would trap
          // the fullscreen video stage inside the card instead of the viewport.
          // Drop it while fullscreen so the stage's position:fixed fills the
          // whole screen (the card is covered by the stage then anyway).
          backdropFilter: isFullscreen ? 'none' : 'blur(46px) saturate(170%)',
          WebkitBackdropFilter: isFullscreen ? 'none' : 'blur(46px) saturate(170%)',
          border: `0.5px solid ${theme.winBorder}`,
          // Scales with the actual viewport (vw) instead of a fixed px
          // width, capped generously so it keeps growing on large monitors
          // instead of plateauing at a size tuned for a ~1440px-wide
          // laptop screen — the playback area being as large as possible
          // matters more than showing off AmbientBackground's glow around
          // a smaller window (still visible at any size that doesn't fill
          // the viewport, just less of it).
          width: theaterMode ? 'min(97vw, 2400px)' : 'min(94vw, 2000px)',
          maxWidth: '100%',
          // Caps the card so it can never grow taller than the viewport
          // (matches the wrapper's 44px top + 24px bottom padding above).
          // Combined with the subtitle sidebar's absolutely-positioned scroll
          // body (SidebarPanel.jsx), a long cue list scrolls inside its own
          // pane instead of stretching the whole card. Pinned to the full
          // cap in both views for a stable window size — trying this out
          // instead of leaving player view auto-height (hugging the video's
          // own aspect-ratio size); the tradeoff is non-16:9 videos now get
          // letterboxed within a fixed-height card rather than the card
          // itself shrinking/growing to match.
          height: 'calc(100vh - 68px)',
          maxHeight: 'calc(100vh - 68px)',
          borderRadius: 18,
          overflow: 'hidden',
          boxShadow: `0 40px 100px rgba(0,0,0,0.5), inset 0 1px 0 ${theme.winInsetHighlight}`,
          display: 'flex',
          flexDirection: 'column',
          fontFamily: "-apple-system,BlinkMacSystemFont,'SF Pro Text',Helvetica,Arial,sans-serif",
        }}
      >
        <Titlebar
          theme={theme}
          videoTitle={videoTitle}
          urlInput={urlInput}
          onUrlChange={setUrlInput}
          onUrlSubmit={handleUrlSubmit}
          loading={queueSubmitting}
          // Library ENTRY moved to the sidebar footer button (handoff §6), so
          // the Titlebar no longer offers "影片庫" in the player view. We still
          // pass the toggle WHILE the library is open so its "返回播放器" exit
          // stays reachable (the sidebar — and thus its footer — isn't rendered
          // in library view). undefined in player view => Titlebar renders no
          // library button there.
          showLibrary={view === 'library'}
          onToggleLibrary={view === 'library' ? () => setView('player') : undefined}
          onOpenAppSettings={() => setShowAppSettings(true)}
          optionsAnchorRef={queueOptionsAnchorRef}
          showOptions={showQueueOptions}
          onToggleOptions={() => setShowQueueOptions((s) => !s)}
          optionsSlot={
            <AddToQueuePopover
              theme={theme}
              previewLoading={queuePreviewLoading}
              previewError={queuePreviewError}
              previewTitle={queuePreview?.title}
              previewChannel={queuePreview?.channel}
              whisperModel={queueDraft.whisperModel}
              onWhisperModelChange={(v) => updateQueueDraft({ whisperModel: v })}
              whisperTemperature={queueDraft.whisperTemperature}
              onWhisperTemperatureChange={(v) => updateQueueDraft({ whisperTemperature: v })}
              initialPrompt={queueDraft.initialPrompt}
              onInitialPromptChange={(v) => updateQueueDraft({ initialPrompt: v })}
              referenceLyrics={queueDraft.referenceLyrics}
              onReferenceLyricsChange={(v) => updateQueueDraft({ referenceLyrics: v })}
              vadEnabled={queueDraft.vadEnabled}
              onVadEnabledChange={(v) => updateQueueDraft({ vadEnabled: v })}
              vadThreshold={queueDraft.vadThreshold}
              onVadThresholdChange={(v) => updateQueueDraft({ vadThreshold: v })}
              vadMinSilenceMs={queueDraft.vadMinSilenceMs}
              onVadMinSilenceMsChange={(v) => updateQueueDraft({ vadMinSilenceMs: v })}
              vadSpeechPadMs={queueDraft.vadSpeechPadMs}
              onVadSpeechPadMsChange={(v) => updateQueueDraft({ vadSpeechPadMs: v })}
              vadMaxSpeechS={queueDraft.vadMaxSpeechS}
              onVadMaxSpeechSChange={(v) => updateQueueDraft({ vadMaxSpeechS: v })}
              isMusicVideo={queueDraft.isMusicVideo}
              onIsMusicVideoChange={setQueueMusicVideo}
              sourceLang={queueDraft.sourceLang}
              onSourceLangChange={(v) => updateQueueDraft({ sourceLang: v })}
              maxHeight={queueDraft.maxHeight}
              onMaxHeightChange={(v) => updateQueueDraft({ maxHeight: v })}
              onResetGenerationSettings={resetQueueDraft}
            />
          }
        />

        {/* The download queue (處理中) moved from a standalone strip here into
           the sidebar's 收藏 tab (handoff §6) — see the SidebarPanel below. */}

        {view === 'library' ? (
          <div
            className="rj-view-in"
            style={{
              flex: 1,
              minHeight: 0,
              display: 'flex',
              animation: 'rjViewIn 300ms cubic-bezier(.2,.8,.3,1) both',
            }}
          >
            <LibraryView
              theme={theme}
              videos={libraryVideos}
              activeVideoId={videoId}
              playlistIds={playlistIds}
              onPlay={handleLibraryPlay}
              onAddToPlaylist={addToPlaylist}
              onRegenerate={handleLibraryRegenerate}
              onDelete={handleLibraryDelete}
            />
          </div>
        ) : (
        /* Outer flex:1 column so the row below centers vertically in the
           now fixed-height card (see the card's `height` above) instead of
           sticking to the top with dead space below whenever the video is
           shorter than the available room. */
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
        {/* Two-column body (README change #3): LEFT = channel row + video +
           controls (unchanged behavior), RIGHT = the clickable subtitle-list
           sidebar. minHeight:0 lets the sidebar's own overflowY:auto scroll
           within the row's stretched height instead of growing it. */}
        <div style={{ display: 'flex', minHeight: 0 }}>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            {showChannelRow && <VideoInfo theme={theme} channelName={channelName} />}

            <VideoStage
              theme={theme}
              theaterMode={theaterMode}
              showChannelRow={showChannelRow}
              videoAspectRatio={videoAspectRatio}
              containerRef={stageContainerRef}
              isFullscreen={isFullscreen}
              videoRef={videoRef}
              videoSrc={videoSrc}
              isPlaying={isPlaying}
              onTogglePlay={togglePlay}
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
              onTimeUpdate={handleTimeUpdate}
              onLoadedMetadata={handleLoadedMetadata}
              onEnded={handleVideoEnded}
              onCanPlay={handleCanPlay}
              loadStatus={loadStatus}
              downloadPct={downloadPct}
              stageLabel={stageLabel}
              errorMessage={errorMessage}
              currentTime={currentTime}
              cues={cues}
              subSource={subSource}
              subTarget={subTarget}
              subPhonetic={subPhonetic}
              sourceStyle={sourceStyle}
              targetStyle={targetStyle}
              phoneticStyle={phoneticStyle}
              subtitleOffsetMs={subtitleOffsetMs}
              subtitleBg={subtitleBg}
              subtitleStatus={subtitleStatus}
              subtitleStage={subtitleStage}
              subtitlePct={subtitlePct}
              subtitleError={subtitleError}
              controlBar={isFullscreen ? controlBarElement : null}
            />

            {!isFullscreen && controlBarElement}
          </div>

          {showSubtitlePanel && (
            <SidebarPanel
              theme={theme}
              activeTab={sidebarTab}
              onTabChange={setSidebarTab}
              tabs={[
                {
                  key: 'collection',
                  label: '收藏',
                  badge: playlistItems.length + queueItems.length || null,
                },
                { key: 'subtitles', label: '字幕', badge: hasCues ? `${cues.length} 句` : null },
              ]}
              footer={
                // Library entry point (handoff §6) — replaces the removed
                // Titlebar 影片庫 button. Persistent across both sidebar tabs.
                <button
                  type="button"
                  onClick={() => setView('library')}
                  style={{
                    width: '100%',
                    border: `1px solid ${theme.hairline}`,
                    background: theme.segBg,
                    color: theme.textSecondary,
                    fontSize: 11,
                    fontWeight: 700,
                    padding: '8px 0',
                    borderRadius: 9,
                    cursor: 'pointer',
                  }}
                >
                  瀏覽完整影片庫 →
                </button>
              }
            >
              {sidebarTab === 'subtitles' ? (
                <SubtitleList
                  theme={theme}
                  cues={cues}
                  currentTime={currentTime}
                  subtitleOffsetMs={subtitleOffsetMs}
                  subtitleStatus={subtitleStatus}
                  subtitleStage={subtitleStage}
                  subtitlePct={subtitlePct}
                  source={docSource}
                  targetSource={docTargetSource}
                  onSeekToCue={seekToCue}
                  onEditCue={editCue}
                  onExport={handleExportSubtitles}
                />
              ) : (
                // 收藏 tab (handoff §6): download queue (處理中) pinned at top,
                // playlist (播放清單) scrolling below. The two section blocks
                // stagger their rjRowCascade entrance (~60ms apart) for the
                // subtle cascade the handoff asks for.
                <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
                  {queueItems.length > 0 && (
                    <div
                      className="rj-cascade-item"
                      style={{ flexShrink: 0, animation: 'rjRowCascade 260ms cubic-bezier(.2,.8,.3,1) both' }}
                    >
                      <div
                        style={{
                          padding: '10px 12px 4px',
                          fontSize: 10,
                          fontWeight: 700,
                          letterSpacing: 0.5,
                          color: theme.textTertiary,
                        }}
                      >
                        處理中 · {queueItems.length}
                      </div>
                      <QueueList theme={theme} items={queueItems} onCancel={handleCancelQueueItem} />
                    </div>
                  )}
                  <div
                    className="rj-cascade-item"
                    style={{
                      flexShrink: 0,
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'baseline',
                      padding: '10px 12px 4px',
                      fontSize: 10,
                      fontWeight: 700,
                      letterSpacing: 0.5,
                      color: theme.textTertiary,
                      animation: 'rjRowCascade 260ms cubic-bezier(.2,.8,.3,1) both',
                      animationDelay: '60ms',
                    }}
                  >
                    <span>播放清單 · {playlistItems.length}</span>
                    {playlistItems.length > 0 && <span style={{ fontWeight: 500 }}>拖曳排序</span>}
                  </div>
                  <PlaylistPanel
                    theme={theme}
                    items={playlistItems}
                    activeVideoId={videoId}
                    onSelect={selectPlaylistItem}
                    onRemove={removeFromPlaylist}
                    onReorder={reorderPlaylist}
                  />
                </div>
              )}
            </SidebarPanel>
          )}
        </div>
        </div>
        )}
      </div>
      </div>

      <ConfirmDialog
        open={Boolean(confirmDelete)}
        theme={theme}
        title="刪除影片？"
        message={confirmDelete ? `「${confirmDelete.title}」的影片檔、字幕與縮圖都會從硬碟移除，無法復原。` : ''}
        confirmLabel="刪除"
        cancelLabel="取消"
        danger
        onConfirm={performDelete}
        onCancel={() => setConfirmDelete(null)}
      />

      <AppSettingsPanel
        theme={theme}
        dark={darkMode}
        onDarkModeChange={setDarkMode}
        open={showAppSettings}
        onClose={() => setShowAppSettings(false)}
      />

      {notice && (
        <div
          style={{
            position: 'fixed',
            left: '50%',
            bottom: 28,
            transform: 'translateX(-50%)',
            zIndex: 1001,
            maxWidth: '80vw',
            background: 'rgba(20,20,22,0.92)',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            border: '1px solid rgba(255,255,255,0.12)',
            color: '#fff',
            fontSize: 13,
            fontWeight: 600,
            padding: '10px 16px',
            borderRadius: 10,
            boxShadow: '0 12px 40px rgba(0,0,0,0.45)',
          }}
        >
          {notice}
        </div>
      )}
    </>
  );
}
