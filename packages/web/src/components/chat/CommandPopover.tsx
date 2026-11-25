import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { BotCommandOption } from '@backspace/shared';
import type { CommandRow } from '../../utils/commandArgs';
import { Avatar } from '../ui/Avatar';
import { BotBadge } from '../ui/BotBadge';
import { useUIStore } from '../../stores/uiStore';
import { uploadUrlOn } from '../../utils/assetUrls';
import { useAnchorRect } from './useAnchorRect';

type AnchorRef = React.RefObject<HTMLElement | null>;

/**
 * Where the suggestions sit: above the composer, level with its left edge and as
 * wide as it; a bottom sheet on mobile. The list is driven by the composer text,
 * so the mobile backdrop does not intercept taps.
 */
function PopoverShell({
  anchorRef,
  enabled,
  children,
}: {
  anchorRef: AnchorRef;
  enabled: boolean;
  children: React.ReactNode;
}) {
  const isMobile = useUIStore((s) => s.isMobile);
  const rect = useAnchorRect(anchorRef, enabled && !isMobile);

  if (isMobile) {
    return createPortal(
      <>
        <div className="fixed inset-0 z-[300] bg-black/30 pointer-events-none" />
        <div
          className="fixed left-0 right-0 z-[301] rounded-t-2xl glass-modal animate-slide-up-sheet flex flex-col"
          style={{
            bottom: 'var(--keyboard-inset)',
            paddingBottom: 'var(--safe-bottom)',
            maxHeight: 'min(calc(50*var(--app-dvh)), calc(50*var(--app-vh)))',
          }}
        >
          <div className="w-10 h-1 bg-txt-tertiary/30 rounded-full mx-auto mt-2 mb-1 shrink-0" />
          <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">{children}</div>
        </div>
      </>,
      document.body,
    );
  }

  if (!rect) return null;

  return createPortal(
    <div className="z-[300]" style={{ position: 'fixed', left: rect.left, bottom: rect.bottom, width: rect.width }}>
      <div className="glass rounded-lg overflow-hidden max-h-[320px] overflow-y-auto scrollbar-thin">{children}</div>
    </div>,
    document.body,
  );
}

function rowClass(mobile: boolean, selected: boolean): string {
  const sizing = mobile ? 'gap-3 px-3 py-2.5 min-h-[44px]' : 'gap-2.5 px-2 py-1.5';
  const tone = selected ? 'bg-interactive-selected' : 'hover:bg-interactive-hover';
  return `flex items-center mx-1 rounded cursor-pointer transition-colors ${sizing} ${tone}`;
}

interface CommandPopoverProps {
  /**
   * The matching commands, one row per command or per subcommand of one,
   * already filtered; the composer owns the list so its keys and this popover
   * index the same rows.
   */
  commands: CommandRow[];
  selectedIndex: number;
  onSelect: (row: CommandRow) => void;
  anchorRef: AnchorRef;
  /** Origin of the chat ('' is home): the listing's avatar filenames are uploads of that instance. */
  origin: string;
}

function CommandList({ commands, selectedIndex, onSelect, origin }: Omit<CommandPopoverProps, 'anchorRef'>) {
  const { t } = useTranslation(['chat']);
  const mobile = useUIStore((s) => s.isMobile);
  const selectedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  return (
    <>
      <div className="px-2 py-1.5 text-[11px] font-bold text-txt-tertiary uppercase tracking-wider">
        {t('chat:commands.title')}
      </div>
      {commands.map((row, i) => {
        const { command } = row;
        return (
          <div
            key={[command.id, ...row.path].join(' ')}
            ref={i === selectedIndex ? selectedRef : undefined}
            onClick={() => onSelect(row)}
            className={rowClass(mobile, i === selectedIndex)}
          >
            <Avatar
              src={uploadUrlOn(command.bot.avatar, origin)}
              name={command.bot.displayName || command.bot.username}
              size={mobile ? 28 : 24}
              avatarColor={command.bot.avatarColor}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className={`${mobile ? 'text-[15px]' : 'text-[14px]'} font-medium text-txt-primary shrink-0`}>
                  {['/' + command.name, ...row.path].join(' ')}
                </span>
                <span className="text-[12px] text-txt-tertiary truncate">{row.description}</span>
              </div>
              <div className="flex items-center gap-1.5 mt-0.5">
                <span className="text-[11px] text-txt-tertiary truncate">{`@${command.bot.username}`}</span>
                <BotBadge />
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
}

export function CommandPopover({ commands, selectedIndex, onSelect, anchorRef, origin }: CommandPopoverProps) {
  if (commands.length === 0) return null;

  return (
    <PopoverShell anchorRef={anchorRef} enabled>
      <CommandList commands={commands} selectedIndex={selectedIndex} onSelect={onSelect} origin={origin} />
    </PopoverShell>
  );
}

interface CommandOptionPopoverProps {
  options: BotCommandOption[];
  selectedIndex: number;
  onSelect: (option: BotCommandOption) => void;
  anchorRef: AnchorRef;
}

function OptionList({ options, selectedIndex, onSelect }: Omit<CommandOptionPopoverProps, 'anchorRef'>) {
  const { t } = useTranslation(['chat']);
  const mobile = useUIStore((s) => s.isMobile);
  const selectedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  return (
    <>
      <div className="px-2 py-1.5 text-[11px] font-bold text-txt-tertiary uppercase tracking-wider">
        {t('chat:commands.optionsTitle')}
      </div>
      {options.map((option, i) => (
        <div
          key={option.name}
          ref={i === selectedIndex ? selectedRef : undefined}
          onClick={() => onSelect(option)}
          className={rowClass(mobile, i === selectedIndex)}
        >
          <span className={`${mobile ? 'text-[15px]' : 'text-[14px]'} font-medium text-txt-primary shrink-0`}>
            {`${option.name}:`}
          </span>
          <span className="text-[12px] text-txt-tertiary truncate flex-1 min-w-0">{option.description}</span>
          {option.required && (
            <span className="text-[11px] text-accent-primary shrink-0">{t('chat:commands.required')}</span>
          )}
          <span className="text-[11px] text-txt-tertiary shrink-0">{option.type}</span>
        </div>
      ))}
    </>
  );
}

export function CommandOptionPopover({ options, selectedIndex, onSelect, anchorRef }: CommandOptionPopoverProps) {
  if (options.length === 0) return null;

  return (
    <PopoverShell anchorRef={anchorRef} enabled>
      <OptionList options={options} selectedIndex={selectedIndex} onSelect={onSelect} />
    </PopoverShell>
  );
}

interface CommandSubcommandPopoverProps {
  /** The next step of the command's path: subcommands, or groups of them. */
  steps: BotCommandOption[];
  selectedIndex: number;
  onSelect: (step: BotCommandOption) => void;
  anchorRef: AnchorRef;
}

/** The subcommands (or groups) a command offers next, after `/name ` or `/name group `. */
export function CommandSubcommandPopover({ steps, selectedIndex, onSelect, anchorRef }: CommandSubcommandPopoverProps) {
  const { t } = useTranslation(['chat']);
  const mobile = useUIStore((s) => s.isMobile);
  const selectedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  if (steps.length === 0) return null;

  return (
    <PopoverShell anchorRef={anchorRef} enabled>
      <div className="px-2 py-1.5 text-[11px] font-bold text-txt-tertiary uppercase tracking-wider">
        {t('chat:commands.subcommandsTitle')}
      </div>
      {steps.map((step, i) => (
        <div
          key={step.name}
          ref={i === selectedIndex ? selectedRef : undefined}
          onClick={() => onSelect(step)}
          className={rowClass(mobile, i === selectedIndex)}
        >
          <span className={`${mobile ? 'text-[15px]' : 'text-[14px]'} font-medium text-txt-primary shrink-0`}>
            {step.name}
          </span>
          <span className="text-[12px] text-txt-tertiary truncate flex-1 min-w-0">{step.description}</span>
          {step.type === 'subcommand_group' && (
            <span className="text-[11px] text-txt-tertiary shrink-0">{t('chat:commands.group')}</span>
          )}
        </div>
      ))}
    </PopoverShell>
  );
}

/** One value the value popover offers for a typed option. */
export interface CommandValueCandidate {
  key: string;
  /** What the row shows. */
  label: string;
  /** A second, dimmer line of the row (a handle, a channel type). */
  detail?: string;
  /** What picking the row writes into the draft after `name:`. */
  insert: string;
}

interface CommandValuePopoverProps {
  /** The option whose value is being picked: its name heads the list. */
  optionName: string;
  candidates: CommandValueCandidate[];
  selectedIndex: number;
  onSelect: (candidate: CommandValueCandidate) => void;
  anchorRef: AnchorRef;
}

function ValueList({ optionName, candidates, selectedIndex, onSelect }: Omit<CommandValuePopoverProps, 'anchorRef'>) {
  const mobile = useUIStore((s) => s.isMobile);
  const selectedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  return (
    <>
      <div className="px-2 py-1.5 text-[11px] font-bold text-txt-tertiary uppercase tracking-wider">
        {`${optionName}:`}
      </div>
      {candidates.map((candidate, i) => (
        <div
          key={candidate.key}
          ref={i === selectedIndex ? selectedRef : undefined}
          onClick={() => onSelect(candidate)}
          className={rowClass(mobile, i === selectedIndex)}
        >
          <span className={`${mobile ? 'text-[15px]' : 'text-[14px]'} font-medium text-txt-primary truncate`}>
            {candidate.label}
          </span>
          {candidate.detail && (
            <span className="text-[12px] text-txt-tertiary truncate flex-1 min-w-0">{candidate.detail}</span>
          )}
        </div>
      ))}
    </>
  );
}

/** The values a typed slash command option may take: people, roles, channels or true/false. */
export function CommandValuePopover({ optionName, candidates, selectedIndex, onSelect, anchorRef }: CommandValuePopoverProps) {
  if (candidates.length === 0) return null;

  return (
    <PopoverShell anchorRef={anchorRef} enabled>
      <ValueList optionName={optionName} candidates={candidates} selectedIndex={selectedIndex} onSelect={onSelect} />
    </PopoverShell>
  );
}
