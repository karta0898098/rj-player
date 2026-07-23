// Design Tokens — from design_handoff_dark_mode_ux/README.md §Design Tokens,
// copied 1:1 from the working prototype (`RJ Player.dc.html`'s `getTheme()`
// inside `Component`). Dark is a much darker macOS-vibrancy glass look (not
// gray); light is largely unchanged from before this pass.

export const ACCENT = '#e0453f';

export function getTheme(dark) {
  return dark
    ? {
        ambientBase: '#050506',
        blobOpacity1: 0.24,
        blobOpacity2: 0.22,
        blobOpacity3: 0.16,
        vignette: 'radial-gradient(125% 95% at 50% 10%, transparent 35%, rgba(0,0,0,0.72) 100%)',
        winBg: 'rgba(17,17,19,0.62)',
        winBorder: 'rgba(255,255,255,0.07)',
        winInsetHighlight: 'rgba(255,255,255,0.05)',
        hairline: 'rgba(255,255,255,0.07)',
        textPrimary: 'rgba(255,255,255,0.94)',
        textSecondary: 'rgba(255,255,255,0.56)',
        textTertiary: 'rgba(255,255,255,0.34)',
        chipBg: 'rgba(255,255,255,0.07)',
        inputBg: 'rgba(255,255,255,0.07)',
        segBg: 'rgba(255,255,255,0.06)',
        segmentActiveBg: 'rgba(255,255,255,0.18)',
        segmentActiveText: 'rgba(255,255,255,0.94)',
        trackBg: 'rgba(255,255,255,0.12)',
        toggleTrack: 'rgba(255,255,255,0.14)',
        playBtnBg: 'rgba(255,255,255,0.12)',
        // Popover glass: a DARK, mostly-opaque frosted fill (handoff §5's
        // `rgba(30,30,33,0.85)`) rather than a near-transparent white tint.
        // The old translucent-white value let bright backgrounds (the ambient
        // red glow, a light video frame) bleed through and wash out the dim
        // description text inside AddToQueuePopover / SettingsPopover. This
        // keeps the blur/saturate frosted look but gives text a stable surface.
        popGlassBg: 'rgba(30,30,33,0.85)',
        popGlassBorder: 'rgba(255,255,255,0.12)',
      }
    : {
        ambientBase: '#eef0f4',
        blobOpacity1: 0.18,
        blobOpacity2: 0.14,
        blobOpacity3: 0.1,
        vignette: 'radial-gradient(125% 95% at 50% 10%, transparent 45%, rgba(0,0,0,0.1) 100%)',
        winBg: 'rgba(255,255,255,0.68)',
        winBorder: 'rgba(0,0,0,0.06)',
        winInsetHighlight: 'rgba(255,255,255,0.6)',
        hairline: 'rgba(0,0,0,0.07)',
        textPrimary: 'rgba(0,0,0,0.88)',
        textSecondary: 'rgba(0,0,0,0.55)',
        textTertiary: 'rgba(0,0,0,0.42)',
        chipBg: '#f0f0f3',
        inputBg: '#f0f0f3',
        segBg: '#f0f0f3',
        segmentActiveBg: '#ffffff',
        segmentActiveText: 'rgba(0,0,0,0.88)',
        trackBg: 'rgba(0,0,0,0.09)',
        toggleTrack: '#e4e4e8',
        playBtnBg: '#1c1c1e',
        popGlassBg: 'rgba(255,255,255,0.45)',
        popGlassBorder: 'rgba(255,255,255,0.7)',
      };
}
