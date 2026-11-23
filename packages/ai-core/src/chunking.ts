export interface Chunk { index: number; heading: string | null; content: string; tokenEstimate: number }

/** Split Markdown/plain text into heading-aware chunks (~target chars) with a small overlap. */
export function chunkText(text: string, opts: { target?: number; max?: number; overlap?: number } = {}): Chunk[] {
  const target = opts.target ?? 900, max = opts.max ?? 1400, overlap = opts.overlap ?? 120;
  const lines = text.replace(/\r/g, "").split("\n");
  const sections: { heading: string | null; body: string[] }[] = [];
  let cur: { heading: string | null; body: string[] } = { heading: null, body: [] };
  for (const line of lines) {
    const h = line.match(/^#{1,4}\s+(.*)$/);
    if (h) {
      if (cur.body.join("").trim()) sections.push(cur);
      cur = { heading: h[1].trim(), body: [] };
    } else cur.body.push(line);
  }
  if (cur.body.join("").trim()) sections.push(cur);

  const chunks: Chunk[] = [];
  const push = (heading: string | null, content: string) => {
    const c = content.trim();
    if (c.length < 20) return;
    chunks.push({ index: chunks.length, heading, content: c, tokenEstimate: Math.ceil(c.length / 4) });
  };
  for (const sec of sections) {
    const paras = sec.body.join("\n").split(/\n{2,}|\n(?=[-*] )/).map((p) => p.trim()).filter(Boolean);
    let buf = "";
    for (const para of paras) {
      if (para.length > max) {
        if (buf) { push(sec.heading, buf); buf = ""; }
        for (let i = 0; i < para.length; i += max - overlap) push(sec.heading, para.slice(i, i + max));
        continue;
      }
      if ((buf + "\n" + para).length > target && buf) {
        push(sec.heading, buf);
        buf = buf.slice(-overlap).replace(/^\S*\s/, "") + "\n" + para;
      } else buf = buf ? buf + "\n" + para : para;
    }
    if (buf) push(sec.heading, buf);
  }
  return chunks;
}
