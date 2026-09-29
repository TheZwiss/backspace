import { useLayoutEffect, useRef, type RefObject, type TextareaHTMLAttributes } from 'react';
import type { ComposerMentions } from './composerMentions';

interface Props extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  model: ComposerMentions;
  textareaRef: RefObject<HTMLTextAreaElement>;
  mentionAnchorRef: RefObject<HTMLSpanElement>;
  mentionStart?: number;
}

/** A native textarea retains IME, selection and paste behavior; its mirror paints mentions. */
export function MentionTextarea({ model, textareaRef, mentionAnchorRef, mentionStart, ...props }: Props) {
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
  return <div className="relative flex-1 min-w-0">
    <div aria-hidden="true" className="absolute inset-0 overflow-hidden pointer-events-none">
      <div ref={mirrorRef} className="py-[10px] px-1 text-[15px] leading-[1.375rem] whitespace-pre-wrap break-words" style={{ overflowWrap: 'break-word' }}>
        {model.parts.map((part, index) => {
          const offset = anchor - part.start;
          const content = offset >= 0 && offset < part.text.length
            ? <>{part.text.slice(0, offset)}{marker}{part.text.slice(offset)}</> : part.text;
          return <span key={index} className={part.mention ? 'rounded bg-accent-primary/15 text-accent-primary' : undefined}>{content}</span>;
        })}
        {'\u200b'}
      </div>
    </div>
    <textarea {...props} ref={textareaRef} value={model.text}
      style={{ ...props.style, color: 'transparent', caretColor: 'var(--color-txt-primary, #fff)', background: 'transparent' }}
      onScroll={event => {
        if (mirrorRef.current) mirrorRef.current.style.transform = 'translateY(-' + event.currentTarget.scrollTop + 'px)';
        props.onScroll?.(event);
      }} />
  </div>;
}
