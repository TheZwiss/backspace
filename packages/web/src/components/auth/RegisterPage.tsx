import React, { useState, useRef, useEffect } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';
import { Avatar } from '../ui/Avatar';
import { ImageCropModal } from '../ui/ImageCropModal';
import { AVATAR_GRADIENT_MAP } from '../../utils/gradients';
import { AVATAR_COLORS } from '@backspace/shared';
import type { AvatarColor, CheckInviteResponse, InstanceInfoResponse } from '@backspace/shared';
import { api, RateLimitError } from '../../api/client';
import { useTransferStore } from '../../stores/transferStore';
import { waitForTransferAttachment } from '../../utils/waitForTransfer';
import { SourceCodeLink } from '../ui/SourceCodeLink';

// Single-source regex for extracting a bare invite token from a pasted full URL.
// Token format: 22 chars base64url ([A-Za-z0-9_-]).
const INVITE_URL_REGEX = /[?&]invite=([A-Za-z0-9_-]{22})/;

type UsernameStatus = 'idle' | 'checking' | 'available' | 'taken' | 'invalid';

export function RegisterPage() {
  // Step state
  const [step, setStep] = useState<1 | 2>(1);
  const [direction, setDirection] = useState<'forward' | 'back'>('forward');

  // Step 1 fields
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  // Username availability check
  const [usernameStatus, setUsernameStatus] = useState<UsernameStatus>('idle');
  const [usernameStatusMessage, setUsernameStatusMessage] = useState('');
  const usernameCheckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const usernameCheckAbortRef = useRef<AbortController | null>(null);

  // Instance info (for registration policy)
  const [instanceInfo, setInstanceInfo] = useState<InstanceInfoResponse | null>(null);

  // Invite token state
  const [manualInviteToken, setManualInviteToken] = useState('');
  const [inviteCheck, setInviteCheck] = useState<CheckInviteResponse | null>(null);
  const [inviteChecking, setInviteChecking] = useState(false);
  const inviteCheckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Ref tracking whether the URL token has been confirmed invalid by the server.
  // Used as the gate for the manual-entry debounce so we don't need inviteCheck?.valid
  // in the manual-effect dep array (which would cause a dep loop via setInviteCheck).
  const urlTokenInvalidRef = useRef(false);

  // Step 2 fields
  const [displayName, setDisplayName] = useState('');
  const [avatarColor, setAvatarColor] = useState<AvatarColor>(
    () => AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)] ?? 'mint'
  );
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarCropSrc, setAvatarCropSrc] = useState<string | null>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);

  const [error, setError] = useState('');
  const [isRegistering, setIsRegistering] = useState(false);
  const [retryAfter, setRetryAfter] = useState(0);

  const initSession = useAuthStore((s) => s.initSession);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const redirect = searchParams.get('redirect');
  const urlInviteToken = searchParams.get('invite');

  // Cleanup blob URL on unmount
  useEffect(() => {
    return () => {
      if (avatarPreview) URL.revokeObjectURL(avatarPreview);
    };
  }, [avatarPreview]);

  // Fetch instance info to determine registration policy
  useEffect(() => {
    let cancelled = false;
    api.instance.info()
      .then((info) => { if (!cancelled) setInstanceInfo(info); })
      .catch(() => {
        // Leave null — treat as open by default to avoid soft-locking the page.
        // Server-side validation (Task 11) is the real gate.
      });
    return () => { cancelled = true; };
  }, []);

  // Validate URL-supplied invite token — only fires when:
  // (a) a URL token is present, AND
  // (b) instanceInfo has loaded AND indicates registration is closed.
  // Per spec §4.4: when registration is open, the URL invite param is silently ignored
  // (no token consumption, no validation, no rate-limit slot burned).
  // When the result is invalid, urlTokenInvalidRef is set so the manual-entry
  // debounce effect can use it as a stable gate without introducing a dep loop.
  useEffect(() => {
    if (!urlInviteToken) return;
    if (!instanceInfo || instanceInfo.registrationOpen) return;
    let cancelled = false;
    urlTokenInvalidRef.current = false;
    setInviteChecking(true);
    api.auth.checkInvite(urlInviteToken)
      .then((res) => {
        if (!cancelled) {
          if (!res.valid) urlTokenInvalidRef.current = true;
          setInviteCheck(res);
        }
      })
      .catch(() => {
        if (!cancelled) {
          urlTokenInvalidRef.current = true;
          setInviteCheck({ valid: false, reason: 'invalid' });
        }
      })
      .finally(() => { if (!cancelled) setInviteChecking(false); });
    return () => { cancelled = true; };
  }, [urlInviteToken, instanceInfo]);

  // Debounced manual-entry invite validation.
  // The URL token takes precedence while it is still in-flight or has been confirmed valid.
  // Once the URL token is confirmed invalid (urlTokenInvalidRef.current === true), this
  // effect fires on manual input changes.
  //
  // We intentionally do NOT include inviteCheck?.valid in the dep array — the URL-token
  // validation effect sets urlTokenInvalidRef synchronously when the server response arrives,
  // and the user's next keystroke in the manual field re-triggers this effect. This avoids
  // a dep-loop where setInviteCheck() inside this effect would mutate a dep and cause
  // infinite re-runs.
  useEffect(() => {
    if (urlInviteToken && !urlTokenInvalidRef.current) return; // URL token takes precedence while in flight or valid

    const trimmed = manualInviteToken.trim();
    if (!trimmed) {
      setInviteCheck(null);
      setInviteChecking(false);
      return;
    }

    // Extract bare token if user pasted a full URL
    let token = trimmed;
    const urlMatch = trimmed.match(INVITE_URL_REGEX);
    if (urlMatch) token = urlMatch[1]!;

    let cancelled = false;

    if (inviteCheckTimerRef.current) clearTimeout(inviteCheckTimerRef.current);

    // Set checking=true immediately so the manual-entry row shows "Checking..." rather
    // than the stale URL-token failure state while the user is actively typing.
    setInviteChecking(true);

    inviteCheckTimerRef.current = setTimeout(async () => {
      if (cancelled) return;
      // Clear stale check result (e.g., prior URL-token invalid result) before the
      // fresh API response arrives so stale text never briefly flashes on completion.
      setInviteCheck(null);
      try {
        const res = await api.auth.checkInvite(token);
        if (cancelled) return;
        setInviteCheck(res);
      } catch {
        if (cancelled) return;
        setInviteCheck({ valid: false, reason: 'invalid' });
      } finally {
        if (!cancelled) setInviteChecking(false);
      }
    }, 500);

    return () => {
      cancelled = true;
      if (inviteCheckTimerRef.current) clearTimeout(inviteCheckTimerRef.current);
    };
  }, [manualInviteToken, urlInviteToken]);

  // Debounced username availability check
  useEffect(() => {
    // Clear previous timer and abort
    if (usernameCheckTimerRef.current) clearTimeout(usernameCheckTimerRef.current);
    if (usernameCheckAbortRef.current) usernameCheckAbortRef.current.abort();

    const trimmed = username.trim();

    if (trimmed.length === 0) {
      setUsernameStatus('idle');
      setUsernameStatusMessage('');
      return;
    }

    if (trimmed.length < 3 || trimmed.length > 32) {
      setUsernameStatus(trimmed.length > 0 ? 'invalid' : 'idle');
      setUsernameStatusMessage(trimmed.length > 0 ? 'Username must be between 3 and 32 characters' : '');
      return;
    }

    if (!/^[a-z0-9_]+$/.test(trimmed)) {
      setUsernameStatus('invalid');
      setUsernameStatusMessage('Username can only contain lowercase letters, numbers, and underscores');
      return;
    }

    setUsernameStatus('checking');
    setUsernameStatusMessage('Checking availability...');

    usernameCheckTimerRef.current = setTimeout(async () => {
      const controller = new AbortController();
      usernameCheckAbortRef.current = controller;

      try {
        const result = await api.auth.checkUsername(trimmed);
        if (controller.signal.aborted) return;

        if (result.reason) {
          setUsernameStatus('invalid');
          setUsernameStatusMessage(result.reason);
        } else if (result.available) {
          setUsernameStatus('available');
          setUsernameStatusMessage('Username is available');
        } else {
          setUsernameStatus('taken');
          setUsernameStatusMessage('Username is already taken');
        }
      } catch {
        if (controller.signal.aborted) return;
        // Network error or rate limit — fall back to idle silently
        setUsernameStatus('idle');
        setUsernameStatusMessage('');
      }
    }, 500);

    return () => {
      if (usernameCheckTimerRef.current) clearTimeout(usernameCheckTimerRef.current);
      if (usernameCheckAbortRef.current) usernameCheckAbortRef.current.abort();
    };
  }, [username]);

  // Countdown timer
  useEffect(() => {
    if (retryAfter <= 0) return;
    const timer = setInterval(() => {
      setRetryAfter((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [retryAfter]);

  // ── Invite requirements ──
  const inviteRequired = instanceInfo !== null && !instanceInfo.registrationOpen;
  const inviteValid = inviteRequired ? inviteCheck?.valid === true : true;

  // Show the manual-entry container when:
  // - Registration is closed AND
  // - There is no URL token, OR the URL token has already been validated as invalid
  const showManualEntry = instanceInfo !== null
    && !instanceInfo.registrationOpen
    && (!urlInviteToken || inviteCheck?.valid === false);

  // ── Step 1 validation ──
  const handleContinue = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    const trimmed = username.trim();
    if (!trimmed) {
      setError('Username is required');
      return;
    }
    if (trimmed.length < 3 || trimmed.length > 32) {
      setError('Username must be between 3 and 32 characters');
      return;
    }
    if (!/^[a-z0-9_]+$/.test(trimmed)) {
      setError('Username can only contain lowercase letters, numbers, and underscores');
      return;
    }
    if (usernameStatus === 'taken' || usernameStatus === 'invalid') {
      return;
    }
    if (!password) {
      setError('Password is required');
      return;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    setDirection('forward');
    setStep(2);
  };

  // ── Avatar file selection ──
  const handleAvatarSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setAvatarCropSrc(reader.result as string);
    reader.readAsDataURL(file);
    if (avatarInputRef.current) avatarInputRef.current.value = '';
  };

  const handleAvatarCropComplete = (blob: Blob) => {
    if (avatarPreview) URL.revokeObjectURL(avatarPreview);
    const previewUrl = URL.createObjectURL(blob);
    setAvatarPreview(previewUrl);
    setAvatarFile(new File([blob], 'avatar.png', { type: 'image/png' }));
    setAvatarCropSrc(null);
  };

  // ── Registration ──
  const handleRegister = async (skip: boolean) => {
    setError('');
    setIsRegistering(true);
    try {
      const dn = skip ? undefined : displayName.trim() || undefined;
      const ac = skip ? undefined : avatarColor;

      // Resolve the token to send.
      // Per spec §4.4 / §3: open-registration instances silently ignore invite tokens —
      // sending one would be harmless (server ignores it) but it's cleaner to omit it
      // client-side so nothing unexpected is on the wire.
      const tokenForRegister = (() => {
        if (!instanceInfo || instanceInfo.registrationOpen) {
          return undefined;
        }
        // URL token takes precedence ONLY while it hasn't been confirmed invalid.
        const urlInvalid = !!urlInviteToken && inviteCheck?.valid === false;
        if (urlInviteToken && !urlInvalid) return urlInviteToken;
        const trimmed = manualInviteToken.trim();
        if (trimmed) {
          const urlMatch = trimmed.match(INVITE_URL_REGEX);
          return urlMatch ? urlMatch[1] : trimmed;
        }
        // Manual empty AND URL token was confirmed invalid — send URL token so the
        // server returns the authoritative error message rather than "invite required".
        return urlInviteToken ?? undefined;
      })();

      // Step 1: Register via API — store token in localStorage for API auth,
      // but NOT in Zustand yet so AuthRedirect doesn't fire prematurely
      const response = await api.auth.register({
        username: username.trim(),
        password,
        displayName: dn,
        avatarColor: ac,
        ...(tokenForRegister ? { inviteToken: tokenForRegister } : {}),
      });
      localStorage.setItem('backspace_token', response.token);

      // Step 2: Upload avatar while still on the register page
      let finalUser = response.user;
      if (!skip && avatarFile) {
        try {
          const tid = await useTransferStore.getState().startUpload(avatarFile, { tray: false });
          const { filename } = await waitForTransferAttachment(tid);
          finalUser = await api.users.update({ avatar: filename });
        } catch {
          // Avatar upload failed — user can set it later in settings
        }
      }

      // Step 3: Activate session — sets Zustand token, triggers AuthRedirect
      initSession(response.token, finalUser);

      if (redirect && redirect.startsWith('/') && !redirect.startsWith('//')) {
        navigate(redirect);
      } else {
        navigate('/channels/@me');
      }
    } catch (err) {
      if (err instanceof RateLimitError) {
        setRetryAfter(err.retryAfter);
        setError('');
      } else {
        setError(err instanceof Error ? err.message : 'Registration failed');
      }
      setIsRegistering(false);
    }
  };

  const effectiveDisplayName = displayName.trim() || username.trim();
  const initial = effectiveDisplayName.charAt(0).toUpperCase();
  const gradient = AVATAR_GRADIENT_MAP[avatarColor];

  const isDisabled = isRegistering || retryAfter > 0;

  // Continue button is blocked while username is invalid/taken OR when an invite is required
  // but not yet validated as valid
  const continueDisabled =
    usernameStatus === 'taken' ||
    usernameStatus === 'invalid' ||
    (inviteRequired && !inviteValid);

  return (
    // Outer scroll container — root is `h-full overflow-hidden`, so this page must own
    // its own scroll. Without it, mobile users with the keyboard up cannot reach the
    // submit button on Step 2 (avatar + color picker + display name + buttons exceeds
    // the visible viewport once the iOS keyboard claims ~300 px). `h-full` (rather than
    // `min-h-full`) makes this element exactly viewport-height; the inner flex wrapper
    // uses `min-h-full` so short content still centers vertically.
    <div className="h-full overflow-y-auto bg-surface-base relative">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(124,108,246,0.06)_0%,transparent_50%)] pointer-events-none" />
      <div className="min-h-full flex items-center justify-center px-4 py-6 md:py-10 relative z-10">
        <div className="w-full max-w-[480px] bg-surface-elevated rounded-md p-6 md:p-8 shadow-elevation-high overflow-hidden">
        {/* Progress dots */}
        <div className="flex justify-center gap-2 mb-5">
          <div className={`w-2 h-2 rounded-full transition-colors duration-300 ${step === 1 ? 'bg-accent-primary' : 'bg-txt-tertiary/30'}`} />
          <div className={`w-2 h-2 rounded-full transition-colors duration-300 ${step === 2 ? 'bg-accent-primary' : 'bg-txt-tertiary/30'}`} />
        </div>

        {step === 1 ? (
          <div key="step1" className={`w-full${direction === 'back' ? ' animate-step-back' : ''}`}>
            <div className="text-center mb-6">
              <h1 className="text-2xl font-bold text-txt-primary">Create an account</h1>
            </div>

            <form onSubmit={handleContinue}>
              {error && (
                <div className="mb-4 p-3 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-sm">
                  {error}
                </div>
              )}

              {/* Closed-registration invite entry — shown when registration is closed and:
                  (a) no URL token is present, or (b) the URL token has already failed validation */}
              {showManualEntry && (
                <div className="mb-4 p-3 rounded-lg bg-surface-elevated border border-surface-border space-y-2">
                  <div className="text-sm text-txt-secondary">
                    Registration is invite-only on this instance. Paste your invite link or enter the code below.
                  </div>
                  <input
                    type="text"
                    value={manualInviteToken}
                    onChange={(e) => setManualInviteToken(e.target.value)}
                    placeholder="Invite code or link"
                    // text-base on mobile prevents iOS Safari from auto-zooming
                    // when the field is focused (any <input> with font-size <16px triggers zoom).
                    className="input-standard w-full px-3 py-2 text-base md:text-sm"
                    aria-label="Invite code or link"
                    autoComplete="off"
                  />
                  {inviteChecking && (
                    <div className="text-xs text-txt-tertiary">Checking...</div>
                  )}
                  {!inviteChecking && inviteCheck?.valid === true && (
                    <div className="text-xs text-status-online flex items-center gap-1">
                      <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
                        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                      </svg>
                      Valid invite: {inviteCheck.name}
                    </div>
                  )}
                  {!inviteChecking && inviteCheck?.valid === false && (
                    <div className="text-xs text-txt-danger">
                      {inviteCheck.reason === 'expired' && 'This invite link has expired. Ask the admin for a new one.'}
                      {inviteCheck.reason === 'exhausted' && 'This invite has reached its usage limit. Ask the admin to extend it.'}
                      {inviteCheck.reason === 'invalid' && 'Invalid invite code.'}
                    </div>
                  )}
                </div>
              )}

              {/* URL-token chip — shown only when registration is closed AND a URL token was provided.
                  Per spec §4.4: open-registration instances silently ignore the ?invite= param.
                  Layout: inline pill on desktop, full-width banner on mobile so the longer
                  error copy ("Invalid invite link — please request a new one") wraps cleanly
                  inside a 360 px viewport instead of forcing a single-line pill that overflows. */}
              {urlInviteToken && instanceInfo && !instanceInfo.registrationOpen && (
                <div className="mb-4 flex md:inline-flex items-start md:items-center gap-2 px-3 py-1.5 rounded-md md:rounded-full bg-accent-primary/10 text-accent-primary text-xs">
                  {inviteChecking ? (
                    <>
                      <svg className="w-3 h-3 animate-spin flex-shrink-0 mt-0.5 md:mt-0" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                      <span>Validating invite...</span>
                    </>
                  ) : inviteCheck?.valid === true ? (
                    <>
                      <svg className="w-3 h-3 flex-shrink-0 mt-0.5 md:mt-0" viewBox="0 0 20 20" fill="currentColor">
                        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                      </svg>
                      <span className="break-all">Using invite: {inviteCheck.name}</span>
                    </>
                  ) : inviteCheck?.valid === false ? (
                    <>
                      <svg className="w-3 h-3 flex-shrink-0 mt-0.5 md:mt-0" viewBox="0 0 20 20" fill="currentColor">
                        <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                      </svg>
                      <span>Invalid invite link — please request a new one</span>
                    </>
                  ) : (
                    <>Validating invite...</>
                  )}
                </div>
              )}

              <div className="mb-5">
                <label className="block text-xs font-bold text-txt-secondary uppercase mb-2">
                  Username <span className="text-txt-danger">*</span>
                </label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value.toLowerCase())}
                  // text-base on mobile prevents iOS Safari zoom-on-focus (<16px triggers it).
                  className="input-standard w-full py-2.5 text-base md:text-sm"
                  autoFocus
                  autoComplete="username"
                />
                {usernameStatus !== 'idle' && (
                  <div className={`mt-1.5 flex items-center gap-1.5 text-xs ${
                    usernameStatus === 'available' ? 'text-status-online' :
                    usernameStatus === 'checking' ? 'text-txt-tertiary' :
                    'text-txt-danger'
                  }`}>
                    {usernameStatus === 'checking' && (
                      <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                    )}
                    {usernameStatus === 'available' && (
                      <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
                        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                      </svg>
                    )}
                    {(usernameStatus === 'taken' || usernameStatus === 'invalid') && (
                      <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
                        <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                      </svg>
                    )}
                    <span>{usernameStatusMessage}</span>
                  </div>
                )}
              </div>

              <div className="mb-5">
                <label className="block text-xs font-bold text-txt-secondary uppercase mb-2">
                  Password <span className="text-txt-danger">*</span>
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="input-standard w-full py-2.5 text-base md:text-sm"
                  autoComplete="new-password"
                />
              </div>

              <div className="mb-5">
                <label className="block text-xs font-bold text-txt-secondary uppercase mb-2">
                  Confirm Password <span className="text-txt-danger">*</span>
                </label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="input-standard w-full py-2.5 text-base md:text-sm"
                  autoComplete="new-password"
                />
              </div>

              <button
                type="submit"
                disabled={continueDisabled}
                // py-3 on mobile yields ≥44 px tap target (Apple HIG); py-2.5 keeps the
                // tighter desktop look from before.
                className="w-full py-3 md:py-2.5 bg-accent-primary hover:bg-accent-primary/80 text-white font-medium rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Continue
              </button>

              {/* Helper text when invite is required but not yet entered */}
              {inviteRequired && !manualInviteToken.trim() && !urlInviteToken && (
                <div className="text-xs text-txt-tertiary mt-2">
                  An invite is required to register on this instance.
                </div>
              )}

              <p className="mt-3 text-sm text-txt-tertiary">
                Already have an account?{' '}
                <Link to={`/login${redirect ? `?redirect=${encodeURIComponent(redirect)}` : ''}`} className="text-accent-primary hover:underline">
                  Log In
                </Link>
              </p>
            </form>
          </div>
        ) : (
          <div key="step2" className={`w-full${direction === 'forward' ? ' animate-step-forward' : ''}`}>
            <div className="text-center mb-6">
              <h1 className="text-2xl font-bold text-txt-primary">Make it yours</h1>
              <p className="text-txt-tertiary text-sm mt-1">Personalize your profile, or skip for now</p>
            </div>

            {retryAfter > 0 && (
              <div className="mb-4 p-3 bg-accent-amber/10 border border-accent-amber/30 rounded text-sm">
                <p className="font-medium text-accent-amber">Too many attempts</p>
                <p className="text-txt-secondary mt-0.5">Try again in {retryAfter}s</p>
              </div>
            )}

            {error && (
              <div className="mb-4 p-3 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-sm">
                {error}
              </div>
            )}

            {/* Avatar preview */}
            <div className="flex flex-col items-center mb-5">
              <button
                type="button"
                onClick={() => avatarInputRef.current?.click()}
                className="relative group"
              >
                <Avatar
                  src={avatarPreview}
                  name={effectiveDisplayName}
                  size={80}
                  avatarColor={avatarColor}
                />
                <div className="absolute inset-0 rounded-full bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                  <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                </div>
              </button>
              <button
                type="button"
                onClick={() => avatarInputRef.current?.click()}
                className="text-xs text-accent-primary hover:underline mt-2"
              >
                Upload photo
              </button>
              <input
                ref={avatarInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleAvatarSelect}
              />
            </div>

            {/* Display Name */}
            <div className="mb-5">
              <label className="block text-xs font-bold text-txt-secondary uppercase mb-2">
                Display Name
              </label>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder={username.trim() || 'Display name'}
                className="input-standard w-full py-2.5 text-base md:text-sm"
                autoComplete="name"
              />
            </div>

            {/* Avatar Color Picker */}
            <div className="mb-6">
              <label className="block text-xs font-bold text-txt-secondary uppercase mb-2">
                Avatar Color
              </label>
              {/* Color swatch row: gap tightens on narrow viewports so the 7 swatches
                  fit inside a 360 px viewport (p-6 inner content area is ~280 px;
                  7×32 + 6×10 = 284 px would overflow with gap-2.5). */}
              <div className="flex gap-2 md:gap-2.5 justify-center">
                {AVATAR_COLORS.map((key) => {
                  const entry = AVATAR_GRADIENT_MAP[key];
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setAvatarColor(key)}
                      className="w-8 h-8 rounded-full border-2 transition-all hover:scale-110"
                      style={{
                        background: entry.gradient,
                        borderColor: avatarColor === key ? 'white' : 'transparent',
                        boxShadow: avatarColor === key ? `0 0 0 2px ${entry.glow}40` : 'none',
                      }}
                      title={key.charAt(0).toUpperCase() + key.slice(1)}
                    />
                  );
                })}
              </div>
            </div>

            {/* Actions */}
            <button
              type="button"
              onClick={() => handleRegister(false)}
              disabled={isDisabled}
              className="w-full py-3 md:py-2.5 bg-accent-primary hover:bg-accent-primary/80 text-white font-medium rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {retryAfter > 0
                ? `Try again in ${retryAfter}s`
                : isRegistering
                  ? 'Creating account...'
                  : 'Get Started'}
            </button>

            <div className="flex items-center justify-between mt-3">
              <button
                type="button"
                onClick={() => { setError(''); setRetryAfter(0); setDirection('back'); setStep(1); }}
                disabled={isRegistering}
                // py-2 px-1 widens the tap area on mobile while keeping the visual link style.
                className="text-sm text-txt-tertiary hover:text-txt-secondary transition-colors disabled:opacity-50 py-2 px-1 -mx-1"
              >
                Back
              </button>
              <button
                type="button"
                onClick={() => handleRegister(true)}
                disabled={isDisabled}
                className="text-sm text-txt-tertiary hover:text-txt-secondary transition-colors disabled:opacity-50 py-2 px-1 -mx-1"
              >
                Skip for now
              </button>
            </div>
          </div>
        )}

        {/* AGPL § 13: source offer for anonymous visitors, shown on both steps. */}
        {instanceInfo && (
          <div className="mt-6 pt-4 border-t border-white/[0.04] flex justify-center">
            <SourceCodeLink sourceCodeUrl={instanceInfo.sourceCodeUrl} version={instanceInfo.version} commit={instanceInfo.commit} />
          </div>
        )}
        </div>
      </div>

      {/* Image Crop Modal */}
      {avatarCropSrc && (
        <ImageCropModal
          isOpen={true}
          onClose={() => setAvatarCropSrc(null)}
          imageSrc={avatarCropSrc}
          onCropComplete={handleAvatarCropComplete}
          title="Crop Avatar"
          aspectRatio={1}
          cropShape="round"
          maxOutputDimension={256}
        />
      )}
    </div>
  );
}
