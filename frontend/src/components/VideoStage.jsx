import { useEffect, useRef, useState } from 'react';
import { ACCENT } from '../theme.js';
import { STAGE_LABELS, formatPipelineStatusLabel } from '../utils.js';
import SubtitleOverlay from './SubtitleOverlay.jsx';

// How long the fullscreen control overlay stays visible after the mouse
// last moved, before auto-hiding (YouTube-style) — only while playing; kept
// visible indefinitely while paused (nothing to "watch" without controls).
const FULLSCREEN_CONTROLS_HIDE_DELAY_MS = 2500;

// Measured (not guessed) height of everything ABOVE/BELOW the video box when
// not fullscreen, so the width cap below (see `maxWidth`) only kicks in when
// the viewport genuinely can't fit the video at its natural width — an
// over-conservative estimate here just shrinks the video for no reason.
// Titlebar (55.5) + the 12px stage top-margin + ControlBar's margin+content
// (14+64+20=98) = 165.5, rounded up for border/line-height slop; +52 more
// when VideoInfo's channel row is also showing (its own 14+6 padding + 32px
// icon). OUTER_PADDING_PX is App.jsx's outer wrapper's 20px+20px centering
// padding, kept as a separate constant since it's independent of ControlBar/
// VideoInfo (changes only if that wrapper's own padding changes).
const CHROME_PX = 180;
const CHROME_WITH_CHANNEL_ROW_PX = 235;
const OUTER_PADDING_PX = 40;

// 16:9 video area — README §版面結構 3. Real <video> element (per dsd.md §0.1
// — NOT a YouTube iframe) replaces the prototype's CSS-stripe placeholder.
// Shows: idle hint (nothing loaded) / download progress / error / center
// play button overlay when paused / the three-layer subtitle overlay / the
// B3.4 pipeline-in-progress pill.
export default function VideoStage({
  theme,
  theaterMode,
  // Whether VideoInfo's channel row is rendered above this — changes how
  // much vertical chrome the width cap (see `maxWidth`) needs to budget for.
  showChannelRow,
  // Real width/height of the loaded video's actual pixels (from
  // <video>'s loadedmetadata), or null before that fires / with nothing
  // loaded. The stage sizes itself to this instead of a fixed 16:9 so a
  // non-16:9 source (pillarboxed TV rips, etc.) never shows a letterboxed
  // gap between the video and the box edge.
  videoAspectRatio,
  containerRef,
  isFullscreen,
  videoRef,
  videoSrc,
  isPlaying,
  onTogglePlay,
  onPlay,
  onPause,
  onTimeUpdate,
  onLoadedMetadata,
  onEnded,
  onCanPlay,
  loadStatus, // 'idle' | 'connecting' | 'downloading' | 'downloaded' | 'error'
  downloadPct,
  stageLabel,
  errorMessage,
  currentTime,
  cues,
  subSource,
  subTarget,
  subPhonetic,
  sourceStyle,
  targetStyle,
  phoneticStyle,
  subtitleOffsetMs,
  subtitleBg,
  // B3.4 — AI pipeline progress, independent of `loadStatus` (the video is
  // already playable once `loadStatus === 'downloaded'`; the pipeline can
  // still be running in the background for a while after that).
  subtitleStatus, // 'idle' | 'ready' | 'failed' | one of PIPELINE_ACTIVE_STATUSES
  subtitleStage, // raw Stage from the latest `progress` event, e.g. 'asr'
  subtitlePct,
  subtitleError,
  // Pre-built <ControlBar/> element (App.jsx instantiates it once with the
  // full prop set it already needs for the windowed layout — see App.jsx).
  // Rendered here, inside the fullscreen target, ONLY while isFullscreen —
  // outside fullscreen App.jsx renders it itself in the normal below-video
  // position. Never both at once: ControlBar's settings-gear button shares
  // a single ref/boolean (settingsAnchorRef/showSettings) with App.jsx, so
  // two simultaneously-mounted instances would fight over anchoring the
  // settings popover.
  controlBar,
}) {
  const chromeBudgetPx = OUTER_PADDING_PX + (showChannelRow ? CHROME_WITH_CHANNEL_ROW_PX : CHROME_PX);
  // Falls back to 16:9 before metadata arrives (idle placeholder, or the
  // brief moment between picking a video and its <video> firing
  // loadedmetadata) — everywhere below derives from this instead of a
  // hardcoded 16/9 so the box always matches the actual video once known.
  const ratio = videoAspectRatio || 16 / 9;

  // ---- YouTube-style auto-hiding fullscreen controls ----------------------
  const [fsControlsVisible, setFsControlsVisible] = useState(false);
  const fsHideTimerRef = useRef(null);

  function clearHideTimer() {
    if (fsHideTimerRef.current) {
      clearTimeout(fsHideTimerRef.current);
      fsHideTimerRef.current = null;
    }
  }

  function armHideTimer() {
    clearHideTimer();
    fsHideTimerRef.current = setTimeout(() => {
      setFsControlsVisible(false);
    }, FULLSCREEN_CONTROLS_HIDE_DELAY_MS);
  }

  // Purely hover-driven while playing — entering fullscreen (or resuming
  // playback within it) does NOT auto-show the controls; only actual mouse
  // movement does (handleStageMouseMove below). Paused is the one exception:
  // stays visible with no hide timer, since there's nothing to "watch"
  // without controls anyway.
  useEffect(() => {
    if (!isFullscreen) {
      clearHideTimer();
      setFsControlsVisible(false); // reset for next time fullscreen opens
      return;
    }
    if (isPlaying) {
      setFsControlsVisible(false);
      clearHideTimer();
    } else {
      setFsControlsVisible(true);
      clearHideTimer();
    }
    return clearHideTimer;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFullscreen, isPlaying]);

  function handleStageMouseMove() {
    if (!isFullscreen) return;
    setFsControlsVisible(true);
    if (isPlaying) armHideTimer();
  }

  return (
    <div
      ref={containerRef}
      onMouseMove={handleStageMouseMove}
      style={{
        // Hides the cursor along with the controls while playing+idle in
        // fullscreen (YouTube-style) — restored the instant the mouse moves
        // (handleStageMouseMove) or playback pauses.
        cursor: isFullscreen && !fsControlsVisible ? 'none' : 'default',
        // Fullscreen target (README change #4): App.jsx calls
        // containerRef.current.requestFullscreen() on this element — NOT the
        // bare <video> — so the ruby subtitle overlay stays visible in
        // fullscreen. When fullscreen, drop the margin/rounding/aspect-ratio
        // so this div fills the whole screen edge-to-edge; the <video>
        // inside already uses width/height:100% + objectFit:contain (below),
        // so it letterboxes correctly at any screen aspect ratio.
        marginTop: isFullscreen ? 0 : 12,
        // Auto side-margins ALWAYS (not just when the sidebar is absent) —
        // combined with the explicit `width` below, this centers the stage
        // in whatever room it actually has. This matters whenever `width`
        // ends up smaller than the available column: previously that only
        // happened via the height-based clamp, and margins stayed fixed at
        // 20px/0, so a short window left the (now-narrower) video sitting
        // flush left with a dead gap before the sidebar. Auto margins make
        // that gap split evenly instead, whether or not a sidebar is present.
        marginLeft: isFullscreen ? 0 : 'auto',
        marginRight: isFullscreen ? 0 : 'auto',
        position: isFullscreen ? 'fixed' : 'relative',
        // Fill the viewport when fullscreen. Required for the desktop app, where
        // the OS *window* (not this element) goes fullscreen — `100%` would only
        // fill the layout parent — so pin to the viewport instead. Harmless for
        // the browser's element-fullscreen path, which fills the screen anyway.
        inset: isFullscreen ? 0 : undefined,
        zIndex: isFullscreen ? 9999 : undefined,
        borderRadius: isFullscreen ? 0 : theaterMode ? 0 : 12,
        overflow: 'hidden',
        background: '#0b0b0c',
        // Stringified: React appends "px" to bare numeric style values for
        // properties it doesn't know are unitless, which would silently
        // break this (invalid CSS, e.g. "1.77px") depending on React
        // version.
        aspectRatio: isFullscreen ? 'auto' : String(ratio),
        // `min(...)` picks whichever is tighter: the column's own width
        // (fitting the original 20px/0 gutters, preserved by subtracting
        // them here since auto margins no longer imply a fixed gutter on
        // their own) or the height-derived budget. Auto margins center
        // whatever that resolves to — filling the column exactly like
        // before when that's the binding constraint, or centering a
        // shrunk box when the height budget is tighter.
        width: isFullscreen
          ? '100vw'
          : `min(${theaterMode ? '100%' : 'calc(100% - 40px)'}, calc((100vh - ${chromeBudgetPx}px) * ${ratio}))`,
        height: isFullscreen ? '100vh' : undefined,
        // Establishes a query container so SubtitleOverlay's font sizes (in
        // cqw/cqh) scale with THIS box's actual rendered size — the same
        // box the video letterboxes into via objectFit:contain below — so
        // subtitles stay proportionally sized whether this is the small
        // windowed 16:9 box or a full physical-screen fullscreen box,
        // instead of staying pinned at a fixed px size tuned for one of
        // them.
        containerType: 'size',
      }}
    >
      {videoSrc ? (
        <video
          ref={videoRef}
          src={videoSrc}
          preload="metadata"
          playsInline
          onClick={onTogglePlay}
          onPlay={onPlay}
          onPause={onPause}
          onTimeUpdate={onTimeUpdate}
          onLoadedMetadata={onLoadedMetadata}
          onDurationChange={onLoadedMetadata}
          onEnded={onEnded}
          onCanPlay={onCanPlay}
          style={{ width: '100%', height: '100%', display: 'block', objectFit: 'contain', background: '#000' }}
        />
      ) : (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            backgroundImage:
              'repeating-linear-gradient(135deg,rgba(255,255,255,0.03) 0 2px,transparent 2px 14px)',
          }}
        />
      )}

      {loadStatus !== 'downloaded' && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
            color: 'rgba(255,255,255,0.85)',
            padding: '0 24px',
            textAlign: 'center',
            background: 'rgba(0,0,0,0.15)',
          }}
        >
          {loadStatus === 'idle' && (
            <>
              <div
                style={{
                  fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace',
                  fontSize: 12,
                  letterSpacing: 1,
                  color: 'rgba(255,255,255,0.35)',
                }}
              >
                尚未載入影片
              </div>
              <div
                style={{
                  fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace',
                  fontSize: 11,
                  color: 'rgba(255,255,255,0.3)',
                }}
              >
                貼上 YouTube 連結後點擊「載入」
              </div>
            </>
          )}

          {(loadStatus === 'connecting' || loadStatus === 'downloading') && (
            <>
              <div style={{ fontSize: 13, fontWeight: 600 }}>
                {STAGE_LABELS[stageLabel] || '準備中'}
                {downloadPct != null ? `… ${downloadPct}%` : '…'}
              </div>
              <div style={{ width: 220, height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.15)', overflow: 'hidden' }}>
                <div
                  style={{
                    height: '100%',
                    width: `${downloadPct ?? 0}%`,
                    background: ACCENT,
                    borderRadius: 3,
                    transition: 'width 0.2s',
                  }}
                />
              </div>
            </>
          )}

          {loadStatus === 'error' && (
            <div style={{ fontSize: 13, fontWeight: 600, color: '#ff8a80', maxWidth: 280 }}>
              載入失敗：{errorMessage}
            </div>
          )}
        </div>
      )}

      {loadStatus === 'downloaded' && !isPlaying && (
        <div
          onClick={onTogglePlay}
          style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
        >
          <div
            style={{
              width: 68,
              height: 68,
              borderRadius: '50%',
              background: 'rgba(0,0,0,0.42)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              backdropFilter: 'blur(10px) saturate(160%)',
              WebkitBackdropFilter: 'blur(10px) saturate(160%)',
              border: '0.5px solid rgba(255,255,255,0.18)',
            }}
          >
            <div
              style={{
                width: 0,
                height: 0,
                borderTop: '13px solid transparent',
                borderBottom: '13px solid transparent',
                borderLeft: '20px solid #fff',
                marginLeft: 5,
              }}
            />
          </div>
        </div>
      )}

      {loadStatus === 'downloaded' && (subtitleStatus === 'failed' || (subtitleStatus && subtitleStatus !== 'idle' && subtitleStatus !== 'ready')) && (
        <div
          style={{
            position: 'absolute',
            top: 10,
            right: 10,
            maxWidth: 240,
            padding: '5px 10px',
            borderRadius: 999,
            background: 'rgba(0,0,0,0.5)',
            backdropFilter: 'blur(6px)',
            WebkitBackdropFilter: 'blur(6px)',
            color: subtitleStatus === 'failed' ? '#ff8a80' : 'rgba(255,255,255,0.85)',
            fontSize: 11,
            fontWeight: 600,
            textAlign: 'right',
            pointerEvents: 'none',
          }}
        >
          {subtitleStatus === 'failed'
            ? `字幕處理失敗：${subtitleError || '未知錯誤'}`
            : formatPipelineStatusLabel(subtitleStatus, subtitleStage, subtitlePct)}
        </div>
      )}

      <SubtitleOverlay
        cues={cues}
        currentTime={currentTime}
        subSource={subSource}
        subTarget={subTarget}
        subPhonetic={subPhonetic}
        sourceStyle={sourceStyle}
        targetStyle={targetStyle}
        phoneticStyle={phoneticStyle}
        subtitleOffsetMs={subtitleOffsetMs}
        subtitleBg={subtitleBg}
        isFullscreen={isFullscreen}
      />

      {isFullscreen && controlBar && (
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            paddingTop: 48,
            background: 'linear-gradient(to top, rgba(0,0,0,0.82), rgba(0,0,0,0.45) 60%, transparent)',
            opacity: fsControlsVisible ? 1 : 0,
            // Un-hittable while hidden — otherwise an invisible ControlBar
            // still eats clicks meant for the video underneath it.
            pointerEvents: fsControlsVisible ? 'auto' : 'none',
            transition: 'opacity 0.2s ease',
          }}
        >
          {controlBar}
        </div>
      )}
    </div>
  );
}
