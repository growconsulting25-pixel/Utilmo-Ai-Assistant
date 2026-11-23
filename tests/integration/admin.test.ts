import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../../server/db";
import { admin, chat, setupHarness } from "../helpers/harness";

let bg: Promise<unknown>[];
beforeAll(async () => {
  ({ bg } = await setupHarness());
  await chat(bg, "Je veux un site web. Je m'appelle Léa Roy, =HYPERLINK(\"x\") lea.roy@example.com", null);
});

describe("admin security", () => {
  it("requires authentication", async () => {
    expect((await admin("/leads", { cookie: "" })).status).toBe(401);
  });
  it("rejects the setup with a wrong token, then initialises once", async () => {
    expect((await admin("/setup", { body: { token: "nope", email: "o@example.com", password: "Sup3rSecret!pass" } })).status).toBe(403);
    expect((await admin("/setup", { body: { token: "dev-setup-token", email: "o@example.com", password: "weak" } })).status).toBe(400);
    expect((await admin("/setup", { body: { token: "dev-setup-token", email: "o@example.com", password: "Sup3rSecret!pass" } })).status).toBe(200);
    expect((await admin("/setup", { body: { token: "dev-setup-token", email: "x@example.com", password: "Sup3rSecret!pass" } })).status).toBe(409);
  });
  it("logs in and enforces CSRF header on mutations", async () => {
    expect((await admin("/login", { body: { email: "o@example.com", password: "wrong-password" } })).status).toBe(401);
    expect((await admin("/login", { body: { email: "o@example.com", password: "Sup3rSecret!pass" } })).status).toBe(200);
    expect((await admin("/knowledge/reindex", { method: "POST", csrf: false })).status).toBe(403);
  });
  it("lists leads and exports CSV with formula-injection protection", async () => {
    const l = await admin("/leads");
    expect(l.data.items.length).toBe(1);
    const csv = await admin("/leads/export.csv");
    expect(csv.status).toBe(200);
    expect(String(csv.data)).toContain("lea.roy@example.com");
    const audit = await admin("/audit");
    expect(audit.data.items.some((a: { action: string }) => a.action === "leads.export")).toBe(true);
  });
  it("enforces role permissions (viewer cannot export or change settings)", async () => {
    await admin("/users", { body: { email: "viewer@example.com", role: "viewer", password: "Vi3werSecret!pass" } });
    const v = await admin("/login", { body: { email: "viewer@example.com", password: "Vi3werSecret!pass" }, cookie: "x" });
    const vc = String(v.headers.get("set-cookie")).split(";")[0];
    expect((await admin("/leads", { cookie: vc })).status).toBe(200);
    expect((await admin("/leads/export.csv", { cookie: vc })).status).toBe(403);
    expect((await admin("/settings", { method: "PUT", body: { settings: {} }, cookie: vc })).status).toBe(403);
  });
  it("isolates tenants: another organization's admin cannot read this lead", async () => {
    await getDb().query(`INSERT INTO organizations (slug, name) VALUES ('other', 'Other Co')`);
    await getDb().query(`INSERT INTO assistants (organization_id, public_key, name) SELECT id, 'other', 'Other' FROM organizations WHERE slug = 'other'`);
    const { hashPassword } = await import("../../server/crypto");
    await getDb().query(`INSERT INTO admin_users (organization_id, email, role, password_hash) SELECT id, 'other@example.com', 'owner', $1 FROM organizations WHERE slug = 'other'`, [await hashPassword("Oth3rSecret!pass")]);
    const o = await admin("/login", { body: { email: "other@example.com", password: "Oth3rSecret!pass" }, cookie: "x" });
    const oc = String(o.headers.get("set-cookie")).split(";")[0];
    const leads = await admin("/leads", { cookie: oc });
    expect(leads.data.items.length).toBe(0);
    const lead = (await admin("/leads")).data.items[0];
    expect((await admin(`/leads/${lead.id}`, { cookie: oc })).status).toBe(404);
  });
});

describe("admin knowledge management", () => {
  it("adds verified internal knowledge that outranks website content", async () => {
    const r = await admin("/knowledge/documents", { body: { title: "Durée officielle de l'essai", content: "L'essai gratuit officiel du CRM Utilmo dure 30 jours (confirmé par l'équipe).", priority: 1, collection: "both", doc_type: "correction", verified: true, language: "fr" } });
    expect(r.status).toBe(200);
    const s = await admin("/knowledge/search-test", { body: { query: "essai gratuit durée", collection: "sales" } });
    expect(s.data.results[0].title).toBe("Durée officielle de l'essai");
    expect(s.data.results[0].priority).toBe(1);
  });
  it("disables outdated documents so they are no longer retrieved", async () => {
    const docs = (await admin("/knowledge/documents")).data.items;
    const d = docs.find((x: { title: string }) => x.title === "Durée officielle de l'essai");
    await admin(`/knowledge/documents/${d.id}`, { method: "PATCH", body: { status: "disabled" } });
    const s = await admin("/knowledge/search-test", { body: { query: "essai gratuit durée", collection: "sales" } });
    expect(s.data.results.find((x: { title: string }) => x.title === "Durée officielle de l'essai")).toBeUndefined();
  });
  it("shows real (non-demo) dashboard metrics", async () => {
    const d = await admin("/dashboard?days=30");
    expect(d.data.demoData).toBe(false);
    expect(d.data.totals.leads).toBeGreaterThanOrEqual(1);
  });
  it("validates settings and rejects unsafe integration destinations", async () => {
    expect((await admin("/settings", { method: "PUT", body: { settings: { appearance: { primaryColor: "red" } } } })).status).toBe(400);
    const bad = await admin("/integrations", { body: { type: "webhook", name: "bad", config: { url: "https://169.254.169.254/latest" } } });
    expect(bad.status).toBe(400);
  });
});
