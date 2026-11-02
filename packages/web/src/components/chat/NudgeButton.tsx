import { useTranslation } from 'react-i18next';
import { Fragment, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { NudgeEffect } from '@backspace/shared';
import { wsSend } from '../../hooks/useWebSocket';
import { getChannelOrigin } from '../../stores/spaceStore';

const effects: { value: NudgeEffect; icon: string; }[] = [
  { value: 'shake', icon: '🔔' },
  { value: 'wave', icon: '🌊' },
  { value: 'jelly', icon: '🍮' },
  { value: 'knock', icon: '✊' },
  { value: 'confetti', icon: '🎉' },
  { value: 'pulse', icon: '💜' },
];

const msnEffects: typeof effects = [
  { value: 'msn_bouncy_ball', icon: '🏀' },
  { value: 'msn_bow', icon: '🙇' },
  { value: 'msn_dancing_pig', icon: '🐷' },
  { value: 'msn_eyeball', icon: '👀' },
  { value: 'msn_frog', icon: '🐸' },
  { value: 'msn_guitar_smash', icon: '🎸' },
  { value: 'msn_heart', icon: '❤️' },
  { value: 'msn_kiss', icon: '💋' },
  { value: 'msn_lipstick_girl', icon: '💄' },
  { value: 'msn_love_letter', icon: '💌' },
  { value: 'msn_notes', icon: '🎵' },
  { value: 'msn_silly_face', icon: '🤪' },
  { value: 'msn_stars', icon: '⭐' },
  { value: 'msn_water_balloon', icon: '🎈' },
  { value: 'msn_fart_guy', icon: '💨' },
];

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
    <button ref={button} type="button" title={cooling ? t('chat:nudge.cooldown') : t('chat:nudge.title')}
      aria-label={t('chat:nudge.title')} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      disabled={cooling} onClick={() => {
        const rect = button.current!.getBoundingClientRect();
        setPosition({ left: Math.max(8, Math.min(rect.left, innerWidth - 280)), bottom: Math.max(8, innerHeight - rect.top + 8) });
        setOpen(value => !value);
      }} className="w-10 h-10 desktop:w-[34px] desktop:h-[34px] rounded-[6px] text-txt-tertiary hover:text-txt-primary hover:bg-white/[0.06] disabled:opacity-40">🔔</button>
    {open && createPortal(<div ref={menu} id={id} role="menu" aria-label={t('chat:nudge.choose')}
      style={{ position: 'fixed', ...position, zIndex: 500, width: 264, maxHeight: 'min(420px, 75vh)', overflowY: 'auto' }}
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
        <button role="menuitem" type="button"
        className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-white/[0.06] focus:bg-white/[0.06] focus:outline-none"
        onClick={() => {
          if (Date.now() >= until.current && wsSend({ type: 'dm_nudge', dmChannelId: channelId, effect: effect.value }, getChannelOrigin(channelId))) {
            until.current = Date.now() + 10_000; setCooling(true);
          }
          close();
        }}><span aria-hidden="true" className="text-lg">{effect.icon}</span><span><span className="block text-sm text-txt-primary">{t(`chat:nudge.effects.${effect.value}.title`)}</span><span className="block text-xs text-txt-tertiary">{t(`chat:nudge.effects.${effect.value}.description`)}</span></span></button></Fragment>)}
      <p className="border-t border-border-soft px-2 pt-2 pb-1 text-[11px] text-txt-tertiary">{t('chat:nudge.footer')}</p>
    </div>, document.body)}
  </>;
}
