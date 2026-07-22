import { useEffect, useRef } from 'react';
import { ACCENT } from '../theme.js';

// Full-viewport ambient backdrop behind the player, so the space around the
// window is never blank:
//   • a dark "aurora" of soft accent/blue/violet glows (the idle look), plus
//   • an Ambilight-style backdrop sampled from the currently-playing video —
//     the surrounding space picks up the video's colours (dominant while a
//     video is loaded). Cheap: we draw the video into a tiny 96×54 canvas a
//     few times a second and blow it up, heavily blurred.
// Base color/blob opacities/vignette come from theme.js (design handoff
// §Design Tokens) — `dark` is passed separately only for the ambilight
// canvas's own brightness/opacity, which isn't part of the token set.
export default function AmbientBackground({ theme, dark, videoSrc, videoRef }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    if (!videoSrc) return;
    let raf;
    let last = 0;
    const tick = (t) => {
      raf = requestAnimationFrame(tick);
      if (t - last < 110) return; // ~9fps is plenty for a blurred wash
      last = t;
      const v = videoRef?.current;
      const c = canvasRef.current;
      if (v && c && v.readyState >= 2 && v.videoWidth) {
        try {
          c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        } catch {
          /* not ready / cross-origin — ignore this frame */
        }
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [videoSrc, videoRef]);

  return (
    <div
      aria-hidden="true"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 0,
        overflow: 'hidden',
        background: theme.ambientBase,
        pointerEvents: 'none',
      }}
    >
      <div style={blob(ACCENT, '-16%', '-14%', '56vw', theme.blobOpacity1, '0s')} />
      <div style={blob('#3a5bd0', '46%', '56%', '60vw', theme.blobOpacity2, '-8s')} />
      <div style={blob('#7b3ff2', '64%', '-10%', '44vw', theme.blobOpacity3, '-16s')} />

      {videoSrc && (
        <canvas
          ref={canvasRef}
          width={96}
          height={54}
          style={{
            position: 'absolute',
            inset: '-12%',
            width: '124%',
            height: '124%',
            filter: `blur(72px) saturate(1.6) brightness(${dark ? 0.72 : 1.05})`,
            opacity: dark ? 0.6 : 0.42,
            transform: 'translateZ(0)',
          }}
        />
      )}

      {/* vignette — sinks the edges so the player floats */}
      <div style={{ position: 'absolute', inset: 0, background: theme.vignette }} />
    </div>
  );
}

function blob(color, top, left, size, opacity, delay) {
  return {
    position: 'absolute',
    top,
    left,
    width: size,
    height: size,
    background: `radial-gradient(circle, ${color} 0%, transparent 62%)`,
    opacity,
    borderRadius: '50%',
    willChange: 'transform',
    animation: `ambientDrift 34s ease-in-out ${delay} infinite alternate`,
  };
}
