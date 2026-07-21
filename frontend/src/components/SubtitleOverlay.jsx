import { useMemo, useState } from 'react';
import { findActiveCue, isRubyToken, MAX_CUE_DISPLAY_MS } from '../utils.js';

// ============================================================================
// Phase 3 (B3.1/B3.2) — three-layer ruby subtitle overlay.
// ----------------------------------------------------------------------------
// Cue sync rides on `currentTime`, which App.jsx's existing rAF loop already
// drives at animation-frame cadence while playing (plus onSeek/onTimeUpdate
// while paused/scrubbing) — this file does NOT run a second rAF loop
// (dsd.md §6.2 is explicit that a second competing loop is wrong here).
//
// Every render, `findActiveCue` binary-searches `cues` (sorted by start_ms
// by App.jsx after fetch) for the cue with start_ms <= t*1000 < end_ms. That
// binary search itself is cheap enough to redo every frame, but committing a
// *new* `activeCue` state only happens when the resulting cue id actually
// changes (the `candidate.id !== activeCue.id` guard below) — this is the
// standard React "adjust state during render" pattern, and it's what keeps
// the ruby markup from being rebuilt/re-diffed on every single animation
// frame the way it would if we rendered straight off a recomputed value
// (dsd.md §6.2: "變更才重繪 overlay").
// ============================================================================
export default function SubtitleOverlay({
  cues,
  currentTime,
  subJP,
  subCN,
  subRomaji,
  // Per-layer appearance — each `{ scale, color, shadow }` (size multiplier,
  // CSS color, 0..1 text-shadow intensity). Independently adjustable per
  // layer (SettingsPopover.jsx's "字幕樣式" section) rather than one shared
  // fontScale/jpColor for all three.
  jpStyle,
  cnStyle,
  romajiStyle,
  subtitleOffsetMs = 0,
  subtitleBg = 0,
  isFullscreen = false,
}) {
  const [activeCue, setActiveCue] = useState(null);

  // Manual subtitle time-offset control ("字幕時間校正", spec's planned
  // "手動微調字幕時間軸偏移"). Semantics: a POSITIVE subtitleOffsetMs makes
  // subtitles appear LATER (delayed) — e.g. if a cue's ja text is spoken
  // slightly before its start_ms timestamp (ASR drift), the user dials in a
  // negative offset to pull the cue earlier; if the ASR timestamps run
  // ahead of the audio, a positive offset pushes the cue later.
  //
  // Direction check: findActiveCue treats its second argument as "how far
  // into the timeline have we gotten" and activates a cue once that value
  // reaches the cue's start_ms. Subtracting a positive offset from the real
  // playback time (currentTime * 1000) makes the lookup value grow more
  // slowly than real time, so it reaches any given cue's start_ms LATER in
  // real playback — i.e. the cue becomes active later, confirming positive
  // = delayed. (Symmetrically, a negative offset adds to the lookup value,
  // reaching start_ms earlier in real time, i.e. negative = earlier.)
  const lookupMs = currentTime * 1000 - subtitleOffsetMs;
  let candidate = cues && cues.length ? findActiveCue(cues, lookupMs) : null;
  // Cap displayed duration (see MAX_CUE_DISPLAY_MS in utils.js): once the
  // offset-adjusted lookup time passes start_ms + MAX_CUE_DISPLAY_MS, treat
  // the cue as no longer active even though it's technically still inside
  // [start_ms, end_ms) — this makes the effective on-screen window
  // min(end_ms, start_ms + MAX_CUE_DISPLAY_MS), applied on the same
  // offset-adjusted timeline findActiveCue used above.
  if (candidate && lookupMs >= candidate.start_ms + MAX_CUE_DISPLAY_MS) {
    candidate = null;
  }
  const candidateId = candidate ? candidate.id : null;
  const activeId = activeCue ? activeCue.id : null;
  if (candidateId !== activeId) {
    setActiveCue(candidate);
  }
  const cue = activeCue;

  // ja_tokens -> <ruby> per dsd.md §4.2: a token with a `reading` AND
  // containing kanji renders as <ruby>t<rt>reading</rt></ruby>, otherwise
  // plain text. Concatenating every token's `t` reproduces `ja_text`
  // exactly, so falling back to a single plain-text "token" wrapping
  // `ja_text` is a safe degrade if `ja_tokens` is ever missing/empty.
  const jpNodes = useMemo(() => {
    if (!cue) return null;
    const tokens = cue.ja_tokens && cue.ja_tokens.length ? cue.ja_tokens : [{ t: cue.ja_text }];
    return tokens.map((tok, i) =>
      isRubyToken(tok) ? (
        <ruby key={i}>
          {tok.t}
          <rt>{tok.reading}</rt>
        </ruby>
      ) : (
        <span key={i}>{tok.t}</span>
      )
    );
  }, [cue]);

  // Each layer independently gated on its toggle AND on the cue actually
  // having content for that layer — a cue with zh_text: null (dsd.md §7
  // translate-partial degradation) hides the 中 line even when 中 is on
  // (B3.3), and when no cue is active at all (a gap between cues) every
  // layer is empty, i.e. "show nothing" (dsd.md §6.2).
  const showJP = subJP && Boolean(cue) && Boolean(jpNodes);
  const showCN = subCN && Boolean(cue) && Boolean(cue.zh_text);
  const showRomaji = subRomaji && Boolean(cue) && Boolean(cue.romaji);
  const hasVisibleContent = showJP || showCN || showRomaji;

  // `shadow` is a 0..1 intensity dialed in per layer (SettingsPopover.jsx) —
  // 0 renders no shadow at all rather than a shadow at alpha 0 (matches
  // subtitleBg's own "0 means off" convention below).
  function textShadowFor(shadow, blurPx) {
    return shadow > 0 ? `0 2px ${blurPx}px rgba(0,0,0,${shadow})` : 'none';
  }

  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        // Scales with the actual video-stage box (see VideoStage.jsx's
        // `containerType: 'size'`) so the gap from the bottom edge stays
        // proportional whether this is the small windowed box or a
        // full-screen one, instead of a fixed 22px that reads as "hugging
        // the edge" on a large fullscreen display. Fullscreen gets a larger
        // floor/ceiling than windowed: windowed has ControlBar sitting right
        // below the video as a visual "floor" for the same offset to read
        // as comfortable, but fullscreen has nothing there (the auto-hiding
        // overlay controls float OVER the video, not reserving space) — the
        // same offset that looks fine windowed reads as "hugging the bottom
        // edge" once that anchor is gone.
        bottom: isFullscreen ? 'clamp(28px, 6cqh, 96px)' : 'clamp(14px, 3.5cqh, 48px)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '0 clamp(16px, 3cqw, 48px)',
        pointerEvents: 'none',
      }}
    >
      {hasVisibleContent && (
        <div
          style={{
            display: 'inline-flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 4,
            // Readability box (default off, subtitleBg === 0): hugs the text
            // (inline-flex/fit-content, centered) rather than spanning the
            // full width — only gains a background/padding/rounded corners
            // once the user turns it on, so at 0 it renders exactly as
            // before this feature existed.
            ...(subtitleBg > 0
              ? {
                  background: `rgba(0,0,0,${subtitleBg})`,
                  borderRadius: 10,
                  padding: '6px 14px',
                }
              : null),
          }}
        >
          {showJP && (
            <div
              style={{
                fontFamily: "'Noto Sans JP',sans-serif",
                fontWeight: 700,
                // cqw-based (see VideoStage.jsx's `containerType: 'size'')
                // so this scales with the actual video box instead of
                // staying a fixed px size tuned for the windowed 16:9 box —
                // clamped so it never goes illegibly small or absurdly
                // large at the extremes.
                fontSize: `clamp(${16 * jpStyle.scale}px, ${3.1 * jpStyle.scale}cqw, ${64 * jpStyle.scale}px)`,
                color: jpStyle.color,
                textShadow: textShadowFor(jpStyle.shadow, 6),
                textAlign: 'center',
                lineHeight: 1.3,
              }}
            >
              {jpNodes}
            </div>
          )}
          {showCN && (
            <div
              style={{
                fontFamily: "'Noto Sans TC',sans-serif",
                fontWeight: 500,
                fontSize: `clamp(${11 * cnStyle.scale}px, ${2 * cnStyle.scale}cqw, ${42 * cnStyle.scale}px)`,
                color: cnStyle.color,
                textShadow: textShadowFor(cnStyle.shadow, 5),
                textAlign: 'center',
                lineHeight: 1.3,
              }}
            >
              {cue.zh_text}
            </div>
          )}
          {showRomaji && (
            <div
              style={{
                fontFamily: '-apple-system,sans-serif',
                fontStyle: 'italic',
                fontWeight: 400,
                fontSize: `clamp(${8 * romajiStyle.scale}px, ${1.5 * romajiStyle.scale}cqw, ${30 * romajiStyle.scale}px)`,
                color: romajiStyle.color,
                textShadow: textShadowFor(romajiStyle.shadow, 4),
                letterSpacing: 0.3,
                textAlign: 'center',
              }}
            >
              {cue.romaji}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
