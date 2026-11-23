import type { ChatStreamEvent, PublicSettings, StoredMessage } from "./types";

export interface WidgetConfigResponse { assistantId: string; settings: PublicSettings; approvedLinkHosts: string[]; version: number }

export class ApiError extends Error { constructor(public status: number, public code: string, message?: string) { super(message ?? code); } }

export class Api {
  constructor(public base: string, public assistantId: string) {}

  async config(): Promise<WidgetConfigResponse> {
    const r = await fetch(`${this.base}/api/widget-config?assistantId=${encodeURIComponent(this.assistantId)}`, { credentials: "omit" });
    if (!r.ok) throw await this.err(r);
    return r.json();
  }

  async restore(token: string): Promise<{ conversation: { id: string; state: string; language: string; busy: boolean } | null; messages?: StoredMessage[] }> {
    const r = await fetch(`${this.base}/api/session?assistantId=${encodeURIComponent(this.assistantId)}&token=${encodeURIComponent(token)}`, { credentials: "omit" });
    if (!r.ok) throw await this.err(r);
    return r.json();
  }

  async deleteSession(token: string) {
    await fetch(`${this.base}/api/session`, { method: "DELETE", credentials: "omit", headers: { "content-type": "application/json" }, body: JSON.stringify({ assistantId: this.assistantId, sessionToken: token }) });
  }

  track(event: "chat_opened" | "booking_clicked", token: string | null, properties: Record<string, string | number | boolean> = {}) {
    const body = JSON.stringify({ assistantId: this.assistantId, sessionToken: token, event, properties });
    try { fetch(`${this.base}/api/event`, { method: "POST", credentials: "omit", keepalive: true, headers: { "content-type": "application/json" }, body }).catch(() => {}); } catch { /* ignore */ }
  }

  /** POST /api/chat and parse the NDJSON event stream. */
  async chat(payload: Record<string, unknown>, onEvent: (e: ChatStreamEvent) => void, signal?: AbortSignal): Promise<void> {
    const r = await fetch(`${this.base}/api/chat`, { method: "POST", credentials: "omit", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal });
    if (!r.ok || !r.body) throw await this.err(r);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) onEvent(JSON.parse(line));
      }
    }
    if (buf.trim()) onEvent(JSON.parse(buf));
  }

  private async err(r: Response) {
    let code = "http_" + r.status, message = "";
    try { const j = await r.json(); code = j.error ?? code; message = j.message ?? ""; } catch { /* */ }
    return new ApiError(r.status, code, message);
  }
}
