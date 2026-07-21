import { useRef, useState } from 'react';
import { ACCENT } from '../theme.js';
import { formatTime } from '../utils.js';

// Custom progress track — README §控制列: 6px rounded track, drag-to-seek via
// pointer capture, hover tooltip with time code, 12px white thumb, accent fill.
//
// The prototype's hover tooltip also shows a JP subtitle preview line under
// the time code; that part is intentionally omitted here (no subtitle data
// exists in Phase 1 — see SubtitleOverlay.jsx for the Phase 3 seam).
export default function ProgressTrack({ theme, currentTime, duration, onSeek, disabled }) {
  const [hoverInfo, setHoverInfo] = useState(null); // { pct, time }
  const draggingRef = useRef(false);
  const pct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

  function seekPctFromEvent(e) {
    const rect = e.currentTarget.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
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
    setHoverInfo({ pct: p * 100, time: formatTime(p * (duration || 0)) });
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
      {hoverInfo && (
        <div
          style={{
            position: 'absolute',
            bottom: 20,
            left: `${hoverInfo.pct}%`,
            transform: 'translateX(-50%)',
            background: 'rgba(0,0,0,0.85)',
            borderRadius: 8,
            padding: '8px 12px',
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
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
