import { useState, useEffect, useCallback } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { useFormatters } from '../../../i18n/formatters';
import { describeError } from '../../../i18n/errors';
import { api } from '../../../api/client';
import type { StorageStats, CleanupResult } from '@backspace/shared';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useUIStore } from '../../../stores/uiStore';

type UploadUnit = 'MB' | 'GB';

// Render a number with up to 3 decimals, trimming trailing zeros. 1.5 → "1.5", 5 → "5", 0.098 → "0.098".
function formatUnitValue(n: number): string {
  return Number(n.toFixed(3)).toString();
}

function parseDisplayMb(input: string, unit: UploadUnit): number | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return null;
  const mb = unit === 'GB' ? Math.round(n * 1024) : Math.round(n);
  return Number.isInteger(mb) && mb >= 1 ? mb : null;
}

export function StoragePanel() {
  const { t } = useTranslation(['admin', 'common']);
  const f = useFormatters();
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const addToast = useUIStore((s) => s.addToast);
  const [cleanupResult, setCleanupResult] = useState<CleanupResult | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [previewDone, setPreviewDone] = useState(false);

  // Upload limit state
  const instanceSettings = useSettingsStore((s) => s.instanceSettings);
  const updateInstanceSettings = useSettingsStore((s) => s.updateInstanceSettings);
  const [uploadUnit, setUploadUnit] = useState<UploadUnit>('MB');
  const [uploadLimitInput, setUploadLimitInput] = useState<string>('100');
  const [uploadLimitSaving, setUploadLimitSaving] = useState(false);

  // Media retention state
  const [mediaAgeDays, setMediaAgeDays] = useState(90);
  const [mediaCleanupResult, setMediaCleanupResult] = useState<CleanupResult | null>(null);
  const [mediaCleaning, setMediaCleaning] = useState(false);
  const [mediaPreviewDone, setMediaPreviewDone] = useState(false);

  // Stale tus session cleanup state
  const [tusMaxAgeHours, setTusMaxAgeHours] = useState(1);
  const [tusCleanupResult, setTusCleanupResult] = useState<CleanupResult | null>(null);
  const [tusCleaning, setTusCleaning] = useState(false);
  const [tusPreviewDone, setTusPreviewDone] = useState(false);

  const fetchStats = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const data = await api.admin.storageStats();
      setStats(data);
    } catch (err) {
      setLoadError(err instanceof Error ? describeError(err) : t('admin:storage.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  useEffect(() => {
    const mb = instanceSettings?.maxUploadSizeMb;
    if (typeof mb === 'number' && mb > 0) {
      const unit: UploadUnit = mb >= 1024 ? 'GB' : 'MB';
      setUploadUnit(unit);
      setUploadLimitInput(unit === 'GB' ? formatUnitValue(mb / 1024) : String(mb));
    }
  }, [instanceSettings]);

  const parsedUploadMb = parseDisplayMb(uploadLimitInput, uploadUnit);
  const uploadLimitDirty = parsedUploadMb !== null && parsedUploadMb !== instanceSettings?.maxUploadSizeMb;

  const handleUploadUnitChange = (next: UploadUnit) => {
    if (next === uploadUnit) return;
    const n = Number(uploadLimitInput.trim());
    if (Number.isFinite(n) && n > 0) {
      setUploadLimitInput(next === 'GB' ? formatUnitValue(n / 1024) : String(Math.round(n * 1024)));
    }
    setUploadUnit(next);
  };

  const handleUploadLimitSave = async () => {
    if (parsedUploadMb === null) return;
    const mb = parsedUploadMb;
    setUploadLimitSaving(true);
    try {
      await updateInstanceSettings({ maxUploadSizeMb: mb });
      addToast(t('admin:storage.uploadLimit.saved', { limit: f.formatBytes(mb * 1024 * 1024) }), 'success');
    } catch {
      addToast(t('admin:storage.uploadLimit.saveFailed'), 'warning');
    } finally {
      setUploadLimitSaving(false);
    }
  };

  const handleMediaCleanup = async (dryRun: boolean) => {
    setMediaCleaning(true);
    setMediaCleanupResult(null);
    try {
      const result = await api.admin.cleanupOldMedia(mediaAgeDays, dryRun);
      setMediaCleanupResult(result);
      if (dryRun) {
        setMediaPreviewDone(true);
      } else {
        setMediaPreviewDone(false);
        addToast(t('admin:storage.media.deletedToast', { count: result.deletedFiles, size: f.formatBytes(result.freedBytes) }), 'success');
        await fetchStats();
      }
    } catch (err) {
      addToast(err instanceof Error ? describeError(err) : t('admin:storage.media.failed'), 'warning');
    } finally {
      setMediaCleaning(false);
    }
  };

  const handleTusCleanup = async (dryRun: boolean) => {
    if (!Number.isFinite(tusMaxAgeHours) || tusMaxAgeHours <= 0) return;
    setTusCleaning(true);
    setTusCleanupResult(null);
    try {
      const result = await api.admin.cleanupTusSessions(tusMaxAgeHours, dryRun);
      setTusCleanupResult(result);
      if (dryRun) {
        setTusPreviewDone(true);
      } else {
        setTusPreviewDone(false);
        addToast(t('admin:storage.stale.cleanedToast', { count: result.deletedFiles, size: f.formatBytes(result.freedBytes) }), 'success');
        await fetchStats();
      }
    } catch (err) {
      addToast(err instanceof Error ? describeError(err) : t('admin:storage.stale.failed'), 'warning');
    } finally {
      setTusCleaning(false);
    }
  };

  const handleCleanup = async (dryRun: boolean) => {
    setCleaning(true);
    setCleanupResult(null);
    try {
      const result = await api.admin.storageCleanup(dryRun);
      setCleanupResult(result);
      if (dryRun) {
        setPreviewDone(true);
      } else {
        setPreviewDone(false);
        addToast(t('admin:storage.cleanup.cleanedToast', { count: result.deletedFiles, size: f.formatBytes(result.freedBytes) }), 'success');
        await fetchStats();
      }
    } catch (err) {
      addToast(err instanceof Error ? describeError(err) : t('admin:storage.cleanup.failed'), 'warning');
    } finally {
      setCleaning(false);
    }
  };

  if (loading) {
    return <div className="text-sm text-txt-tertiary">{t('admin:storage.loading')}</div>;
  }

  if (loadError && !stats) {
    return (
      <div className="space-y-3">
        <div className="p-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-sm">{loadError}</div>
        <button onClick={fetchStats} className="text-sm text-accent-primary hover:underline">{t('common:actions.retry')}</button>
      </div>
    );
  }

  if (!stats) return null;

  const hasOrphans = stats.orphanedFiles > 0 || stats.unlinkedAttachments > 0 || stats.danglingAttachments > 0;

  return (
    <div className="space-y-5">
      <h2 className="text-lg font-semibold text-txt-primary">{t('admin:storage.title')}</h2>
      <div className="text-xs text-txt-tertiary">
        {t('admin:storage.description')}
      </div>

      {/* Storage Overview */}
      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">{t('admin:storage.overview.label')}</div>
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-lg bg-white/[0.02] p-3.5">
            <div className="text-xs text-txt-tertiary mb-0.5">{t('admin:storage.overview.totalFiles')}</div>
            <div className="text-lg font-semibold text-txt-primary">{f.formatNumber(stats.totalFiles)}</div>
            <div className="text-xs text-txt-tertiary">{f.formatBytes(stats.totalSize)}</div>
          </div>
          <div className="rounded-lg bg-white/[0.02] p-3.5">
            <div className="text-xs text-txt-tertiary mb-0.5">{t('admin:storage.overview.referenced')}</div>
            <div className="text-lg font-semibold text-txt-primary">{f.formatNumber(stats.referencedFiles)}</div>
            <div className="text-xs text-txt-tertiary">{f.formatBytes(stats.referencedSize)}</div>
          </div>
          <div className="rounded-lg bg-white/[0.02] p-3.5">
            <div className="text-xs text-txt-tertiary mb-0.5">{t('admin:storage.overview.orphanedFiles')}</div>
            <div className={`text-lg font-semibold ${stats.orphanedFiles > 0 ? 'text-accent-amber' : 'text-txt-primary'}`}>
              {f.formatNumber(stats.orphanedFiles)}
            </div>
            <div className="text-xs text-txt-tertiary">{f.formatBytes(stats.orphanedSize)}</div>
          </div>
          <div className="rounded-lg bg-white/[0.02] p-3.5">
            <div className="text-xs text-txt-tertiary mb-0.5">{t('admin:storage.overview.unlinkedUploads')}</div>
            <div className={`text-lg font-semibold ${stats.unlinkedAttachments > 0 ? 'text-accent-amber' : 'text-txt-primary'}`}>
              {f.formatNumber(stats.unlinkedAttachments)}
            </div>
            <div className="text-xs text-txt-tertiary">{f.formatBytes(stats.unlinkedSize)}</div>
          </div>
          <div className="rounded-lg bg-white/[0.02] p-3.5">
            <div className="text-xs text-txt-tertiary mb-0.5">{t('admin:storage.overview.danglingRecords')}</div>
            <div className={`text-lg font-semibold ${stats.danglingAttachments > 0 ? 'text-accent-amber' : 'text-txt-primary'}`}>
              {f.formatNumber(stats.danglingAttachments)}
            </div>
            <div className="text-xs text-txt-tertiary">{f.formatBytes(stats.danglingSize)}</div>
          </div>
          <div className="rounded-lg bg-white/[0.02] p-3.5">
            <div className="text-xs text-txt-tertiary mb-0.5">{t('admin:storage.overview.staleUploads')}</div>
            <div className={`text-lg font-semibold ${stats.staleTusSessions > 0 ? 'text-accent-amber' : 'text-txt-primary'}`}>
              {f.formatNumber(stats.staleTusSessions)}
            </div>
            <div className="text-xs text-txt-tertiary">{f.formatBytes(stats.staleTusSize)}</div>
          </div>
        </div>
      </div>

      {/* File Type Breakdown */}
      {stats.breakdown.length > 0 && (
        <div>
          <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">{t('admin:storage.breakdown.label')}</div>
          <div className="rounded-lg bg-white/[0.02] p-3.5">
            <div className="space-y-1.5">
              {stats.breakdown.map((b) => (
                <div key={b.type} className="flex items-center justify-between text-sm">
                  <span className="text-txt-secondary capitalize">{b.type}</span>
                  <span className="text-txt-tertiary">
                    {t('admin:storage.breakdown.entry', { count: b.count, size: f.formatBytes(b.size) })}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Upload Limit */}
      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">{t('admin:storage.uploadLimit.label')}</div>
        <div className="rounded-lg bg-white/[0.02] p-3.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <label className="text-sm text-txt-secondary whitespace-nowrap">{t('admin:storage.uploadLimit.maxFileSize')}</label>
            <div className="flex items-center gap-3">
              <input
                type="number"
                min={uploadUnit === 'GB' ? 0.001 : 1}
                step={uploadUnit === 'GB' ? 0.5 : 1}
                value={uploadLimitInput}
                onChange={(e) => setUploadLimitInput(e.target.value)}
                className="input-standard w-24 px-2 py-1 text-sm text-center"
              />
              <div className="flex items-center gap-0.5 rounded-lg bg-surface-input p-0.5">
                {(['MB', 'GB'] as const).map((u) => (
                  <button
                    key={u}
                    type="button"
                    onClick={() => handleUploadUnitChange(u)}
                    className={`px-2.5 py-1 rounded text-[12px] font-medium transition-colors ${
                      uploadUnit === u
                        ? 'bg-accent-primary text-white'
                        : 'text-txt-tertiary hover:text-txt-primary'
                    }`}
                  >
                    {u}
                  </button>
                ))}
              </div>
            </div>
            <button
              onClick={handleUploadLimitSave}
              disabled={!uploadLimitDirty || uploadLimitSaving || parsedUploadMb === null}
              className="px-3 py-1 bg-accent-primary hover:bg-accent-primary/80 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50 ml-auto"
            >
              {uploadLimitSaving ? t('common:states.saving') : t('common:actions.save')}
            </button>
          </div>
        </div>
      </div>

      {/* Cleanup Actions */}
      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">{t('admin:storage.cleanup.label')}</div>
        <div className="rounded-lg bg-white/[0.02] p-3.5 space-y-3">
          {!hasOrphans && (
            <div className="text-sm text-txt-tertiary">{t('admin:storage.cleanup.nothingFound')}</div>
          )}

          {hasOrphans && (
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => handleCleanup(true)}
                disabled={cleaning}
                className="px-3 py-1.5 bg-white/[0.06] hover:bg-white/[0.1] text-txt-secondary text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
              >
                {cleaning ? t('admin:shared.scanning') : t('admin:storage.cleanup.preview')}
              </button>
              <button
                onClick={() => handleCleanup(false)}
                disabled={cleaning || !previewDone}
                className="px-3 py-1.5 bg-accent-rose hover:bg-accent-rose/80 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
              >
                {cleaning ? t('admin:storage.cleanup.running') : t('admin:storage.cleanup.run')}
              </button>
            </div>
          )}

          {cleanupResult && (
            <div className={`p-2 rounded text-sm ${
              cleanupResult.dryRun
                ? 'bg-accent-amber/10 border border-accent-amber/30 text-accent-amber'
                : 'bg-status-online/10 border border-status-online/30 text-status-online'
            }`}>
              <div className="font-medium mb-1">
                {cleanupResult.dryRun ? t('admin:storage.cleanup.previewResult') : t('admin:storage.cleanup.complete')}
              </div>
              <div>
                {t('admin:storage.cleanup.orphanedFiles', { count: cleanupResult.deletedFiles, size: f.formatBytes(cleanupResult.freedBytes) })}
                {cleanupResult.deletedAttachmentRecords > 0 && (
                  t('admin:storage.cleanup.staleRecords', { count: cleanupResult.deletedAttachmentRecords })
                )}
              </div>
              {cleanupResult.errors.length > 0 && (
                <div className="mt-1 text-txt-danger">
                  {t('admin:storage.cleanup.errors', { count: cleanupResult.errors.length, first: cleanupResult.errors[0] })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Stale Uploads */}
      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">{t('admin:storage.stale.label')}</div>
        <div className="rounded-lg bg-white/[0.02] p-3.5 space-y-3">
          <div className="text-xs text-txt-tertiary">
            <Trans
              t={t}
              i18nKey="admin:storage.stale.description"
              components={{ code: <code className="text-txt-secondary" /> }}
            />
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <label className="text-sm text-txt-secondary whitespace-nowrap">{t('admin:storage.stale.maxAge')}</label>
            <input
              type="number"
              min={0.5}
              step={0.5}
              value={tusMaxAgeHours}
              onChange={(e) => {
                const next = Number(e.target.value);
                setTusMaxAgeHours(Number.isFinite(next) && next > 0 ? next : 0);
                setTusPreviewDone(false);
                setTusCleanupResult(null);
              }}
              className="input-standard w-24 px-2 py-1 text-sm text-center"
            />
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => handleTusCleanup(true)}
              disabled={tusCleaning || tusMaxAgeHours <= 0}
              className="px-3 py-1.5 bg-white/[0.06] hover:bg-white/[0.1] text-txt-secondary text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
            >
              {tusCleaning ? t('admin:shared.scanning') : t('admin:storage.cleanup.preview')}
            </button>
            <button
              onClick={() => handleTusCleanup(false)}
              disabled={tusCleaning || !tusPreviewDone}
              className="px-3 py-1.5 bg-accent-rose hover:bg-accent-rose/80 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
            >
              {tusCleaning ? t('admin:storage.cleanup.running') : t('admin:storage.cleanup.run')}
            </button>
          </div>

          {tusCleanupResult && (
            <div className={`p-2 rounded text-sm ${
              tusCleanupResult.dryRun
                ? 'bg-accent-amber/10 border border-accent-amber/30 text-accent-amber'
                : 'bg-status-online/10 border border-status-online/30 text-status-online'
            }`}>
              <div className="font-medium mb-1">
                {tusCleanupResult.dryRun ? t('admin:storage.cleanup.previewResult') : t('admin:storage.cleanup.complete')}
              </div>
              <div>
                {t('admin:storage.stale.sessionFiles', { count: tusCleanupResult.deletedFiles, size: f.formatBytes(tusCleanupResult.freedBytes) })}
              </div>
              {tusCleanupResult.errors.length > 0 && (
                <div className="mt-1 text-txt-danger">
                  {t('admin:storage.cleanup.errors', { count: tusCleanupResult.errors.length, first: tusCleanupResult.errors[0] })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Media Retention */}
      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">{t('admin:storage.media.label')}</div>
        <div className="rounded-lg bg-white/[0.02] p-3.5 space-y-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <label className="text-sm text-txt-secondary whitespace-nowrap">{t('admin:storage.media.olderThan')}</label>
            <div className="flex items-center gap-3">
              <input
                type="number"
                min={1}
                value={mediaAgeDays}
                onChange={(e) => { setMediaAgeDays(Number(e.target.value)); setMediaPreviewDone(false); setMediaCleanupResult(null); }}
                className="input-standard w-20 px-2 py-1 text-sm text-center"
              />
              <span className="text-sm text-txt-tertiary">{t('admin:storage.media.days')}</span>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => handleMediaCleanup(true)}
              disabled={mediaCleaning || mediaAgeDays < 1}
              className="px-3 py-1.5 bg-white/[0.06] hover:bg-white/[0.1] text-txt-secondary text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
            >
              {mediaCleaning ? t('admin:shared.scanning') : t('admin:storage.media.preview')}
            </button>
            <button
              onClick={() => handleMediaCleanup(false)}
              disabled={mediaCleaning || !mediaPreviewDone}
              className="px-3 py-1.5 bg-accent-rose hover:bg-accent-rose/80 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
            >
              {mediaCleaning ? t('admin:storage.media.running') : t('admin:storage.media.run')}
            </button>
          </div>

          {mediaCleanupResult && (
            <div className={`p-2 rounded text-sm ${
              mediaCleanupResult.dryRun
                ? 'bg-accent-amber/10 border border-accent-amber/30 text-accent-amber'
                : 'bg-status-online/10 border border-status-online/30 text-status-online'
            }`}>
              <div className="font-medium mb-1">
                {mediaCleanupResult.dryRun ? t('admin:storage.cleanup.previewResult') : t('admin:storage.cleanup.complete')}
              </div>
              <div>
                {t('admin:storage.media.files', { count: mediaCleanupResult.deletedFiles, size: f.formatBytes(mediaCleanupResult.freedBytes) })}
              </div>
              {mediaCleanupResult.errors.length > 0 && (
                <div className="mt-1 text-txt-danger">
                  {t('admin:storage.cleanup.errors', { count: mediaCleanupResult.errors.length, first: mediaCleanupResult.errors[0] })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <button
        onClick={() => { setCleanupResult(null); setPreviewDone(false); fetchStats(); }}
        className="text-sm text-accent-primary hover:underline"
      >
        {t('admin:storage.refresh')}
      </button>
    </div>
  );
}
