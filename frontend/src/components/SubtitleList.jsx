import { useEffect, useRef, useState } from 'react';
import { ACCENT } from '../theme.js';
import { findActiveCue, formatTime, formatPipelineStatusLabel, PIPELINE_ACTIVE_STATUSES } from '../utils.js';

// Subtitle-list body — one of two tabs hosted inside SidebarPanel.jsx (the
// other being PlaylistPanel.jsx); SidebarPanel owns the shared width/
// collapse/tab-header chrome, this component owns only the scrollable cue
// list itself. Mirrors the EXACT active-cue lookup SubtitleOverlay.jsx uses —
// findActiveCue(cues, currentTime*1000 - subtitleOffsetMs) — so the
// highlighted row here and the on-video subtitle never disagree about which
// cue is active. Clicking a row seeks via onSeekToCue (wired to App.jsx,
// which sets videoRef.current.currentTime + setCurrentTime). Requires its
// parent to be `position: relative` -- the "回到目前播放" button anchors to it.
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
  // Whether the list should keep auto-scrolling the active row into view.
  // Starts pinned (old behavior); the moment the user scrolls the list by
  // hand it un-pins so their position stops getting yanked back down on
  // every cue change — they get it back via the "回到目前播放" button or by
  // clicking a row.
  const [pinned, setPinned] = useState(true);
  const activeRowRef = useRef(null);
  // Guards handleScroll against reacting to our OWN scrollIntoView calls
  // (fired below) as if they were user-initiated scrolling.
  const programmaticScrollRef = useRef(false);

  const hasCues = Boolean(cues && cues.length);
  const lookupMs = currentTime * 1000 - (subtitleOffsetMs || 0);
  const activeCue = hasCues ? findActiveCue(cues, lookupMs) : null;
  const activeId = activeCue ? activeCue.id : null;

  // Auto-scroll the active row into view — only while `pinned`. `block:
  // 'nearest'` only moves the list's own scroll container (the nearest
  // scrollable ancestor of the row), never the page itself.
  useEffect(() => {
    if (!pinned || !activeRowRef.current) return;
    programmaticScrollRef.current = true;
    activeRowRef.current.scrollIntoView({ block: 'nearest' });
    // The resulting 'scroll' event fires asynchronously (next frame) — clear
    // the guard just after so a genuine user scroll right afterwards isn't
    // mistaken for our own.
    const t = setTimeout(() => {
      programmaticScrollRef.current = false;
    }, 100);
    return () => clearTimeout(t);
  }, [activeId, pinned]);

  function handleScroll() {
    if (programmaticScrollRef.current) return;
    setPinned(false);
  }

  function handleRowClick(cue) {
    setPinned(true);
    onSeekToCue(cue);
  }

  function jumpToCurrent() {
    setPinned(true);
    if (activeRowRef.current) {
      activeRowRef.current.scrollIntoView({ block: 'nearest' });
    }
  }

  return (
    <>
      <div onScroll={handleScroll} className="subtitle-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
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
                onClick={() => handleRowClick(cue)}
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

      {!pinned && hasCues && activeId != null && (
        <button
          type="button"
          onClick={jumpToCurrent}
          style={{
            position: 'absolute',
            left: '50%',
            bottom: 14,
            transform: 'translateX(-50%)',
            padding: '6px 12px',
            borderRadius: 999,
            border: 'none',
            background: ACCENT,
            color: '#fff',
            fontSize: 11,
            fontWeight: 700,
            cursor: 'pointer',
            boxShadow: '0 4px 14px rgba(0,0,0,0.35)',
          }}
        >
          ↓ 回到目前播放
        </button>
      )}
    </>
  );
}
