import { ACCENT } from '../theme.js';

// Titlebar — README §版面結構 1. Video title (14px/700, ellipsized — see
// videoTitle below), icon-first dark/light pill toggle (sun/moon glyph in
// the knob, no text label), YouTube URL pill input (280px w/ small red
// icon), icon-only ASR-options gear + icon-only accent submit button (no
// "載入"/"加入佇列" text — see design handoff change #3). macOS traffic
// lights were removed (MacTrafficLights.jsx is kept on disk, unused).
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
  // Video-library view toggle (swaps the whole body between the player and
  // LibraryView). Highlighted while the library is open; the glyph doubles as
  // a "back to player" affordance in that state.
  showLibrary,
  onToggleLibrary,
}) {
  return (
    <div
      style={{
        borderBottom: `1px solid ${theme.hairline}`,
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '13px 18px',
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

      {onToggleLibrary && (
        <button
          type="button"
          onClick={onToggleLibrary}
          title={showLibrary ? '返回播放器' : '影片庫'}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            flexShrink: 0,
            height: 32,
            padding: '0 11px',
            borderRadius: 9,
            border: 'none',
            cursor: 'pointer',
            background: showLibrary ? ACCENT : theme.chipBg,
            color: showLibrary ? '#fff' : theme.textSecondary,
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <rect x="3" y="4" width="7" height="7" rx="1.4" stroke="currentColor" strokeWidth="1.9" />
            <rect x="14" y="4" width="7" height="7" rx="1.4" stroke="currentColor" strokeWidth="1.9" />
            <rect x="3" y="15" width="7" height="5" rx="1.4" stroke="currentColor" strokeWidth="1.9" />
            <rect x="14" y="15" width="7" height="5" rx="1.4" stroke="currentColor" strokeWidth="1.9" />
          </svg>
          {showLibrary ? '播放器' : '影片庫'}
        </button>
      )}

      <div
        title="切換深色／淺色外觀"
        onClick={onToggleDark}
        style={{
          width: 38,
          height: 22,
          borderRadius: 11,
          cursor: 'pointer',
          flexShrink: 0,
          background: theme.toggleTrack,
          position: 'relative',
          transition: 'background 0.15s',
        }}
      >
        <div
          style={{
            position: 'absolute',
            top: 2,
            left: darkMode ? 18 : 2,
            width: 18,
            height: 18,
            borderRadius: '50%',
            background: '#fff',
            boxShadow: '0 1px 3px rgba(0,0,0,0.35)',
            transition: 'left 0.15s',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 10,
          }}
        >
          {darkMode ? '🌙' : '☀'}
        </div>
      </div>

      <form
        style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, position: 'relative' }}
        onSubmit={onUrlSubmit}
        ref={optionsAnchorRef}
      >
        <div
          style={{
            background: theme.inputBg,
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            borderRadius: 9,
            padding: '7px 11px',
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
            title="ASR／產生設定（音樂 MV、辨識模型、歌詞校正等）"
            style={{
              width: 32,
              height: 32,
              borderRadius: 9,
              border: 'none',
              background: showOptions ? theme.chipBg : 'transparent',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: theme.textSecondary,
              flexShrink: 0,
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
              <path d="M12 15.5a3.5 3.5 0 100-7 3.5 3.5 0 000 7z" stroke="currentColor" strokeWidth="1.8" />
              <path
                d="M19.4 13a7.97 7.97 0 000-2l2.1-1.6-2-3.5-2.5 1a8 8 0 00-1.7-1L14.9 3h-4l-.4 2.9a8 8 0 00-1.7 1l-2.5-1-2 3.5L6.4 11a8 8 0 000 2l-2.1 1.6 2 3.5 2.5-1a8 8 0 001.7 1l.4 2.9h4l.4-2.9a8 8 0 001.7-1l2.5 1 2-3.5-2.1-1.6z"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}
        <button
          type="submit"
          disabled={loading}
          title="加入佇列"
          style={{
            width: 32,
            height: 32,
            borderRadius: 9,
            border: 'none',
            background: ACCENT,
            color: '#fff',
            cursor: loading ? 'default' : 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            opacity: loading ? 0.7 : 1,
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <path d="M5 12h14M13 6l6 6-6 6" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {showOptions && optionsSlot}
      </form>
    </div>
  );
}
