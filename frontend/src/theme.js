// Design Tokens — from design_handoff_youtube_subtitle_player/README.md
// §Design Tokens, copied 1:1 from the working prototype
// (`YouTube 字幕播放器.dc.html`, `theme` object inside `renderVals()`).

export const ACCENT = '#e0453f';

export function getTheme(dark) {
  return {
    winBg: dark ? '#1e1e20' : '#ffffff',
    border: dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)',
    textPrimary: dark ? 'rgba(255,255,255,0.92)' : 'rgba(0,0,0,0.88)',
    textSecondary: dark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.55)',
    textTertiary: dark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.45)',
    chipInactiveBg: dark ? 'rgba(255,255,255,0.1)' : '#f2f2f4',
    chipInactiveText: dark ? 'rgba(255,255,255,0.65)' : 'rgba(0,0,0,0.55)',
    segmentBg: dark ? 'rgba(255,255,255,0.08)' : '#f2f2f4',
    segmentActiveBg: dark ? 'rgba(255,255,255,0.18)' : '#ffffff',
    segmentActiveText: dark ? '#ffffff' : 'rgba(0,0,0,0.85)',
    urlPillBg: dark ? 'rgba(255,255,255,0.08)' : '#f2f2f4',
    trackBg: dark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.09)',
  };
}
