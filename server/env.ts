/** Environment access that works in Netlify Functions, the local dev server and tests. */
export function env(name: string): string | undefined {
  const n = (globalThis as { Netlify?: { env?: { get(k: string): string | undefined } } }).Netlify;
  try {
    const v = n?.env?.get(name);
    if (v !== undefined && v !== "") return v;
  } catch { /* not in Netlify runtime */ }
  const v = process.env[name];
  return v === "" ? undefined : v;
}

export function isDevMode(): boolean {
  return env("UTILMO_DEV") === "1" || env("NETLIFY_DEV") === "true" || process.env.VITEST === "true";
}

const DEV_SECRETS: Record<string, string> = {
  SESSION_SECRET: "dev-session-secret-not-for-production-0123456789",
  ADMIN_AUTH_SECRET: "dev-admin-secret-not-for-production-0123456789",
  ENCRYPTION_KEY: "dev-encryption-key-not-for-production-0123456789",
  ADMIN_SETUP_TOKEN: "dev-setup-token",
};

const managed = new Map<string, string>();
let managedLoaded: Promise<void> | null = null;
const MANAGED = ["SESSION_SECRET", "ADMIN_AUTH_SECRET", "ENCRYPTION_KEY"] as const;

/**
 * Production secrets: environment variables win. If one is not configured, a 48-byte random value is
 * generated server-side once and stored in the database (app_secrets), so the app works out of the box
 * without secrets ever being handled by a person. ADMIN_SETUP_TOKEN is never auto-generated.
 */
export async function ensureSecrets(): Promise<void> {
  if (isDevMode() || MANAGED.every((n) => hasSecret(n))) return;
  if (!managedLoaded) {
    managedLoaded = (async () => {
      const { getDb } = await import("./db");
      const { randomBytes } = await import("node:crypto");
      for (const n of MANAGED) {
        if (hasSecret(n)) continue;
        await getDb().query(`INSERT INTO app_secrets (name, value) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING`, [n, randomBytes(48).toString("base64url")]);
        const r = await getDb().query<{ value: string }>(`SELECT value FROM app_secrets WHERE name = $1`, [n]);
        managed.set(n, r.rows[0].value);
      }
    })().catch((e) => { managedLoaded = null; throw e; });
  }
  await managedLoaded;
}

/** Secrets are mandatory in production; deterministic placeholders are used only in local dev/tests. */
export function secret(name: "SESSION_SECRET" | "ADMIN_AUTH_SECRET" | "ENCRYPTION_KEY" | "ADMIN_SETUP_TOKEN"): string {
  const v = env(name);
  if (v && v.length >= 16) return v;
  const m = managed.get(name);
  if (m) return m;
  if (isDevMode()) return DEV_SECRETS[name];
  if (name === "ADMIN_SETUP_TOKEN") throw Object.assign(new Error("ADMIN_SETUP_TOKEN is not configured"), { code: "setup_token_missing" });
  throw new Error(`Secret ${name} unavailable (call ensureSecrets first or set it in Netlify environment variables).`);
}

export function hasSecret(name: string): boolean {
  const v = env(name);
  return !!v && v.length >= 16;
}
