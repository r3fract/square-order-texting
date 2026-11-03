import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Square signs each webhook with HMAC-SHA256 over (notification URL + raw body),
 * base64-encoded, in the x-square-hmacsha256-signature header.
 */
export function verifySquareSignature(opts: {
  signatureKey: string;
  notificationUrl: string;
  rawBody: string;
  signature: string | undefined;
}): boolean {
  if (!opts.signature) return false;
  const expected = createHmac("sha256", opts.signatureKey).update(opts.notificationUrl + opts.rawBody).digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(opts.signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function signSquareBody(signatureKey: string, notificationUrl: string, rawBody: string): string {
  return createHmac("sha256", signatureKey).update(notificationUrl + rawBody).digest("base64");
}
