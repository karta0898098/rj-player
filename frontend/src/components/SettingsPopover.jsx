import { useState } from 'react';
import { ACCENT } from '../theme.js';
import GenerationOptionsForm from './GenerationOptionsForm.jsx';

const SPEEDS = [0.5, 1, 1.25, 1.5, 2];
const COLOR_SWATCHES = ['#ffffff', '#ffe9a8', '#a8e6ff', '#b8f2c9'];

// Small pill toggle — visually matches Titlebar.jsx's dark-mode switch, used
// here as each subtitle layer's on/off control (moved in from ControlBar's
// old 日/中/拼 chips, see the "字幕樣式" section below).
function ToggleSwitch({ checked, onChange }) {
  return (
    <div
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      style={{
        width: 34,
        height: 19,
        borderRadius: 10,
        cursor: 'pointer',
        flexShrink: 0,
        background: checked ? ACCENT : 'rgba(127,127,127,0.35)',
        position: 'relative',
        transition: 'background 0.15s',
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: 2,
          left: checked ? 17 : 2,
          width: 15,
          height: 15,
          borderRadius: '50%',
          background: '#fff',
          boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
          transition: 'left 0.15s',
        }}
      />
    </div>
  );
}

// One subtitle layer's full control set: on/off + size/color/shadow, all
// independently adjustable per layer (日/中/拼 each get their own instance)
// rather than one shared size+color for all three.
function SubtitleLayerPanel({ theme, label, badge, enabled, onToggleEnabled, style, onStyleChange }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: theme.textPrimary, display: 'flex', alignItems: 'center', gap: 6 }}>
          {label}
          {badge}
        </span>
        <ToggleSwitch checked={enabled} onChange={onToggleEnabled} />
      </div>
      <div
        style={{
          opacity: enabled ? 1 : 0.4,
          pointerEvents: enabled ? 'auto' : 'none',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        <div>
          <div style={{ fontSize: 10, color: theme.textTertiary, marginBottom: 4 }}>大小</div>
          <input
            type="range"
            min="0.7"
            max="1.6"
            step="0.05"
            value={style.scale}
            onChange={(e) => onStyleChange({ scale: Number(e.target.value) })}
            style={{ width: '100%', accentColor: ACCENT }}
          />
        </div>
        <div>
          <div style={{ fontSize: 10, color: theme.textTertiary, marginBottom: 4 }}>顏色</div>
          <div style={{ display: 'flex', gap: 8 }}>
            {COLOR_SWATCHES.map((c) => (
              <button
                key={c}
                onClick={() => onStyleChange({ color: c })}
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: '50%',
                  cursor: 'pointer',
                  background: c,
                  border: style.color === c ? `2px solid ${ACCENT}` : '1px solid rgba(0,0,0,0.15)',
                }}
              />
            ))}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 10, color: theme.textTertiary, marginBottom: 4 }}>陰影強度</div>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={style.shadow}
            onChange={(e) => onStyleChange({ shadow: Number(e.target.value) })}
            style={{ width: '100%', accentColor: ACCENT }}
          />
        </div>
      </div>
    </div>
  );
}

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
  // Per-layer on/off + appearance (moved in from ControlBar's old 日/中/拼
  // chips, plus size/color now adjustable per layer instead of one shared
  // fontScale/jpColor for all three — see SubtitleLayerPanel above).
  subJP,
  onToggleSubJP,
  subCN,
  onToggleSubCN,
  subRomaji,
  onToggleSubRomaji,
  jpStyle,
  onJpStyleChange,
  cnStyle,
  onCnStyleChange,
  romajiStyle,
  onRomajiStyleChange,
  // dsd.md §7 translate_partial — minimal hint that some 中文 lines are
  // missing translation; shown as a small badge next to the 中文 toggle.
  translatePartial,
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
  onRetranslateSubtitles,
  retranslateDisabled,
  retranslating,
}) {
  // Collapsed by default (README §版面結構 5 keeps this panel compact) — the
  // Whisper/VAD knobs are power-user territory most sessions won't touch.
  const [genSettingsOpen, setGenSettingsOpen] = useState(false);

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

          <SubtitleLayerPanel
            theme={theme}
            label="日文"
            enabled={subJP}
            onToggleEnabled={onToggleSubJP}
            style={jpStyle}
            onStyleChange={onJpStyleChange}
          />

          <div style={{ borderTop: `1px solid ${theme.border}`, paddingTop: 12 }}>
            <SubtitleLayerPanel
              theme={theme}
              label="中文"
              badge={
                translatePartial && (
                  <span
                    title="部分中文翻譯缺失"
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      background: '#ffb020',
                      display: 'inline-block',
                    }}
                  />
                )
              }
              enabled={subCN}
              onToggleEnabled={onToggleSubCN}
              style={cnStyle}
              onStyleChange={onCnStyleChange}
            />
          </div>

          <div style={{ borderTop: `1px solid ${theme.border}`, paddingTop: 12 }}>
            <SubtitleLayerPanel
              theme={theme}
              label="羅馬拼音"
              enabled={subRomaji}
              onToggleEnabled={onToggleSubRomaji}
              style={romajiStyle}
              onStyleChange={onRomajiStyleChange}
            />
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
              <div style={{ marginTop: 10 }}>
                <GenerationOptionsForm
                  theme={theme}
                  whisperModel={whisperModel}
                  onWhisperModelChange={onWhisperModelChange}
                  whisperTemperature={whisperTemperature}
                  onWhisperTemperatureChange={onWhisperTemperatureChange}
                  initialPrompt={initialPrompt}
                  onInitialPromptChange={onInitialPromptChange}
                  referenceLyrics={referenceLyrics}
                  onReferenceLyricsChange={onReferenceLyricsChange}
                  vadEnabled={vadEnabled}
                  onVadEnabledChange={onVadEnabledChange}
                  vadThreshold={vadThreshold}
                  onVadThresholdChange={onVadThresholdChange}
                  vadMinSilenceMs={vadMinSilenceMs}
                  onVadMinSilenceMsChange={onVadMinSilenceMsChange}
                  vadSpeechPadMs={vadSpeechPadMs}
                  onVadSpeechPadMsChange={onVadSpeechPadMsChange}
                  vadMaxSpeechS={vadMaxSpeechS}
                  onVadMaxSpeechSChange={onVadMaxSpeechSChange}
                  onResetGenerationSettings={onResetGenerationSettings}
                />
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

            <button
              onClick={onRetranslateSubtitles}
              disabled={retranslateDisabled}
              style={{
                border: `1px solid ${retranslateDisabled ? 'transparent' : theme.border}`,
                cursor: retranslateDisabled ? 'default' : 'pointer',
                fontSize: 11,
                fontWeight: 700,
                padding: '7px 12px',
                borderRadius: 999,
                background: theme.segmentBg,
                color: retranslateDisabled ? theme.textTertiary : theme.textPrimary,
                opacity: retranslateDisabled ? 0.6 : 1,
                width: '100%',
                marginTop: 4,
              }}
            >
              {retranslating ? '重新翻譯中…' : '只重新翻譯'}
            </button>
            <div style={{ fontSize: 10, color: theme.textTertiary }}>
              只翻譯有問題的句子，不重新辨識語音（比重新產生快很多）
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
