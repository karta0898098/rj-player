import GenerationOptionsForm from './GenerationOptionsForm.jsx';

// Anchored glass popover under Titlebar's URL input — lets the user
// pre-select per-item ASR/generation options (and confirm/override the
// auto-detected "music MV" flag) before a pasted URL is actually added to
// the queue. Mirrors SettingsPopover's visual language (14px-radius glass
// panel) but anchors below (`top`) instead of above (`bottom`), since it
// hangs off the title bar at the top of the window. No submit button of its
// own — it lives inside Titlebar's <form>, so the titlebar's own accent
// arrow button (or Enter in the URL field) submits it, matching the design
// handoff reference exactly.
export default function AddToQueuePopover({
  theme,
  previewLoading,
  previewError,
  previewTitle,
  previewChannel,
  ...formProps
}) {
  return (
    <div style={{ position: 'absolute', top: 40, right: 0, zIndex: 6, width: 270 }}>
      <div style={{ position: 'relative', borderRadius: 14 }}>
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
          className="rj-pop-in"
          style={{
            position: 'relative',
            zIndex: 1,
            padding: 14,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            maxHeight: 'min(74vh, 600px)',
            overflowY: 'auto',
            boxSizing: 'border-box',
            animation: 'rjPopIn 180ms cubic-bezier(.2,.8,.3,1) both',
            transformOrigin: 'top right',
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 700, color: theme.textPrimary }}>加入佇列的 ASR 設定</div>

          <div
            // Clamp the preview line to 2 lines with an ellipsis so a very long
            // video title can't grow the popover tall or (for a long
            // space-less string / URL) overflow its fixed 270px width.
            title={previewTitle || undefined}
            style={{
              fontSize: 11,
              color: theme.textTertiary,
              minHeight: 14,
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              overflowWrap: 'anywhere',
              lineHeight: 1.35,
            }}
          >
            {previewLoading
              ? '讀取影片資訊中…'
              : previewError
              ? previewError
              : previewTitle
              ? `${previewTitle}${previewChannel ? ` · ${previewChannel}` : ''}`
              : '貼上網址後會自動讀取標題與分類'}
          </div>

          <GenerationOptionsForm theme={theme} {...formProps} />
        </div>
      </div>
    </div>
  );
}
