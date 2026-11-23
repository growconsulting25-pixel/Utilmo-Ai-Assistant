import { findPhoneNumbersInText, parsePhoneNumberFromString } from "libphonenumber-js";
import type { ProfileUpdate } from "./profile";

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}/g;

export function normalizeEmail(email: string): string | null {
  const e = email.trim().toLowerCase();
  if (e.length > 254) return null;
  if (!/^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,24}$/.test(e)) return null;
  if (e.includes("..")) return null;
  return e;
}

/** Normalise to E.164. Canadian/NANP numbers are assumed when no country code is present. */
export function normalizePhone(raw: string): string | null {
  const p = parsePhoneNumberFromString(raw, "CA");
  if (!p || !p.isValid()) return null;
  return p.number; // E.164
}

export function extractEmails(text: string): string[] {
  return Array.from(new Set((text.match(EMAIL_RE) ?? []).map(normalizeEmail).filter((e): e is string => !!e)));
}

export function extractPhones(text: string): string[] {
  const out = new Set<string>();
  for (const m of findPhoneNumbersInText(text, "CA")) if (m.number.isValid()) out.add(m.number.number);
  // Also accept international numbers written with "+".
  for (const m of text.matchAll(/\+\d[\d\s().-]{7,18}\d/g)) {
    const n = normalizePhone(m[0]);
    if (n) out.add(n);
  }
  return Array.from(out);
}

const NAME_PREFIX = /(?:je m'appelle|je m’appelle|mon nom est|mon nom c'est|moi c'est|my name is|this is|ici)\s+/iu;
const NAME_RE = /^([A-ZÀ-ÖØ-Þ][a-zà-öø-ÿ'’-]+)(?:\s+([A-ZÀ-ÖØ-Þ][a-zà-öø-ÿ'’-]+(?:-[A-ZÀ-ÖØ-Þ][a-zà-öø-ÿ'’-]+)?))?/u;
const NOT_NAMES = new Set(["courtier", "broker", "agent", "intéressé", "interested", "client", "nouveau", "new", "here", "ici", "pas", "not", "looking", "ok", "un", "une", "a", "an"]);

/** Conservative pattern-based name detection (the LLM analyzer handles harder cases). */
export function extractName(text: string): { first?: string; last?: string } {
  const p = text.match(NAME_PREFIX);
  if (!p || p.index === undefined) return {};
  const m = text.slice(p.index + p[0].length).match(NAME_RE);
  if (!m || NOT_NAMES.has(m[1].toLowerCase())) return {};
  return { first: m[1], last: m[2] && !NOT_NAMES.has(m[2].toLowerCase()) ? m[2] : undefined };
}

/** Deterministic extraction of contact data. These are treated as high-confidence ("pattern"). */
export function extractContact(text: string): ProfileUpdate {
  const u: ProfileUpdate = {};
  const emails = extractEmails(text);
  if (emails[0]) u.email = { value: emails[0], source: "pattern" };
  // Avoid reading digits inside an e-mail as a phone number.
  const phones = extractPhones(text.replace(EMAIL_RE, " "));
  if (phones[0]) u.phone = { value: phones[0], source: "pattern" };
  const n = extractName(text);
  if (n.first) u.first_name = { value: n.first, source: "pattern" };
  if (n.last) u.last_name = { value: n.last, source: "pattern" };
  return u;
}

const EN_WORDS = /\b(the|and|i|you|my|is|are|what|how|do|does|can|need|want|leads?|website|price|hello|hi|thanks|please|with|for|your|have|more)\b/gi;
const FR_WORDS = /\b(le|la|les|et|je|vous|mon|ma|mes|est|sont|quoi|comment|pouvez|besoin|veux|voudrais|site|prix|bonjour|merci|avec|pour|votre|avoir|plus|des|un|une|du|j'ai|c'est)\b/gi;

/** Cheap language detection used as a fallback and to validate the LLM's guess. */
export function detectLanguage(text: string, fallback: "fr" | "en" = "fr"): "fr" | "en" {
  const en = (text.match(EN_WORDS) ?? []).length;
  const fr = (text.match(FR_WORDS) ?? []).length + (/[éèêàùçâîôû]/i.test(text) ? 2 : 0);
  if (en === fr) return fallback;
  return en > fr ? "en" : "fr";
}
