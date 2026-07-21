import ProgressTrack from './ProgressTrack.jsx';
import { ACCENT } from '../theme.js';

// Control bar — README §版面結構 4. Progress track, play/pause (34px), time
// label, mute + volume slider, 日/中/拼 subtitle chips, theater-mode button,
// settings gear. `settingsSlot` renders the anchored SettingsPopover (passed
// in by App so ControlBar doesn't need to know about App-level state).
export default function ControlBar({
  theme,
  currentTime,
  duration,
  onSeek,
  disabled,
  isPlaying,
  onTogglePlay,
  timeLabel,
  volume,
  onVolumeChange,
  onToggleMute,
  subJP,
  subCN,
  subRomaji,
  onToggleSubJP,
  onToggleSubCN,
  onToggleSubRomaji,
  translatePartial,
  theaterMode,
  onToggleTheater,
  isFullscreen,
  onToggleFullscreen,
  showSettings,
  onToggleSettings,
  settingsAnchorRef,
  settingsSlot,
}) {
  const chipStyle = (active) => ({
    border: 'none',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 600,
    padding: '6px 10px',
    borderRadius: 7,
    background: active ? ACCENT : theme.chipInactiveBg,
    color: active ? '#fff' : theme.chipInactiveText,
  });
  const volumeIcon = volume === 0 ? '🔇' : volume < 50 ? '🔉' : '🔊';

  return (
    <div style={{ margin: '14px 20px 20px', display: 'flex', flexDirection: 'column', gap: 10, position: 'relative' }}>
      <ProgressTrack theme={theme} currentTime={currentTime} duration={duration} onSeek={onSeek} disabled={disabled} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <button
          onClick={onTogglePlay}
          disabled={disabled}
          style={{
            width: 34,
            height: 34,
            borderRadius: '50%',
            border: 'none',
            background: '#1c1c1e',
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
            style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: 2, fontSize: 14, color: theme.textSecondary }}
          >
            {volumeIcon}
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

        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {/* 日/中/拼 independently show/hide their SubtitleOverlay layer (B3.3). */}
          <button onClick={onToggleSubJP} style={chipStyle(subJP)}>
            日
          </button>
          <button
            onClick={onToggleSubCN}
            style={{ ...chipStyle(subCN), position: 'relative' }}
            title={translatePartial ? '部分中文翻譯缺失' : undefined}
          >
            中
            {/* dsd.md §7 translate_partial — minimal hint that some 中文 lines
                are missing, per B3.4's "optional, keep it minimal". */}
            {translatePartial && (
              <span
                style={{
                  position: 'absolute',
                  top: -2,
                  right: -2,
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: '#ffb020',
                  boxShadow: '0 0 0 1.5px rgba(0,0,0,0.3)',
                }}
              />
            )}
          </button>
          <button onClick={onToggleSubRomaji} style={chipStyle(subRomaji)}>
            拼
          </button>
        </div>

        <button
          onClick={onToggleTheater}
          style={{
            border: 'none',
            cursor: 'pointer',
            fontSize: 12,
            fontWeight: 600,
            padding: '7px 12px',
            borderRadius: 7,
            background: theaterMode ? ACCENT : theme.chipInactiveBg,
            color: theaterMode ? '#fff' : theme.chipInactiveText,
          }}
        >
          劇院模式
        </button>

        <button
          onClick={onToggleFullscreen}
          title={isFullscreen ? '離開全螢幕' : '全螢幕'}
          style={{
            border: 'none',
            cursor: 'pointer',
            fontSize: 12,
            fontWeight: 600,
            padding: '7px 12px',
            borderRadius: 7,
            background: isFullscreen ? ACCENT : theme.chipInactiveBg,
            color: isFullscreen ? '#fff' : theme.chipInactiveText,
          }}
        >
          {isFullscreen ? '⤢ 離開全螢幕' : '⛶ 全螢幕'}
        </button>

        <div style={{ position: 'relative' }} ref={settingsAnchorRef}>
          <button
            onClick={onToggleSettings}
            style={{
              width: 30,
              height: 30,
              borderRadius: 8,
              border: 'none',
              background: showSettings ? theme.chipInactiveBg : 'transparent',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: theme.textSecondary,
              fontSize: 15,
            }}
          >
            ⚙
          </button>
          {showSettings && settingsSlot}
        </div>
      </div>
    </div>
  );
}
