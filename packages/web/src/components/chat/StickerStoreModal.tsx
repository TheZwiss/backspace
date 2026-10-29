import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { stickerUrl, stickerPreviewUrl, type StickerPackDetail, type StickerPackSummary } from '@backspace/shared/src/stickers';
import { api } from '../../api/client';
import { describeError } from '../../i18n/errors';
import { usePortalContainer } from '../../hooks/usePortalContainer';
import { useAuthStore } from '../../stores/authStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { StickerPackManageModal } from './StickerPackManageModal';
import './stickers.css';

interface StickerStoreModalProps {
  onClose: () => void;
  onPacksChanged?: () => void;
}

export function StickerStoreModal({ onClose, onPacksChanged }: StickerStoreModalProps) {
  const { t } = useTranslation(['chat', 'common']);
  const isSettingsAdmin = useSettingsStore(s => s.isAdmin);
  const isAuthAdmin = useAuthStore(s => !!s.user?.isAdmin);
  const isAdmin = isSettingsAdmin || isAuthAdmin;
  const [activeTab, setActiveTab] = useState<'explore' | 'myPacks' | 'reviews'>('explore');
  const [search, setSearch] = useState('');

  const [packs, setPacks] = useState<StickerPackSummary[]>([]);
  const [myPacks, setMyPacks] = useState<StickerPackSummary[]>([]);
  const [reviews, setReviews] = useState<StickerPackSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [actionSuccess, setActionSuccess] = useState('');
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  // Reject dialog state
  const [rejectingPack, setRejectingPack] = useState<{ id: string; name: string } | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  // Selected pack for preview modal
  const [previewPack, setPreviewPack] = useState<StickerPackDetail | null>(null);

  // Authoring modal state
  const [editingPackId, setEditingPackId] = useState<string | null | undefined>(undefined);

  const fetchExplorePacks = async (query = '') => {
    setLoading(true);
    setError('');
    setActionSuccess('');
    try {
      const data = await api.stickerStore.listPacks({ q: query || undefined });
      setPacks(data);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  };

  const fetchMyCreatedPacks = async () => {
    setLoading(true);
    setError('');
    setActionSuccess('');
    try {
      const data = await api.stickerStore.listCreated();
      setMyPacks(data);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  };

  const fetchReviews = async () => {
    if (!isAdmin) return;
    setLoading(true);
    setError('');
    setActionSuccess('');
    try {
      const data = await api.admin.stickerPacks.listReviews();
      setReviews(data);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isAdmin) {
      api.admin.stickerPacks.listReviews().then(setReviews).catch(() => {});
    }
  }, [isAdmin]);

  useEffect(() => {
    if (activeTab === 'explore') {
      fetchExplorePacks(search);
    } else if (activeTab === 'myPacks') {
      fetchMyCreatedPacks();
    } else if (activeTab === 'reviews') {
      fetchReviews();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  const handleToggleInstall = async (e: React.MouseEvent, pack: StickerPackSummary) => {
    e.stopPropagation();
    try {
      if (pack.isInstalled) {
        await api.stickerStore.uninstall(pack.id);
        setPacks(prev => prev.map(p => p.id === pack.id ? { ...p, isInstalled: false } : p));
        if (previewPack && previewPack.id === pack.id) {
          setPreviewPack(prev => prev ? { ...prev, isInstalled: false } : null);
        }
      } else {
        await api.stickerStore.install(pack.id);
        setPacks(prev => prev.map(p => p.id === pack.id ? { ...p, isInstalled: true } : p));
        if (previewPack && previewPack.id === pack.id) {
          setPreviewPack(prev => prev ? { ...prev, isInstalled: true } : null);
        }
      }
      onPacksChanged?.();
    } catch (err) {
      setError(describeError(err));
    }
  };

  const handleOpenPreview = async (packId: string) => {
    try {
      const detail = await api.stickerStore.getPack(packId);
      setPreviewPack(detail);
    } catch (err) {
      setError(describeError(err));
    }
  };

  const handleNewVersion = async (packId: string) => {
    try {
      await api.stickerStore.newVersion(packId);
      setEditingPackId(packId);
    } catch (err) {
      setError(describeError(err));
    }
  };

  const handleDeletePack = async (packId: string) => {
    try {
      await api.stickerStore.deletePack(packId);
      fetchMyCreatedPacks();
      onPacksChanged?.();
    } catch (err) {
      setError(describeError(err));
    }
  };

  const handleApprove = async (packId: string) => {
    setActionLoading(packId);
    setError('');
    setActionSuccess('');
    try {
      await api.admin.stickerPacks.approve(packId);
      setActionSuccess(t('stickers.approvedSuccess'));
      setReviews(prev => prev.filter(p => p.id !== packId));
      if (previewPack && previewPack.id === packId) {
        setPreviewPack(prev => prev ? { ...prev, status: 'approved' } : null);
      }
      onPacksChanged?.();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setActionLoading(null);
    }
  };

  const handleStartReject = (pack: { id: string; name: string }) => {
    setRejectingPack(pack);
    setRejectReason('');
  };

  const handleConfirmReject = async () => {
    if (!rejectingPack) return;
    const packId = rejectingPack.id;
    setActionLoading(packId);
    setError('');
    setActionSuccess('');
    try {
      await api.admin.stickerPacks.reject(packId, rejectReason.trim() || undefined);
      setActionSuccess(t('stickers.rejectedSuccess'));
      setReviews(prev => prev.filter(p => p.id !== packId));
      if (previewPack && previewPack.id === packId) {
        setPreviewPack(prev => prev ? { ...prev, status: 'rejected', reviewNotes: rejectReason.trim() || null } : null);
      }
      setRejectingPack(null);
      setRejectReason('');
      onPacksChanged?.();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setActionLoading(null);
    }
  };

  const portalContainer = usePortalContainer();

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (rejectingPack) {
        setRejectingPack(null);
      } else if (previewPack) {
        setPreviewPack(null);
      } else {
        onClose();
      }
    }
  }, [onClose, previewPack, rejectingPack]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('stickers.store')}
      className="fixed inset-0 z-[500] flex items-center justify-center animate-fade-in"
      onMouseDown={e => e.stopPropagation()}
    >
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative w-full max-w-3xl h-[620px] max-h-[calc(calc(100*var(--app-vh))-2rem)] mx-4 glass-modal rounded-xl shadow-2xl flex flex-col overflow-hidden animate-slide-up">
        {/* Modal Top Bar */}
        <div className="flex items-center justify-between px-6 pt-4 pb-3 border-b border-border-soft">
          <div className="flex items-center gap-4">
            <h3 className="text-lg font-bold text-txt-primary flex items-center gap-2">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-accent-primary">
                <path d="m2 7 4.41-4.41A2 2 0 0 1 7.83 2h8.34a2 2 0 0 1 1.42.59L22 7" />
                <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
                <path d="M15 22v-4a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4" />
                <path d="M2 7h20" />
              </svg>
              {t('stickers.store')}
            </h3>

            {/* Navigation Tabs */}
            <div className="flex rounded-lg bg-surface-base/80 p-0.5 border border-border-soft">
              <button
                type="button"
                onClick={() => setActiveTab('explore')}
                className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${activeTab === 'explore' ? 'bg-surface-elevated text-txt-primary shadow-sm' : 'text-txt-tertiary hover:text-txt-primary'}`}
              >
                {t('stickers.explore')}
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('myPacks')}
                className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${activeTab === 'myPacks' ? 'bg-surface-elevated text-txt-primary shadow-sm' : 'text-txt-tertiary hover:text-txt-primary'}`}
              >
                {t('stickers.myPacks')}
              </button>
              {isAdmin && (
                <button
                  type="button"
                  onClick={() => setActiveTab('reviews')}
                  className={`flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-md transition-colors ${activeTab === 'reviews' ? 'bg-surface-elevated text-txt-primary shadow-sm' : 'text-txt-tertiary hover:text-txt-primary'}`}
                >
                  <span>{t('stickers.reviews')}</span>
                  {reviews.length > 0 && (
                    <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-accent-amber/20 text-accent-amber font-bold">
                      {reviews.length}
                    </span>
                  )}
                </button>
              )}
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-txt-tertiary hover:text-txt-primary hover:bg-interactive-hover transition-colors"
            aria-label={t('common:actions.close')}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Tab Content */}
        <div className="flex-1 overflow-y-auto p-6 scrollbar-thin">
          {error && (
            <div role="alert" className="mb-4 p-3 rounded-xl bg-accent-rose/10 border border-accent-rose/20 text-xs text-txt-danger">
              {error}
            </div>
          )}
          {actionSuccess && (
            <div role="status" className="mb-4 p-3 rounded-xl bg-accent-mint/10 border border-accent-mint/20 text-xs text-accent-mint flex items-center justify-between">
              <span>{actionSuccess}</span>
              <button type="button" onClick={() => setActionSuccess('')} className="text-accent-mint/70 hover:text-accent-mint font-bold">✕</button>
            </div>
          )}

          {activeTab === 'explore' ? (
            <div>
              {/* Search Bar */}
              <div className="relative mb-5">
                <svg
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-txt-tertiary"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <circle cx="11" cy="11" r="8" />
                  <path d="m21 21-4.35-4.35" />
                </svg>
                <input
                  type="search"
                  value={search}
                  onChange={e => {
                    setSearch(e.target.value);
                    fetchExplorePacks(e.target.value);
                  }}
                  placeholder={t('stickers.search')}
                  className="input-search w-full pl-9 pr-4 py-2 text-xs"
                />
              </div>

              {/* Packs Grid */}
              {loading ? (
                <div className="grid grid-cols-2 gap-4">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <div key={i} className="h-44 rounded-2xl bg-surface-base animate-pulse border border-border-soft" />
                  ))}
                </div>
              ) : packs.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-center text-txt-tertiary">
                  <p className="text-sm">{t('stickers.noPacks')}</p>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-4">
                  {packs.map(pack => (
                    <div
                      key={pack.id}
                      onClick={() => handleOpenPreview(pack.id)}
                      className="group cursor-pointer rounded-2xl border border-border-soft bg-surface-base/60 hover:bg-surface-base/90 p-3.5 transition-all flex flex-col justify-between hover:shadow-lg hover:border-border-hard"
                    >
                      <div>
                        {/* Cover image or placeholder */}
                        <div className="aspect-video w-full rounded-xl bg-surface-elevated/70 flex items-center justify-center mb-3 overflow-hidden border border-border-soft">
                          {pack.coverUrl ? (
                            <img src={stickerPreviewUrl(pack.coverUrl) || pack.coverUrl} alt={pack.name} className="h-full w-full object-contain p-2" loading="lazy" />
                          ) : (
                            <span className="text-2xl text-txt-tertiary">🎨</span>
                          )}
                        </div>

                        <div className="flex items-start justify-between gap-1 mb-1">
                          <h4 className="text-sm font-semibold text-txt-primary truncate">{pack.name}</h4>
                          {pack.originType === 'replica' && (
                            <span className="shrink-0 px-1.5 py-0.5 text-[10px] font-medium rounded-md bg-accent-lavender/10 text-accent-lavender border border-accent-lavender/20">
                              {t('stickers.replicaBadge')}
                            </span>
                          )}
                        </div>

                        {pack.description && (
                          <p className="text-xs text-txt-tertiary line-clamp-2 mb-2">{pack.description}</p>
                        )}
                      </div>

                      <div className="flex items-center justify-between pt-2 border-t border-border-soft/60 mt-2">
                        <span className="text-[11px] text-txt-tertiary">
                          {t('stickers.stickersCount', { count: pack.itemCount })}
                        </span>

                        <button
                          type="button"
                          onClick={e => handleToggleInstall(e, pack)}
                          className={pack.isInstalled ? 'sticker-secondary-button text-xs py-1 px-2.5' : 'sticker-primary-button text-xs py-1 px-2.5'}
                        >
                          {pack.isInstalled ? `✓ ${t('stickers.installed')}` : `+ ${t('stickers.install')}`}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : activeTab === 'myPacks' ? (
            <div>
              {/* Creator Packs Tab */}
              <div className="flex items-center justify-between mb-5">
                <p className="text-xs text-txt-tertiary">{t('stickers.collectionHint')}</p>
                <button
                  type="button"
                  onClick={() => setEditingPackId(null)}
                  className="sticker-primary-button text-xs"
                >
                  + {t('stickers.createPack')}
                </button>
              </div>

              {loading ? (
                <div className="space-y-3">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="h-20 rounded-xl bg-surface-base animate-pulse border border-border-soft" />
                  ))}
                </div>
              ) : myPacks.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-center text-txt-tertiary">
                  <p className="text-sm">{t('stickers.noPacks')}</p>
                  <button
                    type="button"
                    onClick={() => setEditingPackId(null)}
                    className="sticker-secondary-button mt-3 text-xs"
                  >
                    {t('stickers.createPack')}
                  </button>
                </div>
              ) : (
                <div className="space-y-3">
                  {myPacks.map(pack => (
                    <div
                      key={pack.id}
                      className="p-4 rounded-xl border border-border-soft bg-surface-base/60 flex flex-col gap-3"
                    >
                      <div className="flex items-center justify-between gap-4">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="h-12 w-12 shrink-0 rounded-lg bg-surface-elevated flex items-center justify-center overflow-hidden border border-border-soft">
                            {pack.coverUrl ? (
                              <img src={stickerPreviewUrl(pack.coverUrl) || pack.coverUrl} alt={pack.name} className="h-full w-full object-contain p-1" />
                            ) : (
                              <span className="text-lg">🎨</span>
                            )}
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <h4 className="text-sm font-semibold text-txt-primary truncate">{pack.name}</h4>
                              <span className={`px-2 py-0.5 text-[10px] font-medium rounded-full ${
                                pack.status === 'approved' || pack.status === 'active' ? 'bg-accent-mint/10 text-accent-mint border border-accent-mint/20' :
                                pack.status === 'pending_review' ? 'bg-accent-amber/10 text-accent-amber border border-accent-amber/20' :
                                pack.status === 'rejected' ? 'bg-accent-rose/10 text-accent-rose border border-accent-rose/20' :
                                'bg-surface-input text-txt-tertiary'
                              }`}>
                                {pack.status === 'approved' || pack.status === 'active' ? t('stickers.approved') :
                                 pack.status === 'pending_review' ? t('stickers.pendingReview') :
                                 pack.status === 'rejected' ? t('stickers.rejected') :
                                 t('stickers.draft')}
                              </span>
                            </div>
                            <p className="text-xs text-txt-tertiary truncate">
                              {/* i18n-check: allow-literal */}
                              v{pack.currentVersion} · {t('stickers.stickersCount', { count: pack.itemCount })}
                            </p>
                          </div>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            type="button"
                            onClick={() => handleOpenPreview(pack.id)}
                            className="sticker-secondary-button text-xs"
                          >
                            {t('stickers.viewStickers')}
                          </button>
                          {pack.status === 'approved' ? (
                            <button
                              type="button"
                              onClick={() => handleNewVersion(pack.id)}
                              className="sticker-secondary-button text-xs"
                            >
                              {t('stickers.newVersion')}
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setEditingPackId(pack.id)}
                              className="sticker-secondary-button text-xs"
                            >
                              {t('stickers.editPack')}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => handleDeletePack(pack.id)}
                            className="sticker-icon-button text-txt-danger hover:bg-accent-rose/10"
                            aria-label={t('stickers.deletePack')}
                          >
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                            </svg>
                          </button>
                        </div>
                      </div>

                      {pack.status === 'pending_review' && (
                        <div className="text-[11px] text-accent-amber/90 flex items-center gap-1.5 pl-1">
                          <span>⏳</span>
                          <span>{t('stickers.pendingReviewHint')}</span>
                        </div>
                      )}

                      {pack.status === 'rejected' && pack.reviewNotes && (
                        <div className="p-2.5 rounded-lg bg-accent-rose/10 border border-accent-rose/20 text-xs text-txt-danger">
                          <span className="font-semibold">{t('stickers.reviewNotes')}: </span>
                          <span>{pack.reviewNotes}</span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div>
              {/* Admin Reviews Tab */}
              {loading ? (
                <div className="space-y-3">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="h-24 rounded-xl bg-surface-base animate-pulse border border-border-soft" />
                  ))}
                </div>
              ) : reviews.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-center text-txt-tertiary">
                  <p className="text-sm">{t('stickers.noReviews')}</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {reviews.map(pack => (
                    <div
                      key={pack.id}
                      className="p-4 rounded-xl border border-border-soft bg-surface-base/60 flex flex-col justify-between gap-4"
                    >
                      <div className="flex items-start gap-3 min-w-0">
                        <div className="h-12 w-12 shrink-0 rounded-lg bg-surface-elevated flex items-center justify-center overflow-hidden border border-border-soft mt-0.5">
                          {pack.coverUrl ? (
                            <img src={stickerPreviewUrl(pack.coverUrl) || pack.coverUrl} alt={pack.name} className="h-full w-full object-contain p-1" />
                          ) : (
                            <span className="text-lg">🎨</span>
                          )}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <h4 className="text-sm font-semibold text-txt-primary truncate">{pack.name}</h4>
                            <span className="px-2 py-0.5 text-[10px] font-medium rounded-full bg-accent-amber/10 text-accent-amber border border-accent-amber/20">
                              {t('stickers.pendingReview')}
                            </span>
                          </div>
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-xs text-txt-tertiary">
                            <span>{t('stickers.creator')}: <strong className="text-txt-secondary font-medium">{pack.creatorName || '—'}</strong></span>
                            <span>•</span>
                            <span>{t('stickers.sourceInstance')}: <strong className="text-txt-secondary font-medium">{pack.sourceInstance || t('stickers.localInstance')}</strong></span>
                            <span>•</span>
                            {/* i18n-check: allow-literal */}
                            <span>v{pack.currentVersion} · {t('stickers.stickersCount', { count: pack.itemCount })}</span>
                          </div>
                          {pack.description && (
                            <p className="text-xs text-txt-secondary mt-1.5 line-clamp-2">{pack.description}</p>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0 self-end">
                        <button
                          type="button"
                          onClick={() => handleOpenPreview(pack.id)}
                          className="sticker-secondary-button text-xs"
                        >
                          {t('stickers.viewStickers')}
                        </button>
                        <button
                          type="button"
                          disabled={actionLoading === pack.id}
                          onClick={() => handleStartReject(pack)}
                          className="px-3 py-1.5 text-xs font-medium rounded-lg text-txt-danger bg-accent-rose/10 hover:bg-accent-rose/20 border border-accent-rose/20 transition-colors disabled:opacity-50"
                        >
                          {t('stickers.reject')}
                        </button>
                        <button
                          type="button"
                          disabled={actionLoading === pack.id}
                          onClick={() => handleApprove(pack.id)}
                          className="px-3 py-1.5 text-xs font-medium rounded-lg text-accent-mint bg-accent-mint/10 hover:bg-accent-mint/20 border border-accent-mint/20 transition-colors disabled:opacity-50"
                        >
                          {actionLoading === pack.id ? '…' : t('stickers.approve')}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Pack Preview Modal */}
      {previewPack && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-[510] flex items-center justify-center animate-fade-in"
          onMouseDown={e => e.stopPropagation()}
        >
          <div className="absolute inset-0 bg-black/60" onClick={() => setPreviewPack(null)} />
          <div className="relative w-full max-w-md mx-4 glass-modal rounded-xl shadow-2xl p-6 flex flex-col max-h-[calc(80*var(--app-vh))] animate-slide-up">
            <div className="flex items-start justify-between gap-3 mb-4">
              <div>
                <h4 className="text-base font-bold text-txt-primary">{previewPack.name}</h4>
                <div className="flex flex-wrap items-center gap-x-2 text-xs text-txt-tertiary mt-1">
                  <span>{t('stickers.creator')}: <strong className="text-txt-secondary font-medium">{previewPack.creatorName || '—'}</strong></span>
                  <span>•</span>
                  <span>{t('stickers.sourceInstance')}: <strong className="text-txt-secondary font-medium">{previewPack.sourceInstance || t('stickers.localInstance')}</strong></span>
                </div>
                {previewPack.description && (
                  <p className="text-xs text-txt-secondary mt-1.5">{previewPack.description}</p>
                )}
              </div>
              <button
                type="button"
                onClick={() => setPreviewPack(null)}
                className="p-1.5 rounded-lg text-txt-tertiary hover:text-txt-primary hover:bg-interactive-hover transition-colors"
                aria-label={t('common:actions.close')}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Sticker Grid Preview */}
            <div className="flex-1 overflow-y-auto grid grid-cols-4 gap-2 p-1 scrollbar-thin">
              {previewPack.items.map(item => (
                <div key={item.id} className="aspect-square rounded-xl bg-surface-base/60 p-2 flex items-center justify-center border border-border-soft">
                  <img src={stickerPreviewUrl(item.token) || stickerUrl(item.token) || item.token.replace(/^sticker:/, '')} alt={item.name} className="max-h-full max-w-full object-contain" />
                </div>
              ))}
            </div>

            <div className="flex justify-between items-center pt-4 border-t border-border-soft mt-4">
              <span className="text-xs text-txt-tertiary">
                {t('stickers.stickersCount', { count: previewPack.items.length })}
              </span>
              {isAdmin && (previewPack.status === 'pending_review' || reviews.some(r => r.id === previewPack.id)) ? (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={actionLoading === previewPack.id}
                    onClick={() => handleStartReject(previewPack)}
                    className="px-3 py-1.5 text-xs font-medium rounded-lg text-txt-danger bg-accent-rose/10 hover:bg-accent-rose/20 border border-accent-rose/20 transition-colors disabled:opacity-50"
                  >
                    {t('stickers.reject')}
                  </button>
                  <button
                    type="button"
                    disabled={actionLoading === previewPack.id}
                    onClick={() => handleApprove(previewPack.id)}
                    className="px-3 py-1.5 text-xs font-medium rounded-lg text-accent-mint bg-accent-mint/10 hover:bg-accent-mint/20 border border-accent-mint/20 transition-colors disabled:opacity-50"
                  >
                    {actionLoading === previewPack.id ? '…' : t('stickers.approve')}
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={e => handleToggleInstall(e, previewPack)}
                  className={previewPack.isInstalled ? 'sticker-secondary-button' : 'sticker-primary-button'}
                >
                  {previewPack.isInstalled ? `✓ ${t('stickers.installed')}` : `+ ${t('stickers.install')}`}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Reject Reason Modal */}
      {rejectingPack && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t('stickers.rejectTitle')}
          className="fixed inset-0 z-[520] flex items-center justify-center animate-fade-in"
          onMouseDown={e => e.stopPropagation()}
        >
          <div className="absolute inset-0 bg-black/60" onClick={() => setRejectingPack(null)} />
          <div className="relative w-full max-w-md mx-4 glass-modal rounded-xl shadow-2xl p-6 flex flex-col animate-slide-up">
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-base font-bold text-txt-primary flex items-center gap-2">
                <span className="text-accent-rose">⚠️</span>
                {t('stickers.rejectTitle')}
              </h4>
              <button
                type="button"
                onClick={() => setRejectingPack(null)}
                className="p-1 rounded-lg text-txt-tertiary hover:text-txt-primary transition-colors"
                aria-label={t('common:actions.close')}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </div>

            <p className="text-xs text-txt-secondary mb-3">
              {t('stickers.packName')}: <strong className="text-txt-primary">{rejectingPack.name}</strong>
            </p>

            <label className="block text-xs font-medium text-txt-secondary mb-1.5">
              {t('stickers.rejectReason')}
            </label>
            <textarea
              rows={4}
              value={rejectReason}
              onChange={e => setRejectReason(e.target.value)}
              placeholder={t('stickers.rejectPlaceholder')}
              className="w-full rounded-lg border border-border-soft bg-surface-base/80 p-2.5 text-xs text-txt-primary placeholder:text-txt-tertiary focus:border-accent-primary focus:outline-none resize-none mb-4"
              autoFocus
            />

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setRejectingPack(null)}
                className="sticker-secondary-button text-xs"
              >
                {t('common:actions.cancel')}
              </button>
              <button
                type="button"
                disabled={actionLoading === rejectingPack.id}
                onClick={handleConfirmReject}
                className="px-3.5 py-1.5 text-xs font-medium rounded-lg text-white bg-accent-rose hover:bg-accent-rose/90 transition-colors disabled:opacity-50"
              >
                {actionLoading === rejectingPack.id ? '…' : t('stickers.rejectConfirm')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Authoring / Edit Modal */}
      {editingPackId !== undefined && (
        <StickerPackManageModal
          packId={editingPackId}
          onClose={() => setEditingPackId(undefined)}
          onSaved={() => {
            fetchMyCreatedPacks();
            onPacksChanged?.();
          }}
        />
      )}
    </div>,
    portalContainer,
  );
}
