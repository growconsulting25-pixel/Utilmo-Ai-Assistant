import { getDb, many } from "./db";
import { getEmbedder } from "./ai";
import { hasVector, setEmbedding } from "./retrieval";
import { retryDueDeliveries } from "./webhooks";

/** Periodic jobs: webhook retries, retention purge, embeddings backfill, housekeeping. */
export async function runMaintenance(budgetMs = 25_000) {
  const started = Date.now();
  const out: Record<string, unknown> = {};
  out.webhooks = await retryDueDeliveries(20);

  // Data retention (per assistant settings; Law 25 / PIPEDA data minimisation).
  const assistants = await many<{ id: string; days: number }>(`SELECT a.id, coalesce((s.settings->'privacy'->>'conversationRetentionDays')::int, 365) AS days FROM assistants a LEFT JOIN assistant_settings s ON s.assistant_id = a.id`);
  let purged = 0;
  for (const a of assistants) {
    const r = await many(`DELETE FROM conversations WHERE assistant_id = $1 AND coalesce(last_message_at, created_at) < now() - make_interval(days => $2) AND lead_id IS NULL RETURNING id`, [a.id, a.days]);
    purged += r.length;
    await getDb().query(`DELETE FROM visitors v WHERE v.assistant_id = $1 AND v.last_seen_at < now() - make_interval(days => $2) AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.visitor_id = v.id)`, [a.id, a.days]);
    await getDb().query(`DELETE FROM analytics_events WHERE assistant_id = $1 AND created_at < now() - make_interval(days => $2)`, [a.id, Math.max(a.days, 400)]);
  }
  out.retention_purged_conversations = purged;
  await getDb().query(`DELETE FROM rate_limits WHERE window_start < now() - interval '1 day'`);
  await getDb().query(`UPDATE conversations SET processing_until = NULL WHERE processing_until < now() - interval '5 minutes'`);

  // Embeddings backfill (only when an embedding provider is configured and pgvector exists).
  const embedder = getEmbedder();
  if (embedder && (await hasVector())) {
    let n = 0;
    while (Date.now() - started < budgetMs - 5000) {
      const batch = await many<{ id: string; heading: string | null; content: string }>(`SELECT id, heading, content FROM knowledge_chunks WHERE embedding IS NULL LIMIT 32`);
      if (!batch.length) break;
      const vecs = await embedder.embed(batch.map((c) => `${c.heading ?? ""}\n${c.content}`.slice(0, 6000)));
      for (let i = 0; i < batch.length; i++) await setEmbedding(batch[i].id, vecs[i], embedder.model);
      n += batch.length;
    }
    out.embedded_chunks = n;
  }
  return out;
}
