import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useFormatters } from '../../../i18n/formatters';
import { describeError } from '../../../i18n/errors';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useUIStore } from '../../../stores/uiStore';
import type { InstanceStreamingLimits } from '@backspace/shared';
import { Toggle } from '../../ui/Toggle';
import {
  STANDARD_RESOLUTIONS, STANDARD_FRAMERATES,
  ALL_RESOLUTIONS, RESOLUTION_LABELS,
  HIGH_END_RESOLUTION_THRESHOLD, HIGH_END_FRAMERATE_THRESHOLD,
  BITRATE_MATRIX_KBPS,
  type Resolution,
} from '@backspace/shared/src/constants';

export function StreamingPanel() {
  const { t } = useTranslation(['admin', 'common']);
  const f = useFormatters();
  const limits = useSettingsStore((s) => s.streamingLimits);
  const updateStreamingLimits = useSettingsStore((s) => s.updateStreamingLimits);

  const addToast = useUIStore((s) => s.addToast);

  const [draft, setDraft] = useState<InstanceStreamingLimits | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');


  // Matrix editor state: full grid of kbps values (integers only)
  const [matrixDraft, setMatrixDraft] = useState<Record<string, number>>({});
  const [editingCell, setEditingCell] = useState<string | null>(null);
  const [scaleValue, setScaleValue] = useState(1.0);
  const scaleSnapshot = useRef<Record<string, number> | null>(null);

  useEffect(() => {
    if (limits) setDraft({ ...limits });
  }, [limits]);

  // Initialize matrix draft from limits + overrides
  useEffect(() => {
    if (!limits) return;
    const matrix: Record<string, number> = {};
    for (const res of STANDARD_RESOLUTIONS) {
      for (const fps of STANDARD_FRAMERATES) {
        const key = `${res}_${fps}`;
        matrix[key] = limits.bitrateMatrixOverrides?.[key] ?? BITRATE_MATRIX_KBPS[res]![fps as number]!;
      }
    }
    setMatrixDraft(matrix);
  }, [limits]);

  // Mbps with one decimal, kbps below a megabit; the unit words come from the catalog.
  const formatKbps = (kbps: number): string =>
    kbps >= 1000
      ? t('admin:streaming.units.mbps', { value: f.formatNumber(Math.round(kbps / 100) / 10) })
      : t('admin:streaming.units.kbps', { value: f.formatNumber(kbps) });

  if (!draft) return <div className="text-sm text-txt-tertiary">{t('admin:shared.loadingSettings')}</div>;

  const getDefaultKbps = (key: string): number => {
    const parts = key.split('_').map(Number);
    const h = parts[0]!;
    const f = parts[1]!;
    return BITRATE_MATRIX_KBPS[h]?.[f] ?? 8000;
  };

  const isOverridden = (key: string): boolean => matrixDraft[key] !== getDefaultKbps(key);

  const enabledResolutions = draft.allowedResolutions.filter((r): r is number => r !== 'native');
  const enabledFramerates = draft.allowedFramerates;

  const handleScaleStart = () => {
    scaleSnapshot.current = { ...matrixDraft };
  };

  const handleScaleChange = (newScale: number) => {
    setScaleValue(newScale);
    if (!scaleSnapshot.current) return;
    const scaled: Record<string, number> = {};
    for (const [key, val] of Object.entries(scaleSnapshot.current)) {
      scaled[key] = Math.round(val * newScale);
    }
    setMatrixDraft(scaled);
  };

  const handleScaleEnd = () => {
    scaleSnapshot.current = null;
    setScaleValue(1.0);
  };

  const matrixHasChanges = (() => {
    if (!limits) return false;
    for (const [key, val] of Object.entries(matrixDraft)) {
      const serverVal = limits.bitrateMatrixOverrides?.[key] ?? getDefaultKbps(key);
      if (val !== serverVal) return true;
    }
    return false;
  })();
  const hasChanges = JSON.stringify(draft) !== JSON.stringify(limits) || matrixHasChanges;

  const handleSave = async () => {
    setSaving(true);
    setSaveError('');
    try {
      // Compute sparse overrides: only cells that differ from defaults
      const overrides: Record<string, number> = {};
      for (const [key, val] of Object.entries(matrixDraft)) {
        if (val !== getDefaultKbps(key)) {
          overrides[key] = val;
        }
      }
      const payload = {
        ...draft,
        bitrateMatrixOverrides: Object.keys(overrides).length > 0 ? overrides : null,
      };
      await updateStreamingLimits(payload);
      addToast(t('admin:shared.saved'), 'success', 2000);
    } catch (err) {
      setSaveError(err instanceof Error ? describeError(err) : t('admin:shared.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    if (limits) {
      setDraft({ ...limits });
      const matrix: Record<string, number> = {};
      for (const res of STANDARD_RESOLUTIONS) {
        for (const fps of STANDARD_FRAMERATES) {
          const key = `${res}_${fps}`;
          matrix[key] = limits.bitrateMatrixOverrides?.[key] ?? BITRATE_MATRIX_KBPS[res]![fps as number]!;
        }
      }
      setMatrixDraft(matrix);
    }
    setSaveError('');
  };

  const toggleResolution = (res: number | 'native') => {
    const current = new Set(draft.allowedResolutions);
    if (current.has(res)) {
      if (current.size <= 1) return;
      current.delete(res);
    } else {
      current.add(res);
    }
    // Sort: numbers ascending, 'native' always last
    const nums: (number | 'native')[] = Array.from(current).filter((r): r is number => r !== 'native').sort((a, b) => a - b);
    if (current.has('native')) nums.push('native');
    setDraft({ ...draft, allowedResolutions: nums });
  };

  const toggleFramerate = (fps: number) => {
    const current = new Set(draft.allowedFramerates);
    if (current.has(fps)) {
      if (current.size <= 1) return;
      current.delete(fps);
    } else {
      current.add(fps);
    }
    setDraft({ ...draft, allowedFramerates: Array.from(current).sort((a, b) => a - b) });
  };

  const pillBase = 'px-3 py-1.5 rounded text-[13px] font-medium transition-colors cursor-pointer select-none';
  const pillOn = 'bg-accent-primary text-white';
  const pillOff = 'bg-surface-elevated text-txt-secondary hover:bg-interactive-hover';

  return (
    <div className="space-y-5">
      <h2 className="text-lg font-semibold text-txt-primary">{t('admin:streaming.title')}</h2>
      <div className="text-xs text-txt-tertiary">
        {t('admin:streaming.description')}
      </div>

      {/* Bandwidth */}
      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">{t('admin:streaming.bandwidth.label')}</div>
        <p className="text-xs text-txt-tertiary mb-2">{t('admin:streaming.bandwidth.description')}</p>
        <div className="rounded-lg bg-white/[0.02] p-3.5 space-y-4">
          {/* Allow Custom Bitrate */}
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-txt-primary">{t('admin:streaming.bandwidth.customBitrate.label')}</div>
              <div className="text-xs text-txt-tertiary">{t('admin:streaming.bandwidth.customBitrate.description')}</div>
            </div>
            <Toggle
              enabled={draft.allowCustomBitrate}
              onChange={(enabled) => setDraft({ ...draft, allowCustomBitrate: enabled })}
            />
          </div>
          {/* Bitrate Range */}
          <div>
            <div className="text-xs text-txt-secondary mb-1.5">
              {t('admin:streaming.bandwidth.range')}
            </div>
            <div className="flex items-start gap-3">
              <div className="flex-1 space-y-1.5">
                <label className="text-[11px] text-txt-tertiary block">{t('admin:streaming.bandwidth.min')}</label>
                <input
                  type="range"
                  min={100}
                  max={Math.min(draft.maxBitrateKbps - 500, 100000)}
                  step={100}
                  value={Math.min(draft.minBitrateKbps, 100000)}
                  onChange={(e) => setDraft({ ...draft, minBitrateKbps: Number(e.target.value) })}
                  className="w-full h-1.5 accent-accent-primary cursor-pointer appearance-none bg-interactive-muted rounded-full
                    [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3
                    [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-md
                    [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:border-0"
                />
                <div className="flex items-center gap-1.5">
                  <input
                    type="number"
                    min={100}
                    max={1000000}
                    step={100}
                    value={draft.minBitrateKbps}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (v >= 100 && v <= 1000000) setDraft({ ...draft, minBitrateKbps: v });
                    }}
                    className="input-standard w-20 px-2 py-0.5 text-xs"
                  />
                  <span className="text-[11px] text-txt-tertiary">{formatKbps(draft.minBitrateKbps)}</span>
                </div>
              </div>
              <div className="flex-1 space-y-1.5">
                <label className="text-[11px] text-txt-tertiary block">{t('admin:streaming.bandwidth.max')}</label>
                <input
                  type="range"
                  min={draft.minBitrateKbps + 500}
                  max={100000}
                  step={500}
                  value={Math.min(draft.maxBitrateKbps, 100000)}
                  onChange={(e) => setDraft({ ...draft, maxBitrateKbps: Number(e.target.value) })}
                  className="w-full h-1.5 accent-accent-primary cursor-pointer appearance-none bg-interactive-muted rounded-full
                    [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3
                    [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-md
                    [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:border-0"
                />
                <div className="flex items-center gap-1.5">
                  <input
                    type="number"
                    min={draft.minBitrateKbps + 500}
                    max={1000000}
                    step={500}
                    value={draft.maxBitrateKbps}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (v >= 500 && v <= 1000000) setDraft({ ...draft, maxBitrateKbps: v });
                    }}
                    className="input-standard w-20 px-2 py-0.5 text-xs"
                  />
                  <span className="text-[11px] text-txt-tertiary">{formatKbps(draft.maxBitrateKbps)}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Bitrate Step — presets + custom input */}
          <div className="pt-2 border-t border-white/[0.04]">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-[11px] text-txt-tertiary">{t('admin:streaming.bandwidth.step')}</span>
              <input
                type="number"
                min={50}
                max={10000}
                step={50}
                value={draft.bitrateStepKbps}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (v >= 50 && v <= 10000) setDraft({ ...draft, bitrateStepKbps: v });
                }}
                className="input-standard w-14 px-1.5 py-0 text-[11px] text-center"
              />
              <span className="text-[11px] text-txt-tertiary">{t('admin:streaming.units.kbpsLabel')}</span>
            </div>
            <div className="flex flex-wrap gap-1">
              {[100, 250, 500, 1000, 2500, 5000].map((step) => (
                <button
                  key={step}
                  onClick={() => setDraft({ ...draft, bitrateStepKbps: step })}
                  className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors cursor-pointer select-none ${
                    draft.bitrateStepKbps === step
                      ? 'bg-accent-primary text-white'
                      : 'bg-surface-elevated text-txt-secondary hover:bg-interactive-hover'
                  }`}
                >
                  {formatKbps(step)}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Quality */}
      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">{t('admin:streaming.quality.label')}</div>
        <p className="text-xs text-txt-tertiary mb-2">{t('admin:streaming.quality.description')}</p>
        <div className="rounded-lg bg-white/[0.02] p-3.5 space-y-4">
          {/* Allowed Resolutions */}
          <div>
            <div className="text-xs text-txt-secondary mb-1.5">
              {t('admin:streaming.quality.resolutions')}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {ALL_RESOLUTIONS.map((res) => (
                <button
                  key={String(res)}
                  onClick={() => toggleResolution(res)}
                  className={`${pillBase} ${draft.allowedResolutions.includes(res) ? pillOn : pillOff}`}
                >
                  {RESOLUTION_LABELS[res]}
                </button>
              ))}
            </div>
          </div>

          {/* Allowed Frame Rates */}
          <div>
            <div className="text-xs text-txt-secondary mb-1.5">
              {t('admin:streaming.quality.framerates')}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {STANDARD_FRAMERATES.map((fps) => (
                <button
                  key={fps}
                  onClick={() => toggleFramerate(fps)}
                  className={`${pillBase} ${draft.allowedFramerates.includes(fps) ? pillOn : pillOff}`}
                >
                  {t('admin:streaming.units.fps', { value: fps })}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* High-end resource warning */}
      {(draft.allowedResolutions.some(
          (r) => r === 'native' || (typeof r === 'number' && r >= HIGH_END_RESOLUTION_THRESHOLD)
        ) || draft.allowedFramerates.some(
          (f) => f >= HIGH_END_FRAMERATE_THRESHOLD
        )) && (
        <div className="p-3 bg-accent-amber/10 border border-accent-amber/30 rounded-lg">
          <div className="flex items-start gap-2">
            <svg className="w-4 h-4 text-accent-amber mt-0.5 shrink-0" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.168 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 6a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 6zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
            </svg>
            <div className="text-xs text-accent-amber/90 leading-relaxed">
              <span className="font-semibold">{t('admin:streaming.highEndWarning.title')}</span>{' '}
              {t('admin:streaming.highEndWarning.description')}
            </div>
          </div>
        </div>
      )}

      {/* Bitrate Matrix */}
      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">{t('admin:streaming.matrix.label')}</div>
        <p className="text-xs text-txt-tertiary mb-2">{t('admin:streaming.matrix.description')}</p>
        <div className="rounded-lg bg-white/[0.02] p-3.5 space-y-4">
          {/* Scale slider */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <div className="text-xs text-txt-secondary">{t('admin:streaming.matrix.scaleAll')}</div>
              <div className="text-xs text-txt-tertiary font-mono">&times;{scaleValue.toFixed(2)}</div>
            </div>
            <input
              type="range"
              min={0.5}
              max={2.0}
              step={0.05}
              value={scaleValue}
              onPointerDown={handleScaleStart}
              onChange={(e) => handleScaleChange(Number(e.target.value))}
              onPointerUp={handleScaleEnd}
              onPointerCancel={handleScaleEnd}
              className="w-full h-1.5 accent-accent-primary cursor-pointer appearance-none bg-interactive-muted rounded-full
                [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3
                [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-md
                [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:border-0"
            />
            <div className="text-[10px] text-txt-tertiary mt-0.5">{t('admin:streaming.matrix.scaleHint')}</div>
          </div>

          {/* Matrix grid */}
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr>
                  <th className="text-left text-txt-tertiary font-normal pb-1.5 pr-2"></th>
                  {enabledFramerates.map((fps) => (
                    <th key={fps} className="text-center text-txt-tertiary font-normal pb-1.5 px-1 min-w-[52px]">{t('admin:streaming.units.fps', { value: fps })}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {enabledResolutions.map((res) => (
                  <tr key={res}>
                    <td className="text-txt-secondary font-medium pr-2 py-0.5">{RESOLUTION_LABELS[res as Resolution] ?? `${res}p`}</td>
                    {enabledFramerates.map((fps) => {
                      const key = `${res}_${fps}`;
                      const val = matrixDraft[key] ?? getDefaultKbps(key);
                      const overridden = isOverridden(key);
                      const exceedsCap = val > draft.maxBitrateKbps;

                      return (
                        <td key={key} className="px-1 py-0.5">
                          {editingCell === key ? (
                            <input
                              autoFocus
                              type="number"
                              step={0.1}
                              className="input-standard w-full px-1.5 py-0.5 text-xs text-center"
                              defaultValue={(val / 1000).toFixed(1)}
                              onBlur={(e) => {
                                const mbps = parseFloat(e.target.value);
                                if (!isNaN(mbps) && mbps > 0) {
                                  setMatrixDraft({ ...matrixDraft, [key]: Math.round(mbps * 1000) });
                                }
                                setEditingCell(null);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                                if (e.key === 'Escape') setEditingCell(null);
                              }}
                            />
                          ) : (
                            <button
                              onClick={() => setEditingCell(key)}
                              className={`w-full px-1.5 py-0.5 rounded text-center transition-colors
                                ${exceedsCap ? 'bg-accent-amber/10 text-accent-amber' : ''}
                                ${overridden && !exceedsCap ? 'bg-accent-primary/10 text-accent-primary' : ''}
                                ${!overridden && !exceedsCap ? 'text-txt-secondary hover:bg-interactive-hover' : ''}
                              `}
                              title={overridden ? t('admin:streaming.matrix.cellDefault', { value: formatKbps(getDefaultKbps(key)) }) : t('admin:streaming.matrix.cellEdit')}
                            >
                              {(val / 1000).toFixed(1)}
                              {overridden && (
                                <span
                                  className="ml-1 text-[10px] text-txt-tertiary hover:text-txt-danger cursor-pointer"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setMatrixDraft({ ...matrixDraft, [key]: getDefaultKbps(key) });
                                  }}
                                >
                                  &times;
                                </span>
                              )}
                            </button>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Reset all button */}
          {Object.entries(matrixDraft).some(([key, val]) => val !== getDefaultKbps(key)) && (
            <button
              onClick={() => {
                const reset: Record<string, number> = {};
                for (const [key] of Object.entries(matrixDraft)) {
                  reset[key] = getDefaultKbps(key);
                }
                setMatrixDraft(reset);
              }}
              className="text-[11px] text-accent-primary hover:text-accent-lavender transition-colors"
            >
              {t('admin:streaming.matrix.resetAll')}
            </button>
          )}
        </div>
      </div>

      {/* Coherence warning */}
      {Object.entries(matrixDraft).some(([, val]) => val > draft.maxBitrateKbps) && (
        <div className="p-3 bg-accent-amber/10 border border-accent-amber/30 rounded-lg">
          <div className="flex items-start gap-2">
            <svg className="w-4 h-4 text-accent-amber mt-0.5 shrink-0" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.168 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 6a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 6zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
            </svg>
            <div className="text-xs text-accent-amber/90 leading-relaxed">
              <span className="font-semibold">{t('admin:streaming.capWarning.title')}</span>{' '}
              {t('admin:streaming.capWarning.description', { max: formatKbps(draft.maxBitrateKbps) })}
            </div>
          </div>
        </div>
      )}

      {/* Save / Reset */}
      {saveError && (
        <div className="p-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-sm">{saveError}</div>
      )}
      {hasChanges && (
        <div className="sticky bottom-0 z-10 pointer-events-none">
          <div className="flex justify-center pt-3 pb-1">
            <div className="glass-bubble rounded-full px-4 py-2 flex items-center gap-2 animate-slide-up pointer-events-auto">
              <button
                onClick={handleReset}
                className="px-3 py-1 text-sm text-txt-tertiary hover:text-txt-secondary transition-colors"
              >
                {t('common:actions.reset')}
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-3 py-1.5 bg-accent-primary hover:bg-accent-primary/80 text-white text-sm font-medium rounded-full transition-colors disabled:opacity-50"
              >
                {saving ? t('common:states.saving') : t('common:actions.save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
