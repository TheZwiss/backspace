import React, { useState, useRef, useEffect } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';
import { Avatar } from '../ui/Avatar';
import { ImageCropModal } from '../ui/ImageCropModal';
import { AVATAR_GRADIENT_MAP } from '../../utils/gradients';
import { AVATAR_COLORS } from '@backspace/shared';
import type { AvatarColor } from '@backspace/shared';
import { api, RateLimitError } from '../../api/client';

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

  const register = useAuthStore((s) => s.register);
  const updateProfile = useAuthStore((s) => s.updateProfile);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const redirect = searchParams.get('redirect');

  // Cleanup blob URL on unmount
  useEffect(() => {
    return () => {
      if (avatarPreview) URL.revokeObjectURL(avatarPreview);
    };
  }, [avatarPreview]);

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
      await register(username.trim(), password, dn, ac);

      // Upload avatar if chosen (non-fatal — account already created)
      if (!skip && avatarFile) {
        try {
          const attachment = await api.uploads.upload(avatarFile);
          await updateProfile({ avatar: attachment.filename });
        } catch {
          // Avatar upload failed — user can set it later in settings
        }
      }

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

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-base relative">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(124,108,246,0.06)_0%,transparent_50%)]" />
      <div className="w-full max-w-[480px] bg-surface-elevated rounded-md p-8 shadow-elevation-high relative z-10 overflow-hidden">
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

              <div className="mb-5">
                <label className="block text-xs font-bold text-txt-secondary uppercase mb-2">
                  Username <span className="text-txt-danger">*</span>
                </label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value.toLowerCase())}
                  className="input-standard w-full py-2.5"
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
                  className="input-standard w-full py-2.5"
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
                  className="input-standard w-full py-2.5"
                  autoComplete="new-password"
                />
              </div>

              <button
                type="submit"
                disabled={usernameStatus === 'taken' || usernameStatus === 'invalid'}
                className="w-full py-2.5 bg-accent-primary hover:bg-accent-primary/80 text-white font-medium rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Continue
              </button>

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
                className="input-standard w-full py-2.5"
                autoComplete="name"
              />
            </div>

            {/* Avatar Color Picker */}
            <div className="mb-6">
              <label className="block text-xs font-bold text-txt-secondary uppercase mb-2">
                Avatar Color
              </label>
              <div className="flex gap-2.5 justify-center">
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
              className="w-full py-2.5 bg-accent-primary hover:bg-accent-primary/80 text-white font-medium rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
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
                className="text-sm text-txt-tertiary hover:text-txt-secondary transition-colors disabled:opacity-50"
              >
                Back
              </button>
              <button
                type="button"
                onClick={() => handleRegister(true)}
                disabled={isDisabled}
                className="text-sm text-txt-tertiary hover:text-txt-secondary transition-colors disabled:opacity-50"
              >
                Skip for now
              </button>
            </div>
          </div>
        )}
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
        />
      )}
    </div>
  );
}
