import { useState, useEffect, useRef } from 'react';
import { getDoctor, startDoctorFix } from '../api.js';
import { setLlmKey, llmKeyPresent, setWhisperModel } from '../tauri.js';
import CustomSelect from './CustomSelect.jsx';

const WIZARD_MODEL_OPTIONS = [
  { value: 'tiny', label: 'tiny — 最小、最快，準確度較低' },
  { value: 'base', label: 'base — 小、快，準確度普通' },
  { value: 'small', label: 'small — 中等體積與速度' },
  { value: 'medium', label: 'medium — 較大、較準，速度稍慢' },
  { value: 'large-v3', label: 'large-v3 — 最準確（建議）' },
];
const WIZARD_COMPUTE_OPTIONS = [
  { value: 'int8', label: 'int8 — 最省資源（建議）' },
  { value: 'int8_float16', label: 'int8_float16' },
  { value: 'float32', label: 'float32 — 最高精度' },
];

// First-run setup wizard (dsd.md §13.5). Shown once on the desktop app; walks
// the user through installing the AI components (via the Doctor API), picking a
// Whisper model, and optionally storing a translation key in the OS keychain.
// Design: design_handoff_setup_wizard/. Wired to the REAL backend — the Doctor
// report/fixes/WS progress, and the Tauri keychain/settings bridge — not the
// prototype's fake timers.

const MODEL_INFO = {
  tiny: '約 75 MB',
  base: '約 145 MB',
  small: '約 480 MB',
  medium: '約 1.5 GB',
  'large-v3': '約 2.9 GB',
};
// Doctor fix id -> the check it satisfies.
const FIX_TO_CHECK = {
  install_runtime: 'python_runtime',
  install_deps: 'ai_deps',
  download_model: 'whisper_model',
};
const PROVIDER_LABELS = { gemini: 'Gemini', openai: 'OpenAI', anthropic: 'Anthropic' };

const STATUS_META = {
  ok: { text: '完成', color: '#4fd67a' },
  missing: { text: '待處理', color: 'rgba(255,255,255,0.34)' },
  installing: { text: '安裝中', color: '#e0453f' },
  failed: { text: '失敗', color: '#ff6b62' },
  absent: { text: '略過', color: 'rgba(255,255,255,0.34)' },
  broken: { text: '需修復', color: '#ff6b62' },
};

export default function SetupWizard({ onComplete }) {
  const [step, setStep] = useState(0); // 0 welcome · 1 install · 2 model · 3 key · 4 done
  const [report, setReport] = useState({ ready: false, checks: [] });
  const [activeFix, setActiveFix] = useState(null);
  const [logLines, setLogLines] = useState({}); // { fixId: [lines] }
  const [fixErrors, setFixErrors] = useState({}); // { fixId: message }
  const [whisperModel, setWhisperModelState] = useState('large-v3');
  const [computeType, setComputeType] = useState('int8');
  const [provider, setProvider] = useState('gemini');
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [keyPresent, setKeyPresent] = useState(false);
  const [savingKey, setSavingKey] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [checkingId, setCheckingId] = useState(null); // id of a built-in check being manually rechecked

  // Refs so the (once-registered) WebSocket handler reads current values.
  const stepRef = useRef(step);
  const reportRef = useRef(report);
  const activeFixRef = useRef(activeFix);
  const fixErrorsRef = useRef(fixErrors);
  useEffect(() => {
    stepRef.current = step;
  }, [step]);
  useEffect(() => {
    reportRef.current = report;
  }, [report]);
  useEffect(() => {
    activeFixRef.current = activeFix;
  }, [activeFix]);
  useEffect(() => {
    fixErrorsRef.current = fixErrors;
  }, [fixErrors]);

  async function refresh() {
    try {
      const r = await getDoctor();
      setReport(r);
      setLoadError(false);
      return r;
    } catch (err) {
      setLoadError(true);
      throw err;
    }
  }

  function nextPendingFix(r) {
    return r.checks.find(
      (c) =>
        c.required &&
        c.fix &&
        (c.status === 'missing' || c.status === 'broken') &&
        !fixErrorsRef.current[c.fix]
    );
  }

  async function runFix(fixId) {
    setActiveFix(fixId);
    setFixErrors((e) => {
      const n = { ...e };
      delete n[fixId];
      return n;
    });
    setLogLines((l) => ({ ...l, [fixId]: [] }));
    try {
      await startDoctorFix(fixId);
    } catch (err) {
      // 409 (busy) / 400 / network — surface as a failed row.
      setActiveFix((cur) => (cur === fixId ? null : cur));
      setFixErrors((e) => ({ ...e, [fixId]: String(err?.message || err) }));
    }
  }

  // Manually re-run all Doctor checks — for built-in tool checks (yt-dlp,
  // ffmpeg) that have no `fix` action, this is the only way to retry after a
  // slow-starting binary got reported as missing.
  async function recheck(id) {
    setCheckingId(id);
    try {
      await refresh();
    } catch {
      /* refresh() already surfaces loadError */
    } finally {
      setCheckingId((cur) => (cur === id ? null : cur));
    }
  }

  // Fetch the initial report + connect the progress WebSocket, once.
  useEffect(() => {
    let ws;
    (async () => {
      try {
        const r = await refresh();
        const wm = r.checks.find((c) => c.id === 'whisper_model');
        const m = wm?.label?.match(/\(([^)]+)\)/)?.[1];
        if (m && MODEL_INFO[m]) setWhisperModelState(m);
        const present = await llmKeyPresent(provider);
        if (present) setKeyPresent(true);
      } catch {
        /* keep the wizard usable even if the first poll fails */
      }
    })();

    ws = new WebSocket(`ws://${location.host}/api/doctor/events`);
    ws.onmessage = (e) => {
      let ev;
      try {
        ev = JSON.parse(e.data);
      } catch {
        return;
      }
      if (ev.type === 'log') {
        setLogLines((l) => ({ ...l, [ev.fix]: [...(l[ev.fix] || []), ev.line].slice(-40) }));
      } else if (ev.type === 'done') {
        setActiveFix(null);
        // The install-step effect below chains the next pending fix once the
        // refreshed report lands.
        refresh().catch(() => {});
      } else if (ev.type === 'failed') {
        setActiveFix((cur) => (cur === ev.fix ? null : cur));
        setFixErrors((er) => ({ ...er, [ev.fix]: ev.error || '安裝失敗，請重試。' }));
      }
    };
    return () => {
      try {
        ws && ws.close();
      } catch {
        /* noop */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-run the next pending required fix while on the install step. Driven by
  // an effect (not the button handler) so it ALSO fires once a slow
  // `/api/doctor` finishes loading — otherwise clicking 開始 before the report
  // arrived left the step stuck with nothing installing — and chains fix→fix as
  // each completes.
  useEffect(() => {
    if (step !== 1 || activeFix) return;
    const next = report.checks.find(
      (c) =>
        c.required &&
        c.fix &&
        (c.status === 'missing' || c.status === 'broken') &&
        !fixErrors[c.fix]
    );
    if (next) runFix(next.fix);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, report, activeFix, fixErrors]);

  function derivedStatus(c) {
    if (activeFix === c.fix) return 'installing';
    if (fixErrors[c.fix]) return 'failed';
    return c.status;
  }

  // Ensure the backend targets `model` and (re)download it if not cached.
  async function ensureModel(model) {
    try {
      await setWhisperModel(model);
      const r = await refresh();
      const wm = r.checks.find((c) => c.id === 'whisper_model');
      if (wm && wm.status !== 'ok' && !activeFixRef.current) runFix('download_model');
    } catch {
      /* noop */
    }
  }

  async function handleSaveKey() {
    if (!apiKeyInput) return;
    setSavingKey(true);
    try {
      await setLlmKey(provider, apiKeyInput);
      setKeyPresent(true);
    } catch {
      /* noop */
    } finally {
      setSavingKey(false);
    }
  }

  const modelCheck = report.checks.find((c) => c.id === 'whisper_model');
  const modelOk = modelCheck?.status === 'ok';
  const modelInstalling = activeFix === 'download_model';
  const requiredOk = report.ready;

  // Footer primary action per step.
  const primaries = [
    { label: '開始', disabled: false, action: () => setStep(1) },
    {
      label: '下一步',
      disabled: !requiredOk,
      action: () => {
        setStep(2);
        ensureModel(whisperModel);
      },
    },
    { label: '下一步', disabled: !modelOk, action: () => setStep(3) },
    {
      label: '儲存並下一步',
      disabled: savingKey,
      action: async () => {
        if (apiKeyInput && !keyPresent) await handleSaveKey();
        setStep(4);
      },
    },
    {
      label: '完成',
      disabled: false,
      action: () => {
        try {
          localStorage.setItem('rj_setup_done', '1');
        } catch {
          /* noop */
        }
        onComplete && onComplete();
      },
    },
  ];
  const primary = primaries[step];

  const dotBg = (i) =>
    i < step ? '#e0453f' : i === step ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.12)';

  const fieldStyle = {
    width: '100%',
    boxSizing: 'border-box',
    background: 'rgba(255,255,255,0.07)',
    color: 'rgba(255,255,255,0.94)',
    border: 'none',
    borderRadius: 9,
    padding: '10px 12px',
    fontSize: 13,
    fontWeight: 600,
    outline: 'none',
    fontFamily: 'inherit',
  };
  const labelStyle = { fontSize: 11, color: 'rgba(255,255,255,0.34)', marginBottom: 6 };
  const spinner = (
    <div
      style={{
        width: 9,
        height: 9,
        borderRadius: '50%',
        border: '2px solid rgba(255,255,255,0.18)',
        borderTopColor: '#e0453f',
        animation: 'rjSpin 0.7s linear infinite',
        flexShrink: 0,
      }}
    />
  );

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100000,
        overflow: 'hidden',
        background: '#050506',
        fontFamily: "-apple-system,BlinkMacSystemFont,'SF Pro Text',Helvetica,Arial,sans-serif",
      }}
    >
      {/* Ambient aurora backdrop */}
      <div aria-hidden="true" style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
        <div style={aura('#e0453f', '-16%', '-14%', '56vw', 0.24, '0s')} />
        <div style={aura('#3a5bd0', '46%', '56%', '60vw', 0.22, '-8s')} />
        <div style={aura('#7b3ff2', '64%', '-10%', '44vw', 0.16, '-16s')} />
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background:
              'radial-gradient(125% 95% at 50% 10%, transparent 35%, rgba(0,0,0,0.72) 100%)',
          }}
        />
      </div>

      <div
        style={{
          position: 'relative',
          zIndex: 1,
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          boxSizing: 'border-box',
        }}
      >
        <div
          style={{
            width: 'min(92vw, 560px)',
            background: 'rgba(17,17,19,0.62)',
            backdropFilter: 'blur(44px) saturate(180%)',
            WebkitBackdropFilter: 'blur(44px) saturate(180%)',
            border: '1px solid rgba(255,255,255,0.07)',
            borderRadius: 20,
            boxShadow: '0 30px 90px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.05)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          {/* progress dots */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '20px 28px 0' }}>
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} style={{ height: 4, flex: 1, borderRadius: 2, background: dotBg(i) }} />
            ))}
          </div>

          {/* body */}
          <div
            style={{
              padding: '26px 28px 28px',
              display: 'flex',
              flexDirection: 'column',
              gap: 18,
              minHeight: 360,
            }}
          >
            {step === 0 && (
              <IntroPane
                chipBg="rgba(224,69,63,0.18)"
                stroke="#e0453f"
                title="歡迎使用 rj-player"
                body="首次啟動需要下載一些 AI 元件（約 2.8 GB），並在背景設定本機語音辨識與翻譯功能。這需要網路連線，完成後就能離線使用。"
              />
            )}

            {step === 1 && (
              <>
                <Heading title="安裝必要元件" sub="系統會自動檢查並安裝所需元件，翻譯 API Key 可以之後再設定。" />
                {report.checks.length === 0 && (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '8px 2px',
                      color: 'rgba(255,255,255,0.56)',
                      fontSize: 13,
                    }}
                  >
                    {loadError ? (
                      <>
                        <div
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: '50%',
                            background: '#ff6b62',
                            flexShrink: 0,
                          }}
                        />
                        <span style={{ flex: 1 }}>無法連線到後端服務。</span>
                        <button
                          onClick={() => refresh().catch(() => {})}
                          style={{
                            border: 'none',
                            cursor: 'pointer',
                            fontSize: 11,
                            fontWeight: 700,
                            padding: '6px 12px',
                            borderRadius: 999,
                            background: 'rgba(255,255,255,0.14)',
                            color: 'rgba(255,255,255,0.94)',
                          }}
                        >
                          重試
                        </button>
                      </>
                    ) : (
                      <>
                        {spinner}
                        <span>正在檢查元件…</span>
                      </>
                    )}
                  </div>
                )}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {report.checks.map((c) => {
                    const st = derivedStatus(c);
                    const meta = STATUS_META[st] || STATUS_META.missing;
                    const builtIn = st === 'ok' && !c.fix;
                    const log = (logLines[c.fix] || []).slice(-4).join('\n');
                    const dotColor =
                      st === 'ok'
                        ? '#4fd67a'
                        : st === 'failed' || st === 'broken'
                        ? '#ff6b62'
                        : st === 'absent'
                        ? 'rgba(255,255,255,0.3)'
                        : '#e0453f';
                    return (
                      <div
                        key={c.id}
                        style={{
                          background: 'rgba(255,255,255,0.06)',
                          borderRadius: 10,
                          padding: '11px 13px',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 8,
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          {st === 'installing' ? (
                            spinner
                          ) : (
                            <div
                              style={{
                                width: 8,
                                height: 8,
                                borderRadius: '50%',
                                background: dotColor,
                                flexShrink: 0,
                              }}
                            />
                          )}
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div
                              style={{ fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.94)' }}
                            >
                              {c.label}
                            </div>
                            {c.detail && (
                              <div
                                style={{
                                  fontSize: 11,
                                  color: 'rgba(255,255,255,0.34)',
                                  marginTop: 2,
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                }}
                              >
                                {c.detail}
                              </div>
                            )}
                          </div>
                          <div
                            style={{
                              fontSize: 11,
                              fontWeight: 600,
                              color: meta.color,
                              flexShrink: 0,
                            }}
                          >
                            {builtIn ? '已內建' : meta.text}
                          </div>
                          {st === 'failed' && (
                            <button
                              onClick={() => runFix(c.fix)}
                              disabled={!!activeFix}
                              style={{
                                border: 'none',
                                cursor: activeFix ? 'default' : 'pointer',
                                fontSize: 11,
                                fontWeight: 700,
                                padding: '6px 12px',
                                borderRadius: 999,
                                background: 'rgba(255,255,255,0.14)',
                                color: 'rgba(255,255,255,0.94)',
                                opacity: activeFix ? 0.5 : 1,
                                flexShrink: 0,
                              }}
                            >
                              重試
                            </button>
                          )}
                          {st === 'missing' && !c.fix && (
                            <button
                              onClick={() => recheck(c.id)}
                              disabled={!!checkingId}
                              style={{
                                border: 'none',
                                cursor: checkingId ? 'default' : 'pointer',
                                fontSize: 11,
                                fontWeight: 700,
                                padding: '6px 12px',
                                borderRadius: 999,
                                background: 'rgba(255,255,255,0.14)',
                                color: 'rgba(255,255,255,0.94)',
                                opacity: checkingId ? 0.5 : 1,
                                flexShrink: 0,
                              }}
                            >
                              {checkingId === c.id ? '檢查中…' : '重新檢查'}
                            </button>
                          )}
                        </div>
                        {st === 'installing' && log && <LogPanel text={log} />}
                        {st === 'failed' && (
                          <div style={{ fontSize: 11, color: '#ff6b62' }}>{fixErrors[c.fix]}</div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            {step === 2 && (
              <>
                <Heading title="選擇本地模型" sub="模型越大越準確，但下載更久、辨識也更慢。" />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div>
                    <div style={labelStyle}>Whisper 模型</div>
                    <CustomSelect
                      value={whisperModel}
                      onChange={(m) => {
                        setWhisperModelState(m);
                        ensureModel(m);
                      }}
                      options={WIZARD_MODEL_OPTIONS}
                      ariaLabel="Whisper 模型"
                      style={fieldStyle}
                    />
                  </div>
                  <div>
                    <div style={labelStyle}>Compute type（進階）</div>
                    <CustomSelect
                      value={computeType}
                      onChange={setComputeType}
                      options={WIZARD_COMPUTE_OPTIONS}
                      ariaLabel="Compute type"
                      style={fieldStyle}
                    />
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      background: 'rgba(255,255,255,0.04)',
                      borderRadius: 9,
                      padding: '9px 12px',
                    }}
                  >
                    <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.56)' }}>Device</span>
                    <span style={{ fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.94)' }}>
                      cpu（macOS 唯一選項）
                    </span>
                  </div>
                  <div
                    style={{
                      borderTop: '1px solid rgba(255,255,255,0.07)',
                      paddingTop: 12,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 8,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      {modelInstalling && spinner}
                      <div style={{ flex: 1, fontSize: 12, color: 'rgba(255,255,255,0.56)' }}>
                        {modelInstalling
                          ? '下載中…'
                          : modelOk
                          ? `${whisperModel} 已就緒（${MODEL_INFO[whisperModel] || ''}）`
                          : `尚未下載（${MODEL_INFO[whisperModel] || ''}）`}
                      </div>
                    </div>
                    {modelInstalling && (
                      <LogPanel text={(logLines.download_model || []).slice(-4).join('\n')} />
                    )}
                  </div>
                </div>
              </>
            )}

            {step === 3 && (
              <>
                <Heading title="設定翻譯 API Key" sub="用於將字幕翻譯成中文；可略過，之後只會有原文＋讀音層。" />
                <div style={{ display: 'flex', gap: 6 }}>
                  {['gemini', 'openai', 'anthropic'].map((p) => {
                    const on = provider === p;
                    return (
                      <div
                        key={p}
                        onClick={() => {
                          setProvider(p);
                          llmKeyPresent(p)
                            .then((v) => setKeyPresent(!!v))
                            .catch(() => {});
                        }}
                        style={{
                          flex: 1,
                          textAlign: 'center',
                          cursor: 'pointer',
                          padding: '9px 4px',
                          borderRadius: 9,
                          fontSize: 12,
                          fontWeight: 600,
                          background: on ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.05)',
                          color: on ? 'rgba(255,255,255,0.94)' : 'rgba(255,255,255,0.56)',
                          border: `1px solid ${on ? 'rgba(255,255,255,0.2)' : 'transparent'}`,
                        }}
                      >
                        {PROVIDER_LABELS[p]}
                      </div>
                    );
                  })}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <input
                    type="password"
                    value={apiKeyInput}
                    onChange={(e) => {
                      setApiKeyInput(e.target.value);
                      setKeyPresent(false);
                    }}
                    placeholder="貼上 API Key"
                    style={{ ...fieldStyle, fontWeight: 400, padding: '11px 13px' }}
                  />
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <button
                      onClick={handleSaveKey}
                      disabled={savingKey || !apiKeyInput}
                      style={{
                        border: '1px solid rgba(255,255,255,0.14)',
                        cursor: savingKey || !apiKeyInput ? 'default' : 'pointer',
                        fontSize: 11.5,
                        fontWeight: 700,
                        padding: '7px 14px',
                        borderRadius: 999,
                        background: 'rgba(255,255,255,0.06)',
                        color: 'rgba(255,255,255,0.94)',
                        opacity: savingKey || !apiKeyInput ? 0.5 : 1,
                      }}
                    >
                      {savingKey ? '儲存中…' : '儲存'}
                    </button>
                    {keyPresent && (
                      <span style={{ fontSize: 11.5, fontWeight: 600, color: '#4fd67a' }}>已設定</span>
                    )}
                  </div>
                </div>
              </>
            )}

            {step === 4 && (
              <IntroPane
                chipBg="rgba(79,214,122,0.18)"
                stroke="#4fd67a"
                title="設定完成"
                body="所有元件已就緒，現在可以開始貼上 YouTube 連結播放。"
              />
            )}
          </div>

          {/* footer */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '16px 28px',
              borderTop: '1px solid rgba(255,255,255,0.07)',
            }}
          >
            {step > 0 && step < 4 && (
              <button
                onClick={() => setStep((s) => Math.max(0, s - 1))}
                style={{
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 12.5,
                  fontWeight: 600,
                  padding: '9px 16px',
                  borderRadius: 9,
                  background: 'rgba(255,255,255,0.07)',
                  color: 'rgba(255,255,255,0.56)',
                }}
              >
                上一步
              </button>
            )}
            {step === 3 && (
              <button
                onClick={() => setStep(4)}
                style={{
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 12.5,
                  fontWeight: 600,
                  padding: '9px 12px',
                  borderRadius: 9,
                  background: 'none',
                  color: 'rgba(255,255,255,0.34)',
                }}
              >
                略過
              </button>
            )}
            <div style={{ flex: 1 }} />
            <button
              onClick={primary.action}
              disabled={primary.disabled}
              style={{
                border: 'none',
                cursor: primary.disabled ? 'default' : 'pointer',
                fontSize: 13,
                fontWeight: 700,
                padding: '10px 20px',
                borderRadius: 9,
                background: '#e0453f',
                color: '#fff',
                opacity: primary.disabled ? 0.5 : 1,
              }}
            >
              {primary.label}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function aura(color, top, left, size, opacity, delay) {
  return {
    position: 'absolute',
    top,
    left,
    width: size,
    height: size,
    background: `radial-gradient(circle, ${color} 0%, transparent 62%)`,
    opacity,
    borderRadius: '50%',
    animation: `ambientDrift 34s ease-in-out ${delay} infinite alternate`,
  };
}

function Heading({ title, sub }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ fontSize: 16, fontWeight: 700, color: 'rgba(255,255,255,0.94)' }}>{title}</div>
      <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.56)' }}>{sub}</div>
    </div>
  );
}

function IntroPane({ chipBg, stroke, title, body }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        alignItems: 'flex-start',
        paddingTop: 40,
      }}
    >
      <div
        style={{
          width: 52,
          height: 52,
          borderRadius: 14,
          background: chipBg,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
          <path
            d="M4 12l6 6L20 6"
            stroke={stroke}
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <div style={{ fontSize: 20, fontWeight: 700, color: 'rgba(255,255,255,0.94)' }}>{title}</div>
      <div style={{ fontSize: 13, lineHeight: 1.7, color: 'rgba(255,255,255,0.56)' }}>{body}</div>
    </div>
  );
}

function LogPanel({ text }) {
  return (
    <div
      style={{
        background: 'rgba(0,0,0,0.4)',
        borderRadius: 7,
        padding: '8px 10px',
        fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace',
        fontSize: 10.5,
        lineHeight: 1.6,
        color: 'rgba(255,255,255,0.5)',
        whiteSpace: 'pre-wrap',
      }}
    >
      {text}
    </div>
  );
}
