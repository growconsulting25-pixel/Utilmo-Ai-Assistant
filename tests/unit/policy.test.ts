import { describe, expect, it } from "vitest";
import { decide, markAsked } from "../../packages/ai-core/src/policy";
import { fallbackAnalysis, type Analysis } from "../../packages/ai-core/src/analysis";
import type { Profile } from "../../packages/ai-core/src/profile";
import { parseSettings } from "../../packages/shared/src/settings";

const s = parseSettings({ booking: { provider: "link", url: "https://cal.example/demo" } });
const A = (p: Partial<Analysis>): Analysis => ({ ...fallbackAnalysis("fr", "x"), intents: ["PROVIDE_INFO"], ...p });
const base = { previousState: "GREETING" as const, settings: s, unresolvedCount: 0, knowledgeHits: 3, bookingAvailable: true, ticketAlreadyCreated: false };
const f = (v: unknown) => ({ value: v, source: "llm_extracted" as const, updatedAt: "" });

describe("conversation policy", () => {
  it("answers first and does not force contact capture on a first question", () => {
    const d = decide({ ...base, analysis: A({ intents: ["PRODUCT_QUESTION"] }), profile: {}, userTurns: 1 });
    expect(d.guidance.join(" ")).toMatch(/answer it FIRST/);
    expect(["first_name", "phone", "email"]).not.toContain(d.askField);
  });
  it("asks discovery questions one at a time and never repeats them", () => {
    let p: Profile = { services_interest: f(["LEAD_GENERATION"]) as never, main_goal: f("Plus de leads vendeurs") as never, flags: { clear_need: true } };
    const d1 = decide({ ...base, analysis: A({ categories: ["LEAD_GENERATION"] }), profile: p, userTurns: 2 });
    expect(d1.askField).toBe("territory");
    p = markAsked(p, d1.askField);
    const d2 = decide({ ...base, analysis: A({}), profile: p, userTurns: 2 });
    expect(d2.askField).not.toBe("territory");
  });
  it("moves to contact capture once the need is clear, asking one detail at a time", () => {
    const p: Profile = { services_interest: f(["LEAD_GENERATION"]) as never, main_goal: f("x") as never, territory: f(["Longueuil"]) as never, lead_methods: f("zéro") as never, timeline: f("30 jours") as never, flags: { clear_need: true } };
    const d = decide({ ...base, analysis: A({}), profile: p, userTurns: 4 });
    expect(d.state).toBe("CONTACT_CAPTURE");
    expect(d.askField).toBe("first_name");
  });
  it("respects a contact refusal (scenario 10)", () => {
    const p: Profile = { main_goal: f("x") as never, flags: { contact_refused: true, clear_need: true } };
    const d = decide({ ...base, analysis: A({ contact_refused: true }), profile: p, userTurns: 5 });
    expect(["first_name", "phone", "email"]).not.toContain(d.askField);
    expect(d.guidance.join(" ")).toMatch(/declined/);
  });
  it("routes existing customers to support without pitching (scenario 6)", () => {
    const p: Profile = { existing_customer: f("yes") as never };
    const d = decide({ ...base, analysis: A({ intents: ["SUPPORT_REQUEST"], categories: ["CUSTOMER_SUPPORT"], existing_customer: "yes" }), profile: p, userTurns: 1, knowledgeHits: 0 });
    expect(d.state).toBe("SUPPORT_ESCALATION");
    expect(d.guidance.join(" ")).toMatch(/do NOT pitch/);
  });
  it("hands off to a human and offers booking (scenario 13)", () => {
    const d = decide({ ...base, analysis: A({ intents: ["HUMAN_REQUEST"], wants_human: true }), profile: {}, userTurns: 1 });
    expect(d.state).toBe("HUMAN_HANDOFF");
    expect(d.handoff).toBe(true);
    expect(d.offerBooking).toBe(true);
  });
  it("declines injection attempts without asking qualification questions (scenarios 15-16)", () => {
    const d = decide({ ...base, analysis: A({ intents: ["PROMPT_INJECTION"] }), profile: {}, userTurns: 1 });
    expect(d.askField).toBeNull();
    expect(d.guidance.join(" ")).toMatch(/Politely decline/);
  });
  it("offers the booking card on a demo request", () => {
    const d = decide({ ...base, analysis: A({ intents: ["BOOKING_REQUEST"], demo_interest: "yes" }), profile: {}, userTurns: 1 });
    expect(d.offerBooking).toBe(true);
    expect(d.state).toBe("BOOKING");
  });
});
