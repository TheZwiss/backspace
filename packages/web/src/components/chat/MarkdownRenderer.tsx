import React from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Highlight, themes } from 'prism-react-renderer';
import type { Components } from 'react-markdown';
import { MentionBadge } from './MentionBadge';

// ─── Remark Plugin: Tag Bare Fenced Blocks ─────────────────────────────────
// react-markdown v9 removed the `inline` prop from <code>. Fenced blocks
// without a language hint have no className, making them indistinguishable
// from inline code. This plugin assigns `lang: 'text'` to bare fenced blocks
// so that `className="language-text"` is always present on block-level code.

interface MdastNode {
  type: string;
  lang?: string | null;
  children?: MdastNode[];
}

function remarkDefaultCodeLang() {
  return (tree: MdastNode) => {
    walkTree(tree);
  };
}

function walkTree(node: MdastNode) {
  if (node.type === 'code' && !node.lang) {
    node.lang = 'text';
  }
  if (node.children) {
    for (const child of node.children) {
      walkTree(child);
    }
  }
}

// ─── Pre-processing: Mention Tokens ─────────────────────────────────────────
// remark-parse mangles <@userId> (treats as autolink or escapes the angle
// brackets) before remark plugins can see the text nodes. We solve this by
// converting mention tokens to standard markdown links BEFORE the parser
// runs. The `a` component override then detects the mention:// scheme.
// Code spans and fenced blocks are matched first and preserved as-is.

function preprocessMentions(raw: string): string {
  return raw.replace(
    /(```[\s\S]*?```|`[^`]+`)|<@([a-zA-Z0-9_-]+)>/g,
    (match, codeBlock: string | undefined, userId: string | undefined) => {
      if (codeBlock) return codeBlock;
      return `[@${userId}](mention://${userId})`;
    },
  );
}

// ─── URL Transform: Allow mention:// Scheme ─────────────────────────────────
// react-markdown v9's defaultUrlTransform strips URLs with unknown protocols.
// We whitelist mention:// so the `a` component override receives the full href.

function urlTransform(url: string): string {
  if (url.startsWith('mention://')) return url;
  return defaultUrlTransform(url);
}

// ─── Custom Theme (Aether Drift) ──────────────────────────────────────────
// Based on One Dark, tuned to match Aether Drift's elevated surface aesthetic.

const aetherTheme = {
  ...themes.oneDark,
  plain: {
    ...themes.oneDark.plain,
    backgroundColor: 'var(--bg-elevated)',
    color: 'var(--text-message)',
  },
};

// ─── Markdown Component Overrides ──────────────────────────────────────────

const REMARK_PLUGINS = [remarkGfm, remarkDefaultCodeLang];

function CodeBlock({ language, code }: { language: string; code: string }) {
  // 'text' means a bare fenced block with no language — render without highlighting
  if (language === 'text') {
    return (
      <pre className="mt-1 p-3 bg-surface-elevated border border-border-hard/50 rounded text-[0.875rem] leading-[1.125rem] font-mono overflow-x-auto whitespace-pre">
        <code>{code}</code>
      </pre>
    );
  }

  return (
    <Highlight theme={aetherTheme} code={code} language={language}>
      {({ style, tokens, getLineProps, getTokenProps }) => (
        <pre
          className="mt-1 rounded border border-border-hard/50 text-[0.875rem] leading-[1.125rem] font-mono overflow-x-auto"
          style={{ ...style, padding: '0.625rem 0.75rem', margin: 0 }}
        >
          {tokens.map((line, i) => {
            const lineProps = getLineProps({ line });
            return (
              <div key={i} {...lineProps} style={{ ...lineProps.style, minHeight: '1.125rem' }}>
                {line.map((token, key) => (
                  <span key={key} {...getTokenProps({ token })} />
                ))}
              </div>
            );
          })}
        </pre>
      )}
    </Highlight>
  );
}

const MemoizedCodeBlock = React.memo(CodeBlock);

function buildComponents(): Components {
  return {
    // Paragraphs → spans to avoid block nesting issues in chat messages
    p: ({ children }) => <span className="block">{children}</span>,

    // Links & Mentions
    // remark-parse autolinks <@userId> into mailto:@userId before plugins run,
    // so we intercept that pattern here instead of using a remark plugin.
    a: ({ href, children }) => {
      if (href?.startsWith('mention://')) {
        return <MentionBadge userId={href.slice('mention://'.length)} />;
      }
      const mentionMatch = href?.match(/^(?:mailto:)?@([a-zA-Z0-9_-]+)$/);
      if (mentionMatch) {
        return <MentionBadge userId={mentionMatch[1]!} />;
      }
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-txt-link hover:underline"
        >
          {children}
        </a>
      );
    },

    // Fenced code blocks (have className from our remark plugin) vs inline code
    code: ({ className, children, ...rest }) => {
      const match = /language-(\w+)/.exec(className || '');
      if (match) {
        const code = String(children).replace(/\n$/, '');
        return <MemoizedCodeBlock language={match[1]!} code={code} />;
      }
      // Inline code
      return (
        <code
          className="px-[0.35em] py-[0.15em] bg-surface-elevated rounded-[3px] text-[0.875em] font-mono text-accent-coral"
          {...rest}
        >
          {children}
        </code>
      );
    },

    // Override <pre> to be a minimal wrapper — the CodeBlock handles all styling
    pre: ({ children }) => <>{children}</>,

    // Bold / Italic / Strikethrough
    strong: ({ children }) => <strong className="font-bold text-txt-primary">{children}</strong>,
    em: ({ children }) => <em className="italic">{children}</em>,
    del: ({ children }) => <del className="line-through text-txt-secondary">{children}</del>,

    // Blockquotes
    blockquote: ({ children }) => (
      <blockquote className="pl-3 border-l-[3px] border-interactive-muted my-0.5">
        {children}
      </blockquote>
    ),

    // Lists
    ul: ({ children }) => <ul className="list-disc pl-6 my-0.5 space-y-0.5">{children}</ul>,
    ol: ({ children }) => <ol className="list-decimal pl-6 my-0.5 space-y-0.5">{children}</ol>,
    li: ({ children }) => <li>{children}</li>,

    // Headings — Discord renders these with slightly larger/bolder text
    h1: ({ children }) => <div className="text-[1.5rem] font-bold text-txt-primary mt-2 mb-1">{children}</div>,
    h2: ({ children }) => <div className="text-[1.25rem] font-bold text-txt-primary mt-2 mb-1">{children}</div>,
    h3: ({ children }) => <div className="text-[1.1rem] font-bold text-txt-primary mt-1 mb-0.5">{children}</div>,

    // Horizontal rules
    hr: () => <hr className="border-border-soft my-2" />,

    // Images (in markdown content — not attachments)
    img: ({ src, alt }) => (
      <img
        src={src}
        alt={alt ?? ''}
        className="max-w-full max-h-[350px] rounded-md mt-1"
        loading="lazy"
      />
    ),

    // Tables (GFM)
    table: ({ children }) => (
      <div className="overflow-x-auto my-1">
        <table className="border-collapse text-[0.875rem]">{children}</table>
      </div>
    ),
    thead: ({ children }) => <thead className="border-b border-border-soft">{children}</thead>,
    tbody: ({ children }) => <tbody>{children}</tbody>,
    tr: ({ children }) => <tr className="border-b border-border-soft/50">{children}</tr>,
    th: ({ children }) => <th className="px-3 py-1.5 text-left text-txt-primary font-semibold">{children}</th>,
    td: ({ children }) => <td className="px-3 py-1.5">{children}</td>,
  };
}

// Build once and reuse — the components object is static
const MARKDOWN_COMPONENTS = buildComponents();

// ─── Public Component ──────────────────────────────────────────────────────

interface MarkdownRendererProps {
  content: string;
}

export const MarkdownRenderer = React.memo(function MarkdownRenderer({ content }: MarkdownRendererProps) {
  return (
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS} urlTransform={urlTransform}>
      {preprocessMentions(content)}
    </ReactMarkdown>
  );
});
