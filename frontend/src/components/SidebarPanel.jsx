import { useState } from 'react';
import { ACCENT } from '../theme.js';

const EXPANDED_WIDTH = 340;
const COLLAPSED_WIDTH = 44;

// Sidebar shell — right column of the two-column layout (README change #3).
// Owns the width/collapse/border chrome and the tab switcher; hosts either
// SubtitleList.jsx or PlaylistPanel.jsx as `children` depending on which tab
// is active (chosen by the caller via `activeTab`/`onTabChange`, App.jsx
// owns that state since it also needs it to decide what data to fetch/pass).
// The body wrapper is `position: relative` so SubtitleList's "回到目前播放"
// button can anchor to it.
export default function SidebarPanel({ theme, tabs, activeTab, onTabChange, children }) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div
      style={{
        width: collapsed ? COLLAPSED_WIDTH : EXPANDED_WIDTH,
        flexShrink: 0,
        borderLeft: `1px solid ${theme.border}`,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        position: 'relative',
        transition: 'width 0.18s ease',
      }}
    >
      <div
        style={{
          flexShrink: 0,
          padding: collapsed ? '14px 0' : '10px 12px',
          borderBottom: `1px solid ${theme.border}`,
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
                  style={{
                    border: 'none',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 5,
                    padding: '5px 9px',
                    borderRadius: 7,
                    background: active ? theme.segmentActiveBg : 'transparent',
                    color: active ? theme.segmentActiveText : theme.textTertiary,
                    fontSize: 13,
                    fontWeight: 700,
                  }}
                >
                  {tab.label}
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
            fontSize: 13,
            lineHeight: 1,
          }}
        >
          {collapsed ? '‹' : '›'}
        </button>
      </div>

      {!collapsed && (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
          {children}
        </div>
      )}
    </div>
  );
}
