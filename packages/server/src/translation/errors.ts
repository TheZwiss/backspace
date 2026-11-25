export type TranslationFaultCode =
  | 'invalid_input'
  | 'unsafe_endpoint'
  | 'text_too_long'
  | 'provider_failed'
  | 'protected_content'
  | 'storage_error';

export class TranslationFault extends Error {
  constructor(
    public readonly code: TranslationFaultCode,
    public readonly httpStatus?: number,
  ) {
    super(code);
    this.name = 'TranslationFault';
  }
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TranslationFault('invalid_input');
  }
  return value as Record<string, unknown>;
}
