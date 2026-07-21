import { ACCENT } from '../theme.js';

// Titlebar — README §版面結構 1. Video title (14px/700, ellipsized — see
// videoTitle below), dark-mode pill toggle, YouTube URL pill input (280px w/
// small red icon), red "載入" button. macOS traffic lights were removed
// (MacTrafficLights.jsx is kept on disk, unused).
export default function Titlebar({
  theme,
  darkMode,
  onToggleDark,
  videoTitle,
  urlInput,
  onUrlChange,
  onUrlSubmit,
  loading,
  // Queue-feature add-on: a small toggle button next to the URL input that
  // opens the anchored AddToQueuePopover (per-item ASR/generation options +
  // music-MV checkbox), passed in by App the same way ControlBar's
  // settingsSlot works.
  optionsAnchorRef,
  showOptions,
  onToggleOptions,
  optionsSlot,
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
      <div
        style={{
          color: videoTitle ? theme.textPrimary : theme.textTertiary,
          fontSize: 14,
          fontWeight: 700,
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {videoTitle || '尚未載入影片'}
      </div>

      <div
        style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', flexShrink: 0 }}
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

      <form
        style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, position: 'relative' }}
        onSubmit={onUrlSubmit}
        ref={optionsAnchorRef}
      >
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
        {onToggleOptions && (
          <button
            type="button"
            onClick={onToggleOptions}
            title="佇列選項（ASR 模型／音樂 MV）"
            style={{
              width: 30,
              height: 30,
              borderRadius: 8,
              border: 'none',
              background: showOptions ? theme.chipInactiveBg : 'transparent',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: theme.textSecondary,
              fontSize: 15,
              flexShrink: 0,
            }}
          >
            ⚙
          </button>
        )}
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
          {loading ? '載入中…' : '加入佇列'}
        </button>
        {showOptions && optionsSlot}
      </form>
    </div>
  );
}
