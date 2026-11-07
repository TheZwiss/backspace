import { readFileSync, readdirSync } from 'fs';

/**
 * Aceleração de vídeo por hardware (VA-API) no Linux.
 *
 * Em Intel e AMD o VA-API usa o Mesa que o sistema já tem, então basta ligar as
 * features do Chromium - nada para baixar. Em NVIDIA o Chromium ignora de
 * propósito o dispositivo nvidia-drm ("Should skip nVidia device"), então ligar
 * as features não muda nada; nesses sistemas o vídeo segue em software.
 */
const PCI_VENDOR_INTEL = '0x8086';
const PCI_VENDOR_AMD = '0x1002';

export const LINUX_VIDEO_ACCELERATION_FEATURES = [
  'AcceleratedVideoDecodeLinuxGL',
  'AcceleratedVideoDecodeLinuxZeroCopyGL',
  'AcceleratedVideoEncoder',
] as const;

/** Lê o vendor PCI de cada GPU em /sys/class/drm; vazio quando o sysfs não está disponível. */
export function readGpuVendors(
  listCards: () => string[] = () => readdirSync('/sys/class/drm'),
  readVendor: (card: string) => string = (card) => readFileSync(`/sys/class/drm/${card}/device/vendor`, 'utf8'),
): string[] {
  const vendors: string[] = [];
  try {
    for (const card of listCards()) {
      if (!/^card\d+$/.test(card)) continue;
      try {
        vendors.push(readVendor(card).trim().toLowerCase());
      } catch {
        // Cartão sem vendor legível (ex.: dispositivo virtual): ignora.
      }
    }
  } catch {
    return [];
  }
  return vendors;
}

/**
 * Features de decodificação/codificação por hardware a ligar, ou [] quando não
 * há garantia de que ajudam. Só liga quando todas as GPUs são Intel ou AMD:
 * qualquer NVIDIA (inclusive em notebook híbrido) mantém o caminho em software.
 */
export function linuxVideoAccelerationFeatures(
  platform: NodeJS.Platform = process.platform,
  vendors: string[] = readGpuVendors(),
): string[] {
  if (platform !== 'linux' || vendors.length === 0) return [];
  const supported = vendors.every((v) => v === PCI_VENDOR_INTEL || v === PCI_VENDOR_AMD);
  return supported ? [...LINUX_VIDEO_ACCELERATION_FEATURES] : [];
}
