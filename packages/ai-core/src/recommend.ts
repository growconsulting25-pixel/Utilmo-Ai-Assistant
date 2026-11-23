import type { InterestCategory } from "../../shared/src/constants";
import { val, type Profile } from "./profile";

export interface ServiceDef {
  key: string;
  name: { fr: string; en: string };
  description: { fr: string; en: string };
  categories: string[];
  problems: { fr?: string[]; en?: string[] };
  features: { fr?: string[]; en?: string[] };
  price_note: { fr?: string; en?: string };
  next_step: "demo" | "callback" | "quote" | "support" | "info";
  url: string | null;
  enabled: boolean;
  sort: number;
}

export interface Recommendation {
  key: string;
  name: string;
  why: string;
  problem: string;
  features: string[];
  verifiedPrice: string | null;
  confidence: "low" | "medium" | "high";
  nextStep: ServiceDef["next_step"];
  url: string | null;
}

/**
 * Deterministic recommendation engine: maps detected interest categories + stated problems to the
 * admin-editable service catalog. Only catalog features/prices are surfaced (never invented ones).
 */
export function recommendServices(services: ServiceDef[], p: Profile, turnCategories: InterestCategory[], lang: "fr" | "en", max = 2): Recommendation[] {
  const cats = new Set<string>([...(val(p, "services_interest") ?? []), ...turnCategories]);
  const existing = val(p, "existing_customer") === "yes";
  const supportOnly = existing && cats.has("CUSTOMER_SUPPORT");
  const text = [val(p, "main_goal"), val(p, "biggest_challenge"), val(p, "lead_methods"), val(p, "website_status"), val(p, "automation_needs")].filter(Boolean).join(" ").toLowerCase();

  const scored = services
    .filter((s) => s.enabled)
    .filter((s) => (supportOnly ? s.categories.includes("CUSTOMER_SUPPORT") : !s.categories.includes("CUSTOMER_SUPPORT") || cats.has("CUSTOMER_SUPPORT")))
    .map((s) => {
      let score = 0;
      const primary = s.categories[0];
      for (const c of s.categories) if (cats.has(c)) score += c === primary ? 3 : 1;
      const probs = [...(s.problems.fr ?? []), ...(s.problems.en ?? [])];
      const matchedProblem = probs.find((pr) => pr.toLowerCase().split(/\W+/).filter((w) => w.length > 4).some((w) => text.includes(w)));
      if (matchedProblem) score += 1;
      return { s, score, matchedProblem };
    })
    .filter((x) => x.score >= 3 || (x.score >= 1 && x.matchedProblem))
    .sort((a, b) => b.score - a.score || a.s.sort - b.s.sort)
    .slice(0, max);

  return scored.map(({ s, score, matchedProblem }) => ({
    key: s.key,
    name: s.name[lang] || s.name.fr,
    why: s.description[lang] || s.description.fr,
    problem: matchedProblem ?? (s.problems[lang]?.[0] ?? ""),
    features: (s.features[lang] ?? s.features.fr ?? []).slice(0, 5),
    verifiedPrice: (s.price_note[lang] || s.price_note.fr || "").trim() || null,
    confidence: score >= 5 ? "high" : score >= 3 ? "medium" : "low",
    nextStep: s.next_step,
    url: s.url,
  }));
}
