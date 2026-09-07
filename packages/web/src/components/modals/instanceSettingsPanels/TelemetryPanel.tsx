import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useUIStore } from '../../../stores/uiStore';
import { useFormatters, type Formatters } from '../../../i18n/formatters';
import { describeError } from '../../../i18n/errors';
import { Toggle } from '../../ui/Toggle';
import { PayloadPreview } from '../../telemetry/PayloadPreview';
import { HelloScene, type SceneMood } from '../../telemetry/scene/HelloScene';

/** What the ping contains and why, in the repository the instance runs. */
const DOC_URL = 'https://github.com/TheZwiss/backspace/blob/main/docs/systems/telemetry.md';

/**
 * Renders a bare `YYYY-MM-DD` UTC day as a date in the reader's language.
 * The day is built at local midnight rather than parsed as an instant, so a
 * reader west of UTC sees the day that was reported, not the one before it.
 * An unparseable value is shown as it came, rather than as "Invalid Date".
 */
function formatDay(day: string, f: Formatters): string {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!parts) return day;
  return f.formatLongDate(new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])).getTime());
}

/**
 * The first block of the telemetry id and nothing more. The full id is what
 * ties a row in the public archive to this instance, so the panel confirms
 * which one is in use without putting the whole thing on a screen.
 */
function maskId(id: string): string {
  const [first] = id.split('-');
  return `${first ?? id}…`;
}

/**
 * The panel's three states are the scene's three moods, so the artwork from
 * the ask carries straight over instead of being spent once and thrown away.
 *
 * `happy` is the beam lit, `farewell` is the pilot's arm lowered, and `idle`
 * is the pilot still waving because nobody has answered yet. That last one is
 * only reachable before the first answer: once an admin has said either word,
 * `enabled` is never null again.
 */
function moodFor(enabled: boolean | null): SceneMood {
  if (enabled === true) return 'happy';
  if (enabled === false) return 'farewell';
  return 'idle';
}

/**
 * The permanent home of the daily hello: the switch, what the instance last
 * did with it, the id it reports under, and the exact payload it would send
 * today. Everything here reads the home instance through the admin API; there
 * is no local copy of the setting, so what the panel shows is what the server
 * would send.
 */
export function TelemetryPanel() {
  const { t } = useTranslation(['telemetry', 'common']);
  const f = useFormatters();

  const telemetry = useSettingsStore((s) => s.telemetry);
  const preview = useSettingsStore((s) => s.telemetryPreview);
  const fetchTelemetry = useSettingsStore((s) => s.fetchTelemetry);
  const fetchTelemetryPreview = useSettingsStore((s) => s.fetchTelemetryPreview);
  const setTelemetryEnabled = useSettingsStore((s) => s.setTelemetryEnabled);
  const addToast = useUIStore((s) => s.addToast);

  const [loadError, setLoadError] = useState('');
  const [previewError, setPreviewError] = useState('');
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const loadStatus = useCallback(async () => {
    setLoadError('');
    try {
      await fetchTelemetry();
    } catch (err) {
      setLoadError(describeError(err));
    }
  }, [fetchTelemetry]);

  // The preview is built fresh on every request, so a failure here says
  // nothing about the setting itself and must not take the panel down with it.
  const loadPreview = useCallback(async () => {
    setPreviewError('');
    setRefreshing(true);
    try {
      await fetchTelemetryPreview();
    } catch (err) {
      setPreviewError(describeError(err));
    } finally {
      setRefreshing(false);
    }
  }, [fetchTelemetryPreview]);

  useEffect(() => {
    void loadStatus();
    void loadPreview();
  }, [loadStatus, loadPreview]);

  const handleToggle = useCallback(async (next: boolean) => {
    setSaving(true);
    try {
      await setTelemetryEnabled(next);
      // Turning it on mints a new id and turning it off clears it, so the
      // payload on screen would otherwise name an id that no longer applies.
      await loadPreview();
    } catch (err) {
      // The store only keeps what the server returned, so the switch stays
      // where the server has it and the admin is told why nothing moved.
      addToast(describeError(err), 'warning', 5000);
    } finally {
      setSaving(false);
    }
  }, [setTelemetryEnabled, loadPreview, addToast]);

  if (telemetry === null) {
    if (loadError) {
      return (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold text-txt-primary">{t('telemetry:panel.title')}</h2>
          <div className="rounded-lg bg-accent-rose/10 border border-accent-rose/20 p-3.5 text-sm text-txt-secondary">
            {loadError}
          </div>
          <button
            type="button"
            onClick={() => void loadStatus()}
            className="px-3 py-1.5 text-sm text-txt-secondary hover:text-txt-primary bg-white/[0.04] hover:bg-white/[0.08] rounded-lg transition-colors"
          >
            {t('common:actions.tryAgain')}
          </button>
        </div>
      );
    }
    return <div className="text-sm text-txt-tertiary">{t('common:states.loadingSettings')}</div>;
  }

  const statusLabel = telemetry.enabled === null
    ? t('telemetry:panel.status.never')
    : telemetry.enabled
      ? t('telemetry:panel.status.on')
      : t('telemetry:panel.status.off');

  const lastDayLabel = telemetry.lastDay === null
    ? t('telemetry:panel.status.none')
    : t('telemetry:panel.status.lastDay', { date: formatDay(telemetry.lastDay, f) });

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-txt-primary">{t('telemetry:panel.title')}</h2>
        <div className="text-xs text-txt-tertiary mt-1">{t('telemetry:panel.intro')}</div>
      </div>

      {/*
        The scene and the switch are one object rather than two stacked ones.
        Flipping the switch changes the picture immediately above it, which is
        what makes the beam retracting read as a consequence of the click; the
        same artwork sitting elsewhere on the panel would just be decoration.

        5:2 with `slice`: the composition is 3:2, so a banner this wide crops
        the void away at top and bottom and keeps the whole ship. The scene is
        aria-hidden and carries no text, so nothing here is the only copy of
        anything - statusLabel below still says the state in words.
      */}
      <div className="rounded-lg bg-white/[0.02] overflow-hidden">
        <div className="aspect-[5/2] bg-surface-base">
          <HelloScene mood={moodFor(telemetry.enabled)} preserveAspectRatio="xMidYMid slice" />
        </div>
        <div className="flex items-center justify-between gap-4 p-3.5">
          <div>
            <div className="text-sm font-medium text-txt-primary">{t('telemetry:panel.toggle')}</div>
            <div className="text-xs text-txt-tertiary mt-0.5">{statusLabel}</div>
          </div>
          <Toggle
            enabled={telemetry.enabled === true}
            onChange={(next) => void handleToggle(next)}
            disabled={saving}
            ariaLabel={t('telemetry:panel.toggle')}
          />
        </div>
      </div>

      {/* What it has done so far */}
      <div className="rounded-lg bg-white/[0.03] border border-white/[0.04] p-3.5 space-y-1">
        <div className="text-xs text-txt-tertiary">{lastDayLabel}</div>
        {telemetry.lastError !== null && (
          <div className="text-xs text-txt-danger">
            {t('telemetry:panel.status.error', {
              date: formatDay(telemetry.lastError.day, f),
              status: telemetry.lastError.status,
            })}
          </div>
        )}
        {telemetry.id !== null && (
          <div className="text-xs text-txt-tertiary">
            {t('telemetry:panel.status.id', { id: maskId(telemetry.id) })}
          </div>
        )}
      </div>

      {/* The real payload, not a description of one */}
      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">
          {t('telemetry:panel.previewTitle')}
        </div>
        <div className="rounded-lg bg-white/[0.02] p-3.5 space-y-2">
          <PayloadPreview preview={preview} defaultOpen />
          {previewError && <p className="text-xs text-txt-danger">{previewError}</p>}
          <button
            type="button"
            onClick={() => void loadPreview()}
            disabled={refreshing}
            className="px-3 py-1.5 text-sm text-txt-secondary hover:text-txt-primary bg-white/[0.04] hover:bg-white/[0.08] rounded-lg transition-colors disabled:opacity-50"
          >
            {t('telemetry:panel.refreshPreview')}
          </button>
        </div>
      </div>

      <a
        href={DOC_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-block text-xs text-accent-primary hover:underline"
      >
        {t('telemetry:panel.learnMore')}
      </a>
    </div>
  );
}
