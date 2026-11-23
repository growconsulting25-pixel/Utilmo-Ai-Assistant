import { b64url, hmac, safeEqual } from "./crypto";
import { secret } from "./env";

export interface SessionClaims { a: string; v: string; c: string; iat: number }

/** Signed, opaque-to-the-client session token binding visitor + conversation + assistant. */
export function signSession(claims: SessionClaims): string {
  const body = b64url(JSON.stringify(claims));
  return `${body}.${hmac(secret("SESSION_SECRET"), "session:" + body)}`;
}

export function verifySession(token: string | null | undefined, assistantKey: string, maxAgeDays: number): SessionClaims | null {
  if (!token || token.length > 600) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  if (!safeEqual(sig, hmac(secret("SESSION_SECRET"), "session:" + body))) return null;
  try {
    const c = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionClaims;
    if (c.a !== assistantKey) return null;
    if (Date.now() - c.iat > maxAgeDays * 86400_000) return null;
    return c;
  } catch { return null; }
}
