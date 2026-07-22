/**
 * A range <input> that renders a consistent accent-filled track across engines.
 *
 * `accent-color` fills the "elapsed" portion of the track in Blink (Chrome) but
 * NOT in WebKit (Safari, and therefore the Tauri desktop WebView) — there the
 * track stays unfilled/grey. So we drop the native appearance and paint the fill
 * ourselves: the `.rj-range` rules in styles/global.css draw the elapsed portion
 * with a gradient driven by the inline `--range-fill` percentage set here. Volume
 * and settings sliders then look identical in the browser and the desktop app.
 *
 * Drop-in for `<input type="range">`: same value/min/max/step/onChange props;
 * extra props (title, onDoubleClick, disabled, …) pass straight through.
 */
export default function RangeSlider({ value, min = 0, max = 100, step, onChange, style, ...rest }) {
  const lo = Number(min);
  const hi = Number(max);
  const span = hi - lo;
  const pct = span > 0 ? Math.min(100, Math.max(0, ((Number(value) - lo) / span) * 100)) : 0;
  return (
    <input
      type="range"
      className="rj-range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={onChange}
      style={{ '--range-fill': `${pct}%`, ...style }}
      {...rest}
    />
  );
}
