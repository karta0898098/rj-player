import { useEffect, useRef } from 'react';
import { ACCENT } from '../theme.js';
import { findActiveCue, formatTime, formatPipelineStatusLabel, PIPELINE_ACTIVE_STATUSES } from '../utils.js';

// Subtitle-list sidebar — right column of the two-column layout (README
// change #3). Mirrors the EXACT active-cue lookup SubtitleOverlay.jsx uses —
// findActiveCue(cues, currentTime*1000 - subtitleOffsetMs) — so the
// highlighted row here and the on-video subtitle never disagree about which
// cue is active. Clicking a row seeks via onSeekToCue (wired to App.jsx,
// which sets videoRef.current.currentTime + setCurrentTime).
export default function SubtitleList({
  theme,
  cues,
  currentTime,
  subtitleOffsetMs,
  subtitleStatus,
  subtitleStage,
  subtitlePct,
  onSeekToCue,
}) {
  const activeRowRef = useRef(null);

  const hasCues = Boolean(cues && cues.length);
  const lookupMs = currentTime * 1000 - (subtitleOffsetMs || 0);
  const activeCue = hasCues ? findActiveCue(cues, lookupMs) : null;
  const activeId = activeCue ? activeCue.id : null;

  // Auto-scroll the active row into view — `block: 'nearest'` only moves the
  // list's own scroll container (the nearest scrollable ancestor of the
  // row), never the page itself.
  useEffect(() => {
    if (activeRowRef.current) {
      activeRowRef.current.scrollIntoView({ block: 'nearest' });
    }
  }, [activeId]);

  return (
    <div
      style={{
        width: 340,
        flexShrink: 0,
        borderLeft: `1px solid ${theme.border}`,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
      <div
        style={{
          flexShrink: 0,
          padding: '14px 16px',
          borderBottom: `1px solid ${theme.border}`,
          display: 'flex',
          alignItems: 'baseline',
          gap: 8,
        }}
      >
        <span style={{ color: theme.textPrimary, fontSize: 13, fontWeight: 700 }}>字幕</span>
        {hasCues && <span style={{ color: theme.textTertiary, fontSize: 11 }}>{cues.length} 句</span>}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {!hasCues ? (
          <div
            style={{
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '0 24px',
              textAlign: 'center',
            }}
          >
            <span style={{ color: theme.textTertiary, fontSize: 12, lineHeight: 1.6 }}>
              {PIPELINE_ACTIVE_STATUSES.has(subtitleStatus)
                ? formatPipelineStatusLabel(subtitleStatus, subtitleStage, subtitlePct)
                : '字幕會顯示在這裡（可點擊跳轉）'}
            </span>
          </div>
        ) : (
          cues.map((cue) => {
            const isActive = cue.id === activeId;
            return (
              <div
                key={cue.id}
                ref={isActive ? activeRowRef : null}
                className="subtitle-row"
                onClick={() => onSeekToCue(cue)}
                style={{
                  display: 'flex',
                  gap: 10,
                  alignItems: 'flex-start',
                  padding: '8px 14px 8px 12px',
                  cursor: 'pointer',
                  borderLeft: `3px solid ${isActive ? ACCENT : 'transparent'}`,
                  background: isActive ? 'rgba(224,69,63,0.14)' : 'transparent',
                }}
              >
                <div
                  style={{
                    flexShrink: 0,
                    minWidth: 34,
                    paddingTop: 1,
                    fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace',
                    fontSize: 11,
                    color: theme.textTertiary,
                  }}
                >
                  {formatTime(cue.start_ms / 1000)}
                </div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div
                    style={{
                      color: theme.textPrimary,
                      fontSize: 13,
                      fontWeight: isActive ? 700 : 500,
                      lineHeight: 1.4,
                      wordBreak: 'break-word',
                    }}
                  >
                    {cue.ja_text}
                  </div>
                  {cue.zh_text && (
                    <div
                      style={{
                        color: theme.textSecondary,
                        fontSize: 11,
                        marginTop: 2,
                        lineHeight: 1.4,
                        wordBreak: 'break-word',
                      }}
                    >
                      {cue.zh_text}
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
