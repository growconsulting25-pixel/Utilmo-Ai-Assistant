import { parseSettings, type AssistantSettings } from "../packages/shared/src/settings";
import type { ServiceDef } from "../packages/ai-core/src/recommend";
import { many, one } from "./db";

export interface AssistantCtx {
  id: string; organizationId: string; publicKey: string; name: string; status: string;
  settings: AssistantSettings; allowedDomains: string[];
}

const cache = new Map<string, { at: number; value: AssistantCtx }>();
const TTL = 20_000;

export function invalidateAssistantCache() { cache.clear(); }

export async function loadAssistant(publicKey: string): Promise<AssistantCtx | null> {
  const c = cache.get(publicKey);
  if (c && Date.now() - c.at < TTL) return c.value;
  const row = await one<{ id: string; organization_id: string; public_key: string; name: string; status: string; settings: unknown }>(
    `SELECT a.id, a.organization_id, a.public_key, a.name, a.status, coalesce(s.settings, '{}'::jsonb) AS settings
     FROM assistants a LEFT JOIN assistant_settings s ON s.assistant_id = a.id WHERE a.public_key = $1`, [publicKey]);
  if (!row) return null;
  const domains = await many<{ domain: string }>(`SELECT domain FROM assistant_allowed_domains WHERE assistant_id = $1`, [row.id]);
  const value: AssistantCtx = {
    id: row.id, organizationId: row.organization_id, publicKey: row.public_key, name: row.name, status: row.status,
    settings: parseSettings(row.settings), allowedDomains: domains.map((d) => d.domain),
  };
  cache.set(publicKey, { at: Date.now(), value });
  return value;
}

export async function loadAssistantById(orgId: string, id: string): Promise<AssistantCtx | null> {
  const r = await one<{ public_key: string }>(`SELECT public_key FROM assistants WHERE id = $1 AND organization_id = $2`, [id, orgId]);
  return r ? loadAssistant(r.public_key) : null;
}

export async function loadServices(assistantId: string): Promise<ServiceDef[]> {
  return many<ServiceDef>(`SELECT key, name, description, categories, problems, features, price_note, next_step, url, enabled, sort
    FROM recommended_services WHERE assistant_id = $1 ORDER BY sort`, [assistantId]);
}
