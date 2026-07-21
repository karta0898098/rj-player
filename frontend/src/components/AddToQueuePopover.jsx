import { ACCENT } from '../theme.js';
import GenerationOptionsForm from './GenerationOptionsForm.jsx';

// Anchored glass popover under Titlebar's URL input — lets the user
// pre-select per-item ASR/generation options (and confirm/override the
// auto-detected "music MV" flag) before a pasted URL is actually added to
// the queue. Mirrors SettingsPopover's visual language (14px-radius glass
// panel) but anchors below (`top`) instead of above (`bottom`), since it
// hangs off the title bar at the top of the window.
export default function AddToQueuePopover({
  theme,
  dark,
  previewLoading,
  previewError,
  previewTitle,
  previewChannel,
  onSubmit,
  submitDisabled,
  submitting,
  ...formProps
}) {
  return (
    <div style={{ position: 'absolute', top: 40, right: 0, zIndex: 6, width: 260 }}>
      <div style={{ position: 'relative', borderRadius: 14 }}>
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
          <div style={{ fontSize: 12, fontWeight: 700, color: theme.textPrimary }}>加入佇列</div>

          <div style={{ fontSize: 11, color: theme.textTertiary, minHeight: 14 }}>
            {previewLoading
              ? '讀取影片資訊中…'
              : previewError
              ? previewError
              : previewTitle
              ? `${previewTitle}${previewChannel ? ` · ${previewChannel}` : ''}`
              : '貼上網址後會自動讀取標題與分類'}
          </div>

          <GenerationOptionsForm theme={theme} {...formProps} />

          <button
            type="button"
            onClick={onSubmit}
            disabled={submitDisabled}
            style={{
              border: 'none',
              cursor: submitDisabled ? 'default' : 'pointer',
              fontSize: 11,
              fontWeight: 700,
              padding: '7px 12px',
              borderRadius: 999,
              background: submitDisabled ? theme.segmentBg : ACCENT,
              color: submitDisabled ? theme.textTertiary : '#fff',
              opacity: submitDisabled ? 0.6 : 1,
              width: '100%',
            }}
          >
            {submitting ? '加入中…' : '加入佇列'}
          </button>
        </div>
      </div>
    </div>
  );
}
