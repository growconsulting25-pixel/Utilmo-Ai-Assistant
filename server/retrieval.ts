import type { RetrievedChunk } from "../packages/ai-core/src/prompts";
import type { EmbeddingProvider } from "../packages/ai-core/src/providers/types";
import { getDb, many } from "./db";

const STOP = new Set(("le la les un une des du de d l et ou en au aux a à est sont je j tu il elle nous vous ils elles mon ma mes ton ta tes son sa ses notre votre vos leur leurs ce cet cette ces qui que quoi quel quelle quels quelles dans pour par sur avec sans plus moins pas ne y se s c qu n m t est-ce comment combien pourquoi quand où ai as avez avons ont être avoir fait faire peux peut pouvez veux voudrais " +
  "the a an and or of to in on for with without is are be was were i you he she we they my your our their it this that these those what which who how much many why when where do does did can could would should will have has had me us them about from at by as not no yes").split(/\s+/));

const fold = (t: string) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

export function queryTerms(queries: string[]): string[] {
  return (toTsQuery(queries) ?? "").split(" | ").map((t) => t.replace(/:\*$/, "")).filter(Boolean);
}

/** Fraction of distinct query terms (accent-insensitive, prefix match on 5 chars) present in the text. */
export function coverage(terms: string[], text: string): number {
  if (!terms.length) return 0;
  const words = new Set(fold(text).split(/[^\p{L}\p{N}]+/u));
  const stems = new Set([...words].map((w) => w.slice(0, 5)));
  const hits = terms.filter((t) => { const f = fold(t); return words.has(f) || stems.has(f.slice(0, 5)); }).length;
  return hits / terms.length;
}

/** Turn free-text queries into an OR tsquery of meaningful terms (with prefix matching). */
export function toTsQuery(queries: string[]): string | null {
  const terms = new Set<string>();
  for (const q of queries) {
    for (const raw of q.toLowerCase().normalize("NFC").split(/[^\p{L}\p{N}]+/u)) {
      const w = raw.trim();
      if (w.length < 3 || STOP.has(w) || /^\d+$/.test(w) && w.length < 2) continue;
      terms.add(w.replace(/'/g, ""));
      if (terms.size >= 24) break;
    }
  }
  if (!terms.size) return null;
  return [...terms].map((t) => `${t}:*`).join(" | ");
}

let vectorAvailable: boolean | null = null;
async function hasVector(): Promise<boolean> {
  if (vectorAvailable !== null) return vectorAvailable;
  const r = await many<{ n: number }>(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'knowledge_chunks' AND column_name = 'embedding'`);
  vectorAvailable = (r[0]?.n ?? 0) > 0;
  return vectorAvailable;
}

interface Row { id: string; document_id: string; title: string; url: string | null; heading: string | null; content: string; priority: number; verified: boolean; collection: string; doc_type: string; fetched_at: string | null; rank: number }

/**
 * Hybrid retrieval: Postgres full-text search (French + English + simple configs) always; pgvector
 * similarity fused in with reciprocal-rank fusion when embeddings are configured. Results are boosted
 * by source authority (priority 1 > 4) and verification, and diversified (max 2 chunks per document).
 */
export async function searchKnowledge(assistantId: string, queries: string[], opts: { collection: "sales" | "support"; topK: number; embedder?: EmbeddingProvider | null }): Promise<RetrievedChunk[]> {
  const tsq = toTsQuery(queries);
  const collections = opts.collection === "support" ? ["support", "both"] : ["sales", "both", "support"];
  const fetchN = opts.topK * 4;
  const results = new Map<string, { row: Row; score: number }>();

  if (tsq) {
    const rows = await many<Row>(`
      WITH q AS (SELECT to_tsquery('french', $2) || to_tsquery('english', $2) || to_tsquery('simple', $2) AS tq)
      SELECT c.id, c.document_id, d.title, d.url, c.heading, c.content, d.priority, d.verified, d.collection, d.doc_type,
             d.fetched_at::text, ts_rank_cd(c.tsv, q.tq, 32) AS rank
      FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id, q
      WHERE c.assistant_id = $1 AND d.status = 'active' AND d.collection = ANY($3) AND c.tsv @@ q.tq
      ORDER BY rank DESC LIMIT $4`, [assistantId, tsq, collections, fetchN]);
    const terms = queryTerms(queries);
    rows.forEach((row, i) => results.set(row.id, { row, score: 1 / (10 + i) + Number(row.rank) + 1.5 * coverage(terms, `${row.title} ${row.heading ?? ""} ${row.content}`) ** 2 }));
  }

  if (opts.embedder && (await hasVector())) {
    try {
      const [vec] = await opts.embedder.embed([queries.join("\n").slice(0, 2000)]);
      const rows = await many<Row & { dist: number }>(`
        SELECT c.id, c.document_id, d.title, d.url, c.heading, c.content, d.priority, d.verified, d.collection, d.doc_type,
               d.fetched_at::text, 0 AS rank, (c.embedding <=> $2::vector) AS dist
        FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id
        WHERE c.assistant_id = $1 AND d.status = 'active' AND d.collection = ANY($3) AND c.embedding IS NOT NULL
        ORDER BY c.embedding <=> $2::vector LIMIT $4`, [assistantId, `[${vec.join(",")}]`, collections, fetchN]);
      rows.forEach((row, i) => {
        if (row.dist > 0.75) return;
        const prev = results.get(row.id);
        results.set(row.id, { row, score: (prev?.score ?? 0) + 1 / (10 + i) + (1 - row.dist) * 0.2 });
      });
    } catch (err) { console.warn("[retrieval] vector search failed", String(err).slice(0, 200)); }
  }

  const boosted = [...results.values()].map(({ row, score }) => {
    let s = score * (1 + (4 - row.priority) * 0.25) * (row.verified ? 1.15 : 1);
    if (row.doc_type === "article") s *= 0.6;
    if (row.doc_type === "legal") s *= 0.45;
    if (opts.collection === "support" && row.collection === "support") s *= 1.4;
    return { row, score: s };
  }).sort((a, b) => b.score - a.score);

  const perDoc = new Map<string, number>();
  const out: RetrievedChunk[] = [];
  for (const { row, score } of boosted) {
    const n = perDoc.get(row.document_id) ?? 0;
    if (n >= 2) continue;
    perDoc.set(row.document_id, n + 1);
    out.push({ id: row.id, documentId: row.document_id, title: row.title, url: row.url, heading: row.heading, content: row.content, priority: row.priority, verified: row.verified, collection: row.collection, docType: row.doc_type, fetchedAt: row.fetched_at, score });
    if (out.length >= opts.topK) break;
  }
  return out;
}

export async function setEmbedding(chunkId: string, vec: number[], model: string) {
  await getDb().query(`UPDATE knowledge_chunks SET embedding = $2::vector, embedding_model = $3 WHERE id = $1`, [chunkId, `[${vec.join(",")}]`, model]);
}
export { hasVector };
