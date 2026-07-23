import { useEffect, useRef } from 'react';
import { ACCENT } from '../theme.js';

// App-styled confirmation modal — replaces native window.confirm() so
// destructive actions (e.g. deleting a library video) match the glass UI
// instead of a jarring OS dialog. Backdrop click or Esc cancels; Enter (or
// the auto-focused confirm button) confirms. `danger` tints the confirm
// button with the accent red for irreversible actions.
export default function ConfirmDialog({
  open,
  theme,
  title,
  message,
  detail,
  confirmLabel = '確定',
  cancelLabel = '取消',
  danger = false,
  onConfirm,
  onCancel,
}) {
  const confirmRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        onConfirm();
      }
    }
    document.addEventListener('keydown', onKey);
    // Focus the confirm button so it's keyboard-reachable immediately.
    confirmRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onConfirm, onCancel]);

  if (!open) return null;

  return (
    <div
      onPointerDown={onCancel}
      className="rj-backdrop-in"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
        animation: 'rjBackdropIn 160ms ease both',
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        onPointerDown={(e) => e.stopPropagation()}
        className="rj-pop-in"
        style={{
          width: 'min(92vw, 400px)',
          animation: 'rjPopIn 200ms cubic-bezier(.2,.8,.3,1) both',
          background: theme.winBg,
          backdropFilter: 'blur(40px) saturate(160%)',
          WebkitBackdropFilter: 'blur(40px) saturate(160%)',
          border: `1px solid ${theme.winBorder}`,
          borderRadius: 16,
          padding: 22,
          boxShadow: `0 30px 80px rgba(0,0,0,0.5), inset 0 1px 0 ${theme.winInsetHighlight}`,
          fontFamily: "-apple-system,BlinkMacSystemFont,'SF Pro Text',Helvetica,Arial,sans-serif",
        }}
      >
        <div style={{ color: theme.textPrimary, fontSize: 15, fontWeight: 700 }}>{title}</div>
        {message && (
          <div style={{ color: theme.textSecondary, fontSize: 13, lineHeight: 1.65, marginTop: 10, whiteSpace: 'pre-wrap' }}>
            {message}
          </div>
        )}
        {detail && (
          <div style={{ color: theme.textTertiary, fontSize: 12, lineHeight: 1.6, marginTop: 6 }}>{detail}</div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
          <button
            type="button"
            onClick={onCancel}
            style={{
              border: 'none',
              cursor: 'pointer',
              padding: '8px 16px',
              borderRadius: 9,
              fontSize: 13,
              fontWeight: 600,
              background: theme.chipBg,
              color: theme.textSecondary,
            }}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            ref={confirmRef}
            onClick={onConfirm}
            style={{
              border: 'none',
              cursor: 'pointer',
              padding: '8px 16px',
              borderRadius: 9,
              fontSize: 13,
              fontWeight: 700,
              background: danger ? ACCENT : theme.segmentActiveBg,
              color: danger ? '#fff' : theme.segmentActiveText,
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
