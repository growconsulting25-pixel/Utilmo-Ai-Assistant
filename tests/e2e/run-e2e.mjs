// Browser end-to-end tests for the widget (inline + floating, shared state, persistence, a11y, isolation).
// Starts the local server with an embedded database and the scripted TEST DOUBLE LLM (UI behaviour only).
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire(import.meta.url);
const { chromium, devices } = require("playwright");

const PORT = 8899, BASE = `http://localhost:${PORT}`;
const shots = process.env.E2E_SHOTS ?? "test-results/e2e";
fs.mkdirSync(shots, { recursive: true });
const server = spawn("npx", ["tsx", "scripts/dev-server.ts"], { env: { ...process.env, PORT: String(PORT), UTILMO_DB_DIR: "memory", UTILMO_FAKE_LLM: "1" }, stdio: ["ignore", "pipe", "pipe"], detached: true });
let log = ""; server.stdout.on("data", (d) => (log += d)); server.stderr.on("data", (d) => (log += d));
for (let i = 0; i < 60 && !log.includes("dev server"); i++) await new Promise((r) => setTimeout(r, 500));

const results = [];
async function test(name, fn) {
  try { await fn(); results.push([name, "PASS"]); console.log("✓", name); }
  catch (e) { results.push([name, "FAIL: " + e.message.split("\n")[0]]); console.log("✗", name, "\n ", e.message.split("\n").slice(0, 3).join("\n  ")); }
}
const expect = (c, m) => { if (!c) throw new Error(m); };

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  await page.goto(BASE + "/");
  const inline = page.locator("[data-utilmo-ai=inline] .u-inline");
  const panel = page.locator("[data-utilmo-ai=floating] .u-panel");

  await test("inline chat renders greeting and 6 suggestion chips", async () => {
    await inline.locator(".u-welcome .u-bubble").waitFor({ timeout: 10000 });
    const t = await inline.locator(".u-welcome .u-bubble").innerText();
    expect(t.includes("Bienvenue chez Utilmo"), "greeting missing: " + t);
    expect((await inline.locator(".u-welcome .u-suggestion").count()) === 6, "expected 6 suggestions");
  });
  await page.screenshot({ path: `${shots}/01-desktop-inline.png` });

  await test("clicking a suggestion continues the conversation (streamed reply)", async () => {
    await inline.locator(".u-suggestion", { hasText: "Générer plus de leads" }).click();
    await inline.locator(".u-row-user", { hasText: "Générer plus de leads" }).waitFor();
    await inline.locator(".u-row-bot .u-bubble", { hasText: "TEST DOUBLE" }).first().waitFor({ timeout: 15000 });
    expect((await inline.locator(".u-welcome .u-suggestion").count()) === 0, "starter chips should hide after first message");
  });

  await test("typing in the inline composer and Enter sends", async () => {
    await inline.locator("textarea").fill("Je travaille à Longueuil et Brossard.");
    await inline.locator("textarea").press("Enter");
    await page.waitForFunction(() => document.querySelector("[data-utilmo-ai=inline]").shadowRoot.querySelectorAll(".u-row-bot:not(.u-welcome)").length >= 2 && !document.querySelector("[data-utilmo-ai=inline]").shadowRoot.querySelector(".u-typing"), null, { timeout: 15000 });
  });

  await test("floating widget opens and shows the SAME conversation (scenario 17)", async () => {
    await page.locator("[data-utilmo-ai=floating] .u-launcher").click();
    await panel.waitFor();
    const n = await panel.locator(".u-row-user").count();
    expect(n === 2, `floating shows ${n} user messages, expected 2`);
  });

  await test("message sent from floating appears in inline too; no duplicate reply", async () => {
    await panel.locator("textarea").fill("Combien coûte le CRM ?");
    await panel.locator(".u-send").click();
    await page.waitForFunction(() => { const r = document.querySelector("[data-utilmo-ai=floating]").shadowRoot; return r.querySelectorAll(".u-row-user").length === 3 && !r.querySelector(".u-typing") && !r.querySelector(".u-streaming"); }, null, { timeout: 15000 });
    expect((await inline.locator(".u-row-user").count()) === 3, "inline not in sync");
    expect((await inline.locator(".u-row-bot:not(.u-welcome)").count()) === 3, "unexpected number of replies");
  });
  await page.screenshot({ path: `${shots}/02-desktop-both.png` });

  await test("Esc closes the floating panel and returns focus to the launcher", async () => {
    await panel.locator("textarea").focus();
    await page.keyboard.press("Escape");
    await panel.waitFor({ state: "detached" });
    const focused = await page.evaluate(() => document.querySelector("[data-utilmo-ai=floating]").shadowRoot.activeElement?.className ?? "");
    expect(focused.includes("u-launcher"), "focus not returned: " + focused);
  });

  await test("conversation persists after page reload (scenario 18)", async () => {
    await page.reload();
    await inline.locator(".u-row-user").nth(2).waitFor({ timeout: 10000 });
    expect((await inline.locator(".u-row-user").count()) === 3, "history not restored");
  });

  await test("accessible names: launcher, send button, log region", async () => {
    expect(await page.locator("[data-utilmo-ai=floating] .u-launcher").getAttribute("aria-label"), "launcher label");
    expect(await inline.locator(".u-send").getAttribute("aria-label"), "send label");
    expect((await inline.locator("[role=log]").count()) === 1, "log role");
  });

  await test("language toggle switches UI to English", async () => {
    await inline.locator(".u-lang button", { hasText: "EN" }).click();
    expect((await inline.locator("textarea").getAttribute("placeholder")).startsWith("Type"), "placeholder not English");
    await inline.locator(".u-lang button", { hasText: "FR" }).click();
  });

  await test("new conversation resets the shared state", async () => {
    await inline.locator(".u-menu-wrap .u-icon-btn").click();
    await inline.locator(".u-menu button", { hasText: "Nouvelle conversation" }).click();
    expect((await inline.locator(".u-row-user").count()) === 0, "not reset");
    expect((await inline.locator(".u-welcome .u-suggestion").count()) === 6, "suggestions not back");
  });

  // Mobile
  const m = await browser.newContext({ ...devices["iPhone 13"] });
  const mp = await m.newPage();
  await mp.goto(BASE + "/");
  await test("mobile: inline chat fits the viewport without horizontal scroll", async () => {
    await mp.locator("[data-utilmo-ai=inline] .u-welcome").waitFor({ timeout: 10000 });
    const overflow = await mp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow <= 0, "horizontal overflow " + overflow);
  });
  await mp.screenshot({ path: `${shots}/03-mobile-inline.png` });
  await test("mobile: launcher hidden while inline chat is visible; panel opens full screen", async () => {
    expect((await mp.locator("[data-utilmo-ai=floating] .u-launcher").count()) === 0, "launcher should hide over inline chat");
    await mp.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await mp.locator("[data-utilmo-ai=floating] .u-launcher").click();
    await mp.waitForTimeout(500); // open animation
    const box = await mp.locator("[data-utilmo-ai=floating] .u-panel").boundingBox();
    const vw = mp.viewportSize().width;
    expect(box && Math.abs(box.width - vw) < 2, `panel width ${box?.width} vs ${vw}`);
  });
  await mp.screenshot({ path: `${shots}/04-mobile-floating.png` });

  // Third-party embed with hostile CSS
  const e = await browser.newPage();
  await e.goto(BASE + "/embed-example.html");
  await test("embed via one script tag; host CSS does not leak into the widget", async () => {
    await e.locator("button", { hasText: "UtilmoAI.open()" }).click();
    await e.locator("[data-utilmo-ai=floating] .u-panel").waitFor({ timeout: 10000 });
    const font = await e.evaluate(() => getComputedStyle(document.querySelector("[data-utilmo-ai=floating]").shadowRoot.querySelector(".u-title")).fontFamily);
    expect(!/comic/i.test(font), "host font leaked: " + font);
    const bg = await e.evaluate(() => getComputedStyle(document.querySelector("[data-utilmo-ai=floating]").shadowRoot.querySelector(".u-send")).backgroundColor);
    expect(bg !== "rgb(255, 255, 0)", "host button style leaked");
  });
  await e.screenshot({ path: `${shots}/05-embed-isolation.png` });

  // Admin UI smoke
  const ad = await browser.newPage();
  await ad.goto(BASE + "/admin/");
  await test("admin: first-run setup, login, dashboard and leads render", async () => {
    await ad.locator("text=Configuration initiale").waitFor({ timeout: 10000 });
    await ad.locator("input[type=password]").first().fill("dev-setup-token");
    await ad.locator("input[type=email]").fill("owner@example.com");
    await ad.locator("input[type=password]").nth(1).fill("Sup3rSecret!pass");
    await ad.locator("button", { hasText: "Créer le compte" }).click();
    await ad.locator("text=Compte créé").waitFor();
    await ad.locator("button", { hasText: "Se connecter" }).click();
    await ad.locator("h1", { hasText: "Tableau de bord" }).waitFor({ timeout: 10000 });
    await ad.screenshot({ path: `${shots}/06-admin-dashboard.png` });
    await ad.goto(BASE + "/admin/#/knowledge/documents");
    await ad.locator("td", { hasText: "Prix du CRM" }).first().waitFor({ timeout: 10000 });
    await ad.screenshot({ path: `${shots}/07-admin-knowledge.png` });
    const seedRows = await ad.locator("td", { hasText: "Prix du CRM" }).count();
    expect(seedRows === 1, `seed document imported ${seedRows} times`);
    await ad.goto(BASE + "/admin/#/conversations");
    await ad.locator("table").waitFor({ timeout: 10000 });
    await ad.screenshot({ path: `${shots}/08-admin-conversations.png` });
    await ad.goto(BASE + "/admin/#/leads");
    await ad.locator("h1", { hasText: "Leads" }).waitFor({ timeout: 10000 });
  });
} finally {
  await browser.close();
  try { process.kill(-server.pid, "SIGTERM"); } catch { server.kill(); }
}
const failed = results.filter(([, r]) => r !== "PASS");
fs.writeFileSync(`${shots}/results.json`, JSON.stringify(results, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} e2e checks passed`);
if (failed.length) { console.log(log.slice(-2000)); process.exit(1); }
