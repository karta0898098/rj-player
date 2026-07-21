// Channel row — README §版面結構 2. 32px circular channel avatar (first
// character) + channel name (13px/600). The video title itself now lives in
// the Titlebar (see Titlebar.jsx) instead of being duplicated here.
// Explicitly NO subscribe button / view-count / publish-date — the handoff
// says these were removed and must not be re-added.
export default function VideoInfo({ theme, channelName }) {
  const initial = channelName ? channelName.charAt(0) : '';
  return (
    <div style={{ padding: '14px 20px 6px', display: 'flex', alignItems: 'center', gap: 10 }}>
      <div
        style={{
          width: 32,
          height: 32,
          borderRadius: '50%',
          background: '#3a3a3c',
          color: '#fff',
          fontSize: 13,
          fontWeight: 700,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        {initial}
      </div>
      <div style={{ color: theme.textSecondary, fontSize: 13, fontWeight: 600 }}>
        {channelName}
      </div>
    </div>
  );
}
