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

/** Secrets are mandatory in production; deterministic placeholders are used only in local dev/tests. */
export function secret(name: "SESSION_SECRET" | "ADMIN_AUTH_SECRET" | "ENCRYPTION_KEY" | "ADMIN_SETUP_TOKEN"): string {
  const v = env(name);
  if (v && v.length >= 16) return v;
  if (isDevMode()) return DEV_SECRETS[name];
  throw new Error(`Missing or too short secret: ${name} (min 16 chars). Configure it in Netlify environment variables.`);
}

export function hasSecret(name: string): boolean {
  const v = env(name);
  return !!v && v.length >= 16;
}
