import { useState } from 'react';
import { ACCENT } from '../theme.js';
import GenerationOptionsForm from './GenerationOptionsForm.jsx';

const SPEEDS = [0.5, 1, 1.25, 1.5, 2];
// Per-layer selector-chip dot colors (design handoff §版面結構 5, redesign
// note #5) — fixed, not theme-dependent. Keys stay 'jp'/'cn'/'ro' (matching
// `layerDefs`'s `key`, not the language-neutral prop names below) since
// they're just internal chip identifiers, not wire/prop names.
const LAYER_DOTS = { jp: '#ffffff', cn: '#ffe9a8', ro: '#a8e6ff' };

// Source-layer label (dsd.md §12.6/§12.7 B5.3): language-aware instead of a
// hardcoded "日文", since the source language isn't always Japanese.
function sourceLayerLabel(sourceLang) {
  if (sourceLang === 'ja') return '日文';
  if (sourceLang === 'en') return '英文';
  return '原文';
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
// anchored bottom-right, 250px wide. Playback speed segmented buttons drive
// <video>.playbackRate; per-layer style is stored for SubtitleOverlay to
// consume.
//
// "字幕圖層" (redesign note #5): instead of three fully-expanded per-layer
// panels, this is a row of 3 selectable chips (dot + label + the layer's own
// on/off switch) plus ONE shared 大小/陰影 editor below that applies to
// whichever layer chip is currently selected (`editingLayer`, pure UI
// selection state — not persisted, doesn't need to live in App.jsx). Each
// layer still keeps fully independent scale/shadow (and color, unexposed
// here — swatch picker dropped from this pass's scope) in its own style
// object; only the UI to reach them is consolidated.
export default function SettingsPopover({
  theme,
  dark,
  speed,
  onSpeedChange,
  subSource,
  onToggleSubSource,
  subTarget,
  onToggleSubTarget,
  subPhonetic,
  onToggleSubPhonetic,
  sourceStyle,
  onSourceStyleChange,
  targetStyle,
  onTargetStyleChange,
  phoneticStyle,
  onPhoneticStyleChange,
  // dsd.md §12.6/§12.7 B5.3 — data-driven from the loaded doc: true only
  // when it actually has a reading/phonetic layer (ja does, en doesn't per
  // B5.2's `phonetic: ""`). When false, the 羅馬拼音 chip + its 字幕樣式 slot
  // are omitted entirely below (not just disabled) since there's nothing to
  // toggle or style.
  hasPhoneticLayer,
  // The loaded doc's `language_source` ('ja' | 'en' | ...), used only to
  // pick the source-layer chip's label (sourceLayerLabel above) — falls
  // back to 原文 for anything not 'ja'/'en'.
  sourceLang,
  // dsd.md §7 translate_partial — minimal hint that some 中文 lines are
  // missing translation; shown as a small badge next to the 中文 chip label.
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
  // Which layer's sliders the shared editor card below the chip row shows.
  const [editingLayer, setEditingLayer] = useState('jp');

  const layerDefs = [
    {
      key: 'jp',
      label: sourceLayerLabel(sourceLang),
      on: subSource,
      onToggle: onToggleSubSource,
      style: sourceStyle,
      setStyle: onSourceStyleChange,
    },
    {
      key: 'cn',
      label: '中文',
      on: subTarget,
      onToggle: onToggleSubTarget,
      style: targetStyle,
      setStyle: onTargetStyleChange,
      badge: translatePartial,
    },
    // Omitted entirely (not just disabled) when the loaded doc has no
    // reading/phonetic layer (dsd.md §12.6/§12.7 B5.3) — makes both the
    // toggle chip AND its 字幕樣式 style slot below disappear for e.g. an
    // English video.
    hasPhoneticLayer && {
      key: 'ro',
      label: '羅馬拼音',
      on: subPhonetic,
      onToggle: onToggleSubPhonetic,
      style: phoneticStyle,
      setStyle: onPhoneticStyleChange,
    },
  ].filter(Boolean);
  const selectedLayer = layerDefs.find((l) => l.key === editingLayer) || layerDefs[0];

  return (
    <div style={{ position: 'absolute', bottom: 40, right: 0, zIndex: 5, width: 250 }}>
      <div style={{ position: 'relative', borderRadius: 14 }}>
        {/* liquid-glass backplate — macos-window.jsx MacGlass, reimplemented inline */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: 14,
            background: theme.popGlassBg,
            backdropFilter: 'blur(44px) saturate(180%)',
            WebkitBackdropFilter: 'blur(44px) saturate(180%)',
            border: `0.5px solid ${theme.popGlassBorder}`,
            boxShadow: '0 12px 46px rgba(0,0,0,0.35)',
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
            maxHeight: 'min(74vh, 600px)',
            overflowY: 'auto',
            boxSizing: 'border-box',
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 700, color: theme.textPrimary }}>播放速率</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
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
                    padding: '7px 9px',
                    borderRadius: 7,
                    background: active ? theme.segmentActiveBg : theme.segBg,
                    color: active ? theme.segmentActiveText : theme.textTertiary,
                    flex: 1,
                  }}
                >
                  {v}x
                </button>
              );
            })}
          </div>

          <div style={{ borderTop: `1px solid ${theme.hairline}`, paddingTop: 10, fontSize: 12, fontWeight: 700, color: theme.textPrimary }}>
            字幕圖層
          </div>

          <div style={{ display: 'flex', gap: 6 }}>
            {layerDefs.map((l) => {
              const selected = l.key === editingLayer;
              return (
                <div
                  key={l.key}
                  onClick={() => setEditingLayer(l.key)}
                  style={{
                    flex: 1,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 5,
                    padding: '8px 4px',
                    borderRadius: 9,
                    cursor: 'pointer',
                    background: selected ? (dark ? 'rgba(255,255,255,0.1)' : '#ffffff') : 'transparent',
                    border: `1px solid ${selected ? theme.hairline : 'transparent'}`,
                  }}
                >
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: LAYER_DOTS[l.key] }} />
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      color: theme.textPrimary,
                      opacity: l.on ? 1 : 0.4,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                    }}
                  >
                    {l.label}
                    {l.badge && (
                      <span
                        title="部分中文翻譯缺失"
                        style={{ width: 5, height: 5, borderRadius: '50%', background: '#ffb020', display: 'inline-block' }}
                      />
                    )}
                  </span>
                  <div
                    role="switch"
                    aria-checked={l.on}
                    onClick={(e) => {
                      e.stopPropagation();
                      l.onToggle();
                    }}
                    style={{
                      width: 26,
                      height: 15,
                      borderRadius: 8,
                      cursor: 'pointer',
                      background: l.on ? ACCENT : 'rgba(127,127,127,0.35)',
                      position: 'relative',
                    }}
                  >
                    <div
                      style={{
                        position: 'absolute',
                        top: 1.5,
                        left: l.on ? 13 : 1.5,
                        width: 12,
                        height: 12,
                        borderRadius: '50%',
                        background: '#fff',
                        boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
                        transition: 'left 0.15s',
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{ background: theme.segBg, borderRadius: 10, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: theme.textPrimary }}>正在編輯：{selectedLayer.label}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 9, color: theme.textTertiary, width: 26, flexShrink: 0 }}>大小</span>
              <input
                type="range"
                min="0.7"
                max="1.6"
                step="0.05"
                value={selectedLayer.style.scale}
                onChange={(e) => selectedLayer.setStyle({ scale: Number(e.target.value) })}
                style={{ width: '100%', accentColor: ACCENT }}
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 9, color: theme.textTertiary, width: 26, flexShrink: 0 }}>陰影</span>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={selectedLayer.style.shadow}
                onChange={(e) => selectedLayer.setStyle({ shadow: Number(e.target.value) })}
                style={{ width: '100%', accentColor: ACCENT }}
              />
            </div>
          </div>

          <div>
            <div style={{ fontSize: 10, color: theme.textTertiary, marginBottom: 5 }}>字幕背景</div>
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

          <div style={{ borderTop: `1px solid ${theme.hairline}`, paddingTop: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: theme.textPrimary }}>字幕時間校正</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span
                  style={{
                    fontSize: 11,
                    fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace',
                    fontWeight: 700,
                    color: theme.textPrimary,
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
                    padding: 4,
                    borderRadius: 6,
                    background: theme.segBg,
                    color: theme.textTertiary,
                    display: 'flex',
                  }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
                    <path
                      d="M3 12a9 9 0 109-9M3 12V4M3 12h8"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
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

          <div style={{ borderTop: `1px solid ${theme.hairline}`, paddingTop: 8 }}>
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
              borderTop: `1px solid ${theme.hairline}`,
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
                padding: '8px 12px',
                borderRadius: 999,
                background: regenerateDisabled ? theme.segBg : ACCENT,
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
                border: `1px solid ${retranslateDisabled ? 'transparent' : theme.hairline}`,
                cursor: retranslateDisabled ? 'default' : 'pointer',
                fontSize: 11,
                fontWeight: 700,
                padding: '8px 12px',
                borderRadius: 999,
                background: theme.segBg,
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

          <div style={{ fontSize: 10, color: theme.textTertiary, paddingTop: 2 }}>
            字幕來源：本地 Whisper 辨識＋翻譯 API
          </div>
        </div>
      </div>
    </div>
  );
}
