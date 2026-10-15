import type { TranslationLanguage } from '../../shared/src/translation';
import type { TranslationFetch } from './transport';
import { TranslationError } from './validation';

interface AnonymousRequest {
  engine: string;
  text: string;
  target: TranslationLanguage;
  fetcher: TranslationFetch;
}

export async function translateAnonymous(options: AnonymousRequest): Promise<string> {
  void options;
  throw new TranslationError('anonymous-unavailable');
}

