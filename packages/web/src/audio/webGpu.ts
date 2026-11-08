/**
 * The slice of the WebGPU adapter API the local speech engines read. The DOM
 * lib shipped with TypeScript does not declare `navigator.gpu`, and these
 * engines only need the adapter's identity, so a structural type is enough.
 */
export interface GpuAdapterInfo {
  vendor?: string;
  architecture?: string;
  description?: string;
  isFallbackAdapter?: boolean;
}

export interface GpuAdapter {
  isFallbackAdapter?: boolean;
  info?: GpuAdapterInfo;
}

export interface GpuNavigator {
  requestAdapter(options?: { powerPreference?: 'low-power' | 'high-performance' }): Promise<GpuAdapter | null>;
}

/** The WebGPU entry point of the given navigator, or undefined where the browser has none. */
export function gpuOf(scope: { navigator: Navigator }): GpuNavigator | undefined {
  return (scope.navigator as Navigator & { gpu?: GpuNavigator }).gpu;
}
