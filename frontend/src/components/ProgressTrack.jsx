import { useEffect, useRef, useState } from 'react';
import { ACCENT } from '../theme.js';
import { formatTime } from '../utils.js';

// 160×90 (16:9) hover-preview frame, matching a YouTube-style scrub preview.
const PREVIEW_W = 160;
const PREVIEW_H = 90;

// Custom progress track — README §控制列: 6px rounded track, drag-to-seek via
// pointer capture, hover tooltip with time code, 12px white thumb, accent fill.
//
// Hover-preview frame (added once real media exists — the Phase 1 seam the
// original tooltip comment left open): a second, hidden <video> pointed at the
// same locally-downloaded, Range-served mp4 (`previewSrc`) is seeked to the
// hovered timestamp so the tooltip shows the actual frame there. Kept mounted
// (not remounted per hover) so buffered byte-ranges survive between hovers, and
// seeks are throttled to one per animation frame so dragging across the bar
// doesn't queue hundreds of them. No backend/sprite-sheet needed — seeking a
// local file is cheap.
export default function ProgressTrack({ theme, currentTime, duration, onSeek, previewSrc, disabled }) {
  const [hoverInfo, setHoverInfo] = useState(null); // { pxLeft, time, seconds }
  const draggingRef = useRef(false);
  const previewRef = useRef(null);
  const pendingSeekRef = useRef(null);
  const rafRef = useRef(0);
  const pct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
  const previewEnabled = Boolean(previewSrc) && !disabled && duration > 0;

  // Coalesce rapid currentTime writes (one per frame): store the latest target
  // and apply it in a single rAF, skipping no-op seeks.
  function schedulePreviewSeek(seconds) {
    pendingSeekRef.current = seconds;
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      const v = previewRef.current;
      const target = pendingSeekRef.current;
      if (v && target != null && Number.isFinite(v.duration)) {
        if (Math.abs(v.currentTime - target) > 0.05) v.currentTime = target;
      }
    });
  }
  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  function seekPctFromEvent(e) {
    const rect = e.currentTarget.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  }

  function updateHover(e, p) {
    const rect = e.currentTarget.getBoundingClientRect();
    // Clamp the tooltip's center so the 160px frame never spills past either
    // end of the track.
    const half = PREVIEW_W / 2;
    const pxLeft = Math.min(rect.width - half, Math.max(half, p * rect.width));
    const seconds = p * (duration || 0);
    setHoverInfo({ pxLeft, time: formatTime(seconds), seconds });
    if (previewEnabled) schedulePreviewSeek(seconds);
  }

  function onPointerDown(e) {
    if (disabled) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    draggingRef.current = true;
    onSeek(seekPctFromEvent(e));
  }
  function onPointerMove(e) {
    if (disabled) return;
    const p = seekPctFromEvent(e);
    updateHover(e, p);
    if (draggingRef.current) onSeek(p);
  }
  function onPointerUp() {
    draggingRef.current = false;
  }
  function onPointerLeave() {
    if (!draggingRef.current) setHoverInfo(null);
  }

  return (
    <div style={{ position: 'relative', paddingTop: 14 }}>
      {/* Hidden scrub-preview video: kept mounted whenever media is loaded so
          its buffered ranges persist across hovers. It's the element the
          tooltip below reuses, positioned there via the wrapper. */}
      {previewEnabled && (
        <div
          style={{
            position: 'absolute',
            bottom: 20,
            left: hoverInfo ? hoverInfo.pxLeft : 0,
            transform: 'translateX(-50%)',
            opacity: hoverInfo ? 1 : 0,
            visibility: hoverInfo ? 'visible' : 'hidden',
            transition: 'opacity 0.1s',
            pointerEvents: 'none',
            zIndex: 5,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 5,
          }}
        >
          <video
            ref={previewRef}
            src={previewSrc}
            muted
            playsInline
            preload="metadata"
            style={{
              width: PREVIEW_W,
              height: PREVIEW_H,
              objectFit: 'cover',
              borderRadius: 7,
              background: '#000',
              boxShadow: '0 6px 20px rgba(0,0,0,0.55)',
              border: '1px solid rgba(255,255,255,0.14)',
              display: 'block',
            }}
          />
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: '#fff',
              textShadow: '0 1px 3px rgba(0,0,0,0.9)',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {hoverInfo?.time}
          </div>
        </div>
      )}

      {/* Time-only tooltip fallback when there's no scrub-preview video yet
          (e.g. media not loaded) — preserves the original behavior. */}
      {!previewEnabled && hoverInfo && (
        <div
          style={{
            position: 'absolute',
            bottom: 20,
            left: hoverInfo.pxLeft,
            transform: 'translateX(-50%)',
            background: 'rgba(0,0,0,0.85)',
            borderRadius: 8,
            padding: '8px 12px',
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
            zIndex: 5,
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 600, color: '#fff' }}>{hoverInfo.time}</div>
        </div>
      )}

      <div
        style={{
          position: 'relative',
          height: 6,
          borderRadius: 3,
          background: theme.trackBg,
          cursor: disabled ? 'default' : 'pointer',
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerLeave}
      >
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            bottom: 0,
            width: `${pct}%`,
            background: ACCENT,
            borderRadius: 3,
          }}
        />
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: `${pct}%`,
            width: 12,
            height: 12,
            marginTop: -6,
            marginLeft: -6,
            borderRadius: '50%',
            background: '#fff',
            boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
          }}
        />
      </div>
    </div>
  );
}
