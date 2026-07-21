import { PIPELINE_STATUS_LABELS } from '../utils.js';

// Slim strip under Titlebar showing queued/processing videos (the queue
// feature). Collapses to nothing when there's nothing to show, so the
// common "just watching one video" case looks unchanged. Derives its rows
// entirely from GET /api/videos (polled by App), filtered down to
// genuinely in-flight items -- `queued` is FIFO by created_at, and at most
// one item can be in an active pipeline status at a time (single-worker
// queue). Finished/failed/cancelled items drop out of the strip; re-pasting
// a finished URL jumps straight to it via the existing cache-hit path.
export default function QueueList({ theme, items, onCancel }) {
  if (!items || items.length === 0) return null;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        overflowX: 'auto',
        padding: '8px 16px',
        borderBottom: `1px solid ${theme.border}`,
        flexShrink: 0,
      }}
    >
      {items.map((item) => {
        const isPending = item.status === 'queued';
        const label = PIPELINE_STATUS_LABELS[item.status] || item.status;
        return (
          <div
            key={item.video_id}
            title={item.title || item.video_id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              flexShrink: 0,
              maxWidth: 220,
              padding: '5px 10px',
              borderRadius: 999,
              background: theme.chipInactiveBg,
            }}
          >
            {item.is_music_video && <span title="音樂 MV">🎵</span>}
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: theme.textPrimary,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                maxWidth: 120,
              }}
            >
              {item.title || item.video_id}
            </span>
            <span style={{ fontSize: 10, color: theme.textTertiary, whiteSpace: 'nowrap' }}>{label}</span>
            {isPending && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onCancel(item.video_id);
                }}
                title="取消"
                style={{
                  border: 'none',
                  background: 'transparent',
                  cursor: 'pointer',
                  color: theme.textTertiary,
                  fontSize: 12,
                  padding: 0,
                  lineHeight: 1,
                }}
              >
                ✕
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
