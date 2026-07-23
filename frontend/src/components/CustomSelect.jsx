import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ACCENT } from '../theme.js';

// App-styled dropdown replacing the native <select> (which renders an
// OS-native, un-themeable menu that clashes with the glass UI). Trigger looks
// like the app's other compact inputs; the option menu is rendered in a portal
// with fixed positioning computed from the trigger's rect, so it is NOT clipped
// by the `overflowY:auto` popovers/panels these selects live inside. Closes on
// outside pointer, Esc, selection, or any scroll/resize (which would otherwise
// leave the menu detached from a moved trigger).
//
// `options`: [{ value, label }] — `value` keeps its real type (string OR
// number, e.g. max_height), and `onChange` is called with that exact value, so
// callers don't need to re-parse like they did with `e.target.value`.
export default function CustomSelect({ theme, value, onChange, options, ariaLabel, style, disabled }) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);

  // Dark-token fallbacks so this works even where no theme is threaded through
  // (e.g. the dark-only SetupWizard). The menu itself is always dark.
  const t = {
    hairline: theme?.hairline ?? 'rgba(255,255,255,0.07)',
    segBg: theme?.segBg ?? 'rgba(255,255,255,0.06)',
    textPrimary: theme?.textPrimary ?? 'rgba(255,255,255,0.94)',
    popGlassBorder: theme?.popGlassBorder ?? 'rgba(255,255,255,0.12)',
  };

  const selected = options.find((o) => o.value === value);

  // Position the menu against the live trigger rect each time it opens.
  useLayoutEffect(() => {
    if (!open) return;
    const el = triggerRef.current;
    if (el) setRect(el.getBoundingClientRect());
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    function onPointerDown(e) {
      if (triggerRef.current?.contains(e.target) || menuRef.current?.contains(e.target)) return;
      setOpen(false);
    }
    function onKey(e) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    }
    // Any scroll (capture: catches the inner popover's scroll too) or resize
    // moves the trigger — REPOSITION the menu to follow it rather than close.
    // Closing here made the dropdown unusable inside Tauri's WKWebView, which
    // fires spurious scroll events (elastic/momentum scrolling, focus shifts)
    // that fired the instant the menu opened, closing it before an option
    // could be picked ("畫質 can't be selected in the App"). Following the
    // trigger is harmless when the scroll is spurious and correct when it's
    // real.
    function onReflow() {
      const el = triggerRef.current;
      if (el) setRect(el.getBoundingClientRect());
    }
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onReflow, true);
    window.addEventListener('resize', onReflow);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onReflow, true);
      window.removeEventListener('resize', onReflow);
    };
  }, [open]);

  const triggerStyle = {
    width: '100%',
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    fontSize: 12,
    padding: '6px 8px',
    borderRadius: 7,
    border: `1px solid ${t.hairline}`,
    background: t.segBg,
    color: t.textPrimary,
    fontFamily: 'inherit',
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.6 : 1,
    textAlign: 'left',
    ...style,
  };

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => !disabled && setOpen((o) => !o)}
        style={triggerStyle}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {selected ? selected.label : ''}
        </span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          style={{ flexShrink: 0, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}
        >
          <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open &&
        rect &&
        createPortal(
          <div
            ref={menuRef}
            role="listbox"
            className="rj-pop-in subtitle-scroll"
            style={{
              position: 'fixed',
              top: rect.bottom + 4,
              left: rect.left,
              width: rect.width,
              zIndex: 2000,
              maxHeight: 240,
              overflowY: 'auto',
              padding: 4,
              borderRadius: 9,
              background: 'rgba(30,30,33,0.96)',
              backdropFilter: 'blur(30px) saturate(180%)',
              WebkitBackdropFilter: 'blur(30px) saturate(180%)',
              border: `0.5px solid ${t.popGlassBorder}`,
              boxShadow: '0 12px 40px rgba(0,0,0,0.45)',
              animation: 'rjPopIn 140ms cubic-bezier(.2,.8,.3,1) both',
              transformOrigin: 'top center',
            }}
          >
            {options.map((opt) => {
              const active = opt.value === value;
              return (
                <button
                  key={String(opt.value)}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => {
                    onChange(opt.value);
                    setOpen(false);
                  }}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                    border: 'none',
                    cursor: 'pointer',
                    textAlign: 'left',
                    fontSize: 12,
                    fontFamily: 'inherit',
                    padding: '7px 8px',
                    borderRadius: 6,
                    background: active ? 'rgba(255,255,255,0.1)' : 'transparent',
                    color: active ? '#fff' : 'rgba(255,255,255,0.72)',
                  }}
                  onMouseEnter={(e) => {
                    if (!active) e.currentTarget.style.background = 'rgba(255,255,255,0.06)';
                  }}
                  onMouseLeave={(e) => {
                    if (!active) e.currentTarget.style.background = 'transparent';
                  }}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {opt.label}
                  </span>
                  {active && (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0, color: ACCENT }}>
                      <path d="M5 12l4.5 4.5L19 7" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </button>
              );
            })}
          </div>,
          document.body
        )}
    </>
  );
}
