import type { TKey } from './i18n/t.ts';

export const BRAND_LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const BRAND_LOGO_MAX_BYTES = 2 * 1024 * 1024;
export const BRAND_CORRELATION_DISPOSITION_HEADER = 'x-supplyflow-correlation-disposition';
export const BRAND_CORRELATION_ROTATE_VALUE = 'rotate-after-definitive-failure';

const EXTENSION: Record<(typeof BRAND_LOGO_TYPES)[number], string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

export function brandLogoExtension(type: string) {
  return EXTENSION[type as keyof typeof EXTENSION] ?? null;
}

export function brandFailureAllowsNewCorrelation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const context = (error as { context?: unknown }).context;
  if (!context || typeof context !== 'object') return false;
  const headers = (context as { headers?: unknown }).headers;
  if (!headers || typeof headers !== 'object') return false;
  const get = (headers as { get?: unknown }).get;
  return typeof get === 'function'
    && get.call(headers, BRAND_CORRELATION_DISPOSITION_HEADER) === BRAND_CORRELATION_ROTATE_VALUE;
}

/**
 * The refusal, as a KEY. A pure module cannot ask what language the reader chose, and the name
 * carries `Key` so the compiler lists every screen that has to resolve one.
 */
export async function brandLogoProblemKey(file: File): Promise<TKey | null> {
  const extension = brandLogoExtension(file.type);
  if (!extension) return 'branding.logoTypeUnsupported';
  if (file.size > BRAND_LOGO_MAX_BYTES) return 'branding.logoTooLarge';
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const png = bytes.length >= 8
    && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => bytes[index] === byte);
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const webp = bytes.length >= 12
    && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF'
    && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
  if ((extension === 'png' && png) || (extension === 'jpg' && jpeg) || (extension === 'webp' && webp)) return null;
  return 'branding.logoContentMismatch';
}
