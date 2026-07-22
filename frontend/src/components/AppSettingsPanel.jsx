import { useEffect, useState } from 'react';
import { ACCENT } from '../theme.js';
import { getCachedModels, deleteCachedModel, clearCachedModels } from '../api.js';
import { getSettings, setComputeType } from '../tauri.js';
import ConfirmDialog from './ConfirmDialog.jsx';

const COMPUTE_TYPES = [
  { value: 'int8', label: 'int8（最省資源，建議）' },
  { value: 'int8_float16', label: 'int8_float16' },
  { value: 'float32', label: 'float32（最高精度）' },
];

// "2.9 GB" / "480 MB" — matches the wording used for model sizes elsewhere
// (SetupWizard.jsx's MODEL_INFO).
function formatBytes(bytes) {
  if (!bytes) return '0 MB';
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

// Persistent app settings panel (dsd.md §13.7's settings-page knobs, scoped
// to what has no existing home yet: compute type, device, and model-cache
// management). Whisper model size/temperature are deliberately NOT here —
// every real generation already sends an explicit value from the per-video
// "進階：字幕產生設定" popover (GenerationOptionsForm), so a global default
// here would silently have no effect; only compute_type/device have no
// per-request override, so a live settings-page change is the only way they
// take effect at all (dsd.md's "重啟 worker 生效" note, resolved by the
// backend reading these live rather than restarting anything).
export default function AppSettingsPanel({ theme, open, onClose }) {
  const [computeType, setComputeTypeState] = useState('int8');
  const [device, setDevice] = useState('cpu');
  const [savingCompute, setSavingCompute] = useState(false);
  const [models, setModels] = useState([]);
  const [hfHome, setHfHome] = useState(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [busyModel, setBusyModel] = useState(null); // name being deleted, or 'all'
  const [confirmTarget, setConfirmTarget] = useState(null); // { type: 'model', name } | { type: 'all' }
  const [error, setError] = useState('');

  async function refreshModels() {
    setLoadingModels(true);
    try {
      const report = await getCachedModels();
      setModels(report.models || []);
      setHfHome(report.hf_home || null);
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setLoadingModels(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    setError('');
    (async () => {
      try {
        const settings = await getSettings();
        if (settings) {
          setComputeTypeState(settings.compute_type);
          setDevice(settings.device);
        }
      } catch {
        /* keep the panel usable even if reading settings fails */
      }
    })();
    refreshModels();
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  async function handleComputeTypeChange(value) {
    setSavingCompute(true);
    setError('');
    try {
      await setComputeType(value);
      setComputeTypeState(value);
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setSavingCompute(false);
    }
  }

  async function performDelete(target) {
    setBusyModel(target.type === 'all' ? 'all' : target.name);
    setError('');
    try {
      if (target.type === 'all') {
        await clearCachedModels();
      } else {
        await deleteCachedModel(target.name);
      }
      await refreshModels();
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setBusyModel(null);
    }
  }

  if (!open) return null;

  const rowStyle = {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '10px 12px',
    borderRadius: 10,
    background: theme.segBg,
  };
  const buttonStyle = {
    border: 'none',
    cursor: 'pointer',
    fontSize: 11.5,
    fontWeight: 700,
    padding: '6px 12px',
    borderRadius: 999,
    background: theme.chipBg,
    color: theme.textSecondary,
    flexShrink: 0,
  };

  return (
    <div
      onPointerDown={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 900,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        onPointerDown={(e) => e.stopPropagation()}
        style={{
          width: 'min(92vw, 460px)',
          maxHeight: '82vh',
          overflowY: 'auto',
          background: theme.winBg,
          backdropFilter: 'blur(44px) saturate(180%)',
          WebkitBackdropFilter: 'blur(44px) saturate(180%)',
          border: `1px solid ${theme.winBorder}`,
          borderRadius: 18,
          padding: 22,
          boxShadow: `0 30px 90px rgba(0,0,0,0.5), inset 0 1px 0 ${theme.winInsetHighlight}`,
          fontFamily: "-apple-system,BlinkMacSystemFont,'SF Pro Text',Helvetica,Arial,sans-serif",
          display: 'flex',
          flexDirection: 'column',
          gap: 18,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ color: theme.textPrimary, fontSize: 16, fontWeight: 700 }}>系統設定</div>
          <button
            type="button"
            onClick={onClose}
            title="關閉"
            style={{
              border: 'none',
              cursor: 'pointer',
              width: 28,
              height: 28,
              borderRadius: 8,
              background: theme.chipBg,
              color: theme.textSecondary,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {error && (
          <div style={{ fontSize: 12, color: '#ff6b62', background: 'rgba(255,107,98,0.12)', borderRadius: 8, padding: '8px 10px' }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: theme.textPrimary }}>語音辨識效能</div>
          <div style={rowStyle}>
            <span style={{ fontSize: 12, color: theme.textSecondary, flexShrink: 0, width: 90 }}>Compute type</span>
            <select
              value={computeType}
              disabled={savingCompute}
              onChange={(e) => handleComputeTypeChange(e.target.value)}
              style={{
                flex: 1,
                background: theme.inputBg,
                color: theme.textPrimary,
                border: 'none',
                borderRadius: 7,
                padding: '7px 9px',
                fontSize: 12,
                fontWeight: 600,
                outline: 'none',
              }}
            >
              {COMPUTE_TYPES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <div style={rowStyle}>
            <span style={{ fontSize: 12, color: theme.textSecondary, flexShrink: 0, width: 90 }}>Device</span>
            <span style={{ fontSize: 12, fontWeight: 600, color: theme.textTertiary }}>
              {device}（macOS 唯一選項，Apple Silicon 無 Metal 加速）
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: theme.textPrimary }}>模型快取</div>
            {models.length > 0 && (
              <button
                type="button"
                onClick={() => setConfirmTarget({ type: 'all' })}
                disabled={busyModel === 'all'}
                style={{ ...buttonStyle, opacity: busyModel === 'all' ? 0.6 : 1 }}
              >
                {busyModel === 'all' ? '清除中…' : '清除全部快取'}
              </button>
            )}
          </div>
          {hfHome && (
            <div style={{ fontSize: 10.5, color: theme.textTertiary, wordBreak: 'break-all' }}>{hfHome}</div>
          )}
          {loadingModels ? (
            <div style={{ fontSize: 12, color: theme.textTertiary }}>載入中…</div>
          ) : models.length === 0 ? (
            <div style={{ fontSize: 12, color: theme.textTertiary }}>尚未下載任何模型。</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {models.map((m) => (
                <div key={m.name} style={rowStyle}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: theme.textPrimary, flex: 1 }}>{m.name}</span>
                  <span style={{ fontSize: 11, color: theme.textTertiary }}>{formatBytes(m.size_bytes)}</span>
                  <button
                    type="button"
                    onClick={() => setConfirmTarget({ type: 'model', name: m.name })}
                    disabled={busyModel === m.name}
                    style={{ ...buttonStyle, opacity: busyModel === m.name ? 0.6 : 1 }}
                  >
                    {busyModel === m.name ? '刪除中…' : '刪除'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={Boolean(confirmTarget)}
        theme={theme}
        title={confirmTarget?.type === 'all' ? '清除全部模型快取？' : `刪除「${confirmTarget?.name}」模型？`}
        message={
          confirmTarget?.type === 'all'
            ? '所有已下載的 Whisper 模型都會被移除，下次使用時需要重新下載。'
            : '下次選用這個模型時需要重新下載。'
        }
        confirmLabel="刪除"
        danger
        onConfirm={() => {
          const target = confirmTarget;
          setConfirmTarget(null);
          performDelete(target);
        }}
        onCancel={() => setConfirmTarget(null)}
      />
    </div>
  );
}
