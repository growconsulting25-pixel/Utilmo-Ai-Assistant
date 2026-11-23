export class ApiError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }

let assistantId: string | null = localStorage.getItem("uai-admin-assistant");
export function setAssistant(id: string) { assistantId = id; localStorage.setItem("uai-admin-assistant", id); }
export function getAssistant() { return assistantId; }

function withAssistant(path: string) {
  if (!assistantId) return path;
  return path + (path.includes("?") ? "&" : "?") + "assistant=" + encodeURIComponent(assistantId);
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; form?: FormData; raw?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { "x-requested-with": "utilmo-admin" };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const r = await fetch("/api/admin" + withAssistant(path), { method: opts.method ?? (opts.body || opts.form ? "POST" : "GET"), headers, credentials: "same-origin", body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined) });
  if (r.status === 401 && !path.startsWith("/login") && !path.startsWith("/me")) { window.dispatchEvent(new Event("uai-unauth")); }
  if (!r.ok) {
    let code = "http_" + r.status, msg = r.statusText;
    try { const j = await r.json(); code = j.error ?? code; msg = j.message ?? j.error ?? msg; } catch { /* */ }
    throw new ApiError(r.status, code, msg);
  }
  if (opts.raw) return r as unknown as T;
  return r.json();
}

export function downloadUrl(path: string) { return "/api/admin" + withAssistant(path); }
