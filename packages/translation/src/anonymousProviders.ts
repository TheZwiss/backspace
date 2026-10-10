import type { TranslationLanguage } from '../../shared/src/translation';
import { parseJson, requestText, type TranslationFetch } from './transport';
import { TranslationError, record } from './validation';
interface AnonymousRequest {
  engine: string;
  text: string;
  target: TranslationLanguage;
  fetcher: TranslationFetch;
}
async function google(options: AnonymousRequest): Promise<string> {
  const query = new URLSearchParams({
    client: 'gtx',
    sl: 'auto',
    tl: options.target,
    dt: 't',
    q: options.text,
  });
  const raw = await requestText({
    url: `https://translate.googleapis.com/translate_a/single?${query}`,
    fetcher: options.fetcher,
  });
  const value = parseJson(raw);
  if (
    !Array.isArray(value) ||
    !Array.isArray(value[0]) ||
    !value[0].every((part: unknown) => Array.isArray(part) && typeof part[0] === 'string')
  )
    throw new TranslationError('invalid-response');
  return value[0].map((part: string[]) => part[0]).join('');
}
function bingSession(html: string) {
  const parameters = /params_AbusePreventionHelper\s*=\s*(\[[^;]+?\])\s*;/.exec(html)?.[1];
  const ig = /IG:"([A-Za-z0-9]+)"/.exec(html)?.[1];
  const iid = /data-iid="(translator\.[\w.]+)"/.exec(html)?.[1];
  if (!parameters || !ig || !iid) throw new TranslationError('anonymous-unavailable');
  const parametersValue = parseJson(parameters);
  if (!Array.isArray(parametersValue)) throw new TranslationError('anonymous-unavailable');
  const [key, token] = parametersValue;
  if (typeof key !== 'number' || typeof token !== 'string')
    throw new TranslationError('anonymous-unavailable');
  return { key, token, ig, iid };
}
async function microsoft(options: AnonymousRequest): Promise<string> {
  // Public Bing web-session parameters are ephemeral and never persisted. No CAPTCHA bypass or alternate-host retry.
  const html = await requestText({
    url: 'https://www.bing.com/translator',
    maxBytes: 1024 * 1024,
    fetcher: options.fetcher,
  });
  const { key, token, ig, iid } = bingSession(html);
  const target =
    { 'zh-CN': 'zh-Hans', 'zh-TW': 'zh-Hant' }[options.target as 'zh-CN' | 'zh-TW'] ?? options.target;
  const body = new URLSearchParams({
    fromLang: 'auto-detect',
    to: target,
    text: options.text,
    key: String(key),
    token,
  });
  const url = `https://www.bing.com/ttranslatev3?${new URLSearchParams({ isVertical: '1', IG: ig, IID: iid })}`;
  const response = parseJson(
    await requestText({
      url,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      },
      fetcher: options.fetcher,
    }),
  );
  if (!Array.isArray(response)) throw new TranslationError('anonymous-unavailable');
  const translations = record(response[0]).translations;
  if (!Array.isArray(translations)) throw new TranslationError('anonymous-unavailable');
  const text = record(translations[0]).text;
  if (typeof text !== 'string') throw new TranslationError('anonymous-unavailable');
  return text;
}
export async function translateAnonymous(options: AnonymousRequest): Promise<string> {
  // Web endpoints have smaller practical limits. Do not silently split/send additional requests.
  if (options.text.length > 3000) throw new TranslationError('invalid-input');
  try {
    return await (options.engine === 'google-free' ? google(options) : microsoft(options));
  } catch (error) {
    if (error instanceof TranslationError) throw error;
    throw new TranslationError('anonymous-unavailable');
  }
}
