import { ACCENT } from '../theme.js';

export const WHISPER_MODELS = ['tiny', 'base', 'small', 'medium', 'large-v3'];

// The Whisper/VAD/prompt knob controls shared between SettingsPopover's
// "進階：字幕產生設定" (regenerate an already-loaded video) and the
// add-to-queue form (pre-select options for a video that hasn't been
// submitted yet) — extracted so the ~150 lines of controls aren't
// duplicated between the two call sites.
//
// `isMusicVideo`/`onIsMusicVideoChange` are optional: pass both to render
// the "這是一首音樂 MV" checkbox (the add-to-queue form does; the regenerate
// panel in SettingsPopover doesn't, since is_music_video is only persisted
// at initial submission, not on regenerate).
export default function GenerationOptionsForm({
  theme,
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
  isMusicVideo,
  onIsMusicVideoChange,
  onResetGenerationSettings,
}) {
  const compactInputStyle = {
    width: '100%',
    boxSizing: 'border-box',
    fontSize: 12,
    padding: '6px 8px',
    borderRadius: 7,
    border: `1px solid ${theme.hairline}`,
    background: theme.segBg,
    color: theme.textPrimary,
    fontFamily: 'inherit',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {onIsMusicVideoChange && (
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
            <span>這是一首音樂 MV</span>
            <input
              type="checkbox"
              checked={isMusicVideo}
              onChange={(e) => onIsMusicVideoChange(e.target.checked)}
              style={{ width: 16, height: 16, accentColor: ACCENT, cursor: 'pointer' }}
            />
          </label>
          <div style={{ fontSize: 10, color: theme.textTertiary, marginTop: 4 }}>
            依 YouTube 分類自動偵測；勾選後會套用歌詞辨識提示與較適合歌唱的 VAD 參數
          </div>
        </div>
      )}

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

      {onResetGenerationSettings && (
        <button
          type="button"
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
      )}
    </div>
  );
}
