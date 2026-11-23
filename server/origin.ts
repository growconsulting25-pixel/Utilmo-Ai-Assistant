import { env, isDevMode } from "./env";

export function hostMatches(host: string, pattern: string): boolean {
  host = host.toLowerCase(); pattern = pattern.toLowerCase().trim();
  if (pattern.startsWith("*.")) return host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1;
  return host === pattern;
}

/** Hosts of this deployment itself (the demo page and admin are always allowed). */
export function selfHosts(req: Request): string[] {
  const hosts = new Set<string>();
  for (const k of ["URL", "DEPLOY_PRIME_URL", "DEPLOY_URL", "APP_BASE_URL"]) {
    const v = env(k);
    if (v) try { hosts.add(new URL(v).host); } catch { /* ignore */ }
  }
  try { hosts.add(new URL(req.url).host); } catch { /* ignore */ }
  return [...hosts];
}

/**
 * Validate the browser Origin against the assistant's allowed domains.
 * Note: Origin can be forged by non-browser clients, so this is combined with signed sessions,
 * rate limits and daily caps — it is never the only protection.
 */
export function checkOrigin(req: Request, allowedDomains: string[]): { ok: boolean; origin: string | null } {
  const origin = req.headers.get("origin");
  if (!origin) return { ok: false, origin: null };
  let host: string;
  try { host = new URL(origin).host; } catch { return { ok: false, origin }; }
  const hostname = host.split(":")[0];
  if (selfHosts(req).includes(host)) return { ok: true, origin };
  const extra = (env("ALLOWED_WIDGET_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean)
    .map((s) => { try { return s.includes("://") ? new URL(s).hostname : s; } catch { return s; } });
  if ([...allowedDomains, ...extra].some((d) => hostMatches(hostname, d))) return { ok: true, origin };
  if ((isDevMode() || env("ALLOW_LOCALHOST_ORIGINS") === "true") && (hostname === "localhost" || hostname === "127.0.0.1")) return { ok: true, origin };
  return { ok: false, origin };
}
