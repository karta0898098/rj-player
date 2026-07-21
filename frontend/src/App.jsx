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
import { getTheme } from './theme.js';
import {
  formatTime,
  PIPELINE_ACTIVE_STATUSES,
  GENERATION_SETTINGS_DEFAULTS,
  MUSIC_GENERATION_PRESET,
  loadGenerationSettings,
  saveGenerationSettings,
  buildGenerationSettingsPayload,
  loadPlaylist,
  savePlaylist,
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
  // VideoStage's outer 16:9 container (video + SubtitleOverlay) — the
  // fullscreen target (README change #4), so the ruby subtitle overlay is
  // included in fullscreen instead of just the bare <video>.
  const stageContainerRef = useRef(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
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
  // is 0..1 intensity; romaji defaults to 0 (no shadow) matching its
  // pre-existing look, jp/cn default to 0.6 matching their old fixed values.
  const [subJP, setSubJP] = useState(true);
  const [subCN, setSubCN] = useState(true);
  const [subRomaji, setSubRomaji] = useState(true);
  const [jpStyle, setJpStyle] = useState({ scale: 1, color: '#ffffff', shadow: 0.6 });
  // Default colors match the pre-existing fixed values for CN/romaji
  // (dimmer than JP by design) — not one of the swatch presets, so the
  // swatch row just shows no active selection until the user picks one.
  const [cnStyle, setCnStyle] = useState({ scale: 1, color: 'rgba(255,255,255,0.82)', shadow: 0.6 });
  const [romajiStyle, setRomajiStyle] = useState({ scale: 1, color: 'rgba(255,255,255,0.55)', shadow: 0 });
  // Each SubtitleLayerPanel control (size/color/shadow) calls its layer's
  // onXxxStyleChange with just the one field that changed — these merge it
  // into the existing style object rather than requiring the caller to
  // spread the other two fields itself.
  function updateJpStyle(partial) {
    setJpStyle((s) => ({ ...s, ...partial }));
  }
  function updateCnStyle(partial) {
    setCnStyle((s) => ({ ...s, ...partial }));
  }
  function updateRomajiStyle(partial) {
    setRomajiStyle((s) => ({ ...s, ...partial }));
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

  // ---- queue feature: add-to-queue draft + queue list --------------------
  // `queueDraft` is the per-item ASR/generation options (+ music-MV flag)
  // for whatever URL currently sits in the Titlebar input, independent of
  // the `whisperModel`/etc. state above (which is scoped to "regenerate the
  // CURRENTLY LOADED video" and must not be silently mutated just because
  // the user pasted a new URL). Starts from the same persisted
  // localStorage defaults so a user's preferred whisper model etc. carries
  // over, but is otherwise a fresh, independently-editable draft per URL.
  const [queueDraft, setQueueDraft] = useState(() => ({
    ...loadGenerationSettings(),
    isMusicVideo: false,
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
  const [sidebarTab, setSidebarTab] = useState('subtitles'); // 'subtitles' | 'playlist'

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
  async function selectPlaylistItem(id) {
    if (!id || id === videoId) return;
    resetPlaybackState();
    setLoadStatus('connecting');
    setVideoId(id);
    await finalizeReady(id);
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
      ...(checked ? MUSIC_GENERATION_PRESET : {}),
    }));
  }

  function resetQueueDraft() {
    queueTouchedRef.current = false;
    setQueueDraft({ ...GENERATION_SETTINGS_DEFAULTS, isMusicVideo: false });
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
  // (queue feature's music-MV auto-detect): on a genuinely new URL, resets
  // the draft to persisted defaults, then -- once the preview resolves --
  // auto-applies the music preset if is_music is true and the user hasn't
  // already hand-edited a field for this same URL.
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
      setQueueDraft({ ...loadGenerationSettings(), isMusicVideo: false });
      setQueuePreviewLoading(true);
      setQueuePreviewError(null);
      try {
        const data = await previewVideo(url);
        setQueuePreview(data);
        if (data.is_music && !queueTouchedRef.current) {
          setQueueDraft((d) => ({ ...d, isMusicVideo: true, ...MUSIC_GENERATION_PRESET }));
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
      setSubtitleStatus('ready');
    } catch (err) {
      setSubtitleStatus('failed');
      setSubtitleError(err.message || '字幕載入失敗');
    }
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
      const data = await createVideo(url, queueDraft, queueDraft.isMusicVideo);
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

  // Fullscreens/exits VideoStage's outer container (stageContainerRef), NOT
  // the bare <video> — see the module-level helpers above and README change
  // #4. No-ops (rather than throwing) on browsers without any Fullscreen API.
  function toggleFullscreen() {
    const el = stageContainerRef.current;
    if (!el) return;
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
  const showSubtitlePanel = hasCues || (subtitleStatus && subtitleStatus !== 'idle') || playlistIds.length > 0;
  const showChannelRow = !theaterMode && Boolean(channelName);

  // PlaylistPanel's ordered row data: playlistIds (user-reorderable) enriched
  // with the latest known title/channel/status/is_music_video from
  // videoLookup (the same GET /api/videos poll that drives QueueList). Falls
  // back to a bare video_id for an item whose first poll hasn't landed yet.
  const playlistItems = playlistIds.map(
    (id) => videoLookup[id] || { video_id: id, title: '', channel: '', status: 'new', is_music_video: false }
  );

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
          subJP={subJP}
          onToggleSubJP={() => setSubJP((s) => !s)}
          subCN={subCN}
          onToggleSubCN={() => setSubCN((s) => !s)}
          subRomaji={subRomaji}
          onToggleSubRomaji={() => setSubRomaji((s) => !s)}
          jpStyle={jpStyle}
          onJpStyleChange={updateJpStyle}
          cnStyle={cnStyle}
          onCnStyleChange={updateCnStyle}
          romajiStyle={romajiStyle}
          onRomajiStyleChange={updateRomajiStyle}
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
      <AmbientBackground dark={darkMode} videoSrc={videoSrc} videoRef={videoRef} />
      <div style={{ position: 'relative', zIndex: 1, width: '100%', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px', boxSizing: 'border-box' }}>
      <div
        style={{
          background: theme.winBg,
          // Scales with the actual viewport (vw) instead of a fixed px
          // width, capped generously so it keeps growing on large monitors
          // instead of plateauing at a size tuned for a ~1440px-wide
          // laptop screen — the playback area being as large as possible
          // matters more than showing off AmbientBackground's glow around
          // a smaller window (still visible at any size that doesn't fill
          // the viewport, just less of it).
          width: theaterMode ? 'min(97vw, 2400px)' : 'min(94vw, 2000px)',
          maxWidth: '100%',
          // Caps the window so it can never grow taller than the viewport
          // (matches the wrapper's 20px top+bottom padding above). Without
          // this, a long cue list just keeps growing the whole window
          // instead of triggering SubtitleList's own overflowY:auto — its
          // scroll container never actually overflows, so scrollIntoView
          // falls through to scrolling the BROWSER PAGE on every active-cue
          // change instead of scrolling internally.
          maxHeight: 'calc(100vh - 40px)',
          borderRadius: 20,
          overflow: 'hidden',
          boxShadow: darkMode
            ? '0 0 0 1px rgba(255,255,255,0.06), 0 30px 90px rgba(0,0,0,0.6), 0 0 140px rgba(224,69,63,0.09)'
            : '0 0 0 1px rgba(0,0,0,0.08), 0 24px 60px rgba(0,0,0,0.22)',
          display: 'flex',
          flexDirection: 'column',
          fontFamily: "-apple-system,BlinkMacSystemFont,'SF Pro','Helvetica Neue',sans-serif",
        }}
      >
        <Titlebar
          theme={theme}
          darkMode={darkMode}
          onToggleDark={() => setDarkMode((d) => !d)}
          videoTitle={videoTitle}
          urlInput={urlInput}
          onUrlChange={setUrlInput}
          onUrlSubmit={handleUrlSubmit}
          loading={queueSubmitting}
          optionsAnchorRef={queueOptionsAnchorRef}
          showOptions={showQueueOptions}
          onToggleOptions={() => setShowQueueOptions((s) => !s)}
          optionsSlot={
            <AddToQueuePopover
              theme={theme}
              dark={darkMode}
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
              onResetGenerationSettings={resetQueueDraft}
              onSubmit={handleUrlSubmit}
              submitDisabled={queueSubmitting || !urlInput.trim()}
              submitting={queueSubmitting}
            />
          }
        />

        <QueueList theme={theme} items={queueItems} onCancel={handleCancelQueueItem} />

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
              onTimeUpdate={(e) => setCurrentTime(e.target.currentTime)}
              onLoadedMetadata={(e) => {
                if (Number.isFinite(e.target.duration)) setDuration(e.target.duration);
                if (e.target.videoWidth && e.target.videoHeight) {
                  setVideoAspectRatio(e.target.videoWidth / e.target.videoHeight);
                }
              }}
              onEnded={() => setIsPlaying(false)}
              loadStatus={loadStatus}
              downloadPct={downloadPct}
              stageLabel={stageLabel}
              errorMessage={errorMessage}
              currentTime={currentTime}
              cues={cues}
              subJP={subJP}
              subCN={subCN}
              subRomaji={subRomaji}
              jpStyle={jpStyle}
              cnStyle={cnStyle}
              romajiStyle={romajiStyle}
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
                { key: 'subtitles', label: '字幕', badge: hasCues ? `${cues.length} 句` : null },
                { key: 'playlist', label: '播放清單', badge: playlistItems.length ? playlistItems.length : null },
              ]}
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
                  onSeekToCue={seekToCue}
                />
              ) : (
                <PlaylistPanel
                  theme={theme}
                  items={playlistItems}
                  activeVideoId={videoId}
                  onSelect={selectPlaylistItem}
                  onRemove={removeFromPlaylist}
                  onReorder={reorderPlaylist}
                />
              )}
            </SidebarPanel>
          )}
        </div>
      </div>
      </div>
    </>
  );
}
