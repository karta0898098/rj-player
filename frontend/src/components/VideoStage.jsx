import { ACCENT } from '../theme.js';
import { STAGE_LABELS, formatPipelineStatusLabel } from '../utils.js';
import SubtitleOverlay from './SubtitleOverlay.jsx';

// 16:9 video area — README §版面結構 3. Real <video> element (per dsd.md §0.1
// — NOT a YouTube iframe) replaces the prototype's CSS-stripe placeholder.
// Shows: idle hint (nothing loaded) / download progress / error / center
// play button overlay when paused / the three-layer subtitle overlay / the
// B3.4 pipeline-in-progress pill.
export default function VideoStage({
  theme,
  theaterMode,
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
  loadStatus, // 'idle' | 'connecting' | 'downloading' | 'downloaded' | 'error'
  downloadPct,
  stageLabel,
  errorMessage,
  currentTime,
  cues,
  subJP,
  subCN,
  subRomaji,
  fontScale,
  jpColor,
  subtitleOffsetMs,
  subtitleBg,
  // B3.4 — AI pipeline progress, independent of `loadStatus` (the video is
  // already playable once `loadStatus === 'downloaded'`; the pipeline can
  // still be running in the background for a while after that).
  subtitleStatus, // 'idle' | 'ready' | 'failed' | one of PIPELINE_ACTIVE_STATUSES
  subtitleStage, // raw Stage from the latest `progress` event, e.g. 'asr'
  subtitlePct,
  subtitleError,
}) {
  return (
    <div
      ref={containerRef}
      style={{
        // Fullscreen target (README change #4): App.jsx calls
        // containerRef.current.requestFullscreen() on this element — NOT the
        // bare <video> — so the ruby subtitle overlay stays visible in
        // fullscreen. When fullscreen, drop the margin/rounding/aspect-ratio
        // so this div fills the whole screen edge-to-edge; the <video>
        // inside already uses width/height:100% + objectFit:contain (below),
        // so it letterboxes correctly at any screen aspect ratio.
        margin: isFullscreen ? 0 : theaterMode ? '12px 0 0' : '12px 20px 0',
        position: 'relative',
        borderRadius: isFullscreen ? 0 : theaterMode ? 0 : 12,
        overflow: 'hidden',
        background: '#0b0b0c',
        aspectRatio: isFullscreen ? 'auto' : '16/9',
        width: isFullscreen ? '100%' : undefined,
        height: isFullscreen ? '100%' : undefined,
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
              width: 64,
              height: 64,
              borderRadius: '50%',
              background: 'rgba(0,0,0,0.5)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              backdropFilter: 'blur(6px)',
              WebkitBackdropFilter: 'blur(6px)',
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
        subJP={subJP}
        subCN={subCN}
        subRomaji={subRomaji}
        fontScale={fontScale}
        jpColor={jpColor}
        subtitleOffsetMs={subtitleOffsetMs}
        subtitleBg={subtitleBg}
      />
    </div>
  );
}
