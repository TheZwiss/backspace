import { Tooltip } from '../ui/Tooltip';
import { useTranslation } from 'react-i18next';
import { Fragment, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { NudgeEffect } from '@backspace/shared';
import { wsSend } from '../../hooks/useWebSocket';
import { getChannelOrigin } from '../../stores/spaceStore';
import { NudgeEffectPreview } from './NudgeEffectPreview';

const effects: { value: NudgeEffect }[] = [
  { value: 'shake' }, { value: 'wave' }, { value: 'jelly' }, { value: 'knock' }, { value: 'confetti' }, { value: 'pulse' },
];

const msnEffects: typeof effects = [
  'msn_bouncy_ball', 'msn_bow', 'msn_dancing_pig', 'msn_eyeball', 'msn_frog', 'msn_guitar_smash', 'msn_heart', 'msn_kiss',
  'msn_lipstick_girl', 'msn_love_letter', 'msn_notes', 'msn_silly_face', 'msn_stars', 'msn_water_balloon', 'msn_fart_guy',
].map((value) => ({ value: value as NudgeEffect }));

/** One entry of the effect menu: the effect's preview runs while the entry is hovered or focused. */
function NudgeMenuItem({ effect, onPick }: { effect: NudgeEffect; onPick: () => void }) {
  const { t } = useTranslation(['chat']);
  const [active, setActive] = useState(false);
  return (
    <button data-icon-motion="none" role="menuitem" type="button"
      className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-white/[0.06] focus:bg-white/[0.06] focus:outline-none"
      onMouseEnter={() => setActive(true)} onMouseLeave={() => setActive(false)}
      onFocus={() => setActive(true)} onBlur={() => setActive(false)}
      onClick={onPick}>
      <NudgeEffectPreview effect={effect} active={active} />
      <span>
        <span className="block text-sm text-txt-primary">{t(`chat:nudge.effects.${effect}.title`)}</span>
        <span className="block text-xs text-txt-tertiary">{t(`chat:nudge.effects.${effect}.description`)}</span>
      </span>
    </button>
  );
}

export function NudgeButton({ channelId }: { channelId: string }) {
  const { t } = useTranslation(['chat']);
  const [open, setOpen] = useState(false);
  const [cooling, setCooling] = useState(false);
  const [position, setPosition] = useState({ left: 0, bottom: 0 });
  const until = useRef(0);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!cooling) return;
    const timer = setTimeout(() => setCooling(false), Math.max(0, until.current - Date.now()));
    return () => clearTimeout(timer);
  }, [cooling]);
  useEffect(() => { setOpen(false); }, [channelId]);
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !button.current?.contains(event.target as Node)) setOpen(false);
    };
    const reposition = () => setOpen(false);
    document.addEventListener('pointerdown', dismiss);
    window.addEventListener('resize', reposition);
    return () => { document.removeEventListener('pointerdown', dismiss); window.removeEventListener('resize', reposition); };
  }, [open]);
  const close = () => { setOpen(false); button.current?.focus(); };
  return <>
    <Tooltip content={cooling ? t('chat:nudge.cooldown') : t('chat:nudge.title')} position="top"><button data-icon-motion="bell" ref={button} type="button"
      aria-label={t('chat:nudge.title')} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      disabled={cooling} onClick={() => {
        const rect = button.current!.getBoundingClientRect();
        setPosition({ left: Math.max(8, Math.min(rect.left, innerWidth - 308)), bottom: Math.max(8, innerHeight - rect.top + 8) });
        setOpen(value => !value);
      }} className={`w-10 h-10 desktop:w-[34px] desktop:h-[34px] flex items-center justify-center rounded-[6px] transition-colors flex-shrink-0 disabled:opacity-40 ${open ? 'text-accent-primary' : 'text-txt-tertiary hover:text-txt-secondary'}`}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2Zm6-6V9a6 6 0 0 0-5-5.92V2h-2v1.08A6 6 0 0 0 6 9v7l-2 2v1h16v-1l-2-2Z" />
        </svg>
      </button></Tooltip>
    {open && createPortal(<div ref={menu} id={id} role="menu" aria-label={t('chat:nudge.choose')}
      style={{ position: 'fixed', ...position, zIndex: 'var(--layer-menu)', width: 292, maxHeight: 'min(420px, calc(75 * var(--app-vh)))', overflowY: 'auto' }}
      className="rounded-[10px] border border-border-soft bg-surface-elevated p-1.5 shadow-xl"
      onKeyDown={event => {
        if (event.key === 'Escape' || event.key === 'Tab') { if (event.key === 'Escape') event.preventDefault(); close(); }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const buttons = [...menu.current!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          buttons[(index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
        }
      }}>
      <p className="px-2 py-1.5 text-xs font-semibold text-txt-secondary">{t('chat:nudge.title')}</p>
      {[...effects, ...msnEffects].map((effect, index) => <Fragment key={effect.value}>
        {index === effects.length && <p className="border-t border-border-soft mt-1 px-2 pt-3 pb-1 text-xs font-semibold text-txt-secondary">{t('chat:nudge.originals')}</p>}
        <NudgeMenuItem effect={effect.value} onPick={() => {
          if (Date.now() >= until.current && wsSend({ type: 'dm_nudge', dmChannelId: channelId, effect: effect.value }, getChannelOrigin(channelId))) {
            until.current = Date.now() + 10_000; setCooling(true);
          }
          close();
        }} />
      </Fragment>)}
      <p className="border-t border-border-soft px-2 pt-2 pb-1 text-ui-caption text-txt-tertiary">{t('chat:nudge.footer')}</p>
    </div>, document.body)}
  </>;
}
