import type { InterestCategory } from "../../shared/src/constants";

/** How a value was obtained. Higher rank = more trustworthy. */
export type Provenance = "inferred" | "llm_extracted" | "pattern" | "user_confirmed";
const RANK: Record<Provenance, number> = { inferred: 1, llm_extracted: 2, pattern: 3, user_confirmed: 4 };

export interface Field<T = string> {
  value: T;
  source: Provenance;
  updatedAt: string;
}

export interface Profile {
  first_name?: Field; last_name?: Field; email?: Field; phone?: Field;
  brokerage?: Field; city?: Field; territory?: Field<string[]>;
  user_type?: Field<"broker" | "agency" | "team_leader" | "other">;
  existing_customer?: Field<"yes" | "no">;
  main_goal?: Field; current_crm?: Field; website_status?: Field; lead_methods?: Field;
  biggest_challenge?: Field; lead_volume?: Field; automation_needs?: Field; timeline?: Field;
  budget_range?: Field; support_issue?: Field;
  demo_interest?: Field<"yes" | "no">;
  services_interest?: Field<InterestCategory[]>;
  /** Behavioural flags (not personal data). */
  flags?: {
    contact_refused?: boolean; contact_requested?: boolean; human_requested?: boolean;
    commercial_intent?: "none" | "low" | "medium" | "high"; clear_need?: boolean;
    asked_fields?: Record<string, number>; // field -> times asked (prevents repetition)
    privacy_notice_version?: string;
    flow_step?: string; not_broker?: boolean; flow_skipped?: string[]; support_mode?: boolean;
  };
}

export type ProfileKey = Exclude<keyof Profile, "flags">;

export type ProfileUpdate = Partial<{ [K in ProfileKey]: { value: NonNullable<Profile[K]>["value"]; source: Provenance; correction?: boolean } }>;

/**
 * Merge new information into a profile without overwriting confirmed values with weaker guesses.
 * - A value is replaced only if the new source ranks >= the old one, or the user explicitly corrected it.
 * - Array fields (territory, services_interest) are unioned.
 */
export function mergeProfile(profile: Profile, updates: ProfileUpdate, now = new Date().toISOString()): { profile: Profile; changed: ProfileKey[] } {
  const next: Profile = { ...profile, flags: { ...(profile.flags ?? {}) } };
  const changed: ProfileKey[] = [];
  for (const [k, u] of Object.entries(updates) as [ProfileKey, { value: unknown; source: Provenance; correction?: boolean }][]) {
    if (!u || u.value === undefined || u.value === null || u.value === "") continue;
    if (Array.isArray(u.value) && u.value.length === 0) continue;
    const cur = next[k] as Field<unknown> | undefined;
    if (Array.isArray(u.value)) {
      const merged = Array.from(new Set([...(Array.isArray(cur?.value) ? (cur!.value as unknown[]) : []), ...u.value]));
      if (!cur || merged.length !== (cur.value as unknown[]).length) {
        (next as Record<string, unknown>)[k] = { value: merged, source: cur && RANK[cur.source] > RANK[u.source] ? cur.source : u.source, updatedAt: now };
        changed.push(k);
      }
      continue;
    }
    if (cur && String(cur.value).toLowerCase() === String(u.value).toLowerCase()) continue;
    if (!cur || u.correction || RANK[u.source] >= RANK[cur.source]) {
      (next as Record<string, unknown>)[k] = { value: u.value, source: u.correction ? "user_confirmed" : u.source, updatedAt: now };
      changed.push(k);
    }
  }
  return { profile: next, changed };
}

export function val<K extends ProfileKey>(p: Profile, k: K): NonNullable<Profile[K]>["value"] | undefined {
  return (p[k] as Field<never> | undefined)?.value;
}

export function hasContact(p: Profile) {
  return { name: !!val(p, "first_name"), email: !!val(p, "email"), phone: !!val(p, "phone") };
}

/** Privacy-minimised view of the profile for the LLM: contact details are masked. */
export function profileForPrompt(p: Profile): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, f] of Object.entries(p)) {
    if (k === "flags" || !f) continue;
    const v = (f as Field<unknown>).value;
    if (k === "email" || k === "phone" || k === "last_name") out[k] = "✓ provided";
    else out[k] = v;
  }
  if (p.flags?.contact_refused) out.contact_refused = true;
  return out;
}
