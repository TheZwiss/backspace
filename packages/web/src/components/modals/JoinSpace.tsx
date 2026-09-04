import React, { useState, useEffect, useMemo } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Modal } from '../ui/Modal';
import { useUIStore } from '../../stores/uiStore';
import { useSpaceStore, NotConnectedError } from '../../stores/spaceStore';
import { useInstanceStore, DifferentPasswordError } from '../../stores/instanceStore';
import { useAuthStore } from '../../stores/authStore';
import { useExploreStore } from '../../stores/exploreStore';
import { useNavigate } from 'react-router-dom';
import { parseInviteInput } from '../../utils/inviteParser';
import { ExploreSpacePreviewCard } from './ExploreSpacePreviewCard';
import { describeError } from '../../i18n/errors';

type JoinPhase = 'input' | 'connect' | 'fallback';

export function JoinSpaceModal() {
  const { t } = useTranslation(['spaces', 'common']);
  const [inviteCode, setInviteCode] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [phase, setPhase] = useState<JoinPhase>('input');
  const [parsedCode, setParsedCode] = useState('');
  const [parsedOrigin, setParsedOrigin] = useState('');
  const [password, setPassword] = useState('');
  const [fallbackUsername, setFallbackUsername] = useState('');
  const [fallbackPassword, setFallbackPassword] = useState('');

  const activeModal = useUIStore((s) => s.activeModal);
  const closeModal = useUIStore((s) => s.closeModal);
  const joinByCode = useSpaceStore((s) => s.joinByCode);
  const connectToRemote = useInstanceStore((s) => s.connectToRemote);
  const loginToRemote = useInstanceStore((s) => s.loginToRemote);
  const user = useAuthStore((s) => s.user);
  const navigate = useNavigate();

  const isMobile = useUIStore((s) => s.isMobile);
  const pushMobileScreen = useUIStore((s) => s.pushMobileScreen);

  const discoverySpaces = useExploreStore((s) => s.spaces);
  const discoveryLoading = useExploreStore((s) => s.isLoading);
  const discoveryEnabled = useExploreStore((s) => s.discoveryEnabled);
  const discoveryError = useExploreStore((s) => s.error);
  const fetchSpaces = useExploreStore((s) => s.fetchSpaces);
  const fetchMyRequests = useExploreStore((s) => s.fetchMyRequests);

  const isOpen = activeModal === 'joinSpace';

  // Fetch discoverable spaces when the modal opens. Fire-and-forget; the invite
  // section never depends on this resolving.
  useEffect(() => {
    if (isOpen) {
      void fetchSpaces();
      void fetchMyRequests();
    }
  }, [isOpen, fetchSpaces, fetchMyRequests]);

  const previewSpaces = useMemo(
    () => discoverySpaces.filter((s) => !s.joined).slice(0, 6),
    [discoverySpaces],
  );

  const handleBrowseExplore = () => {
    closeModal();
    if (isMobile) pushMobileScreen('explore');
    else navigate('/explore');
  };

  const handlePreviewJoinSuccess = (spaceId: string) => {
    closeModal();
    navigate(`/channels/${spaceId}`);
  };

  // Reset state on close
  useEffect(() => {
    if (!isOpen) {
      setInviteCode('');
      setError('');
      setPhase('input');
      setParsedCode('');
      setParsedOrigin('');
      setPassword('');
      setFallbackUsername('');
      setFallbackPassword('');
    }
  }, [isOpen]);

  const joinAndNavigate = async (code: string, origin?: string) => {
    const space = await joinByCode(code, origin || undefined);
    closeModal();
    navigate(`/channels/${space.id}`);
  };

  // Phase 1: Submit invite code/URL
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    let parsed: { code: string; origin?: string };
    try {
      parsed = parseInviteInput(inviteCode);
    } catch (err) {
      setError(describeError(err));
      return;
    }

    setParsedCode(parsed.code);
    setParsedOrigin(parsed.origin || '');

    setIsLoading(true);
    try {
      await joinAndNavigate(parsed.code, parsed.origin);
    } catch (err) {
      if (err instanceof NotConnectedError) {
        setPhase('connect');
        setError('');
      } else {
        setError(describeError(err));
      }
    } finally {
      setIsLoading(false);
    }
  };

  // Phase 2: Connect to remote instance with password, then join
  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);
    try {
      await connectToRemote(parsedOrigin, password, user?.displayName || undefined);
      await joinAndNavigate(parsedCode, parsedOrigin);
    } catch (err) {
      if (err instanceof DifferentPasswordError) {
        setPhase('fallback');
        setFallbackUsername(err.remoteUsername);
        setFallbackPassword('');
        setError('');
      } else {
        setError(describeError(err));
      }
    } finally {
      setIsLoading(false);
    }
  };

  // Phase 3: Fallback login with different credentials, then join
  const handleFallbackLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);
    try {
      await loginToRemote(parsedOrigin, fallbackUsername, fallbackPassword);
      await joinAndNavigate(parsedCode, parsedOrigin);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setIsLoading(false);
    }
  };

  let hostDisplay = '';
  try {
    if (parsedOrigin) hostDisplay = new URL(parsedOrigin).host;
  } catch { /* ignore */ }

  return (
    <Modal isOpen={isOpen} onClose={closeModal} title={t('spaces:join.title')} mobileStyle="sheet">
      {/* Error display (shared across all phases) */}
      {error && (
        <div className="mb-3 p-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-sm">
          {error}
        </div>
      )}

      {/* Phase: input — discovery-first, with invite code as a secondary path */}
      {phase === 'input' && (
        <div>
          {/* ── Discovery section ── */}
          {discoveryEnabled ? (
            <div className="mb-1">
              <p className="text-txt-secondary text-sm mb-3">
                {t('spaces:join.discoverIntro')}
              </p>

              {discoveryLoading && previewSpaces.length === 0 ? (
                <div className="space-y-2">
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="h-[60px] rounded-lg bg-surface-channel border border-border-soft animate-pulse" />
                  ))}
                </div>
              ) : discoveryError ? (
                <div className="p-2.5 rounded-lg bg-surface-channel border border-border-soft text-[13px] text-txt-tertiary">
                  {t('spaces:join.discoverError')}
                </div>
              ) : previewSpaces.length === 0 ? (
                <div className="p-3 rounded-lg bg-surface-channel border border-border-soft text-[13px] text-txt-tertiary text-center">
                  {t('spaces:join.discoverEmpty')}
                </div>
              ) : (
                <div className="space-y-2 max-h-[280px] overflow-y-auto pr-0.5">
                  {previewSpaces.map((space) => (
                    <ExploreSpacePreviewCard
                      key={`${space.id}:${space._instanceOrigin}`}
                      space={space}
                      onJoinSuccess={handlePreviewJoinSuccess}
                    />
                  ))}
                </div>
              )}

              <button
                type="button"
                onClick={handleBrowseExplore}
                className="mt-3 w-full py-2 flex items-center justify-center gap-1.5 text-sm font-medium text-accent-primary hover:bg-accent-primary/10 rounded-lg transition-colors"
              >
                {t('spaces:join.browseExplore')}
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
              </button>
            </div>
          ) : (
            <div className="mb-1 p-2.5 rounded-lg bg-accent-amber/10 border border-accent-amber/30 text-[13px] text-accent-amber">
              {t('spaces:join.discoveryOff')}
            </div>
          )}

          {/* Divider */}
          <div className="flex items-center gap-3 my-4">
            <div className="flex-1 h-px bg-white/[0.06]" />
            <span className="text-[11px] font-semibold uppercase tracking-wider text-txt-tertiary">
              {t('spaces:join.inviteDivider')}
            </span>
            <div className="flex-1 h-px bg-white/[0.06]" />
          </div>

          {/* ── Invite-code section (secondary) ── */}
          <form onSubmit={handleSubmit}>
            <div className="mb-4">
              <input
                type="text"
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value)}
                className="input-standard w-full"
                placeholder={t('spaces:join.invitePlaceholder')}
              />
            </div>
            <div className="sticky bottom-0 z-10 pointer-events-none">
              <div className="flex justify-center pt-3 pb-1">
                <div className="glass-bubble rounded-full px-3 py-2 flex items-center gap-3 pointer-events-auto">
                  <button
                    type="button"
                    onClick={closeModal}
                    className="px-3 py-1 text-sm text-txt-tertiary hover:text-txt-secondary transition-colors"
                  >
                    {t('common:actions.cancel')}
                  </button>
                  <button
                    type="submit"
                    disabled={isLoading || !inviteCode.trim()}
                    className="px-3 py-1.5 bg-accent-primary hover:bg-accent-primary/80 text-white text-sm font-medium rounded-full transition-colors disabled:opacity-50"
                  >
                    {isLoading ? t('spaces:join.submitting') : t('spaces:join.submit')}
                  </button>
                </div>
              </div>
            </div>
          </form>
        </div>
      )}

      {/* Phase: connect — password prompt to connect to remote instance */}
      {phase === 'connect' && (
        <form onSubmit={handleConnect}>
          <input type="text" autoComplete="username" value={user?.username || ''} readOnly tabIndex={-1} className="sr-only" />
          <p className="text-txt-secondary text-sm mb-4">
            <Trans
              t={t}
              i18nKey="spaces:join.connect.intro"
              values={{ host: hostDisplay }}
              components={{ host: <span className="text-txt-primary font-medium" /> }}
            />
          </p>
          <div className="mb-4 space-y-2">
            <div>
              <label className="block text-xs text-txt-tertiary mb-1">
                {t('spaces:join.connect.passwordLabel')}
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t('spaces:join.connect.passwordPlaceholder')}
                className="input-standard w-full"
                disabled={isLoading}
                autoFocus
                autoComplete="current-password"
              />
              <div className="text-xs text-txt-tertiary mt-1">
                {t('spaces:join.connect.passwordNote', { host: hostDisplay })}
              </div>
            </div>
          </div>
          <div className="sticky bottom-0 z-10 pointer-events-none">
            <div className="flex justify-center pt-3 pb-1">
              <div className="glass-bubble rounded-full px-3 py-2 flex items-center gap-3 pointer-events-auto">
                <button
                  type="button"
                  onClick={() => { setPhase('input'); setPassword(''); setError(''); }}
                  className="px-3 py-1 text-sm text-txt-tertiary hover:text-txt-secondary transition-colors flex items-center gap-1"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                  </svg>
                  {t('common:actions.back')}
                </button>
                <div className="w-px h-5 bg-white/10" />
                <button
                  type="button"
                  onClick={closeModal}
                  className="px-3 py-1 text-sm text-txt-tertiary hover:text-txt-secondary transition-colors"
                >
                  {t('common:actions.cancel')}
                </button>
                <button
                  type="submit"
                  disabled={isLoading || !password}
                  className="px-3 py-1.5 bg-accent-primary hover:bg-accent-primary/80 text-white text-sm font-medium rounded-full transition-colors disabled:opacity-50"
                >
                  {isLoading ? t('spaces:join.connect.submitting') : t('spaces:join.connect.submit')}
                </button>
              </div>
            </div>
          </div>
        </form>
      )}

      {/* Phase: fallback — different password on remote instance */}
      {phase === 'fallback' && (
        <form onSubmit={handleFallbackLogin}>
          <div className="mb-3 p-2 bg-accent-amber/10 border border-accent-amber/30 rounded text-xs text-accent-amber">
            {t('spaces:join.fallback.notice', { host: hostDisplay })}
          </div>
          <div className="mb-4 space-y-3">
            <div>
              <label className="block text-xs text-txt-tertiary mb-1">{t('common:labels.username')}</label>
              <input
                type="text"
                value={fallbackUsername}
                onChange={(e) => setFallbackUsername(e.target.value)}
                placeholder={t('spaces:join.fallback.usernamePlaceholder')}
                className="input-standard w-full"
                disabled={isLoading}
                autoComplete="username"
              />
            </div>
            <div>
              <label className="block text-xs text-txt-tertiary mb-1">{t('spaces:join.fallback.passwordLabel')}</label>
              <input
                type="password"
                value={fallbackPassword}
                onChange={(e) => setFallbackPassword(e.target.value)}
                placeholder={t('spaces:join.fallback.passwordPlaceholder')}
                className="input-standard w-full"
                disabled={isLoading}
                autoFocus
                autoComplete="current-password"
              />
            </div>
          </div>
          <div className="sticky bottom-0 z-10 pointer-events-none">
            <div className="flex justify-center pt-3 pb-1">
              <div className="glass-bubble rounded-full px-3 py-2 flex items-center gap-3 pointer-events-auto">
                <button
                  type="button"
                  onClick={() => { setPhase('connect'); setFallbackPassword(''); setError(''); }}
                  className="px-3 py-1 text-sm text-txt-tertiary hover:text-txt-secondary transition-colors flex items-center gap-1"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                  </svg>
                  {t('common:actions.back')}
                </button>
                <div className="w-px h-5 bg-white/10" />
                <button
                  type="button"
                  onClick={closeModal}
                  className="px-3 py-1 text-sm text-txt-tertiary hover:text-txt-secondary transition-colors"
                >
                  {t('common:actions.cancel')}
                </button>
                <button
                  type="submit"
                  disabled={isLoading || !fallbackUsername || !fallbackPassword}
                  className="px-3 py-1.5 bg-accent-primary hover:bg-accent-primary/80 text-white text-sm font-medium rounded-full transition-colors disabled:opacity-50"
                >
                  {isLoading ? t('spaces:join.fallback.submitting') : t('spaces:join.fallback.submit')}
                </button>
              </div>
            </div>
          </div>
        </form>
      )}
    </Modal>
  );
}
