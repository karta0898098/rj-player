import { useMemo, useState } from 'react';
import { thumbnailUrl } from '../api.js';
import CustomSelect from './CustomSelect.jsx';
import {
  formatTime,
  PIPELINE_STATUS_LABELS,
  PIPELINE_ACTIVE_STATUSES,
  loadResumePositions,
  loadLastPlayedMap,
} from '../utils.js';

// The video library — the app's second main view (App.jsx toggles between
// this and the player via the Titlebar's library button). A poster-card grid
// over every video ever downloaded (GET /api/videos, surfaced by App as the
// `videos` prop), with search / filter / sort and per-card actions
// (play · add-to-playlist · regenerate · delete). Distinct from the sidebar
// PlaylistPanel: that's a hand-curated ordered session list, this is the
// browse-everything home.

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'music', label: '🎵 音樂' },
  { key: 'ready', label: '已就緒' },
  { key: 'processing', label: '處理中' },
  { key: 'failed', label: '失敗' },
];

const SORTS = [
  { key: 'recent', label: '最近加入' },
  { key: 'played', label: '最近觀看' },
  { key: 'oldest', label: '最早加入' },
  { key: 'duration', label: '片長' },
  { key: 'channel', label: '頻道' },
];

function matchesFilter(v, filter) {
  switch (filter) {
    case 'music':
      return v.is_music_video;
    case 'ready':
      return v.status === 'ready';
    case 'processing':
      return PIPELINE_ACTIVE_STATUSES.has(v.status);
    case 'failed':
      return v.status === 'pipeline_failed' || v.status === 'download_failed';
    default:
      return true;
  }
}

// A single circular icon button in the on-thumbnail hover action bar.
function ActionButton({ title, onClick, accent, children }) {
  return (
    <button
      type="button"
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      style={{
        width: 34,
        height: 34,
        borderRadius: '50%',
        border: 'none',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#fff',
        background: accent || 'rgba(20,20,22,0.72)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
      }}
    >
      {children}
    </button>
  );
}

function LibraryCard({
  theme,
  video,
  isActive,
  inPlaylist,
  resumeSeconds,
  onPlay,
  onAddToPlaylist,
  onRegenerate,
  onDelete,
}) {
  const [imgError, setImgError] = useState(false);
  const { video_id, title, channel, duration_ms, status, is_music_video, has_thumbnail, has_subtitles } = video;

  const durationSec = duration_ms ? duration_ms / 1000 : 0;
  const resumePct =
    resumeSeconds && durationSec ? Math.min(100, Math.max(0, (resumeSeconds / durationSec) * 100)) : 0;

  const isProcessing = PIPELINE_ACTIVE_STATUSES.has(status);
  const isFailed = status === 'pipeline_failed' || status === 'download_failed';
  const showStatusPill = status !== 'ready';
  const statusLabel = PIPELINE_STATUS_LABELS[status] || status;

  const showThumb = has_thumbnail && !imgError;

  return (
    <div
      className="library-card"
      onClick={() => onPlay(video_id)}
      style={{
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        borderRadius: 12,
        overflow: 'hidden',
        background: theme.segBg,
        border: `1px solid ${isActive ? theme.segmentActiveBg : theme.hairline}`,
      }}
    >
      {/* Poster (16:9) */}
      <div style={{ position: 'relative', width: '100%', aspectRatio: '16 / 9', background: theme.chipBg }}>
        {showThumb ? (
          <img
            src={thumbnailUrl(video_id)}
            alt=""
            onError={() => setImgError(true)}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        ) : (
          <div
            style={{
              width: '100%',
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: `linear-gradient(135deg, ${theme.chipBg}, ${theme.segBg})`,
            }}
          >
            <div
              style={{
                width: 0,
                height: 0,
                borderTop: '9px solid transparent',
                borderBottom: '9px solid transparent',
                borderLeft: `14px solid ${theme.textTertiary}`,
                marginLeft: 3,
              }}
            />
          </div>
        )}

        {/* Music badge (top-left) */}
        {is_music_video && (
          <span
            title="音樂 MV"
            style={{ position: 'absolute', top: 6, left: 6, fontSize: 13, filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.6))' }}
          >
            🎵
          </span>
        )}

        {/* Active-now badge (top-left, under music if both) */}
        {isActive && (
          <span
            style={{
              position: 'absolute',
              top: 6,
              right: 6,
              fontSize: 10,
              fontWeight: 700,
              color: '#fff',
              background: 'rgba(224,69,63,0.92)',
              borderRadius: 5,
              padding: '2px 6px',
            }}
          >
            播放中
          </span>
        )}

        {/* Duration badge (bottom-right) */}
        {durationSec > 0 && (
          <span
            style={{
              position: 'absolute',
              bottom: 6,
              right: 6,
              fontSize: 11,
              fontWeight: 600,
              color: '#fff',
              background: 'rgba(0,0,0,0.72)',
              borderRadius: 4,
              padding: '1px 5px',
            }}
          >
            {formatTime(durationSec)}
          </span>
        )}

        {/* Hover action bar (centered) */}
        <div
          className="library-card-actions"
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 10,
            background: 'rgba(0,0,0,0.34)',
          }}
        >
          <ActionButton title="播放" onClick={() => onPlay(video_id)} accent="rgba(224,69,63,0.92)">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          </ActionButton>
          <ActionButton title={inPlaylist ? '已在播放清單' : '加入播放清單'} onClick={() => onAddToPlaylist(video_id)}>
            {inPlaylist ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
                <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
                <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
              </svg>
            )}
          </ActionButton>
          <ActionButton title="重新產生字幕" onClick={() => onRegenerate(video_id)}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
              <path
                d="M4 12a8 8 0 0113.7-5.7L20 8M20 4v4h-4M20 12a8 8 0 01-13.7 5.7L4 16M4 20v-4h4"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </ActionButton>
          <ActionButton title="刪除影片" onClick={() => onDelete(video_id)}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
              <path
                d="M6 7h12M9 7V5h6v2M7 7l1 12h8l1-12"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </ActionButton>
        </div>

        {/* Resume progress bar (bottom edge) */}
        {resumePct > 1 && (
          <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 3, background: 'rgba(0,0,0,0.45)' }}>
            <div style={{ width: `${resumePct}%`, height: '100%', background: '#e0453f' }} />
          </div>
        )}
      </div>

      {/* Meta */}
      <div style={{ padding: '9px 10px 11px', minWidth: 0 }}>
        <div
          title={title || video_id}
          style={{
            color: theme.textPrimary,
            fontSize: 13,
            fontWeight: isActive ? 700 : 600,
            lineHeight: 1.3,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {title || video_id}
        </div>
        <div
          style={{
            marginTop: 5,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            color: theme.textTertiary,
            fontSize: 11,
            minWidth: 0,
          }}
        >
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>
            {channel || '—'}
          </span>
          {showStatusPill ? (
            <span
              style={{
                flexShrink: 0,
                fontWeight: 600,
                color: isFailed ? '#e0453f' : isProcessing ? theme.textSecondary : theme.textTertiary,
              }}
            >
              {statusLabel}
            </span>
          ) : (
            has_subtitles && <span style={{ flexShrink: 0, color: theme.textTertiary }}>字幕就緒</span>
          )}
        </div>
      </div>
    </div>
  );
}

export default function LibraryView({
  theme,
  videos,
  activeVideoId,
  playlistIds,
  onPlay,
  onAddToPlaylist,
  onRegenerate,
  onDelete,
}) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState('recent');

  const playlistSet = useMemo(() => new Set(playlistIds), [playlistIds]);
  // Read localStorage fresh each render (cheap for a personal library) so the
  // resume bars / "recently watched" sort reflect the latest playback — App
  // re-renders this on its 3s poll and on every view switch.
  const resumePositions = loadResumePositions();
  const lastPlayed = loadLastPlayedMap();

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = (videos || []).filter((v) => {
      if (!matchesFilter(v, filter)) return false;
      if (!q) return true;
      return (
        (v.title || '').toLowerCase().includes(q) ||
        (v.channel || '').toLowerCase().includes(q)
      );
    });

    const sorted = [...filtered];
    sorted.sort((a, b) => {
      switch (sort) {
        case 'oldest':
          return new Date(a.created_at) - new Date(b.created_at);
        case 'duration':
          return (b.duration_ms || 0) - (a.duration_ms || 0);
        case 'channel':
          return (a.channel || '').localeCompare(b.channel || '');
        case 'played':
          return (lastPlayed[b.video_id] || 0) - (lastPlayed[a.video_id] || 0);
        case 'recent':
        default:
          return new Date(b.created_at) - new Date(a.created_at);
      }
    });
    return sorted;
  }, [videos, search, filter, sort, lastPlayed]);

  const totalCount = (videos || []).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
      {/* Toolbar */}
      <div
        style={{
          flexShrink: 0,
          padding: '14px 20px',
          borderBottom: `1px solid ${theme.hairline}`,
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 12,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexShrink: 0 }}>
          <span style={{ color: theme.textPrimary, fontSize: 15, fontWeight: 700 }}>影片庫</span>
          <span style={{ color: theme.textTertiary, fontSize: 12 }}>{totalCount} 支</span>
        </div>

        {/* Search */}
        <div
          style={{
            background: theme.inputBg,
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            borderRadius: 9,
            padding: '7px 11px',
            width: 240,
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0, color: theme.textTertiary }}>
            <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
            <path d="M20 20l-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜尋標題或頻道…"
            style={{
              color: theme.textPrimary,
              border: 'none',
              background: 'transparent',
              outline: 'none',
              fontSize: 12,
              flex: 1,
              minWidth: 0,
            }}
          />
        </div>

        {/* Filter chips */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
          {FILTERS.map((f) => {
            const active = f.key === filter;
            return (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                style={{
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 12,
                  fontWeight: active ? 700 : 500,
                  padding: '5px 10px',
                  borderRadius: 7,
                  background: active ? theme.segmentActiveBg : 'transparent',
                  color: active ? theme.segmentActiveText : theme.textTertiary,
                }}
              >
                {f.label}
              </button>
            );
          })}
        </div>

        <div style={{ flex: 1 }} />

        {/* Sort */}
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <span style={{ color: theme.textTertiary, fontSize: 11 }}>排序</span>
          <CustomSelect
            theme={theme}
            value={sort}
            onChange={setSort}
            options={SORTS.map((s) => ({ value: s.key, label: s.label }))}
            ariaLabel="排序"
            style={{ width: 132, background: theme.inputBg, padding: '5px 8px' }}
          />
        </label>
      </div>

      {/* Grid */}
      <div className="subtitle-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 20 }}>
        {visible.length === 0 ? (
          <div
            style={{
              height: '100%',
              minHeight: 200,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              textAlign: 'center',
              color: theme.textTertiary,
              fontSize: 13,
              lineHeight: 1.7,
            }}
          >
            {totalCount === 0
              ? '影片庫還是空的 — 在上方貼上 YouTube 連結開始下載，影片會出現在這裡。'
              : '沒有符合條件的影片，換個搜尋或篩選試試。'}
          </div>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
              gap: 16,
            }}
          >
            {visible.map((v) => (
              <LibraryCard
                key={v.video_id}
                theme={theme}
                video={v}
                isActive={v.video_id === activeVideoId}
                inPlaylist={playlistSet.has(v.video_id)}
                resumeSeconds={resumePositions[v.video_id]}
                onPlay={onPlay}
                onAddToPlaylist={onAddToPlaylist}
                onRegenerate={onRegenerate}
                onDelete={onDelete}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
