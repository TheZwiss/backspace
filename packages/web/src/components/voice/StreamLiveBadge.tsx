import { useTranslation } from 'react-i18next';
import { useStreamPreviews } from '../../utils/streamPreviews';
import { Tooltip } from '../ui/Tooltip';

export function StreamLiveBadge({ userId, large = false }: { userId: string; large?: boolean }) {
  const { t } = useTranslation('voice');
  const preview = useStreamPreviews((state) => state.images[state.identities[userId] ?? '']?.image);
  const badge = <span className={`bg-accent-rose text-white font-bold rounded ${large ? 'px-1.5 py-0.5 text-[11px] uppercase tracking-wide' : 'text-[9px] px-1 leading-[14px]'}`}>{t('badges.live')}</span>;
  if (!preview) return badge;
  return <Tooltip position="right" content={<img src={preview} alt={t('badges.live')} className="w-60 aspect-video object-contain rounded bg-black" />}>{badge}</Tooltip>;
}
