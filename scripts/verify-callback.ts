import { safeHexEqual, signCallback } from '../packages/security/src/index.js';

export function verifyCallback(
  secret: string,
  timestamp: string,
  signature: string,
  rawBody: Buffer,
  now = new Date(),
): boolean {
  if (!/^\d{10}$/.test(timestamp)) return false;
  if (Math.abs(now.getTime() - Number(timestamp) * 1000) > 300_000) return false;
  return safeHexEqual(signCallback(secret, timestamp, rawBody), signature);
}
