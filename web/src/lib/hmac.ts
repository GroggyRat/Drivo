import { createHmac, timingSafeEqual } from "node:crypto";

// KaiTech webhook signing (docs/integrations.md):
//   X-KaiTech-Signature: v1=<hex HMAC-SHA256 of "<timestamp>.<raw body>">
// Each link has its own secret, derived from the environment's master secret
// and the linked organisation id, so one leaked link secret does not expose
// the others.

export const MAX_AGE_SECONDS = 300;

export function linkSecret(masterSecret: string, organisationId: string): string {
  return createHmac("sha256", masterSecret).update(`kaitech-link:${organisationId}`).digest("hex");
}

export function sign(secret: string, timestamp: string, body: string): string {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

export type VerifyResult = { ok: true } | { ok: false; reason: "missing" | "stale" | "bad_signature" };

export function verify(
  secret: string,
  headers: { timestamp: string | null; signature: string | null },
  body: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): VerifyResult {
  if (!headers.timestamp || !headers.signature) return { ok: false, reason: "missing" };
  const ts = Number(headers.timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > MAX_AGE_SECONDS) return { ok: false, reason: "stale" };
  const expected = Buffer.from(sign(secret, headers.timestamp, body));
  const given = Buffer.from(headers.signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: "bad_signature" };
  return { ok: true };
}

export function signedHeaders(secret: string, event: string, body: string, deliveryId: string, nowSeconds = Math.floor(Date.now() / 1000)) {
  const timestamp = String(nowSeconds);
  return {
    "Content-Type": "application/json",
    "X-KaiTech-Event": event,
    "X-KaiTech-Delivery": deliveryId,
    "X-KaiTech-Timestamp": timestamp,
    "X-KaiTech-Signature": sign(secret, timestamp, body),
  };
}
