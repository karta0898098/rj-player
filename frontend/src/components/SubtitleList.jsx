import { useEffect, useRef, useState } from 'react';
import { ACCENT } from '../theme.js';
import { findActiveCue, formatTime, formatPipelineStatusLabel, PIPELINE_ACTIVE_STATUSES } from '../utils.js';

// Subtitle-list body — one of two tabs hosted inside SidebarPanel.jsx (the
// other being PlaylistPanel.jsx); SidebarPanel owns the shared width/
// collapse/tab-header chrome, this component owns only the scrollable cue
// list itself. Mirrors the EXACT active-cue lookup SubtitleOverlay.jsx uses —
// findActiveCue(cues, currentTime*1000 - subtitleOffsetMs) — so the
// highlighted row here and the on-video subtitle never disagree about which
// cue is active. Clicking a row seeks via onSeekToCue (wired to App.jsx,
// which sets videoRef.current.currentTime + setCurrentTime). Requires its
// parent to be `position: relative` -- the "回到目前播放" button anchors to it.
//
// Editing: double-click a cue's 日文 or 中文 line to edit it in place;
// Enter/blur saves via onEditCue(cueId, {ja_text?|zh_text?}), Escape cancels.
// Export: onExport(format) is called for 'srt' | 'lrc' | 'txt'.
export default function SubtitleList({
  theme,
  cues,
  currentTime,
  subtitleOffsetMs,
  subtitleStatus,
  subtitleStage,
  subtitlePct,
  onSeekToCue,
  onEditCue,
  onExport,
}) {
  // Whether the list should keep auto-scrolling the active row into view.
  // Starts pinned (old behavior); the moment the user scrolls the list by
  // hand it un-pins so their position stops getting yanked back down on
  // every cue change — they get it back via the "回到目前播放" button or by
  // clicking a row.
  const [pinned, setPinned] = useState(true);
  // In-place edit target: { cueId, field: 'ja'|'zh', value } or null.
  const [edit, setEdit] = useState(null);
  const activeRowRef = useRef(null);
  const editRef = useRef(null);
  // Guards handleScroll against reacting to our OWN scrollIntoView calls
  // (fired below) as if they were user-initiated scrolling.
  const programmaticScrollRef = useRef(false);

  const hasCues = Boolean(cues && cues.length);
  const lookupMs = currentTime * 1000 - (subtitleOffsetMs || 0);
  const activeCue = hasCues ? findActiveCue(cues, lookupMs) : null;
  const activeId = activeCue ? activeCue.id : null;

  // Auto-scroll the active row into view — only while `pinned` AND not
  // mid-edit (so the list doesn't yank away from the textarea you're typing
  // in). `block: 'nearest'` only moves the list's own scroll container.
  useEffect(() => {
    if (!pinned || edit || !activeRowRef.current) return;
    programmaticScrollRef.current = true;
    activeRowRef.current.scrollIntoView({ block: 'nearest' });
    const t = setTimeout(() => {
      programmaticScrollRef.current = false;
    }, 100);
    return () => clearTimeout(t);
  }, [activeId, pinned, edit]);

  // Focus + select the textarea when an edit starts.
  useEffect(() => {
    if (edit && editRef.current) {
      editRef.current.focus();
      editRef.current.select();
    }
  }, [edit]);

  function handleScroll() {
    if (programmaticScrollRef.current) return;
    setPinned(false);
  }

  function handleRowClick(cue) {
    if (edit) return; // don't seek while editing
    setPinned(true);
    onSeekToCue(cue);
  }

  function jumpToCurrent() {
    setPinned(true);
    if (activeRowRef.current) {
      activeRowRef.current.scrollIntoView({ block: 'nearest' });
    }
  }

  function startEdit(cue, field) {
    if (!onEditCue) return;
    setPinned(false);
    setEdit({ cueId: cue.id, field, value: field === 'ja' ? cue.ja_text : cue.zh_text || '' });
  }

  function commitEdit() {
    if (!edit) return;
    const cue = cues.find((c) => c.id === edit.cueId);
    const original = cue ? (edit.field === 'ja' ? cue.ja_text : cue.zh_text || '') : '';
    if (edit.value !== original) {
      const patch = edit.field === 'ja' ? { ja_text: edit.value } : { zh_text: edit.value };
      onEditCue(edit.cueId, patch);
    }
    setEdit(null);
  }

  function onEditKeyDown(e) {
    // Enter commits (Shift+Enter inserts a newline); Escape cancels.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      commitEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setEdit(null);
    }
  }

  const editTextareaStyle = {
    width: '100%',
    boxSizing: 'border-box',
    fontSize: 13,
    fontFamily: 'inherit',
    lineHeight: 1.4,
    padding: '4px 6px',
    borderRadius: 6,
    border: `1px solid ${ACCENT}`,
    background: theme.segmentBg,
    color: theme.textPrimary,
    resize: 'vertical',
  };

  function renderEditable(cue, field, node) {
    const isEditing = edit && edit.cueId === cue.id && edit.field === field;
    if (isEditing) {
      return (
        <textarea
          ref={editRef}
          rows={2}
          value={edit.value}
          onChange={(e) => setEdit((prev) => ({ ...prev, value: e.target.value }))}
          onKeyDown={onEditKeyDown}
          onBlur={commitEdit}
          onClick={(e) => e.stopPropagation()}
          style={editTextareaStyle}
        />
      );
    }
    return (
      <div
        onDoubleClick={(e) => {
          e.stopPropagation();
          startEdit(cue, field);
        }}
        title="雙擊編輯"
      >
        {node}
      </div>
    );
  }

  return (
    <>
      {hasCues && onExport && (
        <div
          style={{
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 12px',
            borderBottom: `1px solid ${theme.border}`,
          }}
        >
          <span style={{ fontSize: 10, color: theme.textTertiary }}>匯出</span>
          {['srt', 'lrc', 'txt'].map((fmt) => (
            <button
              key={fmt}
              type="button"
              onClick={() => onExport(fmt)}
              style={{
                border: 'none',
                cursor: 'pointer',
                fontSize: 10,
                fontWeight: 700,
                padding: '3px 8px',
                borderRadius: 6,
                background: theme.segmentBg,
                color: theme.textSecondary,
                textTransform: 'uppercase',
              }}
            >
              {fmt}
            </button>
          ))}
        </div>
      )}

      <div onScroll={handleScroll} className="subtitle-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {!hasCues ? (
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
              {PIPELINE_ACTIVE_STATUSES.has(subtitleStatus)
                ? formatPipelineStatusLabel(subtitleStatus, subtitleStage, subtitlePct)
                : '字幕會顯示在這裡（可點擊跳轉、雙擊編輯）'}
            </span>
          </div>
        ) : (
          cues.map((cue) => {
            const isActive = cue.id === activeId;
            return (
              <div
                key={cue.id}
                ref={isActive ? activeRowRef : null}
                className="subtitle-row"
                onClick={() => handleRowClick(cue)}
                style={{
                  display: 'flex',
                  gap: 10,
                  alignItems: 'flex-start',
                  padding: '8px 14px 8px 12px',
                  cursor: 'pointer',
                  borderLeft: `3px solid ${isActive ? ACCENT : 'transparent'}`,
                  background: isActive ? 'rgba(224,69,63,0.14)' : 'transparent',
                }}
              >
                <div
                  style={{
                    flexShrink: 0,
                    minWidth: 34,
                    paddingTop: 1,
                    fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace',
                    fontSize: 11,
                    color: theme.textTertiary,
                  }}
                >
                  {formatTime(cue.start_ms / 1000)}
                </div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  {renderEditable(
                    cue,
                    'ja',
                    <div
                      style={{
                        color: theme.textPrimary,
                        fontSize: 13,
                        fontWeight: isActive ? 700 : 500,
                        lineHeight: 1.4,
                        wordBreak: 'break-word',
                      }}
                    >
                      {cue.ja_text}
                    </div>
                  )}
                  {cue.zh_text
                    ? renderEditable(
                        cue,
                        'zh',
                        <div
                          style={{
                            color: theme.textSecondary,
                            fontSize: 11,
                            marginTop: 2,
                            lineHeight: 1.4,
                            wordBreak: 'break-word',
                          }}
                        >
                          {cue.zh_text}
                        </div>
                      )
                    : onEditCue &&
                      !(edit && edit.cueId === cue.id && edit.field === 'zh') && (
                        <div
                          onDoubleClick={(e) => {
                            e.stopPropagation();
                            startEdit(cue, 'zh');
                          }}
                          title="雙擊加入翻譯"
                          style={{ color: theme.textTertiary, fontSize: 11, marginTop: 2, fontStyle: 'italic' }}
                        >
                          ＋加翻譯
                        </div>
                      )}
                  {/* When adding a translation to a cue that has none, the
                      textarea is rendered here (renderEditable's editing branch
                      only fires for the existing-zh path above). */}
                  {edit && edit.cueId === cue.id && edit.field === 'zh' && !cue.zh_text && (
                    <textarea
                      ref={editRef}
                      rows={2}
                      value={edit.value}
                      onChange={(e) => setEdit((prev) => ({ ...prev, value: e.target.value }))}
                      onKeyDown={onEditKeyDown}
                      onBlur={commitEdit}
                      onClick={(e) => e.stopPropagation()}
                      style={{ ...editTextareaStyle, marginTop: 2 }}
                    />
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {!pinned && hasCues && activeId != null && !edit && (
        <button
          type="button"
          onClick={jumpToCurrent}
          style={{
            position: 'absolute',
            left: '50%',
            bottom: 14,
            transform: 'translateX(-50%)',
            padding: '6px 12px',
            borderRadius: 999,
            border: 'none',
            background: ACCENT,
            color: '#fff',
            fontSize: 11,
            fontWeight: 700,
            cursor: 'pointer',
            boxShadow: '0 4px 14px rgba(0,0,0,0.35)',
          }}
        >
          ↓ 回到目前播放
        </button>
      )}
    </>
  );
}
