import { describe, expect, it } from "vitest";
import { mergeProfile, profileForPrompt, type Profile } from "../../packages/ai-core/src/profile";
import { scoreLead } from "../../packages/ai-core/src/scoring";
import { parseSettings } from "../../packages/shared/src/settings";

describe("profile merge", () => {
  it("never overwrites confirmed values with weaker guesses", () => {
    let { profile } = mergeProfile({}, { email: { value: "a@b.ca", source: "pattern" } });
    ({ profile } = mergeProfile(profile, { email: { value: "guess@b.ca", source: "llm_extracted" } }));
    expect(profile.email?.value).toBe("a@b.ca");
  });
  it("applies explicit user corrections", () => {
    let { profile } = mergeProfile({}, { city: { value: "Laval", source: "llm_extracted" } });
    ({ profile } = mergeProfile(profile, { city: { value: "Longueuil", source: "llm_extracted", correction: true } }));
    expect(profile.city?.value).toBe("Longueuil");
    expect(profile.city?.source).toBe("user_confirmed");
  });
  it("unions territories", () => {
    let { profile } = mergeProfile({}, { territory: { value: ["Longueuil"], source: "llm_extracted" } });
    ({ profile } = mergeProfile(profile, { territory: { value: ["Brossard", "Longueuil"], source: "llm_extracted" } }));
    expect(profile.territory?.value).toEqual(["Longueuil", "Brossard"]);
  });
  it("masks contact details before sending the profile to the LLM", () => {
    const p: Profile = { email: { value: "a@b.ca", source: "pattern", updatedAt: "" }, phone: { value: "+15145550123", source: "pattern", updatedAt: "" }, city: { value: "Laval", source: "pattern", updatedAt: "" } };
    const out = profileForPrompt(p);
    expect(JSON.stringify(out)).not.toContain("a@b.ca");
    expect(JSON.stringify(out)).not.toContain("5145550123");
    expect(out.city).toBe("Laval");
  });
});

describe("lead scoring", () => {
  const s = parseSettings({});
  const now = "";
  it("scores a hot, complete lead as high priority with explainable reasons", () => {
    const p: Profile = {
      first_name: { value: "Jean", source: "pattern", updatedAt: now }, email: { value: "j@x.ca", source: "pattern", updatedAt: now }, phone: { value: "+15145550123", source: "pattern", updatedAt: now },
      main_goal: { value: "Plus de leads vendeurs", source: "llm_extracted", updatedAt: now }, timeline: { value: "dans 30 jours", source: "llm_extracted", updatedAt: now },
      services_interest: { value: ["LEAD_GENERATION", "CRM"], source: "llm_extracted", updatedAt: now }, user_type: { value: "broker", source: "llm_extracted", updatedAt: now },
      territory: { value: ["Longueuil"], source: "llm_extracted", updatedAt: now }, demo_interest: { value: "yes", source: "llm_extracted", updatedAt: now },
      flags: { commercial_intent: "high", clear_need: true },
    };
    const r = scoreLead(p, s);
    expect(r.score).toBeGreaterThanOrEqual(85);
    expect(r.priority).toBe("high");
    expect(r.reasons).toContain("Clear commercial intent");
    expect(r.reasons).toContain("Relevant service fit");
  });
  it("scores an anonymous curious visitor as low", () => {
    const r = scoreLead({ flags: { commercial_intent: "low" } }, s);
    expect(r.priority).toBe("low");
    expect(r.score).toBeLessThan(40);
  });
  it("uses configurable weights", () => {
    const custom = parseSettings({ scoring: { weights: { intent: 100, need: 0, timeline: 0, contact: 0, fit: 0, readiness: 0 } } });
    expect(scoreLead({ flags: { commercial_intent: "high" } }, custom).score).toBe(100);
  });
  it("does not score existing-customer support as a sales lead", () => {
    const p: Profile = { existing_customer: { value: "yes", source: "llm_extracted", updatedAt: now }, services_interest: { value: ["CUSTOMER_SUPPORT"], source: "llm_extracted", updatedAt: now }, flags: { commercial_intent: "none" } };
    expect(scoreLead(p, s).score).toBeLessThan(20);
  });
});
