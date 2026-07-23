import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ACCENT } from '../theme.js';
import { findActiveCue, formatTime, formatPipelineStatusLabel, PIPELINE_ACTIVE_STATUSES } from '../utils.js';

// Provenance-badge label/tooltip maps (dsd.md §12.6 B5.5) — `source`: 'cc'
// (manual source-language CC) | 'align' (forced alignment to reference
// lyrics) | 'asr' (Whisper); `target_source`: 'cc' (manual Chinese CC merged
// in) | 'llm' (machine-translated). `official: true` gets the accent tint
// (cc/align — no AI involved in that layer); 'asr'/'llm' stay neutral.
const SOURCE_CHIP_INFO = {
  cc: { label: '官方字幕', title: '字幕來源：影片內建人工字幕（未經 AI 辨識）', official: true },
  align: { label: '歌詞對齊', title: '字幕來源：依參考歌詞做時間軸對齊（未經 AI 辨識）', official: true },
  asr: { label: 'AI 辨識', title: '字幕來源：AI 語音辨識', official: false },
  // A3: no source-language CC, so the source (日文) layer was AI-translated
  // BACK from the official Chinese CC — not the original lyrics.
  cc_reverse: { label: 'AI 日譯', title: '字幕來源：由官方中文字幕 AI 反向翻譯成日文（非原曲歌詞）', official: false },
};

const TARGET_CHIP_INFO = {
  cc: { label: '官方翻譯', title: '翻譯來源：官方中文字幕（未經 AI 翻譯）', official: true },
  llm: { label: 'AI 翻譯', title: '翻譯來源：AI 翻譯', official: false },
};

// ---- timecode helpers (edit-mode timing fields) ---------------------------
// Millisecond-precise, unlike utils.js's `formatTime` (M:SS only) — ASR
// boundary fixes need sub-second control. Format is "M:SS.mmm".
function formatTimecode(ms) {
  const total = Math.max(0, Math.round(ms));
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const millis = total % 1000;
  return `${m}:${String(s).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

// Parse "M:SS.mmm" / "M:SS" / "SS.mmm" / "SS" back to ms. Returns null on
// anything malformed (or seconds > 59) so the caller can reject the edit and
// keep the old value rather than saving garbage.
function parseTimecode(str) {
  const t = (str || '').trim();
  const m = t.match(/^(?:(\d+):)?(\d{1,2})(?:\.(\d{1,3}))?$/);
  if (!m) return null;
  const mins = m[1] ? parseInt(m[1], 10) : 0;
  const secs = parseInt(m[2], 10);
  if (secs > 59) return null;
  const millis = m[3] ? parseInt(m[3].padEnd(3, '0'), 10) : 0;
  return (mins * 60 + secs) * 1000 + millis;
}

function getSourceChipInfo(source) {
  return SOURCE_CHIP_INFO[source] || null;
}

function getTargetChipInfo(targetSource) {
  return TARGET_CHIP_INFO[targetSource] || null;
}

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
// Editing (dsd.md subtitle-edit feature): gated behind an explicit 編輯 mode
// toggle in the header bar — with it OFF the list is read-only (click a row to
// seek, nothing is editable), matching the "點下去之後才編輯" intent. With it
// ON each row exposes:
//   • text edit — double-click the 日文/中文 line; onEditCue(cueId, patch) with
//     {source_text?|target_text?}. Editing 日文 regenerates furigana/romaji
//     server-side (see backend patch_cue).
//   • timing edit — start/end fields (mm:ss.mmm) + "設為現在" (⌖) buttons that
//     snap the boundary to the current playhead; committed via onReplaceCues.
//   • structural ⋯ menu — split at playhead / merge with next / insert after /
//     delete, all expressed as a full new cue array via onReplaceCues(cues).
// Timing + structural changes go through onReplaceCues (not onEditCue) because
// the backend re-sorts and can add/remove/reorder rows; text edits stay on the
// lighter single-cue onEditCue path.
// Export: onExport(format) is called for 'srt' | 'lrc' | 'txt'.
//
// Provenance badges (dsd.md §12.6 B5.5): `source`/`targetSource` come from
// the subtitle doc's `source`/`target_source` fields (App.jsx's docSource/
// docTargetSource, captured in loadSubtitles) and are rendered as small
// chips in the export bar so the user can tell official captions/alignment
// apart from AI-generated ASR/translation at a glance.
export default function SubtitleList({
  theme,
  cues,
  currentTime,
  subtitleOffsetMs,
  subtitleStatus,
  subtitleStage,
  subtitlePct,
  source,
  targetSource,
  onSeekToCue,
  onEditCue,
  onReplaceCues,
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
  // Whether the list is in the explicit 編輯 mode (gates ALL editing UI). Off
  // by default so the list is read-only until the user opts in.
  const [editMode, setEditMode] = useState(false);
  // Open structural ⋯ menu: { cueId, rect } (the trigger button's viewport
  // rect, so the portaled dropdown can position itself) or null. Portaled to
  // <body> so the `overflow-y:auto` scroll container can't clip it.
  const [menu, setMenu] = useState(null);
  // Cue id whose 刪除 is armed for a confirming second click (inline, no native
  // dialog — see the note on the menu below).
  const [deleteArm, setDeleteArm] = useState(null);
  const canEdit = editMode && Boolean(onEditCue);
  const canRestructure = editMode && Boolean(onReplaceCues);
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
  // in). `block: 'center'` (rather than 'nearest') re-centers the active row
  // on every single cue change instead of only moving once the row falls off
  // the visible edge — 'nearest' made the list sit still for many cues in a
  // row and then jerk down by one row at a time, most noticeably once
  // playback got deep enough into the list that the active row was
  // perpetually right at the bottom edge.
  useEffect(() => {
    // Also frozen while the ⋯ menu is open: it's a portaled, `position:fixed`
    // dropdown anchored to the trigger's rect, so an auto-scroll during
    // playback would both detach it from its row and (via handleScroll) close
    // it before the user can pick an item.
    if (!pinned || edit || menu || !activeRowRef.current) return;
    programmaticScrollRef.current = true;
    activeRowRef.current.scrollIntoView({ block: 'center' });
    // Reset the guard once the browser has actually settled the scroll (and
    // dispatched its resulting `scroll` event), rather than after a guessed
    // wall-clock delay. A fixed setTimeout raced the real `scroll` event on
    // large jumps (e.g. seeking far ahead, jumping many rows at once): the
    // event could fire late enough to land after the timeout already reset
    // the flag, get misread as a user-initiated scroll, and permanently
    // un-pin auto-follow for no reason. Two rAFs reliably land after the
    // current frame's scroll/paint work has been flushed.
    let raf2 = null;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        programmaticScrollRef.current = false;
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
    };
  }, [activeId, pinned, edit, menu]);

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
    // Deliberately do NOT close the ⋯ menu here. While the menu is open the
    // auto-scroll effect is frozen (see its guard), so the list doesn't move
    // on its own — and a still-settling scroll from just before the menu
    // opened would otherwise slip past the programmatic guard and close the
    // menu the instant it appears (unselectable during playback). Outside
    // clicks close it via the backdrop instead.
  }

  function handleRowClick(cue) {
    // In edit mode a row-body click must not seek (it would yank playback while
    // you're adjusting cues); seek via the timestamp cell instead. Also never
    // seek mid text-edit.
    if (edit || editMode) return;
    setPinned(true);
    onSeekToCue(cue);
  }

  // Timestamp cell click — seeks in BOTH modes (the only way to seek while in
  // edit mode).
  function seekFromStamp(e, cue) {
    e.stopPropagation();
    setPinned(true);
    onSeekToCue(cue);
  }

  function jumpToCurrent() {
    setPinned(true);
    if (activeRowRef.current) {
      activeRowRef.current.scrollIntoView({ block: 'center' });
    }
  }

  function startEdit(cue, field) {
    if (!canEdit) return;
    setPinned(false);
    setEdit({ cueId: cue.id, field, value: field === 'ja' ? cue.source_text : cue.target_text || '' });
  }

  function commitEdit() {
    if (!edit) return;
    const cue = cues.find((c) => c.id === edit.cueId);
    const original = cue ? (edit.field === 'ja' ? cue.source_text : cue.target_text || '') : '';
    if (edit.value !== original) {
      const patch = edit.field === 'ja' ? { source_text: edit.value } : { target_text: edit.value };
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

  // Leaving edit mode clears any transient edit/menu/arm state so nothing is
  // left half-open when the list goes back to read-only.
  useEffect(() => {
    if (!editMode) {
      setEdit(null);
      setMenu(null);
      setDeleteArm(null);
    }
  }, [editMode]);

  // ---- structural + timing ops (edit mode) --------------------------------
  // All go through onReplaceCues with a full new array; the backend validates,
  // re-sorts by start, and re-tokenizes any cue whose `tokens` we cleared.
  function nextCueId() {
    return cues.length ? Math.max(...cues.map((c) => c.id)) + 1 : 1;
  }

  function commitCues(next) {
    setMenu(null);
    setDeleteArm(null);
    setEdit(null);
    onReplaceCues(next);
  }

  // Commit a timing change for one field. `ms` is already-parsed; invalid or
  // start>=end is rejected (caller keeps the old displayed value).
  function commitTiming(cue, field, ms) {
    if (ms == null) return;
    const start_ms = field === 'start' ? ms : cue.start_ms;
    const end_ms = field === 'end' ? ms : cue.end_ms;
    if (start_ms >= end_ms) return;
    commitCues(cues.map((c) => (c.id === cue.id ? { ...c, start_ms, end_ms } : c)));
  }

  // Snap a boundary to the current playhead — the key ASR-alignment gesture:
  // play to the right moment, click ⌖.
  function setTimingToNow(cue, field) {
    commitTiming(cue, field, Math.round(currentTime * 1000));
  }

  // Split at the playhead if it's inside the cue, else at the midpoint. The
  // first half keeps the original text (and its tokens); the second half is a
  // fresh empty cue for the user to fill.
  function splitCue(cue) {
    const nowMs = Math.round(currentTime * 1000);
    let boundary = nowMs > cue.start_ms && nowMs < cue.end_ms
      ? nowMs
      : Math.round((cue.start_ms + cue.end_ms) / 2);
    boundary = Math.min(cue.end_ms - 1, Math.max(cue.start_ms + 1, boundary));
    const second = {
      ...cue,
      id: nextCueId(),
      start_ms: boundary,
      source_text: '',
      target_text: null,
      tokens: [],
      phonetic: '',
    };
    const next = cues.flatMap((c) =>
      c.id === cue.id ? [{ ...c, end_ms: boundary }, second] : [c]
    );
    commitCues(next);
  }

  // Merge a cue with the one after it: union the time span, concatenate text
  // (no separator — right for JA; the user can adjust), clear tokens so the
  // backend rebuilds furigana/romaji for the joined line.
  function mergeWithNext(cue) {
    const idx = cues.findIndex((c) => c.id === cue.id);
    if (idx < 0 || idx >= cues.length - 1) return;
    const a = cues[idx];
    const b = cues[idx + 1];
    const at = a.target_text || '';
    const bt = b.target_text || '';
    const merged = {
      ...a,
      end_ms: b.end_ms,
      source_text: `${a.source_text}${b.source_text}`,
      target_text: at || bt ? `${at}${bt}` : null,
      tokens: [],
      phonetic: '',
    };
    const next = cues.filter((c) => c.id !== a.id && c.id !== b.id);
    next.splice(idx, 0, merged);
    commitCues(next);
  }

  // Insert a fresh empty cue right after this one, in the gap before the next
  // cue (capped at 2s), so there's a slot to type a missed line into.
  function insertAfter(cue) {
    const idx = cues.findIndex((c) => c.id === cue.id);
    const start = cue.end_ms;
    const nextCue = cues[idx + 1];
    let end = nextCue ? Math.min(nextCue.start_ms, start + 2000) : start + 2000;
    if (end <= start) end = start + 1000;
    const newCue = {
      id: nextCueId(),
      start_ms: start,
      end_ms: end,
      source_text: '',
      target_text: null,
      tokens: [],
      phonetic: '',
    };
    const next = [...cues];
    next.splice(idx + 1, 0, newCue);
    commitCues(next);
  }

  function deleteCue(cue) {
    commitCues(cues.filter((c) => c.id !== cue.id));
  }

  // One start/end timecode field (mm:ss.mmm) + a ⌖ "snap to playhead" button.
  // Uncontrolled + keyed on the current ms so it resets after a save; commits
  // on blur/Enter, restores the old value on a malformed or start>=end entry.
  function renderTimingField(cue, field) {
    const ms = field === 'start' ? cue.start_ms : cue.end_ms;
    const commit = (e) => {
      const parsed = parseTimecode(e.target.value);
      const start = field === 'start' ? parsed : cue.start_ms;
      const end = field === 'end' ? parsed : cue.end_ms;
      if (parsed == null || start >= end) {
        e.target.value = formatTimecode(ms); // reject → restore
        return;
      }
      if (parsed !== ms) commitTiming(cue, field, parsed);
    };
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
        <span style={{ color: theme.textTertiary, fontSize: 9 }}>{field === 'start' ? '始' : '終'}</span>
        <input
          key={`${cue.id}-${field}-${ms}`}
          defaultValue={formatTimecode(ms)}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.currentTarget.blur();
            } else if (e.key === 'Escape') {
              e.currentTarget.value = formatTimecode(ms);
              e.currentTarget.blur();
            }
          }}
          onBlur={commit}
          style={{
            width: 66,
            fontSize: 10,
            fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace',
            padding: '2px 4px',
            borderRadius: 4,
            border: `1px solid ${theme.hairline}`,
            background: theme.segBg,
            color: theme.textSecondary,
          }}
        />
        <button
          type="button"
          title="設為目前播放時間"
          onClick={(e) => {
            e.stopPropagation();
            setTimingToNow(cue, field);
          }}
          style={{
            border: 'none',
            cursor: 'pointer',
            fontSize: 11,
            lineHeight: 1,
            padding: '2px 4px',
            borderRadius: 4,
            background: theme.segBg,
            color: ACCENT,
          }}
        >
          ⌖
        </button>
      </span>
    );
  }

  // The per-row ⋯ trigger. Just opens the menu (rendered once via a portal in
  // renderMenuPortal); it stores the button's viewport rect so the portaled
  // dropdown can anchor to it without being clipped by the scroll container.
  function renderRowMenu(cue) {
    const open = menu?.cueId === cue.id;
    return (
      <div style={{ flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          title="更多編輯"
          onClick={(e) => {
            if (open) {
              setMenu(null);
            } else {
              setMenu({ cueId: cue.id, rect: e.currentTarget.getBoundingClientRect() });
            }
            setDeleteArm(null);
          }}
          style={{
            border: 'none',
            cursor: 'pointer',
            fontSize: 15,
            lineHeight: 1,
            padding: '2px 6px',
            borderRadius: 4,
            background: open ? theme.segBg : 'transparent',
            color: theme.textSecondary,
          }}
        >
          ⋯
        </button>
      </div>
    );
  }

  // The structural menu (split / merge / insert / delete), portaled to <body>
  // and `position: fixed` off the trigger's rect so the `overflow-y:auto`
  // scroll container can't clip it. Flips above the trigger when there isn't
  // room below. Delete is a two-step inline confirm (arm → "確定刪除？") rather
  // than a native dialog, matching the app's no-window.confirm rule.
  function renderMenuPortal() {
    if (!menu) return null;
    const cue = cues.find((c) => c.id === menu.cueId);
    if (!cue) return null;
    const idx = cues.findIndex((c) => c.id === cue.id);
    const hasNext = idx >= 0 && idx < cues.length - 1;
    const armed = deleteArm === cue.id;
    const { rect } = menu;
    const MENU_W = 176;
    const EST_H = 190;
    const flipUp = rect.bottom + EST_H > window.innerHeight;
    const item = (label, onClick, danger) => (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClick();
        }}
        style={{
          display: 'block',
          width: '100%',
          textAlign: 'left',
          border: 'none',
          cursor: 'pointer',
          fontSize: 12,
          padding: '8px 12px',
          background: 'transparent',
          color: danger ? ACCENT : theme.textPrimary,
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </button>
    );
    const closeMenu = () => {
      setMenu(null);
      setDeleteArm(null);
    };
    return createPortal(
      <>
        <div onClick={closeMenu} style={{ position: 'fixed', inset: 0, zIndex: 2000 }} />
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'fixed',
            left: Math.max(8, rect.right - MENU_W),
            top: flipUp ? undefined : rect.bottom + 4,
            bottom: flipUp ? window.innerHeight - rect.top + 4 : undefined,
            zIndex: 2001,
            width: MENU_W,
            padding: '4px 0',
            borderRadius: 8,
            border: `1px solid ${theme.hairline}`,
            background: theme.popGlassBg || theme.segBg,
            backdropFilter: 'blur(12px) saturate(1.4)',
            WebkitBackdropFilter: 'blur(12px) saturate(1.4)',
            boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
          }}
        >
          {item('在此切句（依播放位置）', () => splitCue(cue))}
          {hasNext && item('與下句合併', () => mergeWithNext(cue))}
          {item('在後插入空白句', () => insertAfter(cue))}
          {item(
            armed ? '確定刪除？' : '刪除此句',
            () => {
              if (armed) deleteCue(cue);
              else setDeleteArm(cue.id);
            },
            true
          )}
        </div>
      </>,
      document.body
    );
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
    background: theme.segBg,
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
    // Read-only unless in edit mode — no double-click affordance, no hint.
    if (!canEdit) return node;
    return (
      <div
        onDoubleClick={(e) => {
          e.stopPropagation();
          startEdit(cue, field);
        }}
        title="雙擊編輯"
        style={{ cursor: 'text' }}
      >
        {node}
      </div>
    );
  }

  // Small pill for a provenance chip — `official` (cc/align, no AI in that
  // layer) gets a faint accent tint; AI-derived (asr/llm) stays neutral
  // segBg, matching the existing 匯出 buttons' look.
  function renderProvenanceChip(info, key) {
    if (!info) return null;
    return (
      <span
        key={key}
        title={info.title}
        style={{
          fontSize: 10,
          fontWeight: 600,
          padding: '3px 7px',
          borderRadius: 6,
          background: info.official ? 'rgba(60,179,113,0.16)' : theme.segBg,
          color: info.official ? 'rgba(60,179,113,0.95)' : theme.textSecondary,
          whiteSpace: 'nowrap',
          flexShrink: 0,
        }}
      >
        {info.label}
      </span>
    );
  }

  const sourceChipInfo = getSourceChipInfo(source);
  const targetChipInfo = getTargetChipInfo(targetSource);

  return (
    <>
      {hasCues && (onExport || onEditCue) && (
        <div
          className="rj-hscroll"
          style={{
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 12px',
            borderBottom: `1px solid ${theme.hairline}`,
            // When the chips + edit + export buttons don't all fit (e.g. both
            // provenance badges present), scroll horizontally instead of
            // clipping — items keep their natural width (flexShrink:0/nowrap).
            overflowX: 'auto',
            overflowY: 'hidden',
          }}
        >
          {renderProvenanceChip(sourceChipInfo, 'source-chip')}
          {renderProvenanceChip(targetChipInfo, 'target-chip')}
          {onEditCue && (
            <button
              type="button"
              onClick={() => setEditMode((v) => !v)}
              title={editMode ? '結束編輯' : '編輯字幕（修正 AI 辨識、時間軸、切合句）'}
              style={{
                border: editMode ? `1px solid ${ACCENT}` : `1px solid ${theme.hairline}`,
                cursor: 'pointer',
                fontSize: 10,
                fontWeight: 700,
                padding: '3px 9px',
                borderRadius: 6,
                background: editMode ? ACCENT : theme.segBg,
                color: editMode ? '#fff' : theme.textSecondary,
                // Size to the label on one line; never let the CJK text wrap
                // (which would double the button's height).
                whiteSpace: 'nowrap',
                flexShrink: 0,
              }}
            >
              {editMode ? '✓ 編輯中' : '✎ 編輯'}
            </button>
          )}
          <span style={{ flex: 1 }} />
          {onExport && (
            <span style={{ fontSize: 10, color: theme.textTertiary, whiteSpace: 'nowrap', flexShrink: 0 }}>
              匯出
            </span>
          )}
          {onExport &&
            ['srt', 'lrc', 'txt'].map((fmt) => (
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
                background: theme.segBg,
                color: theme.textSecondary,
                textTransform: 'uppercase',
                whiteSpace: 'nowrap',
                flexShrink: 0,
              }}
            >
              {fmt}
            </button>
          ))}
        </div>
      )}

      <div
        onScroll={handleScroll}
        className="subtitle-scroll"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          // Breathing room so the first/last row (and the auto-scroll
          // highlight below) never sits flush against the panel's edge.
          // The bottom padding is deliberately generous, not just cosmetic:
          // without it, `scrollIntoView({block:'center'})` can't actually
          // center a cue near the end of the list -- the browser can only
          // scroll up to `scrollHeight - clientHeight`, so the last few
          // cues would stay pinned to the bottom edge no matter what block
          // alignment is requested. Padding extends the scrollable range so
          // even the final cue can be centered like every other one. (A
          // fixed px value, not a percentage -- CSS resolves vertical
          // padding percentages against the containing block's *width*, not
          // its height, which would make this unrelated to the scroll
          // distance it's meant to cover.)
          padding: '8px 0 200px',
        }}
      >
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
                : '字幕會顯示在這裡（可點擊跳轉；開啟「編輯」後可修正文字、時間軸與切合句）'}
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
                  background: isActive ? 'rgba(224,69,63,0.16)' : 'transparent',
                }}
              >
                <div
                  onClick={(e) => seekFromStamp(e, cue)}
                  title="跳到這句"
                  style={{
                    flexShrink: 0,
                    minWidth: 34,
                    paddingTop: 1,
                    fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace',
                    fontSize: 11,
                    color: theme.textTertiary,
                    cursor: 'pointer',
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
                      {cue.source_text}
                    </div>
                  )}
                  {cue.target_text
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
                          {cue.target_text}
                        </div>
                      )
                    : canEdit &&
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
                  {edit && edit.cueId === cue.id && edit.field === 'zh' && !cue.target_text && (
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
                  {canRestructure && (
                    <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
                      {renderTimingField(cue, 'start')}
                      {renderTimingField(cue, 'end')}
                    </div>
                  )}
                </div>
                {canRestructure && renderRowMenu(cue)}
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

      {renderMenuPortal()}
    </>
  );
}
