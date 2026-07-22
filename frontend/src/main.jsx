import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
// Self-hosted Noto Sans JP/TC for the subtitle layers — bundled locally so they
// render in WebKit / the Tauri desktop WebView (and offline), instead of
// depending on the Google Fonts CDN (dsd.md §13). Weights match actual usage:
// Noto Sans JP 700, Noto Sans TC 500 (+400 as the default fallback).
import '@fontsource/noto-sans-jp/400.css';
import '@fontsource/noto-sans-jp/700.css';
import '@fontsource/noto-sans-tc/400.css';
import '@fontsource/noto-sans-tc/500.css';
import './styles/global.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
