import { parse as parseHtml, type HTMLElement } from "node-html-parser";
import { chunkText } from "../packages/ai-core/src/chunking";
import { sanitizeSourceText } from "../packages/ai-core/src/injection";
import { sha256 } from "./crypto";
import { acquireLock, getDb, many, one, releaseLock } from "./db";
import { SEED_BUNDLE } from "./generated/seed-bundle";
import type { AssistantCtx } from "./tenant";

export const SEED_VERSION = 1;
export const CRAWLER_UA = "UtilmoAIIngest/1.0 (+knowledge-base crawler; respects robots.txt)";

export interface DocInput {
  sourceId: string | null; title: string; url: string | null; language: string; collection: "sales" | "support" | "both";
  priority: number; docType: string; content: string; verified?: boolean; metadata?: Record<string, unknown>; fetchedAt?: string | null;
}

/** Insert or version a document and (re)build its chunks. Identical content is skipped (dedupe by hash). */
export async function ingestDocument(a: { id: string; organizationId: string }, d: DocInput): Promise<{ id: string; action: "created" | "updated" | "unchanged" }> {
  const content = sanitizeSourceText(d.content).replace(/\n{3,}/g, "\n\n").trim();
  const hash = sha256(content);
  // Crawled pages are identified by URL; other documents (seed, FAQ, uploads) by source + title.
  const prev = d.docType === "page" && d.url
    ? await one<{ id: string; content_hash: string; version: number; verified: boolean; metadata: { edited?: boolean } }>(
        `SELECT id, content_hash, version, verified, metadata FROM knowledge_documents WHERE assistant_id = $1 AND url = $2 AND doc_type = 'page' AND status <> 'superseded' ORDER BY version DESC LIMIT 1`,
        [a.id, d.url])
    : d.sourceId
      ? await one<{ id: string; content_hash: string; version: number; verified: boolean; metadata: { edited?: boolean } }>(
          `SELECT id, content_hash, version, verified, metadata FROM knowledge_documents WHERE assistant_id = $1 AND source_id = $2 AND title = $3 AND status <> 'superseded' ORDER BY version DESC LIMIT 1`,
          [a.id, d.sourceId, d.title.slice(0, 300)])
      : null;
  // Admin-edited documents are authoritative: a re-crawl never overwrites a manual correction.
  if (prev && (prev.content_hash === hash || (prev.metadata?.edited && d.metadata?.crawled))) {
    await getDb().query(`UPDATE knowledge_documents SET fetched_at = coalesce($2, fetched_at) WHERE id = $1`, [prev.id, d.fetchedAt ?? null]);
    return { id: prev.id, action: "unchanged" };
  }
  if (prev) await getDb().query(`UPDATE knowledge_documents SET status = 'superseded', updated_at = now() WHERE id = $1`, [prev.id]);
  const row = await one<{ id: string }>(
    `INSERT INTO knowledge_documents (organization_id, assistant_id, source_id, title, url, language, collection, priority, doc_type, content, content_hash, status, verified, version, metadata, fetched_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending_index',$12,$13,$14,$15) RETURNING id`,
    [a.organizationId, a.id, d.sourceId, d.title.slice(0, 300), d.url, d.language, d.collection, d.priority, d.docType, content, hash,
      d.verified ?? false, (prev?.version ?? 0) + 1, JSON.stringify(d.metadata ?? {}), d.fetchedAt ?? null]);
  await indexDocument(row!.id);
  return { id: row!.id, action: prev ? "updated" : "created" };
}

/** Chunk a document and activate it (embeddings are filled asynchronously when configured). */
export async function indexDocument(documentId: string) {
  const d = await one<{ id: string; organization_id: string; assistant_id: string; title: string; content: string; status: string }>(
    `SELECT id, organization_id, assistant_id, title, content, status FROM knowledge_documents WHERE id = $1`, [documentId]);
  if (!d) return;
  await getDb().query(`DELETE FROM knowledge_chunks WHERE document_id = $1`, [documentId]);
  const chunks = chunkText(d.content);
  for (const c of chunks) {
    await getDb().query(
      `INSERT INTO knowledge_chunks (organization_id, assistant_id, document_id, chunk_index, heading, content, token_estimate) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [d.organization_id, d.assistant_id, d.id, c.index, c.heading ?? d.title, c.content, c.tokenEstimate]);
  }
  if (d.status === "pending_index") await getDb().query(`UPDATE knowledge_documents SET status = 'active', updated_at = now() WHERE id = $1`, [documentId]);
}

export async function bumpKnowledgeVersion(a: { id: string; organizationId: string }, note: string, adminId: string | null = null) {
  const stats = await one<{ docs: number; chunks: number }>(
    `SELECT (SELECT count(*)::int FROM knowledge_documents WHERE assistant_id = $1 AND status = 'active') AS docs,
            (SELECT count(*)::int FROM knowledge_chunks WHERE assistant_id = $1) AS chunks`, [a.id]);
  await getDb().query(
    `INSERT INTO knowledge_versions (organization_id, assistant_id, version, note, stats, created_by)
     VALUES ($1, $2, coalesce((SELECT max(version) FROM knowledge_versions WHERE assistant_id = $2), 0) + 1, $3, $4, $5)`,
    [a.organizationId, a.id, note.slice(0, 300), JSON.stringify(stats ?? {}), adminId]);
}

/** Parse "---\nkey: value\n---" front matter used by seed files. */
export function parseFrontMatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: m[2] };
}

/**
 * First-run bootstrap for a tenant: imports the curated seed knowledge bundled with the app and
 * registers the official website as a crawl source. Idempotent and lock-protected.
 */
export async function bootstrapAssistant(a: AssistantCtx, triggerCrawl?: (sourceId: string) => Promise<void>): Promise<boolean> {
  if (a.settings.seedVersionApplied >= SEED_VERSION) return false;
  const bundle = SEED_BUNDLE[a.publicKey];
  if (!(await acquireLock(`seed:${a.id}`, 120))) return false;
  try {
    let crawlSourceId: string | null = null;
    if (bundle) {
      const src = await one<{ id: string }>(
        `INSERT INTO knowledge_sources (organization_id, assistant_id, type, name, collection, priority) VALUES ($1,$2,'seed',$3,'both',3) RETURNING id`,
        [a.organizationId, a.id, "Base initiale (pages officielles, synthèse vérifiable)"]);
      for (const f of bundle.docs) {
        const { meta, body } = parseFrontMatter(f.raw);
        await ingestDocument(a, {
          sourceId: src!.id, title: meta.title ?? f.file, url: meta.url ?? null, language: "multi",
          collection: (meta.collection as DocInput["collection"]) ?? "both", priority: Number(meta.priority ?? 3), docType: "seed",
          content: body, verified: false, fetchedAt: meta.fetched_at ?? null, metadata: { seed_file: f.file, source_type: meta.source_type, urls: meta.urls },
        });
      }
      if (bundle.website) {
        const w = bundle.website as { name: string; url: string; collection?: string; priority?: number };
        const ws = await one<{ id: string }>(
          `INSERT INTO knowledge_sources (organization_id, assistant_id, type, name, url, collection, priority, config) VALUES ($1,$2,'website',$3,$4,$5,$6,$7) RETURNING id`,
          [a.organizationId, a.id, w.name, w.url, w.collection ?? "both", w.priority ?? 3, JSON.stringify(bundle.website)]);
        crawlSourceId = ws!.id;
      }
      await bumpKnowledgeVersion(a, "Seed knowledge imported");
    }
    await getDb().query(
      `UPDATE assistant_settings SET settings = jsonb_set(settings, '{seedVersionApplied}', to_jsonb($2::int)), updated_at = now() WHERE assistant_id = $1`,
      [a.id, SEED_VERSION]);
    if (crawlSourceId && triggerCrawl) await triggerCrawl(crawlSourceId).catch((e) => console.warn("[bootstrap] crawl trigger failed", String(e)));
    return true;
  } finally {
    await releaseLock(`seed:${a.id}`);
  }
}

// ---------------------------------------------------------------- crawler

interface CrawlConfig { url: string; sitemaps?: string[]; urls?: string[]; include_prefixes?: string[]; exclude_patterns?: string[]; article_sitemaps?: string[]; max_pages?: number; collection?: string; priority?: number }

async function fetchText(url: string, timeoutMs = 12_000): Promise<{ ok: boolean; status: number; text: string; type: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { "user-agent": CRAWLER_UA, accept: "text/html,application/xml,text/xml,text/plain;q=0.9" }, signal: ctrl.signal, redirect: "follow" });
    const text = (await r.text()).slice(0, 3_000_000);
    return { ok: r.ok, status: r.status, text, type: r.headers.get("content-type") ?? "" };
  } catch (e) { return { ok: false, status: 0, text: String(e), type: "" }; }
  finally { clearTimeout(t); }
}

/** Minimal robots.txt evaluation for "*" and our user agent (longest-match Allow/Disallow). */
export function robotsAllows(robots: string, url: string, ua = "UtilmoAIIngest"): boolean {
  const path = new URL(url).pathname + new URL(url).search;
  const groups: { agents: string[]; rules: { allow: boolean; path: string }[] }[] = [];
  let cur: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const rawLine of robots.split("\n")) {
    const line = rawLine.replace(/#.*/, "").trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === "user-agent") {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(v.toLowerCase()); lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (cur && (k === "allow" || k === "disallow") && v) cur.rules.push({ allow: k === "allow", path: v });
    }
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== "*" && ua.toLowerCase().includes(a)));
  const applicable = mine.length ? mine : groups.filter((g) => g.agents.includes("*"));
  let best: { allow: boolean; len: number } = { allow: true, len: -1 };
  for (const g of applicable) for (const r of g.rules) {
    const re = new RegExp("^" + r.path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$"));
    if (re.test(path) && r.path.length > best.len) best = { allow: r.allow, len: r.path.length };
  }
  return best.allow;
}

async function sitemapUrls(url: string, depth = 0): Promise<string[]> {
  if (depth > 2) return [];
  const r = await fetchText(url);
  if (!r.ok) return [];
  const locs = [...r.text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, "&"));
  if (/<sitemapindex/i.test(r.text)) {
    const nested = await Promise.all(locs.map((l) => sitemapUrls(l, depth + 1)));
    return nested.flat();
  }
  return locs;
}

const NOISE_SELECTORS = ["script", "style", "noscript", "svg", "iframe", "template", "form", "nav", "header", "footer", "aside",
  "[role=navigation]", "[role=banner]", "[role=contentinfo]", ".elementor-location-header", ".elementor-location-footer", "#cookie-law-info-bar", ".cookie", ".popup", ".elementor-popup-modal"];

/** Extract meaningful text as light Markdown, dropping navigation/boilerplate. */
export function extractMainContent(html: string): { title: string; lang: string; text: string } {
  const root = parseHtml(html, { comment: false });
  const title = (root.querySelector("title")?.text ?? "").replace(/\s+/g, " ").trim();
  const lang = (root.querySelector("html")?.getAttribute("lang") ?? "").slice(0, 2).toLowerCase() || "fr";
  for (const sel of NOISE_SELECTORS) for (const el of root.querySelectorAll(sel)) el.remove();
  const main = (root.querySelector("main") ?? root.querySelector("article") ?? root.querySelector("body") ?? root) as HTMLElement;
  const lines: string[] = [];
  const walk = (el: HTMLElement) => {
    for (const child of el.childNodes) {
      if (child.nodeType === 3) { const t = child.text.replace(/\s+/g, " ").trim(); if (t) lines.push(t); continue; }
      if (child.nodeType !== 1) continue;
      const c = child as HTMLElement;
      const tag = c.tagName?.toLowerCase();
      if (/^h[1-4]$/.test(tag)) { const t = c.text.replace(/\s+/g, " ").trim(); if (t) lines.push(`\n${tag === "h1" || tag === "h2" ? "##" : "###"} ${t}`); continue; }
      if (tag === "li") { const t = c.text.replace(/\s+/g, " ").trim(); if (t) lines.push(`- ${t}`); continue; }
      if (tag === "p" || tag === "td" || tag === "blockquote") { const t = c.text.replace(/\s+/g, " ").trim(); if (t) lines.push(t); continue; }
      walk(c);
    }
  };
  walk(main);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of lines) {
    const k = l.toLowerCase();
    if (l.length < 80 && seen.has(k)) continue;
    seen.add(k);
    out.push(l);
  }
  return { title, lang, text: out.join("\n").replace(/\n{3,}/g, "\n\n").trim() };
}

/** Crawl an approved website source: robots.txt → sitemap → pages → clean text → documents. */
export async function crawlSource(a: { id: string; organizationId: string }, sourceId: string, log: (m: string) => void = console.log) {
  const src = await one<{ id: string; config: CrawlConfig; url: string; collection: string; priority: number; status: string }>(
    `SELECT id, config, url, collection, priority, status FROM knowledge_sources WHERE id = $1 AND assistant_id = $2 AND type = 'website'`, [sourceId, a.id]);
  if (!src || src.status !== "active") throw new Error("source not found or disabled");
  const cfg = { ...src.config, url: src.config.url ?? src.url };
  const base = new URL(cfg.url);
  const robots = await fetchText(`${base.origin}/robots.txt`);
  const robotsTxt = robots.ok ? robots.text : "";
  const sitemaps = cfg.sitemaps?.length ? cfg.sitemaps : [...robotsTxt.matchAll(/^sitemap:\s*(\S+)/gim)].map((m) => m[1]);
  let urls = [...(cfg.urls ?? [])];
  for (const sm of sitemaps) urls.push(...(await sitemapUrls(sm)));
  if (!urls.length) urls = [cfg.url];
  const articleSet = new Set<string>();
  for (const sm of cfg.article_sitemaps ?? []) for (const u of await sitemapUrls(sm)) articleSet.add(u);
  const prefixes = cfg.include_prefixes?.length ? cfg.include_prefixes : [base.origin + "/"];
  const excludes = cfg.exclude_patterns ?? [];
  urls = Array.from(new Set(urls)).filter((u) => prefixes.some((p) => u.startsWith(p)) && !excludes.some((x) => u.includes(x)));
  // Product pages first, then articles.
  urls.sort((x, y) => Number(articleSet.has(x)) - Number(articleSet.has(y)));
  urls = urls.slice(0, Math.min(cfg.max_pages ?? 60, 200));

  const pages: { url: string; title: string; lang: string; text: string }[] = [];
  let skippedRobots = 0;
  for (const u of urls) {
    if (robotsTxt && !robotsAllows(robotsTxt, u)) { skippedRobots++; continue; }
    const r = await fetchText(u);
    if (!r.ok || !r.type.includes("html")) { log(`skip ${u} (${r.status})`); continue; }
    const ex = extractMainContent(r.text);
    if (ex.text.length > 150) pages.push({ url: u, ...ex });
    await new Promise((res) => setTimeout(res, 250)); // be polite
  }
  // Remove lines repeated on most pages (site-wide boilerplate).
  const freq = new Map<string, number>();
  for (const p of pages) for (const l of new Set(p.text.split("\n"))) freq.set(l, (freq.get(l) ?? 0) + 1);
  const threshold = Math.max(3, Math.ceil(pages.length * 0.4));
  const stats = { fetched: pages.length, created: 0, updated: 0, unchanged: 0, skippedRobots };
  const now = new Date().toISOString();
  for (const p of pages) {
    const text = p.text.split("\n").filter((l) => (freq.get(l) ?? 0) < threshold || l.startsWith("#")).join("\n");
    if (text.length < 120) continue;
    const isArticle = articleSet.has(p.url);
    const res = await ingestDocument(a, {
      sourceId, title: p.title || p.url, url: p.url, language: p.lang === "en" ? "en" : "fr",
      collection: (src.collection as DocInput["collection"]) ?? "both", priority: isArticle ? 4 : src.priority,
      docType: isArticle ? "article" : "page", content: text, verified: false, fetchedAt: now, metadata: { crawled: true },
    });
    stats[res.action]++;
  }
  await getDb().query(`UPDATE knowledge_sources SET last_synced_at = now(), config = config || $2::jsonb WHERE id = $1`, [sourceId, JSON.stringify({ last_stats: stats })]);
  await bumpKnowledgeVersion(a, `Website crawl: ${stats.created} new, ${stats.updated} updated, ${stats.unchanged} unchanged`);
  log(`crawl done ${JSON.stringify(stats)}`);
  return stats;
}

export async function listDocuments(assistantId: string) {
  return many(`SELECT id, title, url, language, collection, priority, doc_type, status, verified, version, fetched_at, updated_at, length(content) AS size
    FROM knowledge_documents WHERE assistant_id = $1 AND status <> 'superseded' ORDER BY priority, doc_type, title`, [assistantId]);
}
