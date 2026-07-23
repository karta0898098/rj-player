import { ACCENT } from '../theme.js';
import RangeSlider from './RangeSlider.jsx';
import CustomSelect from './CustomSelect.jsx';

export const WHISPER_MODELS = ['tiny', 'base', 'small', 'medium', 'large-v3'];

const SOURCE_LANG_OPTIONS = [
  { value: 'ja', label: '日文' },
  { value: 'en', label: '英文' },
];
const MAX_HEIGHT_OPTIONS = [
  { value: 0, label: '最佳' },
  { value: 2160, label: '2160p (4K)' },
  { value: 1440, label: '1440p' },
  { value: 1080, label: '1080p' },
  { value: 720, label: '720p' },
  { value: 480, label: '480p' },
];
const WHISPER_MODEL_OPTIONS = WHISPER_MODELS.map((m) => ({ value: m, label: m }));

// Per-request Demucs vocal-separation override (backend `separate_vocals`):
// 'default' -> omit (follow the global 人聲分離 policy — under "auto" that
// means "separate iff 音樂 MV"), 'on'/'off' -> force for this run. A global
// policy of "off" is a hard kill-switch that beats 'on' (the settings-page
// hint says so).
export const SEPARATE_VOCALS_OPTIONS = [
  { value: 'default', label: '依全域設定（預設）' },
  { value: 'on', label: '強制執行' },
  { value: 'off', label: '此影片停用' },
];

// Per-request LLM lyrics-polish override (backend `lyrics_polish`) — same
// tri-state semantics as SEPARATE_VOCALS_OPTIONS.
export const LYRICS_POLISH_OPTIONS = [
  { value: 'default', label: '依全域設定（預設）' },
  { value: 'on', label: '強制執行' },
  { value: 'off', label: '此影片停用' },
];

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
//
// `sourceLang`/`onSourceLangChange` are likewise optional (dsd.md §12.6/
// §12.7 B5.3): pass both to render a 來源語言 (source_lang) selector at the
// top of the form — only the add-to-queue form does, since source_lang is
// only settable at initial submission (regenerate reuses the video's
// already-stored source_lang). When `sourceLang === 'en'`, the Japanese-only
// controls in this form (音樂 MV, 正確歌詞) hide themselves — Whisper model/
// temperature/VAD/initial_prompt stay visible since they're language-agnostic.
//
// `maxHeight`/`onMaxHeightChange` are likewise optional (per-video quality
// picker): pass both to render a 畫質 (max_height) selector right below the
// source-language one — only the add-to-queue form does, since the quality
// cap is only settable at initial submission (the video is already
// downloaded at whatever resolution by the time a regenerate would run).
export default function GenerationOptionsForm({
  theme,
  sourceLang,
  onSourceLangChange,
  maxHeight,
  onMaxHeightChange,
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
  separateVocals,
  onSeparateVocalsChange,
  lyricsPolish,
  onLyricsPolishChange,
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
      {onSourceLangChange && (
        <div>
          <div style={{ fontSize: 11, color: theme.textTertiary, marginBottom: 6 }}>來源語言 (source_lang)</div>
          <CustomSelect
            theme={theme}
            value={sourceLang}
            onChange={onSourceLangChange}
            options={SOURCE_LANG_OPTIONS}
            ariaLabel="來源語言"
          />
        </div>
      )}

      {onMaxHeightChange && (
        <div>
          <div style={{ fontSize: 11, color: theme.textTertiary, marginBottom: 6 }}>畫質 (max_height)</div>
          <CustomSelect
            theme={theme}
            value={maxHeight}
            onChange={onMaxHeightChange}
            options={MAX_HEIGHT_OPTIONS}
            ariaLabel="畫質"
          />
        </div>
      )}

      {onIsMusicVideoChange && sourceLang !== 'en' && (
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

      {onSeparateVocalsChange && sourceLang !== 'en' && (
        <div>
          <div style={{ fontSize: 11, color: theme.textTertiary, marginBottom: 6 }}>人聲分離 (separate_vocals)</div>
          <CustomSelect
            theme={theme}
            value={separateVocals}
            onChange={onSeparateVocalsChange}
            options={SEPARATE_VOCALS_OPTIONS}
            ariaLabel="人聲分離"
          />
          <div style={{ fontSize: 10, color: theme.textTertiary, marginTop: 4 }}>
            以 Demucs 先分離人聲再辨識，音樂影片歌詞品質更好；全域設定為「關閉」時無法強制開啟
          </div>
        </div>
      )}

      {onLyricsPolishChange && sourceLang !== 'en' && (
        <div>
          <div style={{ fontSize: 11, color: theme.textTertiary, marginBottom: 6 }}>歌詞修正 (lyrics_polish)</div>
          <CustomSelect
            theme={theme}
            value={lyricsPolish}
            onChange={onLyricsPolishChange}
            options={LYRICS_POLISH_OPTIONS}
            ariaLabel="歌詞修正"
          />
          <div style={{ fontSize: 10, color: theme.textTertiary, marginTop: 4 }}>
            辨識後由 LLM 依標題脈絡校對聽錯的歌詞（僅修字、不動時間軸）；需要翻譯 API Key
          </div>
        </div>
      )}

      <div>
        <div style={{ fontSize: 11, color: theme.textTertiary, marginBottom: 6 }}>模型 (whisper_model)</div>
        <CustomSelect
          theme={theme}
          value={whisperModel}
          onChange={onWhisperModelChange}
          options={WHISPER_MODEL_OPTIONS}
          ariaLabel="辨識模型"
        />
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
        <RangeSlider
          min="0"
          max="1"
          step="0.1"
          value={whisperTemperature}
          onChange={(e) => onWhisperTemperatureChange(Number(e.target.value))}
          style={{ width: '100%' }}
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
        <RangeSlider
          min="0"
          max="1"
          step="0.05"
          value={vadThreshold}
          onChange={(e) => onVadThresholdChange(Number(e.target.value))}
          style={{ width: '100%' }}
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

      {sourceLang !== 'en' && (
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
      )}

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
