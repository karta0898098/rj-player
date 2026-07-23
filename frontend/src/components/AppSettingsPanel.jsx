import { useEffect, useState } from 'react';
import { ACCENT } from '../theme.js';
import { getCachedModels, deleteCachedModel, clearCachedModels, getStorageInfo, getDoctor, startDoctorFix } from '../api.js';
import { getSettings, setComputeType, setDevice, getPlatform, revealInFinder } from '../tauri.js';
import ConfirmDialog from './ConfirmDialog.jsx';
import CustomSelect from './CustomSelect.jsx';

const COMPUTE_TYPES = [
  { value: 'int8', label: 'int8（最省資源，建議）' },
  { value: 'int8_float16', label: 'int8_float16' },
  { value: 'float16', label: 'float16（GPU 建議）' },
  { value: 'float32', label: 'float32（最高精度）' },
];

// Only Windows machines can have CUDA (Apple Silicon has none), so the cuda
// option is offered there alone; macOS/web keep a read-only "cpu" row.
const DEVICE_OPTIONS = [
  { value: 'cpu', label: 'cpu（預設）' },
  { value: 'cuda', label: 'cuda（NVIDIA GPU 加速）' },
];

const NAV_DEFS = [
  { key: 'appearance', label: '外觀', icon: '◐' },
  { key: 'performance', label: '語音辨識效能', icon: '⚙' },
  { key: 'storage', label: '儲存位置', icon: '⌸' },
];

// "2.9 GB" / "480 MB" — matches the wording used for model sizes elsewhere
// (SetupWizard.jsx's MODEL_INFO).
function formatBytes(bytes) {
  if (!bytes) return '0 MB';
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

// Global Settings — design_handoff_titlebar_settings/. One entry point (the
// Titlebar's ⚙, distinct from the per-video options button), sectioned
// macOS-System-Settings-style: 外觀 (dark/light — moved out of the Titlebar
// pill toggle), 語音辨識效能 (compute type/device — unchanged content),
// 儲存位置 (NEW: where downloaded videos live + the model-cache management
// that used to be this panel's only section).
//
// Whisper model size/temperature are deliberately NOT here — every real
// generation already sends an explicit value from the per-video "進階：字幕
// 產生設定" popover (GenerationOptionsForm), so a global default here would
// silently have no effect; only compute_type/device have no per-request
// override, so a live settings-page change is the only way they take effect
// at all (dsd.md's "重啟 worker 生效" note, resolved by the backend reading
// these live rather than restarting anything).
export default function AppSettingsPanel({ theme, dark, onDarkModeChange, open, onClose }) {
  const [activeTab, setActiveTab] = useState('appearance');

  const [computeType, setComputeTypeState] = useState('int8');
  const [device, setDeviceState] = useState('cpu');
  const [savingCompute, setSavingCompute] = useState(false);
  const [savingDevice, setSavingDevice] = useState(false);
  const [platform, setPlatform] = useState('web'); // 'macos' | 'windows' | 'web'
  // CUDA environment status shown under the device row when device=cuda:
  // null | {phase:'checking'} | {phase:'installing', line} | {phase:'ok'}
  // | {phase:'error', message}
  const [cudaState, setCudaState] = useState(null);

  const [videosDir, setVideosDir] = useState(null);
  const [videosSizeBytes, setVideosSizeBytes] = useState(0);
  const [loadingStorage, setLoadingStorage] = useState(false);

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

  async function refreshStorage() {
    setLoadingStorage(true);
    try {
      const info = await getStorageInfo();
      setVideosDir(info.videos_dir || null);
      setVideosSizeBytes(info.videos_size_bytes || 0);
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setLoadingStorage(false);
    }
  }

  useEffect(() => {
    getPlatform().then(setPlatform).catch(() => {});
  }, []);

  useEffect(() => {
    if (!open) return;
    setError('');
    (async () => {
      try {
        const settings = await getSettings();
        if (settings) {
          setComputeTypeState(settings.compute_type);
          setDeviceState(settings.device);
          // Already on cuda? Surface the environment status (cached backend-
          // side after the first success) without kicking off any install.
          if (settings.device === 'cuda' && (await getPlatform()) === 'windows') {
            checkCudaRuntime({ autoInstall: false });
          }
        }
      } catch {
        /* keep the panel usable even if reading settings fails */
      }
    })();
    refreshModels();
    refreshStorage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  async function handleDeviceChange(value) {
    setSavingDevice(true);
    setError('');
    try {
      await setDevice(value);
      setDeviceState(value);
      if (value === 'cuda') {
        // Fire-and-forget: the status row below the select tracks progress.
        checkCudaRuntime({ autoInstall: true });
      } else {
        setCudaState(null);
      }
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setSavingDevice(false);
    }
  }

  // Ask the Doctor about the cuda_runtime check; with `autoInstall`, a missing
  // CUDA runtime (fixable via install_cuda_deps) kicks off the install and
  // tracks its progress over the /api/doctor/events WebSocket — the same fix
  // machinery the setup wizard uses.
  async function checkCudaRuntime({ autoInstall }) {
    setCudaState({ phase: 'checking' });
    try {
      const report = await getDoctor();
      const check = report.checks.find((c) => c.id === 'cuda_runtime');
      if (!check) {
        // Backend doesn't consider device=cuda (e.g. env override) — nothing to show.
        setCudaState(null);
        return;
      }
      if (check.status === 'ok') {
        setCudaState({ phase: 'ok' });
      } else if (check.fix === 'install_cuda_deps' && autoInstall) {
        installCudaDeps();
      } else {
        setCudaState({ phase: 'error', message: check.detail || 'CUDA 環境檢查未通過' });
      }
    } catch (err) {
      setCudaState({ phase: 'error', message: String(err?.message || err) });
    }
  }

  // Run the install_cuda_deps Doctor fix, streaming progress until done, then
  // re-check (deps installed ≠ GPU visible — the recheck settles which).
  function installCudaDeps() {
    setCudaState({ phase: 'installing', line: '' });
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${window.location.host}/api/doctor/events`);
    const fail = (message) => {
      try { ws.close(); } catch { /* noop */ }
      setCudaState({ phase: 'error', message });
    };
    ws.onopen = () => {
      // POST only once the socket is listening, so no progress line is lost.
      startDoctorFix('install_cuda_deps').catch((err) => fail(String(err?.message || err)));
    };
    ws.onerror = () => fail('無法連線安裝進度伺服器，請重試。');
    ws.onmessage = async (e) => {
      let ev;
      try {
        ev = JSON.parse(e.data);
      } catch {
        return;
      }
      if (ev.fix !== 'install_cuda_deps') return;
      if (ev.type === 'log') {
        setCudaState({ phase: 'installing', line: ev.line });
      } else if (ev.type === 'failed') {
        fail(ev.error || '安裝失敗，請重試。');
      } else if (ev.type === 'done') {
        try { ws.close(); } catch { /* noop */ }
        checkCudaRuntime({ autoInstall: false });
      }
    };
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

  // Re-show the first-run setup wizard on demand — previously only reachable
  // via a `?setup` URL query param (dev-only; the release bundle has no
  // devtools/address bar to add it from), which meant resetting on Windows
  // required manually finding + deleting the WebView2 data folder.
  function handleRerunWizard() {
    localStorage.removeItem('rj_setup_done');
    window.location.reload();
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
  const smallBtnStyle = {
    border: 'none',
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: 700,
    padding: '6px 12px',
    borderRadius: 999,
    background: theme.chipBg,
    color: theme.textSecondary,
    flexShrink: 0,
    whiteSpace: 'nowrap',
  };
  const sectionTitleStyle = { fontSize: 12.5, fontWeight: 700, color: theme.textPrimary, whiteSpace: 'nowrap' };
  // Windows shows Explorer's name, not Finder's (backend reveal_in_finder
  // already handles both OSes — only this label was hardcoded).
  const revealLabel =
    platform === 'windows' ? '在檔案總管中顯示' : platform === 'macos' ? '在 Finder 中顯示' : '開啟資料夾';
  const hintTextStyle = { fontSize: 11.5, color: theme.textTertiary, lineHeight: 1.6 };
  const segBase = { flex: 1, textAlign: 'center', padding: '8px 4px', borderRadius: 7, fontSize: 12, fontWeight: 700, cursor: 'pointer' };
  // ACCENT (#e0453f = rgb(224,69,63)) tinted nav-active background, per the
  // design's dark/light values.
  const navActiveBg = dark ? 'rgba(224,69,63,0.16)' : 'rgba(224,69,63,0.1)';

  return (
    <div
      onPointerDown={onClose}
      className="rj-backdrop-in"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 900,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
        animation: 'rjBackdropIn 160ms ease both',
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        onPointerDown={(e) => e.stopPropagation()}
        className="rj-pop-in"
        style={{
          width: 'min(92vw, 660px)',
          height: 460,
          animation: 'rjPopIn 220ms cubic-bezier(.2,.8,.3,1) both',
          background: theme.winBg,
          backdropFilter: 'blur(44px) saturate(180%)',
          WebkitBackdropFilter: 'blur(44px) saturate(180%)',
          border: `1px solid ${theme.winBorder}`,
          borderRadius: 18,
          overflow: 'hidden',
          boxShadow: `0 30px 90px rgba(0,0,0,0.5), inset 0 1px 0 ${theme.winInsetHighlight}`,
          fontFamily: "-apple-system,BlinkMacSystemFont,'SF Pro Text',Helvetica,Arial,sans-serif",
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '16px 20px',
            borderBottom: `1px solid ${theme.hairline}`,
            flexShrink: 0,
          }}
        >
          <div style={{ color: theme.textPrimary, fontSize: 15, fontWeight: 700 }}>全域設定</div>
          <button
            type="button"
            onClick={onClose}
            title="關閉"
            style={{
              border: 'none',
              cursor: 'pointer',
              width: 26,
              height: 26,
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

        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <div
            style={{
              width: 170,
              flexShrink: 0,
              borderRight: `1px solid ${theme.hairline}`,
              padding: '12px 8px',
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
            }}
          >
            {NAV_DEFS.map((def) => {
              const active = activeTab === def.key;
              return (
                <div
                  key={def.key}
                  onClick={() => setActiveTab(def.key)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '9px 12px',
                    borderRadius: 9,
                    cursor: 'pointer',
                    background: active ? navActiveBg : 'transparent',
                  }}
                >
                  <span
                    style={{
                      width: 20,
                      textAlign: 'center',
                      fontSize: 13,
                      color: active ? ACCENT : theme.textTertiary,
                    }}
                  >
                    {def.icon}
                  </span>
                  <span
                    style={{
                      fontSize: 12.5,
                      fontWeight: active ? 700 : 600,
                      whiteSpace: 'nowrap',
                      color: active ? theme.textPrimary : theme.textSecondary,
                    }}
                  >
                    {def.label}
                  </span>
                </div>
              );
            })}
          </div>

          <div style={{ flex: 1, minWidth: 0, padding: '20px 24px', overflowY: 'auto' }}>
            {error && (
              <div
                style={{
                  fontSize: 12,
                  color: '#ff6b62',
                  background: 'rgba(255,107,98,0.12)',
                  borderRadius: 8,
                  padding: '8px 10px',
                  marginBottom: 14,
                }}
              >
                {error}
              </div>
            )}

            {activeTab === 'appearance' && (
              <div
                className="rj-tab-pane"
                style={{ display: 'flex', flexDirection: 'column', gap: 12, animation: 'rjTabPane 180ms cubic-bezier(.2,.8,.3,1) both' }}
              >
                <div style={sectionTitleStyle}>外觀</div>
                <div style={rowStyle}>
                  <span style={{ fontSize: 12, color: theme.textSecondary, flexShrink: 0, width: 90 }}>主題</span>
                  <div style={{ flex: 1, display: 'flex', gap: 4, background: theme.chipBg, borderRadius: 9, padding: 3 }}>
                    <div
                      onClick={() => onDarkModeChange(false)}
                      style={{
                        ...segBase,
                        background: !dark ? theme.segmentActiveBg : 'transparent',
                        color: !dark ? theme.textPrimary : theme.textTertiary,
                      }}
                    >
                      ☀ 淺色
                    </div>
                    <div
                      onClick={() => onDarkModeChange(true)}
                      style={{
                        ...segBase,
                        background: dark ? theme.segmentActiveBg : 'transparent',
                        color: dark ? theme.textPrimary : theme.textTertiary,
                      }}
                    >
                      🌙 深色
                    </div>
                  </div>
                </div>
                <div style={hintTextStyle}>套用至整個播放器介面，包含播放器、影片庫與彈出視窗。</div>
              </div>
            )}

            {activeTab === 'performance' && (
              <div
                className="rj-tab-pane"
                style={{ display: 'flex', flexDirection: 'column', gap: 12, animation: 'rjTabPane 180ms cubic-bezier(.2,.8,.3,1) both' }}
              >
                <div style={sectionTitleStyle}>語音辨識效能</div>
                <div style={rowStyle}>
                  <span style={{ fontSize: 12, color: theme.textSecondary, flexShrink: 0, width: 90 }}>Compute type</span>
                  <CustomSelect
                    theme={theme}
                    value={computeType}
                    disabled={savingCompute}
                    onChange={handleComputeTypeChange}
                    options={COMPUTE_TYPES}
                    ariaLabel="Compute type"
                    style={{ flex: 1, width: 'auto', background: theme.inputBg, border: 'none', fontWeight: 600 }}
                  />
                </div>
                <div style={rowStyle}>
                  <span style={{ fontSize: 12, color: theme.textSecondary, flexShrink: 0, width: 90 }}>Device</span>
                  {platform === 'windows' ? (
                    <CustomSelect
                      theme={theme}
                      value={device}
                      disabled={savingDevice}
                      onChange={handleDeviceChange}
                      options={DEVICE_OPTIONS}
                      ariaLabel="Device"
                      style={{ flex: 1, width: 'auto', background: theme.inputBg, border: 'none', fontWeight: 600 }}
                    />
                  ) : (
                    <span style={{ fontSize: 12, fontWeight: 600, color: theme.textTertiary }}>
                      {device}（macOS 唯一選項，Apple Silicon 無 Metal 加速）
                    </span>
                  )}
                </div>
                {platform === 'windows' && device === 'cuda' && cudaState && (
                  <div
                    style={{
                      fontSize: 11.5,
                      lineHeight: 1.6,
                      borderRadius: 8,
                      padding: '8px 10px',
                      background:
                        cudaState.phase === 'error'
                          ? 'rgba(255,107,98,0.12)'
                          : cudaState.phase === 'ok'
                            ? 'rgba(52,199,89,0.12)'
                            : theme.chipBg,
                      color:
                        cudaState.phase === 'error'
                          ? '#ff6b62'
                          : cudaState.phase === 'ok'
                            ? '#34c759'
                            : theme.textSecondary,
                    }}
                  >
                    {cudaState.phase === 'checking' && '正在檢查 CUDA 環境…'}
                    {cudaState.phase === 'ok' && '✓ CUDA 環境就緒，字幕生成將使用 GPU 加速。'}
                    {cudaState.phase === 'error' && cudaState.message}
                    {cudaState.phase === 'installing' && (
                      <>
                        <div>正在安裝 CUDA 執行期依賴（cuBLAS/cuDNN）…</div>
                        {cudaState.line && (
                          <div
                            style={{
                              fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace',
                              fontSize: 10.5,
                              color: theme.textTertiary,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {cudaState.line}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}
                {platform === 'windows' && (
                  <div style={hintTextStyle}>
                    cuda 需要 NVIDIA GPU 與顯示卡驅動；首次切換會自動下載 CUDA 執行期依賴（數百 MB）。
                    使用 GPU 時建議將 Compute type 改為 float16。
                  </div>
                )}
              </div>
            )}

            {activeTab === 'storage' && (
              <div
                className="rj-tab-pane"
                style={{ display: 'flex', flexDirection: 'column', gap: 12, animation: 'rjTabPane 180ms cubic-bezier(.2,.8,.3,1) both' }}
              >
                <div style={sectionTitleStyle}>影片與字幕儲存位置</div>
                <div style={{ ...rowStyle, gap: 10 }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ color: theme.textTertiary, flexShrink: 0 }}>
                    <path
                      d="M3 6.5A1.5 1.5 0 014.5 5h4.8l1.6 2H19.5A1.5 1.5 0 0121 8.5v9A1.5 1.5 0 0119.5 19h-15A1.5 1.5 0 013 17.5v-11z"
                      stroke="currentColor"
                      strokeWidth="1.7"
                      strokeLinejoin="round"
                    />
                  </svg>
                  <span
                    style={{
                      flex: 1,
                      fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace',
                      fontSize: 11,
                      color: theme.textSecondary,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {loadingStorage ? '載入中…' : videosDir || '尚未建立'}
                  </span>
                  <button
                    type="button"
                    onClick={() => videosDir && revealInFinder(videosDir)}
                    disabled={!videosDir}
                    style={smallBtnStyle}
                  >
                    {revealLabel}
                  </button>
                </div>
                <div style={hintTextStyle}>已下載的影片、字幕與縮圖都存放在這裡（共 {formatBytes(videosSizeBytes)}）。</div>

                <div style={{ height: 1, background: theme.hairline, margin: '4px 0' }} />

                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={sectionTitleStyle}>模型快取</div>
                  {models.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setConfirmTarget({ type: 'all' })}
                      disabled={busyModel === 'all'}
                      style={{ ...smallBtnStyle, opacity: busyModel === 'all' ? 0.6 : 1 }}
                    >
                      {busyModel === 'all' ? '清除中…' : '清除全部快取'}
                    </button>
                  )}
                </div>
                {hfHome && (
                  <div style={{ ...rowStyle, gap: 10 }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ color: theme.textTertiary, flexShrink: 0 }}>
                      <path
                        d="M3 6.5A1.5 1.5 0 014.5 5h4.8l1.6 2H19.5A1.5 1.5 0 0121 8.5v9A1.5 1.5 0 0119.5 19h-15A1.5 1.5 0 013 17.5v-11z"
                        stroke="currentColor"
                        strokeWidth="1.7"
                        strokeLinejoin="round"
                      />
                    </svg>
                    <span
                      style={{
                        flex: 1,
                        fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace',
                        fontSize: 11,
                        color: theme.textSecondary,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {hfHome}
                    </span>
                    <button type="button" onClick={() => revealInFinder(hfHome)} style={smallBtnStyle}>
                      {revealLabel}
                    </button>
                  </div>
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
                          style={{ ...smallBtnStyle, opacity: busyModel === m.name ? 0.6 : 1 }}
                        >
                          {busyModel === m.name ? '刪除中…' : '刪除'}
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <div style={{ height: 1, background: theme.hairline, margin: '4px 0' }} />

                <div style={sectionTitleStyle}>設定精靈</div>
                <div style={{ ...rowStyle, gap: 10 }}>
                  <span style={{ fontSize: 12, color: theme.textSecondary, flex: 1 }}>
                    重新執行首次啟動的設定精靈（環境檢查、模型下載…）
                  </span>
                  <button
                    type="button"
                    onClick={() => setConfirmTarget({ type: 'rerunWizard' })}
                    style={smallBtnStyle}
                  >
                    重新執行
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={Boolean(confirmTarget)}
        theme={theme}
        title={
          confirmTarget?.type === 'all'
            ? '清除全部模型快取？'
            : confirmTarget?.type === 'rerunWizard'
              ? '重新執行設定精靈？'
              : `刪除「${confirmTarget?.name}」模型？`
        }
        message={
          confirmTarget?.type === 'all'
            ? '所有已下載的 Whisper 模型都會被移除，下次使用時需要重新下載。'
            : confirmTarget?.type === 'rerunWizard'
              ? '應用程式會重新整理並跳出設定精靈，目前的播放進度不會被保留。'
              : '下次選用這個模型時需要重新下載。'
        }
        confirmLabel={confirmTarget?.type === 'rerunWizard' ? '重新執行' : '刪除'}
        danger={confirmTarget?.type !== 'rerunWizard'}
        onConfirm={() => {
          const target = confirmTarget;
          setConfirmTarget(null);
          if (target.type === 'rerunWizard') {
            handleRerunWizard();
          } else {
            performDelete(target);
          }
        }}
        onCancel={() => setConfirmTarget(null)}
      />
    </div>
  );
}
