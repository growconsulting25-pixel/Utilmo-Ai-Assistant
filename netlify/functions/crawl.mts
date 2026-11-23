import { ensureSecrets } from "../../server/env";
import type { Config } from "@netlify/functions";
import { crawlSource } from "../../server/knowledge";
import { verifyInternal } from "../../server/internal";
import { one } from "../../server/db";

/** Background function (up to 15 min): crawls an approved website source into the knowledge base. */
export default async (req: Request) => {
  await ensureSecrets();
  const body = await req.text();
  if (!verifyInternal(body, req.headers.get("x-internal-signature"))) { console.warn("[crawl] rejected unsigned request"); return; }
  const { assistantId, organizationId, sourceId } = JSON.parse(body) as { assistantId: string; organizationId: string; sourceId: string };
  const a = await one<{ id: string; organization_id: string }>(`SELECT id, organization_id FROM assistants WHERE id = $1 AND organization_id = $2`, [assistantId, organizationId]);
  if (!a) return;
  try {
    const stats = await crawlSource({ id: a.id, organizationId: a.organization_id }, sourceId, (m) => console.log("[crawl]", m));
    console.log("[crawl] finished", JSON.stringify(stats));
  } catch (e) { console.error("[crawl] failed", e); }
};

export const config: Config = { path: "/api/internal/crawl", background: true };
