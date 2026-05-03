/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FORCE_BOOT_STALL?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url' {
  const url: string;
  export default url;
}
declare module '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url' {
  const url: string;
  export default url;
}
declare module '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url' {
  const url: string;
  export default url;
}
