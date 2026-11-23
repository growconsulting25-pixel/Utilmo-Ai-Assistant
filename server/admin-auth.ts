import { b64url, hashPassword, hmac, ipHash, safeEqual, verifyPassword } from "./crypto";
import { getDb, one } from "./db";
import { isDevMode, secret } from "./env";
import { HttpError } from "./http";

export type Role = "owner" | "admin" | "editor" | "viewer";
export interface AdminSession { uid: string; org: string; role: Role; email: string; exp: number }

const COOKIE = "uai_admin";
const TTL_MS = 12 * 3600_000;
const ROLE_RANK: Record<Role, number> = { viewer: 1, editor: 2, admin: 3, owner: 4 };

export function signAdmin(s: AdminSession): string {
  const body = b64url(JSON.stringify(s));
  return `${body}.${hmac(secret("ADMIN_AUTH_SECRET"), "admin:" + body)}`;
}

function readCookie(req: Request, name: string): string | null {
  const h = req.headers.get("cookie") ?? "";
  for (const part of h.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export function sessionCookie(token: string, maxAgeSec: number): string {
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${isDevMode() ? "" : "; Secure"}`;
}

/** Verify the admin cookie + CSRF header, re-check the user is active, and enforce the minimum role. */
export async function requireAdmin(req: Request, minRole: Role = "viewer"): Promise<AdminSession> {
  const token = readCookie(req, COOKIE);
  if (!token) throw new HttpError(401, "unauthenticated");
  const [body, sig] = token.split(".");
  if (!body || !sig || !safeEqual(sig, hmac(secret("ADMIN_AUTH_SECRET"), "admin:" + body))) throw new HttpError(401, "unauthenticated");
  let s: AdminSession;
  try { s = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { throw new HttpError(401, "unauthenticated"); }
  if (Date.now() > s.exp) throw new HttpError(401, "session_expired");
  if (req.method !== "GET" && req.headers.get("x-requested-with") !== "utilmo-admin") throw new HttpError(403, "csrf_check_failed");
  const u = await one<{ active: boolean; role: Role }>(`SELECT active, role FROM admin_users WHERE id = $1 AND organization_id = $2`, [s.uid, s.org]);
  if (!u || !u.active) throw new HttpError(401, "unauthenticated");
  s.role = u.role;
  if (ROLE_RANK[s.role] < ROLE_RANK[minRole]) throw new HttpError(403, "forbidden", `Requires role ${minRole}`);
  return s;
}

export async function login(email: string, password: string, ip: string): Promise<{ token: string; session: AdminSession }> {
  const u = await one<{ id: string; organization_id: string; email: string; password_hash: string; role: Role; active: boolean; failed_logins: number; locked_until: string | null }>(
    `SELECT * FROM admin_users WHERE email = lower($1)`, [email.trim()]);
  const fail = async () => {
    if (u) await getDb().query(`UPDATE admin_users SET failed_logins = failed_logins + 1, locked_until = CASE WHEN failed_logins + 1 >= 5 THEN now() + interval '15 minutes' ELSE locked_until END WHERE id = $1`, [u.id]);
    await audit(u?.organization_id ?? null, u?.id ?? null, "admin.login_failed", "admin_user", u?.id ?? null, { email_hash: hmac("x", email.toLowerCase()).slice(0, 12) }, ip);
    throw new HttpError(401, "invalid_credentials", "Invalid e-mail or password.");
  };
  if (!u || !u.active) { await hashPassword("timing-equaliser"); return fail(); }
  if (u.locked_until && new Date(u.locked_until) > new Date()) throw new HttpError(423, "account_locked", "Too many attempts. Try again in 15 minutes.");
  if (!(await verifyPassword(password, u.password_hash))) return fail();
  await getDb().query(`UPDATE admin_users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1`, [u.id]);
  const session: AdminSession = { uid: u.id, org: u.organization_id, role: u.role, email: u.email, exp: Date.now() + TTL_MS };
  await audit(u.organization_id, u.id, "admin.login", "admin_user", u.id, {}, ip);
  return { token: signAdmin(session), session };
}

export function validatePassword(pw: string): string | null {
  if (pw.length < 12) return "Password must be at least 12 characters.";
  if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw) || !/\d/.test(pw)) return "Password must include upper and lower case letters and a digit.";
  return null;
}

export async function audit(orgId: string | null, adminId: string | null, action: string, targetType: string | null, targetId: string | null, details: Record<string, unknown> = {}, ip?: string) {
  await getDb().query(`INSERT INTO audit_logs (organization_id, admin_user_id, action, target_type, target_id, details, ip_hash) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [orgId, adminId, action, targetType, targetId, JSON.stringify(details), ip ? ipHash(ip) : null]).catch((e) => console.warn("[audit]", String(e)));
}

export function setupTokenMatches(token: string): boolean {
  return safeEqual(hmac("setup", token), hmac("setup", secret("ADMIN_SETUP_TOKEN")));
}
