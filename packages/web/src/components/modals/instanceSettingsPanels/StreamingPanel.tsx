import { useState, useEffect } from 'react';
import { useSettingsStore } from '../../../stores/settingsStore';
import type { InstanceStreamingLimits } from '@backspace/shared';

const VALID_RESOLUTIONS = [540, 720, 1080] as const;
const VALID_FRAMERATES = [30, 45, 60] as const;

function formatKbps(kbps: number): string {
  return kbps >= 1000
    ? `${(kbps / 1000).toFixed(kbps % 1000 === 0 ? 0 : 1)} Mbps`
    : `${kbps} kbps`;
}

export function StreamingPanel() {
  const limits = useSettingsStore((s) => s.streamingLimits);
  const updateStreamingLimits = useSettingsStore((s) => s.updateStreamingLimits);

  const [draft, setDraft] = useState<InstanceStreamingLimits | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saveSuccess, setSaveSuccess] = useState(false);

  useEffect(() => {
    if (limits) setDraft({ ...limits });
  }, [limits]);

  if (!draft) return <div className="text-sm text-txt-tertiary">Loading settings...</div>;

  const hasChanges = JSON.stringify(draft) !== JSON.stringify(limits);

  const handleSave = async () => {
    setSaving(true);
    setSaveError('');
    setSaveSuccess(false);
    try {
      await updateStreamingLimits(draft);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2000);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    if (limits) setDraft({ ...limits });
    setSaveError('');
  };

  const toggleResolution = (res: number) => {
    const current = new Set(draft.allowedResolutions);
    if (current.has(res)) {
      if (current.size <= 1) return;
      current.delete(res);
    } else {
      current.add(res);
    }
    setDraft({ ...draft, allowedResolutions: Array.from(current).sort((a, b) => a - b) });
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
      <div className="text-xs text-txt-tertiary">
        These limits apply to all users on this instance. Users can pick values within these bounds.
      </div>

      {/* Bandwidth */}
      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">Bandwidth</div>
        <p className="text-xs text-txt-tertiary mb-2">Minimum and maximum bitrate bounds, and the step size for the quality slider.</p>
        <div className="rounded-lg bg-white/[0.02] p-3.5 space-y-4">
          {/* Bitrate Range */}
          <div>
            <div className="text-xs text-txt-secondary mb-1.5">
              Bitrate Range
            </div>
            <div className="flex items-center gap-3">
              <div className="flex-1">
                <label className="text-[11px] text-txt-tertiary mb-1 block">Min</label>
                <input
                  type="range"
                  min={100}
                  max={draft.maxBitrateKbps - 500}
                  step={100}
                  value={draft.minBitrateKbps}
                  onChange={(e) => setDraft({ ...draft, minBitrateKbps: Number(e.target.value) })}
                  className="w-full h-1.5 accent-accent-primary cursor-pointer appearance-none bg-interactive-muted rounded-full
                    [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3
                    [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-md
                    [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:border-0"
                />
                <div className="text-[11px] text-txt-secondary mt-0.5">{formatKbps(draft.minBitrateKbps)}</div>
              </div>
              <div className="flex-1">
                <label className="text-[11px] text-txt-tertiary mb-1 block">Max</label>
                <input
                  type="range"
                  min={draft.minBitrateKbps + 500}
                  max={50000}
                  step={500}
                  value={draft.maxBitrateKbps}
                  onChange={(e) => setDraft({ ...draft, maxBitrateKbps: Number(e.target.value) })}
                  className="w-full h-1.5 accent-accent-primary cursor-pointer appearance-none bg-interactive-muted rounded-full
                    [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3
                    [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-md
                    [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:border-0"
                />
                <div className="text-[11px] text-txt-secondary mt-0.5">{formatKbps(draft.maxBitrateKbps)}</div>
              </div>
            </div>
          </div>

          {/* Bitrate Step */}
          <div>
            <div className="text-xs text-txt-secondary mb-1.5">
              Slider Step
            </div>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={50}
                max={5000}
                step={50}
                value={draft.bitrateStepKbps}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (v >= 50 && v <= 5000) setDraft({ ...draft, bitrateStepKbps: v });
                }}
                className="w-24 px-2 py-1 bg-surface-input rounded text-sm text-txt-primary outline-none focus:ring-1 focus:ring-accent-primary"
              />
              <span className="text-[12px] text-txt-tertiary">kbps</span>
            </div>
          </div>
        </div>
      </div>

      {/* Quality */}
      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">Quality</div>
        <p className="text-xs text-txt-tertiary mb-2">Available resolution and frame rate options for screen sharing.</p>
        <div className="rounded-lg bg-white/[0.02] p-3.5 space-y-4">
          {/* Allowed Resolutions */}
          <div>
            <div className="text-xs text-txt-secondary mb-1.5">
              Allowed Resolutions
            </div>
            <div className="flex gap-1.5">
              {VALID_RESOLUTIONS.map((res) => (
                <button
                  key={res}
                  onClick={() => toggleResolution(res)}
                  className={`${pillBase} ${draft.allowedResolutions.includes(res) ? pillOn : pillOff}`}
                >
                  {res}p
                </button>
              ))}
            </div>
          </div>

          {/* Allowed Frame Rates */}
          <div>
            <div className="text-xs text-txt-secondary mb-1.5">
              Allowed Frame Rates
            </div>
            <div className="flex gap-1.5">
              {VALID_FRAMERATES.map((fps) => (
                <button
                  key={fps}
                  onClick={() => toggleFramerate(fps)}
                  className={`${pillBase} ${draft.allowedFramerates.includes(fps) ? pillOn : pillOff}`}
                >
                  {fps} fps
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Save / Reset */}
      {saveError && (
        <div className="p-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-sm">{saveError}</div>
      )}
      {saveSuccess && (
        <div className="p-2 bg-status-online/10 border border-status-online/30 rounded text-status-online text-sm">Settings saved</div>
      )}
      {hasChanges && (
        <div className="sticky bottom-0 z-10 pointer-events-none">
          <div className="flex justify-center pt-3 pb-1">
            <div className="glass-bubble rounded-full px-4 py-2 flex items-center gap-2 animate-slide-up pointer-events-auto">
              <button
                onClick={handleReset}
                className="px-3 py-1 text-sm text-txt-tertiary hover:text-txt-secondary transition-colors"
              >
                Reset
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-3 py-1.5 bg-accent-primary hover:bg-accent-primary/80 text-white text-sm font-medium rounded-full transition-colors disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
