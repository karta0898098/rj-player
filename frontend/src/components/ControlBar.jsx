import ProgressTrack from './ProgressTrack.jsx';
import { ACCENT } from '../theme.js';

// "sound wave" speaker icon path, matched to volume level — combined-path
// trick (each arc subpath auto-closes on fill, forming the wave lines) per
// the design handoff reference.
function volumeIconPath(volume) {
  if (volume === 0) return 'M16.5 12L20 8.5M20 12l-3.5-3.5M11 5L6 9H3v6h3l5 4V5z';
  if (volume < 50) return 'M11 5L6 9H3v6h3l5 4V5zM15.5 8.5a5 5 0 010 7';
  return 'M11 5L6 9H3v6h3l5 4V5zM15.5 8.5a5 5 0 010 7M18 6a9 9 0 010 12';
}

// Control bar — README §版面結構 4. Progress track, play/pause (34px), time
// label, mute + volume slider, theater-mode/fullscreen/settings icon
// buttons, settings gear. `settingsSlot` renders the anchored
// SettingsPopover (passed in by App so ControlBar doesn't need to know
// about App-level state). Theater/fullscreen/mute/settings are icon-only
// (title tooltip, no text label) per the design handoff's icon-first pass —
// the 日/中/拼 subtitle on/off toggles live in SettingsPopover's "字幕圖層"
// section instead.
export default function ControlBar({
  theme,
  currentTime,
  duration,
  onSeek,
  previewSrc,
  disabled,
  isPlaying,
  onTogglePlay,
  timeLabel,
  volume,
  onVolumeChange,
  onToggleMute,
  theaterMode,
  onToggleTheater,
  isFullscreen,
  onToggleFullscreen,
  showSettings,
  onToggleSettings,
  settingsAnchorRef,
  settingsSlot,
}) {
  return (
    <div style={{ margin: '14px 20px 20px', display: 'flex', flexDirection: 'column', gap: 10, position: 'relative' }}>
      <ProgressTrack
        theme={theme}
        currentTime={currentTime}
        duration={duration}
        onSeek={onSeek}
        previewSrc={previewSrc}
        disabled={disabled}
      />

      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <button
          onClick={onTogglePlay}
          disabled={disabled}
          style={{
            width: 34,
            height: 34,
            borderRadius: '50%',
            border: 'none',
            background: theme.playBtnBg,
            color: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: disabled ? 'default' : 'pointer',
            flexShrink: 0,
            opacity: disabled ? 0.5 : 1,
          }}
        >
          {isPlaying ? (
            <div style={{ display: 'flex', gap: 3 }}>
              <div style={{ width: 3, height: 12, background: '#fff', borderRadius: 1 }} />
              <div style={{ width: 3, height: 12, background: '#fff', borderRadius: 1 }} />
            </div>
          ) : (
            <div
              style={{
                width: 0,
                height: 0,
                borderTop: '7px solid transparent',
                borderBottom: '7px solid transparent',
                borderLeft: '11px solid #fff',
                marginLeft: 2,
              }}
            />
          )}
        </button>

        <div style={{ color: theme.textSecondary, fontSize: 12, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
          {timeLabel}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 4 }}>
          <button
            onClick={onToggleMute}
            title="靜音"
            style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: 2, display: 'flex', color: theme.textSecondary }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path d={volumeIconPath(volume)} fill="currentColor" />
            </svg>
          </button>
          <input
            type="range"
            min="0"
            max="100"
            value={volume}
            onChange={(e) => onVolumeChange(Number(e.target.value))}
            style={{ width: 70, accentColor: ACCENT }}
          />
        </div>

        <div style={{ flex: 1 }} />

        {/* Meaningless while fullscreen (theater mode only affects the
            windowed layout's VideoInfo row / width cap) — hidden there
            rather than just disabled, since it'd otherwise look like a
            real option. */}
        {!isFullscreen && (
          <button
            onClick={onToggleTheater}
            title="劇院模式"
            style={{
              border: 'none',
              cursor: 'pointer',
              padding: 7,
              borderRadius: 8,
              background: theaterMode ? ACCENT : theme.chipBg,
              color: theaterMode ? '#fff' : theme.textSecondary,
              display: 'flex',
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <rect x="2" y="6" width="20" height="12" rx="2.5" stroke="currentColor" strokeWidth="2" />
            </svg>
          </button>
        )}

        <button
          onClick={onToggleFullscreen}
          title={isFullscreen ? '離開全螢幕' : '全螢幕'}
          style={{
            border: 'none',
            cursor: 'pointer',
            padding: 7,
            borderRadius: 8,
            background: theme.chipBg,
            color: theme.textSecondary,
            display: 'flex',
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        <div style={{ position: 'relative' }} ref={settingsAnchorRef}>
          <button
            onClick={onToggleSettings}
            title="設定"
            style={{
              width: 32,
              height: 32,
              borderRadius: 9,
              border: 'none',
              background: showSettings ? theme.chipBg : 'transparent',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: theme.textSecondary,
            }}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
              <path d="M12 15.5a3.5 3.5 0 100-7 3.5 3.5 0 000 7z" stroke="currentColor" strokeWidth="1.8" />
              <path
                d="M19.4 13a7.97 7.97 0 000-2l2.1-1.6-2-3.5-2.5 1a8 8 0 00-1.7-1L14.9 3h-4l-.4 2.9a8 8 0 00-1.7 1l-2.5-1-2 3.5L6.4 11a8 8 0 000 2l-2.1 1.6 2 3.5 2.5-1a8 8 0 001.7 1l.4 2.9h4l.4-2.9a8 8 0 001.7-1l2.5 1 2-3.5-2.1-1.6z"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          {showSettings && settingsSlot}
        </div>
      </div>
    </div>
  );
}
