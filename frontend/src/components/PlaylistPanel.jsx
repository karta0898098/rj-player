import { useState } from 'react';
import { PIPELINE_STATUS_LABELS, formatTime } from '../utils.js';

// 56×32 rounded "縮圖" placeholder (design handoff §側邊欄) — the backend
// doesn't serve real per-video thumbnail images (VideoSummary has no
// thumbnail URL), so this renders a themed placeholder tile with a small
// play glyph instead of an actual <img>.
function ThumbnailPlaceholder({ theme }) {
  return (
    <div
      style={{
        width: 56,
        height: 32,
        borderRadius: 6,
        flexShrink: 0,
        background: theme.segBg,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          width: 0,
          height: 0,
          borderTop: '5px solid transparent',
          borderBottom: '5px solid transparent',
          borderLeft: `7px solid ${theme.textTertiary}`,
          marginLeft: 2,
        }}
      />
    </div>
  );
}

// Playlist body — the other of the two tabs hosted inside SidebarPanel.jsx
// (see SubtitleList.jsx for the sibling). Unlike the transient Queue strip
// (QueueList.jsx, shows only in-flight items and drops finished ones), this
// is a persistent, user-reorderable list of every video added via "加入佇列"
// this app has ever seen (App.jsx persists it to localStorage) — click a row
// to switch playback to it, drag to reorder, ✕ to remove from the list.
export default function PlaylistPanel({ theme, items, activeVideoId, onSelect, onRemove, onReorder }) {
  const [draggedIndex, setDraggedIndex] = useState(null);
  const [dragOverIndex, setDragOverIndex] = useState(null);

  if (!items || items.length === 0) {
    return (
      <div
        style={{
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '0 24px',
          textAlign: 'center',
        }}
      >
        <span style={{ color: theme.textTertiary, fontSize: 12, lineHeight: 1.6 }}>
          透過上方「加入佇列」新增的影片會出現在這裡，可拖曳排序
        </span>
      </div>
    );
  }

  function handleDrop(dropIndex) {
    if (draggedIndex != null && draggedIndex !== dropIndex) {
      onReorder(draggedIndex, dropIndex);
    }
    setDraggedIndex(null);
    setDragOverIndex(null);
  }

  return (
    <div className="subtitle-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
      {items.map((item, index) => {
        const isActive = item.video_id === activeVideoId;
        const isDragging = index === draggedIndex;
        const isDragOver = index === dragOverIndex && draggedIndex !== null && draggedIndex !== index;
        const label = PIPELINE_STATUS_LABELS[item.status] || item.status;
        return (
          <div
            key={item.video_id}
            className="subtitle-row"
            draggable
            onDragStart={() => setDraggedIndex(index)}
            onDragOver={(e) => {
              e.preventDefault();
              if (dragOverIndex !== index) setDragOverIndex(index);
            }}
            onDrop={(e) => {
              e.preventDefault();
              handleDrop(index);
            }}
            onDragEnd={() => {
              setDraggedIndex(null);
              setDragOverIndex(null);
            }}
            onClick={() => onSelect(item.video_id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '8px 12px',
              cursor: 'pointer',
              opacity: isDragging ? 0.4 : 1,
              borderLeft: `3px solid ${isActive ? theme.textPrimary : 'transparent'}`,
              borderTop: isDragOver ? `2px solid ${theme.textPrimary}` : '2px solid transparent',
              background: isActive ? 'rgba(127,127,127,0.12)' : 'transparent',
            }}
          >
            <span
              title="拖曳排序"
              style={{ flexShrink: 0, color: theme.textTertiary, fontSize: 12, cursor: 'grab', lineHeight: 1 }}
            >
              ⋮⋮
            </span>
            <ThumbnailPlaceholder theme={theme} />
            {item.is_music_video && <span title="音樂 MV">🎵</span>}
            <div style={{ minWidth: 0, flex: 1 }}>
              <div
                style={{
                  color: theme.textPrimary,
                  fontSize: 13,
                  fontWeight: isActive ? 700 : 500,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {item.title || item.video_id}
              </div>
              <div
                style={{
                  color: theme.textTertiary,
                  fontSize: 11,
                  marginTop: 2,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {[item.channel, item.duration_ms ? formatTime(item.duration_ms / 1000) : null, label]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
            </div>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onRemove(item.video_id);
              }}
              title="從播放清單移除"
              style={{
                flexShrink: 0,
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                color: theme.textTertiary,
                padding: 4,
                display: 'flex',
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        );
      })}
    </div>
  );
}
