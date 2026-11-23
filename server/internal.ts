import { hmac, safeEqual } from "./crypto";
import { secret } from "./env";
import type { AssistantCtx } from "./tenant";

/** Signed internal call to the background crawler (never callable without the server secret). */
export function crawlTrigger(origin: string) {
  return async (a: AssistantCtx, sourceId: string) => {
    const body = JSON.stringify({ assistantId: a.id, organizationId: a.organizationId, sourceId, ts: Date.now() });
    const res = await fetch(`${origin}/api/internal/crawl`, { method: "POST", headers: { "content-type": "application/json", "x-internal-signature": hmac(secret("ADMIN_AUTH_SECRET"), "crawl:" + body) }, body });
    if (res.status >= 400) throw new Error(`crawl trigger HTTP ${res.status}`);
  };
}

export function verifyInternal(body: string, sig: string | null): boolean {
  if (!sig) return false;
  try {
    const parsed = JSON.parse(body) as { ts: number };
    if (Math.abs(Date.now() - parsed.ts) > 5 * 60_000) return false;
  } catch { return false; }
  return safeEqual(sig, hmac(secret("ADMIN_AUTH_SECRET"), "crawl:" + body));
}
