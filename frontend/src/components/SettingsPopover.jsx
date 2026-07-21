import { useState } from 'react';
import { ACCENT } from '../theme.js';

const SPEEDS = [0.5, 1, 1.25, 1.5, 2];
const JP_COLOR_SWATCHES = ['#ffffff', '#ffe9a8', '#a8e6ff', '#b8f2c9'];
const WHISPER_MODELS = ['tiny', 'base', 'small', 'medium', 'large-v3'];

// "+0.5s" / "-1.2s" / "0s" — offset step is 100ms so seconds always land on
// a single decimal place; drop the decimal entirely for whole seconds.
function formatOffsetLabel(ms) {
  if (!ms) return '0s';
  const s = ms / 1000;
  const abs = Math.abs(s);
  const magnitude = Number.isInteger(abs) ? String(abs) : abs.toFixed(1);
  return `${s > 0 ? '+' : '-'}${magnitude}s`;
}

// Settings popover — README §版面結構 5. Liquid-glass panel (14px radius),
// anchored bottom-right, 230px wide. Playback speed segmented buttons drive
// <video>.playbackRate now; font-size/color are stored for the Phase 3
// subtitle overlay to consume.
export default function SettingsPopover({
  theme,
  dark,
  speed,
  onSpeedChange,
  fontScale,
  onFontScaleChange,
  jpColor,
  onJpColorChange,
  subtitleOffsetMs,
  onSubtitleOffsetChange,
  subtitleBg,
  onSubtitleBgChange,
  whisperModel,
  onWhisperModelChange,
  whisperTemperature,
  onWhisperTemperatureChange,
  initialPrompt,
  onInitialPromptChange,
  referenceLyrics,
  onReferenceLyricsChange,
  vadEnabled,
  onVadEnabledChange,
  vadThreshold,
  onVadThresholdChange,
  vadMinSilenceMs,
  onVadMinSilenceMsChange,
  vadSpeechPadMs,
  onVadSpeechPadMsChange,
  vadMaxSpeechS,
  onVadMaxSpeechSChange,
  onResetGenerationSettings,
  onRegenerateSubtitles,
  regenerateDisabled,
  regenerating,
}) {
  // Collapsed by default (README §版面結構 5 keeps this panel compact) — the
  // Whisper/VAD knobs are power-user territory most sessions won't touch.
  const [genSettingsOpen, setGenSettingsOpen] = useState(false);

  const compactInputStyle = {
    width: '100%',
    boxSizing: 'border-box',
    fontSize: 12,
    padding: '6px 8px',
    borderRadius: 7,
    border: `1px solid ${theme.border}`,
    background: theme.segmentBg,
    color: theme.textPrimary,
    fontFamily: 'inherit',
  };

  return (
    <div style={{ position: 'absolute', bottom: 38, right: 0, zIndex: 5, width: 230 }}>
      <div style={{ position: 'relative', borderRadius: 14 }}>
        {/* liquid-glass backplate — macos-window.jsx MacGlass, reimplemented inline */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: 14,
            background: dark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.35)',
            backdropFilter: 'blur(40px) saturate(180%)',
            WebkitBackdropFilter: 'blur(40px) saturate(180%)',
            border: dark ? '0.5px solid rgba(255,255,255,0.12)' : '0.5px solid rgba(255,255,255,0.6)',
            boxShadow: dark
              ? '0 8px 40px rgba(0,0,0,0.2)'
              : '0 8px 40px rgba(0,0,0,0.08), inset 0 1px 0 rgba(255,255,255,0.4)',
          }}
        />
        <div
          style={{
            position: 'relative',
            zIndex: 1,
            padding: 14,
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            maxHeight: 'min(75vh, 560px)',
            overflowY: 'auto',
            boxSizing: 'border-box',
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 700, color: theme.textPrimary }}>播放設定</div>

          <div>
            <div style={{ fontSize: 11, color: theme.textTertiary, marginBottom: 6 }}>播放速率</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 2, borderRadius: 8, padding: 2 }}>
              {SPEEDS.map((v) => {
                const active = speed === v;
                return (
                  <button
                    key={v}
                    onClick={() => onSpeedChange(v)}
                    style={{
                      border: 'none',
                      cursor: 'pointer',
                      fontSize: 12,
                      fontWeight: 600,
                      padding: '8px 10px',
                      borderRadius: 7,
                      background: active ? theme.segmentActiveBg : theme.segmentBg,
                      color: active ? theme.segmentActiveText : theme.textTertiary,
                      boxShadow: active ? '0 1px 2px rgba(0,0,0,0.15)' : 'none',
                    }}
                  >
                    {v}x
                  </button>
                );
              })}
            </div>
          </div>

          <div style={{ fontSize: 12, fontWeight: 700, color: theme.textPrimary }}>字幕樣式</div>

          <div>
            <div style={{ fontSize: 11, color: theme.textTertiary, marginBottom: 6 }}>字級大小</div>
            <input
              type="range"
              min="0.7"
              max="1.6"
              step="0.05"
              value={fontScale}
              onChange={(e) => onFontScaleChange(Number(e.target.value))}
              style={{ width: '100%', accentColor: ACCENT }}
            />
          </div>

          <div>
            <div style={{ fontSize: 11, color: theme.textTertiary, marginBottom: 6 }}>日文字幕顏色</div>
            <div style={{ display: 'flex', gap: 8 }}>
              {JP_COLOR_SWATCHES.map((c) => (
                <button
                  key={c}
                  onClick={() => onJpColorChange(c)}
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: '50%',
                    cursor: 'pointer',
                    background: c,
                    border: jpColor === c ? `2px solid ${ACCENT}` : '1px solid rgba(0,0,0,0.15)',
                  }}
                />
              ))}
            </div>
          </div>

          <div>
            <div style={{ fontSize: 11, color: theme.textTertiary, marginBottom: 6 }}>字幕背景</div>
            <input
              type="range"
              min="0"
              max="100"
              step="1"
              value={Math.round(subtitleBg * 100)}
              onChange={(e) => onSubtitleBgChange(Number(e.target.value) / 100)}
              style={{ width: '100%', accentColor: ACCENT }}
            />
          </div>

          <div style={{ fontSize: 12, fontWeight: 700, color: theme.textPrimary }}>字幕時間校正</div>

          <div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 6,
              }}
            >
              <span style={{ fontSize: 11, color: theme.textTertiary }}>偏移量</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span
                  style={{
                    fontSize: 11,
                    fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace',
                    fontWeight: 700,
                    color: theme.textPrimary,
                    minWidth: 38,
                    textAlign: 'right',
                  }}
                >
                  {formatOffsetLabel(subtitleOffsetMs)}
                </span>
                <button
                  onClick={() => onSubtitleOffsetChange(0)}
                  title="重設為 0"
                  style={{
                    border: 'none',
                    cursor: 'pointer',
                    fontSize: 10,
                    fontWeight: 600,
                    padding: '3px 7px',
                    borderRadius: 6,
                    background: theme.segmentBg,
                    color: theme.textTertiary,
                  }}
                >
                  歸零
                </button>
              </span>
            </div>
            <input
              type="range"
              min="-3000"
              max="3000"
              step="100"
              value={subtitleOffsetMs}
              onChange={(e) => onSubtitleOffsetChange(Number(e.target.value))}
              onDoubleClick={() => onSubtitleOffsetChange(0)}
              title="雙擊重設為 0"
              style={{ width: '100%', accentColor: ACCENT }}
            />
            <div style={{ fontSize: 10, color: theme.textTertiary, marginTop: 4 }}>
              字幕太早就調＋，太晚就調－
            </div>
          </div>

          <div style={{ borderTop: `1px solid ${theme.border}`, paddingTop: 8 }}>
            <button
              onClick={() => setGenSettingsOpen((o) => !o)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                border: 'none',
                background: 'none',
                cursor: 'pointer',
                padding: 0,
                fontSize: 12,
                fontWeight: 700,
                color: theme.textPrimary,
                width: '100%',
              }}
            >
              <span
                style={{
                  fontSize: 9,
                  display: 'inline-block',
                  transform: genSettingsOpen ? 'rotate(90deg)' : 'none',
                  transition: 'transform 0.15s',
                }}
              >
                ▸
              </span>
              進階：字幕產生設定
            </button>

            {genSettingsOpen && (
              <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div>
                  <div style={{ fontSize: 11, color: theme.textTertiary, marginBottom: 6 }}>模型 (whisper_model)</div>
                  <select
                    value={whisperModel}
                    onChange={(e) => onWhisperModelChange(e.target.value)}
                    style={compactInputStyle}
                  >
                    {WHISPER_MODELS.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                  <div style={{ fontSize: 10, color: theme.textTertiary, marginTop: 4 }}>
                    large-v3 對歌聲辨識最準，但速度較慢
                  </div>
                </div>

                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                    <span style={{ fontSize: 11, color: theme.textTertiary }}>temperature</span>
                    <span
                      style={{
                        fontSize: 11,
                        fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace',
                        fontWeight: 700,
                        color: theme.textPrimary,
                      }}
                    >
                      {whisperTemperature.toFixed(1)}
                    </span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.1"
                    value={whisperTemperature}
                    onChange={(e) => onWhisperTemperatureChange(Number(e.target.value))}
                    style={{ width: '100%', accentColor: ACCENT }}
                  />
                </div>

                <div>
                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      cursor: 'pointer',
                      fontSize: 12,
                      fontWeight: 600,
                      color: theme.textPrimary,
                    }}
                  >
                    <span>使用 VAD 語音偵測</span>
                    <input
                      type="checkbox"
                      checked={vadEnabled}
                      onChange={(e) => onVadEnabledChange(e.target.checked)}
                      style={{ width: 16, height: 16, accentColor: ACCENT, cursor: 'pointer' }}
                    />
                  </label>
                  <div style={{ fontSize: 11, color: theme.textTertiary, marginTop: 4 }}>
                    關閉可保留更多小聲／歌唱的字，但前奏等純音樂段可能出現幻覺字幕。關閉時下方 VAD 參數不生效。
                  </div>
                </div>

                <div style={{ opacity: vadEnabled ? 1 : 0.4, pointerEvents: vadEnabled ? 'auto' : 'none' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                    <span style={{ fontSize: 11, color: theme.textTertiary }}>VAD threshold</span>
                    <span
                      style={{
                        fontSize: 11,
                        fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace',
                        fontWeight: 700,
                        color: theme.textPrimary,
                      }}
                    >
                      {vadThreshold.toFixed(2)}
                    </span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={vadThreshold}
                    onChange={(e) => onVadThresholdChange(Number(e.target.value))}
                    style={{ width: '100%', accentColor: ACCENT }}
                  />
                </div>

                <div style={{ opacity: vadEnabled ? 1 : 0.4, pointerEvents: vadEnabled ? 'auto' : 'none' }}>
                  <div style={{ fontSize: 11, color: theme.textTertiary, marginBottom: 6 }}>min_silence (ms)</div>
                  <input
                    type="number"
                    min="0"
                    max="2000"
                    step="50"
                    value={vadMinSilenceMs}
                    onChange={(e) => onVadMinSilenceMsChange(Number(e.target.value))}
                    style={compactInputStyle}
                  />
                </div>

                <div style={{ opacity: vadEnabled ? 1 : 0.4, pointerEvents: vadEnabled ? 'auto' : 'none' }}>
                  <div style={{ fontSize: 11, color: theme.textTertiary, marginBottom: 6 }}>speech_pad (ms)</div>
                  <input
                    type="number"
                    min="0"
                    max="1000"
                    step="50"
                    value={vadSpeechPadMs}
                    onChange={(e) => onVadSpeechPadMsChange(Number(e.target.value))}
                    style={compactInputStyle}
                  />
                </div>

                <div style={{ opacity: vadEnabled ? 1 : 0.4, pointerEvents: vadEnabled ? 'auto' : 'none' }}>
                  <div style={{ fontSize: 11, color: theme.textTertiary, marginBottom: 6 }}>max_speech (s)</div>
                  <input
                    type="number"
                    min="5"
                    max="60"
                    step="1"
                    value={vadMaxSpeechS}
                    onChange={(e) => onVadMaxSpeechSChange(Number(e.target.value))}
                    style={compactInputStyle}
                  />
                </div>

                <div>
                  <div style={{ fontSize: 11, color: theme.textTertiary, marginBottom: 6 }}>initial_prompt</div>
                  <textarea
                    rows={2}
                    value={initialPrompt}
                    onChange={(e) => onInitialPromptChange(e.target.value)}
                    placeholder="可留空；給 Whisper 的提示（例如歌名/風格）"
                    style={{ ...compactInputStyle, resize: 'vertical' }}
                  />
                </div>

                <div>
                  <div style={{ fontSize: 11, color: theme.textTertiary, marginBottom: 6 }}>
                    正確歌詞（選填，一行一句）
                  </div>
                  <textarea
                    rows={5}
                    value={referenceLyrics}
                    onChange={(e) => onReferenceLyricsChange(e.target.value)}
                    placeholder="貼上這首歌的正確歌詞，一行一句。填了會用你的歌詞去對齊時間（文字保證正確）；留空則照常自動辨識。"
                    style={{ ...compactInputStyle, resize: 'vertical' }}
                  />
                  <div style={{ fontSize: 10, color: theme.textTertiary, marginTop: 4 }}>
                    有填＝forced alignment（文字用你的、只對時間，最準）；留空＝自動辨識。
                  </div>
                </div>

                <button
                  onClick={onResetGenerationSettings}
                  style={{
                    alignSelf: 'flex-start',
                    border: 'none',
                    background: 'none',
                    cursor: 'pointer',
                    padding: 0,
                    fontSize: 10,
                    fontWeight: 600,
                    color: ACCENT,
                    textDecoration: 'underline',
                  }}
                >
                  回復預設
                </button>
              </div>
            )}
          </div>

          <div
            style={{
              borderTop: `1px solid ${theme.border}`,
              paddingTop: 8,
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            }}
          >
            <button
              onClick={onRegenerateSubtitles}
              disabled={regenerateDisabled}
              style={{
                border: 'none',
                cursor: regenerateDisabled ? 'default' : 'pointer',
                fontSize: 11,
                fontWeight: 700,
                padding: '7px 12px',
                borderRadius: 999,
                background: regenerateDisabled ? theme.segmentBg : ACCENT,
                color: regenerateDisabled ? theme.textTertiary : '#fff',
                opacity: regenerateDisabled ? 0.6 : 1,
                width: '100%',
              }}
            >
              {regenerating ? '重新產生中…' : '重新產生字幕'}
            </button>
            <div style={{ fontSize: 10, color: theme.textTertiary }}>
              字幕有缺漏或想換模型時可重跑（會重新辨識，需一點時間）
            </div>
          </div>

          <div
            style={{
              fontSize: 10,
              color: theme.textTertiary,
              paddingTop: 2,
            }}
          >
            字幕來源：本地 Whisper 辨識＋翻譯 API
          </div>
        </div>
      </div>
    </div>
  );
}
