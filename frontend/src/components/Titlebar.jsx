import MacTrafficLights from './MacTrafficLights.jsx';
import { ACCENT } from '../theme.js';

// Titlebar — README §版面結構 1. macOS traffic lights, app name (13px/700),
// dark-mode pill toggle, YouTube URL pill input (280px w/ small red icon),
// red "載入" button.
export default function Titlebar({
  theme,
  darkMode,
  onToggleDark,
  urlInput,
  onUrlChange,
  onUrlSubmit,
  loading,
}) {
  return (
    <div
      style={{
        borderBottom: `1px solid ${theme.border}`,
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '12px 16px',
        flexShrink: 0,
      }}
    >
      <MacTrafficLights />
      <div
        style={{
          color: theme.textPrimary,
          fontSize: 13,
          fontWeight: 700,
          whiteSpace: 'nowrap',
          flexShrink: 0,
        }}
      >
        YouTube 字幕播放器
      </div>
      <div style={{ flex: 1 }} />

      <div
        style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
        onClick={onToggleDark}
      >
        <span
          style={{
            fontSize: 12,
            color: theme.textSecondary,
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >
          深色
        </span>
        <div
          style={{
            width: 40,
            height: 22,
            borderRadius: 11,
            background: darkMode ? ACCENT : theme.chipInactiveBg,
            position: 'relative',
            transition: 'background 0.15s',
          }}
        >
          <div
            style={{
              position: 'absolute',
              top: 2,
              left: darkMode ? 20 : 2,
              width: 18,
              height: 18,
              borderRadius: '50%',
              background: '#fff',
              boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
              transition: 'left 0.15s',
            }}
          />
        </div>
      </div>

      <form style={{ display: 'flex', alignItems: 'center', gap: 8 }} onSubmit={onUrlSubmit}>
        <div
          style={{
            background: theme.urlPillBg,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            borderRadius: 8,
            padding: '6px 10px',
            width: 280,
          }}
        >
          <div
            style={{
              width: 16,
              height: 11,
              borderRadius: 3,
              background: ACCENT,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <div
              style={{
                width: 0,
                height: 0,
                borderTop: '3px solid transparent',
                borderBottom: '3px solid transparent',
                borderLeft: '5px solid #fff',
                marginLeft: 1,
              }}
            />
          </div>
          <input
            type="text"
            value={urlInput}
            onChange={(e) => onUrlChange(e.target.value)}
            placeholder="貼上 YouTube 影片連結…"
            style={{
              color: theme.textPrimary,
              border: 'none',
              background: 'transparent',
              outline: 'none',
              fontSize: 12,
              flex: 1,
              minWidth: 0,
            }}
          />
        </div>
        <button
          type="submit"
          disabled={loading}
          style={{
            border: 'none',
            background: ACCENT,
            color: '#fff',
            fontSize: 12,
            fontWeight: 600,
            padding: '7px 14px',
            borderRadius: 8,
            cursor: loading ? 'default' : 'pointer',
            opacity: loading ? 0.7 : 1,
          }}
        >
          {loading ? '載入中…' : '載入'}
        </button>
      </form>
    </div>
  );
}
