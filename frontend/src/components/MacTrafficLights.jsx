// macOS traffic-light dots — from design_handoff_youtube_subtitle_player/macos-window.jsx
// (MacTrafficLights), reimplemented as a plain React component (pure CSS,
// no external deps, per the handoff's own note).
export default function MacTrafficLights() {
  const dot = (bg) => (
    <div
      style={{
        width: 14,
        height: 14,
        borderRadius: '50%',
        background: bg,
        border: '0.5px solid rgba(0,0,0,0.1)',
      }}
    />
  );
  return (
    <div style={{ display: 'flex', gap: 9, alignItems: 'center', padding: 1 }}>
      {dot('#ff736a')}
      {dot('#febc2e')}
      {dot('#19c332')}
    </div>
  );
}
