import type { ComposerAction } from '@backspace/shared/translation';

/**
 * Default actions available out-of-the-box.
 * User requirement: By default, ONLY 'polish' is retained.
 */
export const DEFAULT_COMPOSER_ACTIONS: ComposerAction[] = [
  {
    id: 'polish',
    label: 'Polish',
    icon: '✨',
    systemPrompt:
      'You are a professional writing assistant. Polish and refine the user\'s chat draft to improve fluency and clarity while preserving the original meaning. Output the revised text directly without any explanation or conversational remarks.',
    enabled: true,
  },
];

/**
 * Preset examples available as templates for users to add on demand.
 * Not active by default.
 */
export const PRESET_COMPOSER_EXAMPLES: Omit<ComposerAction, 'enabled'>[] = [
  {
    id: 'professional',
    label: 'Professional',
    icon: '💼',
    systemPrompt:
      'You are a professional business communication expert. Rewrite the user\'s chat draft in a polite, rigorous, and professional workplace tone. Output the revised text directly without any explanation.',
  },
  {
    id: 'concise',
    label: 'Concise',
    icon: '⚡',
    systemPrompt:
      'You are a communication efficiency expert. Condense and streamline the user\'s chat draft, eliminating unnecessary words to make it concise and clear. Output the streamlined text directly.',
  },
  {
    id: 'elaborate',
    label: 'Elaborate',
    icon: '📝',
    systemPrompt:
      'You are a writing assistant. Expand the user\'s chat draft with relevant details and context while preserving the original intent to make it more comprehensive. Output the rewritten text directly.',
  },
  {
    id: 'grammar',
    label: 'Fix Grammar',
    icon: '🔍',
    systemPrompt:
      'You are a meticulous proofreading expert. Correct spelling errors, punctuation mistakes, and grammatical issues in the user\'s draft. Output the corrected text directly.',
  },
  {
    id: 'translateToEnglish',
    label: 'Translate to English',
    icon: '🌐',
    systemPrompt:
      'You are a professional translator. Translate the user\'s draft into natural, fluent, and accurate English. Output the translated English text directly.',
  },
];

/**
 * Returns the localized label if a translation key exists (for built-in presets),
 * otherwise returns the user-defined label string.
 */
const PRESET_IDS = new Set(['polish', 'professional', 'concise', 'elaborate', 'grammar', 'translateToEnglish']);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getActionDisplayLabel(action: { id: string; label: string }, t: (key: any) => string): string {
  const translated = t(action.id);
  if (PRESET_IDS.has(action.id) || (translated && translated !== action.id)) {
    return translated;
  }
  return action.label;
}

export const TARGET_LANGUAGE_NAMES: Record<string, string> = {
  'zh-CN': 'Simplified Chinese',
  'zh-TW': 'Traditional Chinese',
  zh: 'Simplified Chinese',
  en: 'English',
  ja: 'Japanese',
  ko: 'Korean',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  pt: 'Portuguese',
  ru: 'Russian',
  ar: 'Arabic',
};

export function getTargetLanguageName(lang?: string | null): string {
  if (!lang) return 'English';
  return TARGET_LANGUAGE_NAMES[lang] || TARGET_LANGUAGE_NAMES[lang.split('-')[0] ?? ''] || lang;
}
