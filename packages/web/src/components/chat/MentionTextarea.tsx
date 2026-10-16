import { useLayoutEffect, useRef, type CSSProperties, type ReactNode, type RefObject, type TextareaHTMLAttributes } from 'react';
import type { ComposerMentions } from './composerMentions';
import type { ArgumentFrame } from '../../utils/commandArgs';

interface Props extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  model: ComposerMentions;
  textareaRef: RefObject<HTMLTextAreaElement>;
  mentionAnchorRef: RefObject<HTMLSpanElement>;
  mentionStart?: number;
  /** The arguments of a slash command draft, in shown offsets: each is drawn as a box. */
  frames?: readonly ArgumentFrame[];
}

/*
 * An argument is drawn as one capsule in two tones, like the glass pills of
 * the design system: the option's name on the lighter half, its value on the
 * darker one, framed by a line (dashed while no value is written). Only
 * backgrounds, radii, box-shadows and zero-width boxes with absolutely placed
 * pseudo-elements are used: the mirror must lay its text out exactly as the
 * textarea does, or the caret and the painted text drift apart. The room
 * inside and between the capsules is the spacing the composer writes (see
 * `spaceArguments`): the colon of `name:` and a thin space after it are the
 * name's right padding, drawn transparent, and an en space is the value's left
 * padding. The name's left end is widened by a shadow in its colour; the
 * value's frame is drawn by inset shadows (top, bottom, left), which a value
 * wrapped over several lines carries along each line, and closed by an end
 * cap, a zero-width box after the value that draws the right padding and the
 * frame's rounded right end. How far those ends reach depends on the spaces
 * around them (`capsuleRooms`), so plain spaces typed by hand never let two
 * capsules overlap. That cap and the slot of an empty value are
 * empty inline spans: they take no width and break no line, and their
 * pseudo-element spans exactly the line's text height. The class strings
 * are written out whole so Tailwind finds them.
 */
const NAME_BOX = 'bg-white/[0.10] text-txt-secondary rounded-l-md [box-shadow:calc(-1*var(--reach))_0_0_0_rgba(255,255,255,0.10)]';
const COLON = 'text-transparent';
const VALUE_BOX = 'bg-white/[0.05] text-txt-primary [box-shadow:inset_1px_0_0_0_rgba(255,255,255,0.25),inset_0_1px_0_0_rgba(255,255,255,0.25),inset_0_-1px_0_0_rgba(255,255,255,0.25)]';
const VALUE_END = 'relative after:content-[""] after:absolute after:inset-y-0 after:left-0 after:w-[var(--cap)] after:rounded-r-md after:border after:border-l-0 after:border-white/25 after:bg-white/[0.05]';
const EMPTY_VALUE_BOX = 'relative after:content-[""] after:absolute after:inset-y-0 after:left-0 after:w-[var(--slot)] after:rounded-r-md after:border after:border-dashed after:border-white/25 after:bg-white/[0.03]';
const MENTION = 'rounded bg-accent-primary/15 text-accent-primary';

/** Rough widths of the spaces a draft holds, in em; a plain space is about 0.28em. */
const SPACE_WIDTHS: Record<string, number> = { '\u2002': 0.5, '\u2003': 1, '\u2009': 0.2 };
const spaceWidth = (run: string): number => [...run].reduce((w, c) => w + (SPACE_WIDTHS[c] ?? 0.28), 0);

/** How far a capsule reaches past its text, in em: the name's left end, and the value's right end or empty slot. */
interface CapsuleRoom { name: number; value: number }

/** A capsule end at full size (about 6px), an empty slot between two capsules, and their gaps. */
const END = 0.4;
const SLOT = 1;
const SLOT_AT_END = 2;
const LINE_START = 0.25;
const MIN_GAP = 0.12;

/**
 * How far each capsule's ends reach into the spaces around it. With the
 * composer's spacing they get their full size. A run of spaces typed by hand
 * and left as is (a deletion is not respaced) can be narrower: between two
 * capsules it is then shared in proportion, keeping a small gap, and next to
 * other text an end takes what the run leaves, so capsules never run into
 * each other or over the text beside them.
 */
function capsuleRooms(text: string, frames: readonly ArgumentFrame[]): CapsuleRoom[] {
  const rooms = frames.map(() => ({ name: END, value: END }));
  const shared = new Set<number>();
  const isSpace = (char: string | undefined) => char !== undefined && /[^\S\n]/.test(char);
  frames.forEach((frame, i) => {
    const empty = frame.valueEnd === frame.valueStart;
    let end = frame.valueEnd;
    while (isSpace(text[end])) end++;
    const width = spaceWidth(text.slice(frame.valueEnd, end));
    const next = frames[i + 1];
    if (next && end === next.nameStart) {
      // Shared with the next capsule's name.
      const want = (empty ? SLOT : END) + END;
      const full = want + (empty ? 0.6 : 0.7);
      const k = width >= full ? 1 : Math.min(1, Math.max(0, width - MIN_GAP) / want);
      rooms[i]!.value = empty && width >= full ? width - END - 0.6 : (empty ? SLOT : END) * k;
      rooms[i + 1]!.name = END * k;
      shared.add(i + 1);
    } else if (end >= text.length || text[end] === '\n') {
      rooms[i]!.value = empty ? SLOT_AT_END : END;
    } else {
      rooms[i]!.value = Math.min(empty ? SLOT : END, Math.max(0, width - MIN_GAP));
    }
  });
  frames.forEach((frame, i) => {
    if (shared.has(i)) return;
    let start = frame.nameStart;
    while (isSpace(text[start - 1])) start--;
    rooms[i]!.name = start === 0 || text[start - 1] === '\n'
      ? LINE_START
      : Math.min(END, Math.max(0, spaceWidth(text.slice(start, frame.nameStart)) - 0.25));
  });
  return rooms;
}

type Region = 'name' | 'colon' | 'value';

/** Which capsule half `position` falls in: the frame's index and the region, or null outside every capsule. */
function regionAt(frames: readonly ArgumentFrame[], position: number): { frame: number; region: Region } | null {
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]!;
    if (position >= f.nameStart && position < f.colonAt) return { frame: i, region: 'name' };
    if (position >= f.colonAt && position < f.valueStart) return { frame: i, region: 'colon' };
    if (position >= f.valueStart && position < f.valueEnd) return { frame: i, region: 'value' };
  }
  return null;
}

/** A native textarea retains IME, selection and paste behavior; its mirror paints mentions and command arguments. */
export function MentionTextarea({ model, textareaRef, mentionAnchorRef, mentionStart, frames = [], ...props }: Props) {
  const mirrorRef = useRef<HTMLDivElement>(null);
  const anchor = mentionStart === undefined ? -1 : model.toDisplay(mentionStart);
  const marker = (
    <span ref={mentionAnchorRef} className="inline-block w-0 h-[1.375rem] align-bottom" />
  );
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    const mirror = mirrorRef.current;
    if (!textarea || !mirror) return;
    // Match native input metrics, including iOS's 16px font rule and scrollbar width.
    const sync = () => {
      const style = getComputedStyle(textarea);
      mirror.style.font = style.font;
      mirror.style.letterSpacing = style.letterSpacing;
      mirror.style.padding = style.padding;
      mirror.style.width = textarea.clientWidth + 'px';
      mirror.style.transform = 'translateY(-' + textarea.scrollTop + 'px)';
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [textareaRef, model.text]);

  // Every part is cut where an argument's name, colon or value starts or ends,
  // so each piece has one look; a mention keeps its own paint inside a value.
  const cuts = new Set<number>();
  for (const frame of frames) {
    cuts.add(frame.nameStart);
    cuts.add(frame.colonAt);
    cuts.add(frame.valueStart);
    cuts.add(frame.valueEnd);
  }
  const rooms = capsuleRooms(model.text, frames);
  const em = (n: number) => n.toFixed(3) + 'em';
  const emptySlots = new Map<number, string>();
  frames.forEach((frame, i) => {
    if (frame.valueEnd === frame.valueStart) emptySlots.set(frame.valueStart, em(rooms[i]!.value));
  });
  const slot = (at: number) => (
    <span key={`empty-${at}`} className={EMPTY_VALUE_BOX} style={{ '--slot': emptySlots.get(at) } as CSSProperties} />
  );

  // The pieces of one capsule half are wrapped together, so its frame is drawn once around them.
  const pieces: ReactNode[] = [];
  let group: { key: string; frame: number; region: Region; children: ReactNode[] } | null = null;
  const flush = () => {
    if (!group) return;
    const room = rooms[group.frame]!;
    pieces.push(group.region === 'value'
      ? <span key={group.key} className={VALUE_BOX}>
          {group.children}<span className={VALUE_END} style={{ '--cap': em(room.value) } as CSSProperties} />
        </span>
      : <span key={group.key} className={NAME_BOX} style={{ '--reach': em(room.name) } as CSSProperties}>
          {group.children}
        </span>);
    group = null;
  };
  model.parts.forEach((part, index) => {
    const end = part.start + part.text.length;
    const points = [part.start, ...[...cuts].filter((c) => c > part.start && c < end).sort((a, b) => a - b), end];
    for (let i = 0; i < points.length - 1; i++) {
      const from = points[i]!;
      const to = points[i + 1]!;
      // A value not written yet is still shown as a box to fill in.
      if (emptySlots.has(from)) { flush(); pieces.push(slot(from)); }
      const text = part.text.slice(from - part.start, to - part.start);
      const offset = anchor - from;
      const content = offset >= 0 && offset < text.length
        ? <>{text.slice(0, offset)}{marker}{text.slice(offset)}</> : text;
      const at = regionAt(frames, from);
      const classes = [part.painted ? MENTION : '', at?.region === 'colon' ? COLON : ''].filter(Boolean).join(' ');
      const piece = <span key={`${index}-${from}`} className={classes || undefined}>{content}</span>;
      const key = at ? `${at.frame}-${at.region === 'value' ? 'value' : 'name'}` : null;
      if (group && group.key !== key) flush();
      if (!at) { pieces.push(piece); continue; }
      group ??= { key: key!, frame: at.frame, region: at.region === 'value' ? 'value' : 'name', children: [] };
      group.children.push(piece);
    }
  });
  flush();
  // An empty value at the very end of the text has no piece to precede.
  if (emptySlots.has(model.text.length)) pieces.push(slot(model.text.length));

  return <div className="relative flex-1 min-w-0">
    <div aria-hidden="true" className="absolute inset-0 overflow-hidden pointer-events-none">
      <div ref={mirrorRef} className="py-[10px] px-1 text-[15px] leading-[1.375rem] text-txt-primary whitespace-pre-wrap break-words">
        {pieces}
        {'​'}
      </div>
    </div>
    {/* The mirror paints the text; the textarea keeps only its caret,
        selection and placeholder. */}
    <textarea {...props} ref={textareaRef} value={model.text}
      className={`${props.className ?? ''} text-transparent caret-txt-primary`}
      onScroll={event => {
        if (mirrorRef.current) mirrorRef.current.style.transform = 'translateY(-' + event.currentTarget.scrollTop + 'px)';
        props.onScroll?.(event);
      }} />
  </div>;
}
