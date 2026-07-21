import { useEffect, useRef, useState } from 'react';
import AmbientBackground from './components/AmbientBackground.jsx';
import Titlebar from './components/Titlebar.jsx';
import VideoInfo from './components/VideoInfo.jsx';
import VideoStage from './components/VideoStage.jsx';
import ControlBar from './components/ControlBar.jsx';
import SubtitleList from './components/SubtitleList.jsx';
import SettingsPopover from './components/SettingsPopover.jsx';
import { getTheme } from './theme.js';
import {
  formatTime,
  PIPELINE_ACTIVE_STATUSES,
  GENERATION_SETTINGS_DEFAULTS,
  loadGenerationSettings,
  saveGenerationSettings,
  buildGenerationSettingsPayload,
} from './utils.js';
import { createVideo, getVideo, getSubtitles, videoEventsUrl, mediaUrl, regeneratePipeline } from './api.js';

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
  const [volume, setVolume] = useState(70);
  const lastVolumeRef = useRef(70);
  const [speed, setSpeed] = useState(1);

  // ---- subtitle layer toggles + style (B3.3 — wired to SubtitleOverlay) ----
  const [subJP, setSubJP] = useState(true);
  const [subCN, setSubCN] = useState(true);
  const [subRomaji, setSubRomaji] = useState(true);
  const [fontScale, setFontScale] = useState(1);
  const [jpColor, setJpColor] = useState('#ffffff');
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

  async function handleUrlSubmit(e) {
    e.preventDefault();
    const url = urlInput.trim();
    if (!url || loadStatus === 'connecting' || loadStatus === 'downloading') return;

    resetPlaybackState();
    setLoadStatus('connecting');

    try {
      const data = await createVideo(url);
      const id = data.video_id;
      setVideoId(id);
      setUrlInput('');

      if (data.status === 'downloaded' || data.status === 'ready') {
        // Cached hit — dsd.md §3.1: "若已快取 ready → 200 { status:"ready" }"
        await finalizeReady(id);
      } else {
        setLoadStatus('downloading');
        connectEvents(id);
      }
    } catch (err) {
      setLoadStatus('error');
      setErrorMessage(err.message || '載入失敗');
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

  return (
    <>
      <AmbientBackground dark={darkMode} videoSrc={videoSrc} videoRef={videoRef} />
      <div style={{ position: 'relative', zIndex: 1, width: '100%', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px 20px', boxSizing: 'border-box' }}>
      <div
        style={{
          background: theme.winBg,
          width: theaterMode ? 1440 : 1320,
          maxWidth: '100%',
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
          loading={loadStatus === 'connecting' || loadStatus === 'downloading'}
        />

        {/* Two-column body (README change #3): LEFT = channel row + video +
            controls (unchanged behavior), RIGHT = the clickable subtitle-list
            sidebar. minHeight:0 lets the sidebar's own overflowY:auto scroll
            within the row's stretched height instead of growing it. */}
        <div style={{ display: 'flex', minHeight: 0 }}>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            {!theaterMode && channelName && <VideoInfo theme={theme} channelName={channelName} />}

            <VideoStage
              theme={theme}
              theaterMode={theaterMode}
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
              fontScale={fontScale}
              jpColor={jpColor}
              subtitleOffsetMs={subtitleOffsetMs}
              subtitleBg={subtitleBg}
              subtitleStatus={subtitleStatus}
              subtitleStage={subtitleStage}
              subtitlePct={subtitlePct}
              subtitleError={subtitleError}
            />

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
              subJP={subJP}
              subCN={subCN}
              subRomaji={subRomaji}
              onToggleSubJP={() => setSubJP((s) => !s)}
              onToggleSubCN={() => setSubCN((s) => !s)}
              onToggleSubRomaji={() => setSubRomaji((s) => !s)}
              translatePartial={translatePartial}
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
                  fontScale={fontScale}
                  onFontScaleChange={setFontScale}
                  jpColor={jpColor}
                  onJpColorChange={setJpColor}
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
                />
              }
            />
          </div>

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
        </div>
      </div>
      </div>
    </>
  );
}
