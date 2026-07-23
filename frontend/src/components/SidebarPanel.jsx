import { useState } from 'react';

const EXPANDED_WIDTH = 340;
const COLLAPSED_WIDTH = 44;

// Fixed per-tab icons (design handoff §側邊欄) — this sidebar only ever hosts
// these two tabs, so a small key->icon map here is simpler than threading
// icon elements through App.jsx's generic tab descriptors.
const TAB_ICONS = {
  playlist: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path d="M4 6h11M4 12h11M4 18h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="20" cy="6" r="1.6" fill="currentColor" />
      <circle cx="20" cy="12" r="1.6" fill="currentColor" />
      <circle cx="20" cy="18" r="1.6" fill="currentColor" />
    </svg>
  ),
  subtitles: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path d="M4 6h16M4 12h10M4 18h7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  ),
};

// Sidebar shell — right column of the two-column layout (README change #3).
// Owns the width/collapse/border chrome and the tab switcher; hosts either
// SubtitleList.jsx or PlaylistPanel.jsx as `children` depending on which tab
// is active (chosen by the caller via `activeTab`/`onTabChange`, App.jsx
// owns that state since it also needs it to decide what data to fetch/pass).
// The body wrapper is `position: relative` so SubtitleList's "回到目前播放"
// button can anchor to it.
export default function SidebarPanel({ theme, tabs, activeTab, onTabChange, footer, children }) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div
      // `rj-panel-open` / rjPanelOpen: one-time slide+fade on first mount
      // ("opening the collection", handoff §Interactions). Fires when the
      // sidebar appears (showSubtitlePanel flips true in App.jsx); NOT looping.
      className="rj-panel-open"
      style={{
        width: collapsed ? COLLAPSED_WIDTH : EXPANDED_WIDTH,
        flexShrink: 0,
        borderLeft: `1px solid ${theme.hairline}`,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        position: 'relative',
        transition: 'width 0.18s ease',
        animation: 'rjPanelOpen 320ms cubic-bezier(.2,.8,.3,1) both',
      }}
    >
      <div
        style={{
          flexShrink: 0,
          padding: collapsed ? '14px 0' : '10px 12px',
          borderBottom: `1px solid ${theme.hairline}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: collapsed ? 'center' : 'space-between',
          gap: 8,
        }}
      >
        {!collapsed && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
            {tabs.map((tab) => {
              const active = tab.key === activeTab;
              return (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => onTabChange(tab.key)}
                  title={tab.label}
                  style={{
                    border: 'none',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '6px 10px',
                    borderRadius: 7,
                    background: active ? theme.segmentActiveBg : 'transparent',
                    color: active ? theme.segmentActiveText : theme.textTertiary,
                  }}
                >
                  {TAB_ICONS[tab.key]}
                  <span style={{ fontSize: 12, fontWeight: 700 }}>{tab.label}</span>
                  {tab.badge != null && (
                    <span style={{ fontSize: 11, fontWeight: 500, opacity: 0.75 }}>{tab.badge}</span>
                  )}
                </button>
              );
            })}
          </div>
        )}
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? '展開側邊欄' : '收折側邊欄'}
          style={{
            flexShrink: 0,
            width: 22,
            height: 22,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: 'none',
            borderRadius: 6,
            background: 'transparent',
            color: theme.textTertiary,
            cursor: 'pointer',
          }}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            style={{ transform: collapsed ? 'rotate(180deg)' : 'none' }}
          >
            <path d="M15 18l-6-6 6-6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      {!collapsed && (
        // `flex: 1` fills the sidebar's remaining height, but the inner scroll
        // body is `position: absolute; inset: 0` so its (potentially very tall)
        // content does NOT contribute intrinsic height back up the flex chain.
        // Without this the subtitle list's length would drive the two-column
        // row — and therefore the whole card — taller; with it, the card is
        // sized by the video and the list simply scrolls within this pane.
        <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
          {/* Keyed by activeTab so switching tabs remounts this wrapper and
             replays rjRowCascade — the newly-shown list fades/rises in rather
             than snapping. `position:absolute; inset:0` keeps the (tall) list
             from feeding intrinsic height back up the flex chain (the card is
             sized by the video, not the list — see the comment above). */}
          <div
            key={activeTab}
            className="rj-cascade"
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              animation: 'rjRowCascade 260ms cubic-bezier(.2,.8,.3,1) both',
            }}
          >
            {children}
          </div>
        </div>
      )}

      {!collapsed && footer && (
        <div style={{ flexShrink: 0, borderTop: `1px solid ${theme.hairline}`, padding: 10 }}>{footer}</div>
      )}
    </div>
  );
}
