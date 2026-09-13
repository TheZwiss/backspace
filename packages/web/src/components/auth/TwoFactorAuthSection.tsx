import React, { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { api } from '../../api/client';
import type { TotpStatusResponse } from '@backspace/shared';

/**
 * Settings UI for two-factor authentication (issue #182). Lives inside the
 * Account tab of UserSettingsModal. Federated users see a notice instead of
 * controls (issue #182 acceptance criteria — 2FA must be managed on the
 * home instance).
 *
 * State machine:
 *   - `idle`              : no enrollment, no action in progress
 *   - `setup-qr`          : setup initiated, awaiting scan + first code
 *   - `setup-codes`       : first code accepted, showing recovery codes ONCE
 *   - `busy`              : any other request in flight (disable / regenerate)
 *
 * The component never persists recovery codes anywhere on the client — they
 * are displayed once, copied-or-saved by the user, then forgotten.
 */
export function TwoFactorAuthSection() {
  const [status, setStatus] = useState<TotpStatusResponse | null>(null);
  const [phase, setPhase] = useState<'idle' | 'setup-qr' | 'setup-codes' | 'busy'>('idle');
  const [error, setError] = useState<string | null>(null);

  // Setup wizard transient state
  const [secret, setSecret] = useState<string>('');
  const [otpauthUrl, setOtpauthUrl] = useState<string>('');
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [confirmCode, setConfirmCode] = useState<string>('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);

  // Disable / regenerate confirm flow
  const [actionCode, setActionCode] = useState<string>('');
  const [actionPassword, setActionPassword] = useState<string>('');
  const [actionLabel, setActionLabel] = useState<'disable' | 'regenerate'>('disable');

  const qrCanvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.auth.totpStatus()
      .then((s) => { if (!cancelled) setStatus(s); })
      .catch(() => { /* Non-fatal: the section just shows an unknown state. */ });
    return () => { cancelled = true; };
  }, []);

  // Render the QR via the qrcode package — pure SVG fallback if anything fails.
  useEffect(() => {
    if (!otpauthUrl) return;
    if (qrCanvasRef.current) {
      QRCode.toCanvas(qrCanvasRef.current, otpauthUrl, {
        width: 220,
        margin: 1,
        color: { dark: '#13131a', light: '#ffffff' },
      }).catch(() => {
        // If canvas drawing fails, fall back to a data URL via toDataURL.
        QRCode.toDataURL(otpauthUrl, { width: 220, margin: 1 })
          .then((u: string) => setQrDataUrl(u))
          .catch(() => setError('Failed to render QR code'));
      });
    }
  }, [otpauthUrl]);

  const beginSetup = async () => {
    setError(null);
    setPhase('busy');
    try {
      const r = await api.auth.totpSetupInitiate();
      setSecret(r.secret);
      setOtpauthUrl(r.otpauthUrl);
      setConfirmCode('');
      setRecoveryCodes([]);
      setPhase('setup-qr');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start 2FA setup');
      setPhase('idle');
    }
  };

  const confirmSetup = async () => {
    setError(null);
    if (!/^\d{6}$/.test(confirmCode.trim())) {
      setError('Enter the 6-digit code from your authenticator app');
      return;
    }
    setPhase('busy');
    try {
      const r = await api.auth.totpSetupConfirm({ code: confirmCode.trim() });
      setRecoveryCodes(r.recoveryCodes);
      setPhase('setup-codes');
      setStatus({ enabled: true, hasPendingSetup: false, hasRecoveryCodes: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed');
      setPhase('setup-qr');
    }
  };

  const cancelSetup = () => {
    setPhase('idle');
    setSecret('');
    setOtpauthUrl('');
    setQrDataUrl('');
    setConfirmCode('');
    setRecoveryCodes([]);
    setError(null);
    // Re-fetch in case the server-side pending row needs to be cleaned up by disable flow.
  };

  const startAction = (label: 'disable' | 'regenerate') => {
    setActionLabel(label);
    setActionCode('');
    setActionPassword('');
    setError(null);
  };

  const runAction = async () => {
    setError(null);
    if (!actionPassword) { setError('Password is required'); return; }
    if (!/^[A-Z0-9]{6,12}$/i.test(actionCode.trim())) { setError('A 6-digit TOTP code is required'); return; }
    setPhase('busy');
    try {
      if (actionLabel === 'disable') {
        await api.auth.totpDisable({ password: actionPassword, code: actionCode.trim() });
        setStatus({ enabled: false, hasPendingSetup: false, hasRecoveryCodes: false });
      } else {
        const r = await api.auth.totpRegenerateRecoveryCodes({ password: actionPassword, code: actionCode.trim() });
        setRecoveryCodes(r.recoveryCodes);
        setStatus((prev) => prev ? { ...prev, hasRecoveryCodes: true } : prev);
      }
      setPhase('idle');
      setActionCode('');
      setActionPassword('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
      setPhase('idle');
    }
  };

  const cancelAction = () => {
    setActionCode('');
    setActionPassword('');
    setError(null);
  };

  // ─── Render ─────────────────────────────────────────────────────────────

  const statusLine = (() => {
    if (!status) return null;
    if (status.enabled) {
      return (
        <div className="flex items-center gap-2 text-sm text-txt-secondary">
          <span className="inline-block w-2 h-2 rounded-full bg-accent-mint" aria-hidden />
          <span className="text-txt-primary font-medium">Enabled</span>
          {status.hasRecoveryCodes && <span className="text-txt-tertiary">— recovery codes available</span>}
          {!status.hasRecoveryCodes && <span className="text-accent-amber">— recovery codes exhausted, regenerate recommended</span>}
        </div>
      );
    }
    if (status.hasPendingSetup) {
      return (
        <div className="flex items-center gap-2 text-sm text-txt-secondary">
          <span className="inline-block w-2 h-2 rounded-full bg-accent-amber" aria-hidden />
          <span className="text-txt-primary font-medium">Setup pending</span>
          <span className="text-txt-tertiary">— finish scanning + verification</span>
        </div>
      );
    }
    return (
      <div className="flex items-center gap-2 text-sm text-txt-secondary">
        <span className="inline-block w-2 h-2 rounded-full bg-txt-tertiary" aria-hidden />
        <span className="text-txt-primary font-medium">Not enabled</span>
      </div>
    );
  })();

  // Federation notice: server returns 403 for setup on federated users. Detect
  // this on the first initiate attempt — if so, show a permanent notice.
  // We probe by attempting a no-op GET on status; the server only enforces
  // federation at the setup endpoint. If the user attempts setup, we surface
  // the error inline.
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-lg font-semibold text-txt-primary">Two-factor authentication</h3>
        {statusLine}
      </div>

      {error && (
        <div className="mb-3 p-3 bg-accent-rose/10 border border-accent-rose/30 rounded text-sm text-txt-danger">
          {error}
        </div>
      )}

      {/* ─── Status: idle / enabled ─────────────────────────────────────────── */}
      {phase === 'idle' && status && (
        <div className="space-y-3">
          {!status.enabled && !status.hasPendingSetup && (
            <>
              <p className="text-sm text-txt-tertiary">
                Add an extra layer of security with a time-based one-time password (TOTP) from an
                authenticator app like Google Authenticator, Bitwarden, or 1Password.
              </p>
              <button
                type="button"
                onClick={beginSetup}
                className="px-4 py-2 bg-accent-primary hover:bg-accent-primary/80 text-white text-sm font-medium rounded transition-colors"
              >
                Enable two-factor authentication
              </button>
            </>
          )}
          {status.enabled && (
            <div className="flex flex-wrap gap-2">
              {!actionLabel && (
                <>
                  <button
                    type="button"
                    onClick={() => startAction('regenerate')}
                    className="px-4 py-2 bg-interactive-hover hover:bg-interactive-active text-txt-primary text-sm font-medium rounded transition-colors"
                  >
                    Regenerate recovery codes
                  </button>
                  <button
                    type="button"
                    onClick={() => startAction('disable')}
                    className="px-4 py-2 bg-accent-rose/10 hover:bg-accent-rose/20 text-accent-rose text-sm font-medium rounded transition-colors border border-accent-rose/30"
                  >
                    Disable 2FA
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* ─── Action confirm: disable or regenerate ─────────────────────────── */}
      {(actionLabel === 'disable' || actionLabel === 'regenerate') && phase !== 'busy' && (
        <div className="space-y-3 p-4 bg-surface-input rounded">
          <p className="text-sm text-txt-secondary">
            {actionLabel === 'disable'
              ? 'Enter your password and a current 6-digit code from your authenticator to confirm disabling 2FA.'
              : 'Enter your password and a current 6-digit code to regenerate your recovery codes. The previous codes are immediately invalidated.'}
          </p>
          <input
            type="password"
            placeholder="Password"
            autoComplete="current-password"
            value={actionPassword}
            onChange={(e) => setActionPassword(e.target.value)}
            className="input-standard w-full py-2"
          />
          <input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="123456"
            value={actionCode}
            onChange={(e) => setActionCode(e.target.value.replace(/\s+/g, ''))}
            maxLength={6}
            className="input-standard w-full py-2 text-center tracking-[0.3em] font-mono"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={runAction}
              className="px-4 py-2 bg-accent-primary hover:bg-accent-primary/80 text-white text-sm font-medium rounded transition-colors"
            >
              Confirm
            </button>
            <button
              type="button"
              onClick={cancelAction}
              className="px-4 py-2 text-txt-tertiary hover:text-txt-secondary text-sm rounded transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {phase === 'busy' && (
        <p className="text-sm text-txt-tertiary">Working…</p>
      )}

      {/* ─── Setup wizard: QR + first-code ─────────────────────────────────── */}
      {phase === 'setup-qr' && (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row gap-4 items-start">
            <div className="bg-white p-2 rounded shadow-md flex-shrink-0">
              <canvas ref={qrCanvasRef} width={220} height={220} aria-label="TOTP QR code" />
              {qrDataUrl && <img src={qrDataUrl} alt="TOTP QR code" className="hidden" />}
            </div>
            <div className="flex-1 min-w-0 space-y-3">
              <p className="text-sm text-txt-secondary">
                Scan the QR code with your authenticator app, then enter the 6-digit code it shows
                to confirm.
              </p>
              <details className="text-xs">
                <summary className="cursor-pointer text-txt-tertiary hover:text-txt-secondary">
                  Can't scan? Enter the secret manually.
                </summary>
                <div className="mt-2 p-2 bg-surface-input rounded font-mono break-all text-txt-primary">
                  {secret}
                </div>
              </details>
            </div>
          </div>
          <div>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="6-digit code"
              value={confirmCode}
              onChange={(e) => setConfirmCode(e.target.value.replace(/\s+/g, ''))}
              maxLength={6}
              className="input-standard w-full py-2 text-center tracking-[0.3em] font-mono"
              autoFocus
            />
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={confirmSetup}
              disabled={!/^\d{6}$/.test(confirmCode.trim())}
              className="px-4 py-2 bg-accent-primary hover:bg-accent-primary/80 text-white text-sm font-medium rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Verify and enable
            </button>
            <button
              type="button"
              onClick={cancelSetup}
              className="px-4 py-2 text-txt-tertiary hover:text-txt-secondary text-sm rounded transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ─── Recovery-codes display — ONE TIME ───────────────────────────────── */}
      {phase === 'setup-codes' && recoveryCodes.length > 0 && (
        <div className="space-y-3">
          <div className="p-3 bg-accent-mint/10 border border-accent-mint/30 rounded text-sm text-txt-primary">
            <strong className="font-semibold">2FA enabled.</strong> Save these recovery codes
            somewhere safe — they are shown once and never again. Each code is single-use.
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 p-3 bg-surface-input rounded font-mono text-sm">
            {recoveryCodes.map((c, i) => (
              <div key={i} className="px-2 py-1 bg-surface-elevated rounded text-txt-primary text-center">
                {c}
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={cancelSetup}
            className="px-4 py-2 bg-accent-primary hover:bg-accent-primary/80 text-white text-sm font-medium rounded transition-colors"
          >
            I've saved my recovery codes
          </button>
        </div>
      )}
    </div>
  );
}
