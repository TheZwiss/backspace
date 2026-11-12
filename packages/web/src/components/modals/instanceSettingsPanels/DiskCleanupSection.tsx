import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DiskPressureStatus } from '@backspace/shared';
import { api } from '../../../api/client';
import { describeError } from '../../../i18n/errors';
import { useFormatters } from '../../../i18n/formatters';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useUIStore } from '../../../stores/uiStore';
import { Toggle } from '../../ui/Toggle';

/** The bounds the server enforces (`routes/settings.ts`), mirrored so the form can say what is wrong before a request. */
export const DISK_THRESHOLD_MIN = 50;
export const DISK_THRESHOLD_MAX = 99;
export const DISK_TARGET_MIN = 10;
export const DISK_TARGET_GAP = 5;
export const DISK_AGE_MIN_DAYS = 1;
export const DISK_AGE_MAX_DAYS = 3650;

interface DiskDraft {
  threshold: string;
  target: string;
  age: string;
}

function toInt(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isInteger(value) ? value : null;
}

export type DiskDraftProblem = 'threshold' | 'target' | 'age' | null;

/** The first field of a draft the server would refuse, or null when it is acceptable. */
export function diskDraftProblem(draft: DiskDraft): DiskDraftProblem {
  const threshold = toInt(draft.threshold);
  if (threshold === null || threshold < DISK_THRESHOLD_MIN || threshold > DISK_THRESHOLD_MAX) return 'threshold';
  const target = toInt(draft.target);
  if (target === null || target < DISK_TARGET_MIN || target > threshold - DISK_TARGET_GAP) return 'target';
  const age = toInt(draft.age);
  if (age === null || age < DISK_AGE_MIN_DAYS || age > DISK_AGE_MAX_DAYS) return 'age';
  return null;
}

/**
 * Settings > Storage > Automatic cleanup. The owner decides here whether the
 * instance frees space by itself when the disk fills up, and how far it may go:
 * first unreferenced files, then old chat attachments (never newer than the
 * floor). The work is done by `server/src/utils/diskPressure.ts`.
 */
export function DiskCleanupSection() {
  const { t } = useTranslation(['admin', 'common']);
  const f = useFormatters();
  const addToast = useUIStore((s) => s.addToast);
  const instanceSettings = useSettingsStore((s) => s.instanceSettings);
  const updateInstanceSettings = useSettingsStore((s) => s.updateInstanceSettings);

  const [status, setStatus] = useState<DiskPressureStatus | null>(null);
  const [draft, setDraft] = useState<DiskDraft>({ threshold: '90', target: '80', age: '30' });
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkNote, setCheckNote] = useState('');

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await api.admin.diskStatus());
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    if (!instanceSettings) return;
    setDraft({
      threshold: String(instanceSettings.diskCleanupThresholdPercent),
      target: String(instanceSettings.diskCleanupTargetPercent),
      age: String(instanceSettings.diskCleanupMinAgeDays),
    });
  }, [instanceSettings]);

  if (!instanceSettings) return null;

  const enabled = instanceSettings.diskCleanupEnabled;
  const problem = diskDraftProblem(draft);
  const threshold = toInt(draft.threshold);
  const dirty =
    draft.threshold !== String(instanceSettings.diskCleanupThresholdPercent)
    || draft.target !== String(instanceSettings.diskCleanupTargetPercent)
    || draft.age !== String(instanceSettings.diskCleanupMinAgeDays);

  const onToggle = async (next: boolean) => {
    setToggling(true);
    try {
      await updateInstanceSettings({ diskCleanupEnabled: next });
      await refreshStatus();
    } catch (err) {
      addToast(describeError(err), 'warning');
    } finally {
      setToggling(false);
    }
  };

  const onSave = async () => {
    if (problem !== null) return;
    setSaving(true);
    try {
      await updateInstanceSettings({
        diskCleanupThresholdPercent: Number(draft.threshold),
        diskCleanupTargetPercent: Number(draft.target),
        diskCleanupMinAgeDays: Number(draft.age),
      });
      addToast(t('admin:storage.diskCleanup.saved'), 'success');
      await refreshStatus();
    } catch (err) {
      addToast(describeError(err), 'warning');
    } finally {
      setSaving(false);
    }
  };

  const onCheckNow = async () => {
    setChecking(true);
    setCheckNote('');
    try {
      const { run, status: next } = await api.admin.diskSweep();
      setStatus(next);
      setCheckNote(run ? '' : t('admin:storage.diskCleanup.checkedNothing'));
    } catch (err) {
      addToast(describeError(err), 'warning');
    } finally {
      setChecking(false);
    }
  };

  const used = status?.usedPercent ?? null;
  const lastRun = status?.lastRun ?? null;

  return (
    <div>
      <div className="text-ui-caption font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">
        {t('admin:storage.diskCleanup.label')}
      </div>
      <div className="rounded-lg bg-wash/[0.02] p-3.5 space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="text-sm text-txt-primary">{t('admin:storage.diskCleanup.enable')}</div>
            <div className="text-xs text-txt-tertiary mt-0.5">{t('admin:storage.diskCleanup.enableHint')}</div>
          </div>
          <div className={toggling ? 'opacity-50 pointer-events-none' : ''}>
            <Toggle enabled={enabled} onChange={(next) => void onToggle(next)} />
          </div>
        </div>

        {enabled && (
          <div className="p-2 rounded text-xs bg-accent-amber/10 border border-accent-amber/30 text-accent-amber">
            {t('admin:storage.diskCleanup.warning', { days: instanceSettings.diskCleanupMinAgeDays })}
          </div>
        )}

        {/* Live disk usage, with the threshold marked on the bar */}
        <div>
          {used === null ? (
            <div className="text-xs text-txt-tertiary">{t('admin:storage.diskCleanup.usageUnknown')}</div>
          ) : (
            <>
              <div className="flex items-baseline justify-between text-xs text-txt-secondary mb-1">
                <span>
                  {t('admin:storage.diskCleanup.usage', {
                    percent: f.formatNumber(used),
                    used: f.formatBytes(status?.usedBytes ?? 0),
                    total: f.formatBytes(status?.totalBytes ?? 0),
                  })}
                </span>
              </div>
              <div
                className="relative h-2 rounded-full bg-surface-input overflow-hidden"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(used)}
                aria-label={t('admin:storage.diskCleanup.usageLabel')}
              >
                <div
                  className={`h-full rounded-full ${used >= (status?.thresholdPercent ?? 90) ? 'bg-accent-rose' : 'bg-accent-primary'}`}
                  style={{ width: `${Math.min(100, Math.max(0, used))}%` }}
                />
                <div
                  className="absolute top-0 bottom-0 w-px bg-txt-primary/60"
                  style={{ left: `${status?.thresholdPercent ?? 90}%` }}
                  aria-hidden="true"
                />
              </div>
            </>
          )}
        </div>

        <div className="grid grid-cols-1 desktop:grid-cols-3 gap-3 pt-3 border-t border-wash/[0.04]">
          <label className="block text-xs text-txt-secondary">
            {t('admin:storage.diskCleanup.threshold')}
            <div className="mt-1 flex items-center gap-1.5">
              <input
                type="number"
                inputMode="numeric"
                min={DISK_THRESHOLD_MIN}
                max={DISK_THRESHOLD_MAX}
                value={draft.threshold}
                onChange={(e) => setDraft({ ...draft, threshold: e.target.value })}
                className="input-standard w-20 px-2 py-1 text-sm text-center"
                aria-invalid={problem === 'threshold'}
              />
              <span className="text-txt-tertiary">%</span>
            </div>
          </label>
          <label className="block text-xs text-txt-secondary">
            {t('admin:storage.diskCleanup.target')}
            <div className="mt-1 flex items-center gap-1.5">
              <input
                type="number"
                inputMode="numeric"
                min={DISK_TARGET_MIN}
                max={threshold !== null ? threshold - DISK_TARGET_GAP : undefined}
                value={draft.target}
                onChange={(e) => setDraft({ ...draft, target: e.target.value })}
                className="input-standard w-20 px-2 py-1 text-sm text-center"
                aria-invalid={problem === 'target'}
              />
              <span className="text-txt-tertiary">%</span>
            </div>
          </label>
          <label className="block text-xs text-txt-secondary">
            {t('admin:storage.diskCleanup.minAge')}
            <div className="mt-1 flex items-center gap-1.5">
              <input
                type="number"
                inputMode="numeric"
                min={DISK_AGE_MIN_DAYS}
                max={DISK_AGE_MAX_DAYS}
                value={draft.age}
                onChange={(e) => setDraft({ ...draft, age: e.target.value })}
                className="input-standard w-20 px-2 py-1 text-sm text-center"
                aria-invalid={problem === 'age'}
              />
              <span className="text-txt-tertiary">{t('admin:storage.diskCleanup.days')}</span>
            </div>
          </label>
        </div>

        {problem !== null && (
          <div className="text-xs text-txt-danger">
            {problem === 'threshold' && t('admin:storage.diskCleanup.problemThreshold', { min: DISK_THRESHOLD_MIN, max: DISK_THRESHOLD_MAX })}
            {problem === 'target' && t('admin:storage.diskCleanup.problemTarget', { min: DISK_TARGET_MIN, max: (threshold ?? DISK_THRESHOLD_MAX) - DISK_TARGET_GAP })}
            {problem === 'age' && t('admin:storage.diskCleanup.problemAge', { min: DISK_AGE_MIN_DAYS, max: DISK_AGE_MAX_DAYS })}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void onSave()}
            disabled={!dirty || saving || problem !== null}
            className="ui-button ui-button-primary transition-colors disabled:opacity-50"
          >
            {saving ? t('common:states.saving') : t('common:actions.save')}
          </button>
          <button
            type="button"
            onClick={() => void onCheckNow()}
            disabled={!enabled || checking || dirty}
            className="ui-button transition-colors disabled:opacity-50"
          >
            {checking ? t('admin:storage.diskCleanup.checking') : t('admin:storage.diskCleanup.checkNow')}
          </button>
        </div>

        {checkNote && <div className="text-xs text-txt-tertiary">{checkNote}</div>}

        <div className="text-xs text-txt-tertiary">
          {lastRun
            ? t('admin:storage.diskCleanup.lastRun', {
                when: f.formatDateTime(lastRun.at),
                before: f.formatNumber(lastRun.usedPercentBefore),
                after: f.formatNumber(lastRun.usedPercentAfter),
                count: lastRun.deletedFiles,
                size: f.formatBytes(lastRun.freedBytes),
                stage: t(`admin:storage.diskCleanup.stage.${lastRun.stage}`),
              })
            : t('admin:storage.diskCleanup.neverRan')}
        </div>
      </div>
    </div>
  );
}
