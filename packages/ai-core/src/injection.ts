/** Heuristic detection of prompt-injection / exfiltration attempts (defence in depth; the model is also instructed). */
const PATTERNS: RegExp[] = [
  /ignore (all |any )?(previous|prior|above|earlier) (instructions|rules|prompts?)/i,
  /(ignore|oublie|oubliez) (toutes? )?(les |tes |vos )?(instructions|règles|consignes)/i,
  /(system|developer|hidden) prompt/i,
  /(prompt|instructions?) (système|systeme|cachée?s?)/i,
  /(reveal|show|print|display|give me|révèle|montre|affiche|donne[- ]moi).{0,40}(prompt|instructions|api[ _-]?key|secret|token|clé|cle|password|mot de passe)/i,
  /(you are|tu es|vous êtes) (now|maintenant) /i,
  /\b(DAN|jailbreak|developer mode|mode développeur)\b/i,
  /(list|export|dump|liste|exporte).{0,40}(leads?|clients?|customers?|contacts?|prospects?|database|base de données)/i,
  /(other|autres?) (customers?|clients?|users?|utilisateurs?).{0,30}(data|info|données|emails?|courriels?)/i,
  /(call|appelle|trigger|déclenche).{0,20}(webhook|api|endpoint)/i,
  /<\/?(system|assistant|knowledge|source|instructions)>/i,
];

export function looksLikeInjection(text: string): boolean {
  return PATTERNS.some((re) => re.test(text));
}

/** Patterns for secrets the visitor should not share (we never store them in clear in metadata). */
const SECRET_PATTERNS: RegExp[] = [
  /\b(?:\d[ -]?){13,19}\b/, // card-like number
  /(mot de passe|password|passcode|code de vérification|verification code|otp)\s*[:=]?\s*\S{4,}/i,
];
export function containsSensitiveSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text));
}

/** Redact card-like numbers and password-like strings before persistence or LLM calls. */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(?:\d[ -]?){13,19}\b/g, (m) => (m.replace(/\D/g, "").length >= 13 ? "[numéro masqué / number redacted]" : m))
    .replace(/((?:mot de passe|password|passcode|code de vérification|verification code|otp)\s*[:=]?\s*)(\S{4,})/gi, "$1[masqué / redacted]");
}

/** Neutralise tags in retrieved content that could be confused with prompt structure. */
export function sanitizeSourceText(text: string): string {
  return text.replace(/<\/?(system|assistant|user|knowledge|source|instructions|open_conflicts|recommendations|visitor_profile)[^>]*>/gi, "");
}
