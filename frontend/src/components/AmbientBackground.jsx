import { useEffect, useRef } from 'react';
import { ACCENT } from '../theme.js';

// Full-viewport ambient backdrop behind the player, so the space around the
// window is never blank:
//   • a dark "aurora" of soft accent/blue/violet glows (the idle look), plus
//   • an Ambilight-style backdrop sampled from the currently-playing video —
//     the surrounding space picks up the video's colours (dominant while a
//     video is loaded). Cheap: we draw the video into a tiny 96×54 canvas a
//     few times a second and blow it up, heavily blurred.
export default function AmbientBackground({ dark, videoSrc, videoRef }) {
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

  const base = dark ? '#08080c' : '#eaecf1';

  return (
    <div
      aria-hidden="true"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 0,
        overflow: 'hidden',
        background: base,
        pointerEvents: 'none',
      }}
    >
      <div style={blob(ACCENT, '-18%', '-12%', '58vw', dark ? 0.3 : 0.22, '0s')} />
      <div style={blob(dark ? '#3a5bd0' : '#88a6ff', '48%', '58%', '62vw', dark ? 0.28 : 0.18, '-9s')} />
      <div style={blob(dark ? '#7b3ff2' : '#c6a3ff', '68%', '-8%', '46vw', dark ? 0.2 : 0.12, '-16s')} />

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
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: dark
            ? 'radial-gradient(125% 95% at 50% 12%, transparent 38%, rgba(0,0,0,0.6) 100%)'
            : 'radial-gradient(125% 95% at 50% 12%, transparent 45%, rgba(0,0,0,0.12) 100%)',
        }}
      />
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
    animation: `ambientDrift 30s ease-in-out ${delay} infinite alternate`,
  };
}
