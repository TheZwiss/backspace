declare module '@echogarden/espeak-ng-emscripten' {
  export interface EspeakPhonemes {
    ptr: number;
  }
  export interface EspeakWorker {
    set_voice(voice: string): void;
    convert_to_phonemes(text: string, ipa: boolean): EspeakPhonemes;
  }
  export interface EspeakModule {
    HEAPU8: Uint8Array;
    _free(pointer: number): void;
    eSpeakNGWorker: new () => EspeakWorker;
  }
  export default function initialize(options?: Record<string, unknown>): Promise<EspeakModule>;
}
