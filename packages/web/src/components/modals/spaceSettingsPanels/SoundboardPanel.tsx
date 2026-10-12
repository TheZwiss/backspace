import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SoundboardSettings } from '@backspace/shared/src/soundboard';
import { useSpaceStore } from '../../../stores/spaceStore';
import { useSoundboard } from '../../../hooks/useSoundboard';
import { getApiForOrigin } from '../../../utils/crossStoreResolvers';
import { describeError } from '../../../i18n/errors';
import { Toggle } from '../../ui/Toggle';
import { SoundboardLibrary } from '../../voice/SoundboardLibrary';

export function SoundboardPanel({ spaceId }: { spaceId: string }) {
  const origin = useSpaceStore(s => s.spaces.find(space => space.id === spaceId)?._instanceOrigin ?? '');
  return <SoundboardPanelContent key={`${origin}:${spaceId}`} origin={origin} spaceId={spaceId} />;
}

function SoundboardPanelContent({ origin, spaceId }: { origin: string; spaceId: string }) {
  const { t } = useTranslation(['voice', 'common']);
  const { document, error: loadError, reload } = useSoundboard(origin, spaceId);
  const [draft, setDraft] = useState<SoundboardSettings | null>(null);
  const [dirty, setDirty] = useState(false); const [saving, setSaving] = useState(false); const [error, setError] = useState('');
  useEffect(() => { if (document && !dirty) setDraft(document.settings); }, [document, dirty]);
  if (!draft) return <div className="text-txt-tertiary">{loadError ? <><p role="alert">{describeError(loadError)}</p><button onClick={() => void reload()}>{t('common:actions.retry')}</button></> : t('common:states.loading')}</div>;
  const change = (patch: Partial<SoundboardSettings>) => { setDraft({ ...draft, ...patch }); setDirty(true); };
  const valid = Number.isInteger(draft.maxSounds) && draft.maxSounds >= 1 && draft.maxSounds <= 100
    && (draft.maxDurationSeconds === null || (Number.isFinite(draft.maxDurationSeconds) && draft.maxDurationSeconds >= 0.1 && draft.maxDurationSeconds <= 86400));
  const save = async () => {
    if (saving || !valid) return;
    setSaving(true); setError('');
    try { const settings = await getApiForOrigin(origin).soundboard.settings(spaceId, draft); setDraft(settings); await reload(); setDirty(false); }
    catch (cause) { setError(describeError(cause)); }
    finally { setSaving(false); }
  };
  return <div className="space-y-6">
    <h2 className="text-xl font-semibold text-txt-primary">{t('voice:soundboard.title')}</h2>
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 text-sm text-txt-secondary"><span>{t('voice:soundboard.enabled')}</span><Toggle ariaLabel={t('voice:soundboard.enabled')} enabled={draft.enabled} onChange={enabled => change({ enabled })} disabled={saving} /></div>
      <div className="flex items-center justify-between gap-3 text-sm text-txt-secondary"><span>{t('voice:soundboard.memberUploads')}</span><Toggle ariaLabel={t('voice:soundboard.memberUploads')} enabled={draft.allowMemberUploads} onChange={allowMemberUploads => change({ allowMemberUploads })} disabled={saving} /></div>
      <div className="text-sm text-txt-secondary"><label htmlFor="soundboard-duration">{t('voice:soundboard.maxDuration')}</label><div className="flex items-center gap-3 mt-2"><input id="soundboard-duration" type="number" min={0.1} max={86400} step="0.1" disabled={saving || draft.maxDurationSeconds === null} value={draft.maxDurationSeconds ?? ''} onChange={e => change({ maxDurationSeconds: Number(e.target.value) })} className="input-standard w-28" /><label className="flex gap-2 items-center"><input type="checkbox" checked={draft.maxDurationSeconds === null} disabled={saving} onChange={e => change({ maxDurationSeconds: e.target.checked ? null : 10 })} className="accent-accent-primary" />{t('voice:soundboard.unlimited')}</label></div></div>
      <label className="block text-sm text-txt-secondary">{t('voice:soundboard.maxSounds')}<input type="number" min={1} max={100} step={1} value={draft.maxSounds} disabled={saving} onChange={e => change({ maxSounds: Number(e.target.value) })} className="input-standard w-28 block mt-2" /></label>
      <p className="text-xs text-txt-tertiary">{t('voice:soundboard.policyHint')}</p>
      {error && <p role="alert" className="text-sm text-accent-rose">{error}</p>}
      {dirty && <div className="flex gap-3"><button disabled={saving || !valid} onClick={() => void save()} className="bg-accent-primary text-white px-4 py-2 rounded-lg disabled:opacity-40">{saving ? t('common:states.loading') : t('common:actions.save')}</button><button disabled={saving} onClick={() => { setDirty(false); setDraft(document?.settings ?? null); }} className="text-txt-tertiary">{t('common:actions.cancel')}</button></div>}
    </div>
    <SoundboardLibrary origin={origin} spaceId={spaceId} />
  </div>;
}
