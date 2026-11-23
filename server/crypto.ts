import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { secret } from "./env";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;

export const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const hmac = (key: string, data: string) => createHmac("sha256", key).update(data).digest("hex");
export const randomToken = (bytes = 24) => randomBytes(bytes).toString("base64url");

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** scrypt password hashing (N=2^15). Format: scrypt$N$r$p$salt$hash */
export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const N = 32768, r = 8, p = 1;
  const key = await scrypt(pw, salt, 64, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${key.toString("base64")}`;
}
export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, N, r, p, salt, hash] = stored.split("$");
  if (alg !== "scrypt") return false;
  const key = await scrypt(pw, Buffer.from(salt, "base64"), 64, { N: +N, r: +r, p: +p, maxmem: 64 * 1024 * 1024 });
  return timingSafeEqual(key, Buffer.from(hash, "base64"));
}

function encKey(): Buffer {
  return createHash("sha256").update("utilmo-ai:enc:" + secret("ENCRYPTION_KEY")).digest();
}
/** AES-256-GCM for integration secrets stored at rest. */
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", encKey(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1.${iv.toString("base64url")}.${c.getAuthTag().toString("base64url")}.${enc.toString("base64url")}`;
}
export function decrypt(blob: string): string {
  const [v, iv, tag, data] = blob.split(".");
  if (v !== "v1") throw new Error("bad ciphertext");
  const d = createDecipheriv("aes-256-gcm", encKey(), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(data, "base64url")), d.final()]).toString("utf8");
}

/** Privacy-preserving IP hash, rotating daily (used for rate limiting and audit, never stored raw). */
export function ipHash(ip: string | undefined | null): string {
  const day = new Date().toISOString().slice(0, 10);
  return hmac(secret("SESSION_SECRET"), `ip:${day}:${ip ?? "unknown"}`).slice(0, 32);
}
