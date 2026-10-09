// Kept dependency-free: config.ts imports this during startup validation.
const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const FORMAT = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** Validates GSTIN structure (state code, PAN, entity, 'Z') and its mod-36 check character. */
export function isValidGstin(gstin: string): boolean {
  if (!FORMAT.test(gstin)) return false;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const product = CHARS.indexOf(gstin[i]!) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return CHARS[(36 - (sum % 36)) % 36] === gstin[14];
}
