import { Api, ApiError, type WidgetConfigResponse } from "./api";
import type { ChatAction, StoredMessage } from "./types";

export interface UIMessage {
  id: string;
  role: "user" | "assistant" | "agent";
  agentName?: string;
  content: string;
  actions?: ChatAction[];
  status: "done" | "streaming" | "error";
  clientMessageId?: string;
  errorCode?: string;
}

export interface WidgetState {
  ready: boolean;
  configError: string | null;
  config: WidgetConfigResponse | null;
  language: "fr" | "en";
  messages: UIMessage[];
  status: "idle" | "sending" | "streaming";
  phase: "thinking" | "writing" | null;
  token: string | null;
  conversationId: string | null;
  floatingOpen: boolean;
  unread: number;
  inlineVisible: boolean;
  humanActive: boolean;
  agentName: string | null;
  handoff: boolean;
}

type Listener = (s: WidgetState) => void;
type EventName = "ready" | "open" | "close" | "message" | "lead" | "error";

const uid = () => (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/-/g, "");

/**
 * Single source of truth per assistant on a page. Both the inline and the floating views render
 * from this store, so they always show the same conversation; persistence keeps it across reloads
 * and tabs (localStorage + storage events). Only one reply can be in flight at a time.
 */
export class WidgetStore {
  state: WidgetState;
  private listeners = new Set<Listener>();
  private handlers = new Map<EventName, Set<(d: unknown) => void>>();
  private key: string;
  private abort: AbortController | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(public api: Api, language?: "fr" | "en") {
    this.key = `utilmo-ai:v1:${api.assistantId}`;
    this.state = { ready: false, configError: null, config: null, language: language ?? "fr", messages: [], status: "idle", phase: null, token: null, conversationId: null, floatingOpen: false, unread: 0, inlineVisible: false, humanActive: false, agentName: null, handoff: false };
    this.languageForced = !!language;
    this.pageLanguage = language ? undefined : detectPageLanguage();
    if (this.pageLanguage) this.state.language = this.pageLanguage;
    if (!language && typeof MutationObserver !== "undefined") {
      // Sites that switch language without a reload (e.g. Weglot) update <html lang>: follow it.
      new MutationObserver(() => {
        const l = detectPageLanguage();
        if (l && !this.languageForced && l !== this.state.language && this.langAllowed(l)) { this.pageLanguage = l; this.set({ language: l }); this.saveLocal(); }
      }).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
    }
    this.loadLocal();
    window.addEventListener("storage", (e) => { if (e.key === this.key && this.state.status === "idle") { this.loadLocal(); this.emit(); } });
  }
  private languageForced: boolean;
  /** Language of the host page (<html lang>, then /en/ or /fr/ in the URL). Wins on page load. */
  private pageLanguage: "fr" | "en" | undefined;
  private langAllowed(l: "fr" | "en") { const en = (this.state.config?.settings as { languages?: { enabled?: string[] } } | undefined)?.languages?.enabled; return !en || en.includes(l); }

  subscribe(fn: Listener) { this.listeners.add(fn); fn(this.state); return () => this.listeners.delete(fn); }
  on(ev: EventName, fn: (d: unknown) => void) { if (!this.handlers.has(ev)) this.handlers.set(ev, new Set()); this.handlers.get(ev)!.add(fn); return () => this.handlers.get(ev)!.delete(fn); }
  fire(ev: EventName, d?: unknown) { this.handlers.get(ev)?.forEach((f) => { try { f(d); } catch { /* host handler error */ } }); }
  private set(patch: Partial<WidgetState>) { this.state = { ...this.state, ...patch }; this.emit(); }
  private emit() { this.listeners.forEach((l) => l(this.state)); }

  init(): Promise<void> {
    if (!this.initPromise) this.initPromise = this.doInit();
    return this.initPromise;
  }

  private async doInit() {
    try {
      const config = await this.api.config();
      this.set({ config });
      if (this.pageLanguage && !this.langAllowed(this.pageLanguage)) this.pageLanguage = undefined;
      const lang = this.languageForced ? this.state.language : (this.pageLanguage ?? (this.readLocal()?.language as "fr" | "en") ?? config.settings.defaultLanguage);
      this.set({ language: lang, ready: true });
      this.purgeExpired();
      if (this.state.token) await this.syncFromServer();
      this.fire("ready");
    } catch (e) {
      this.set({ configError: e instanceof ApiError ? e.code : "network_error", ready: true });
      this.fire("error", e);
    }
  }

  /** Server is authoritative: refresh messages (e.g. after a reload or from another tab). */
  async syncFromServer() {
    if (!this.state.token || this.state.status !== "idle") return;
    try {
      const r = await this.api.restore(this.state.token);
      if (!r.conversation) { this.set({ token: null, conversationId: null, messages: [] }); this.saveLocal(); return; }
      const messages: UIMessage[] = (r.messages ?? []).map((m: StoredMessage) => ({ id: m.id, role: m.role, agentName: m.agentName, content: m.content, actions: m.actions, status: "done", clientMessageId: m.clientMessageId }));
      const c = r.conversation as typeof r.conversation & { humanActive?: boolean; agentName?: string | null; handoff?: boolean };
      const newAgentMsgs = messages.filter((m) => m.role === "agent").length - this.state.messages.filter((m) => m.role === "agent").length;
      this.set({ messages, conversationId: c.id, humanActive: !!c.humanActive, agentName: c.agentName ?? null, handoff: !!c.handoff, language: this.languageForced ? this.state.language : (this.pageLanguage ?? (c.language === "en" ? "en" : "fr")) });
      if (newAgentMsgs > 0 && !this.state.floatingOpen && !this.state.inlineVisible) this.set({ unread: this.state.unread + newAgentMsgs });
      this.ensurePolling();
      this.saveLocal();
    } catch { /* keep local copy */ }
  }

  async send(text: string, surface: "inline" | "floating", retryOf?: UIMessage) {
    const content = text.trim();
    if (!content || this.state.status !== "idle" || !this.state.config) return;
    const max = this.state.config.settings.maxMessageChars;
    const clientMessageId = retryOf?.clientMessageId ?? uid();
    let messages = this.state.messages.filter((m) => !(m.status === "error" && m.role === "assistant"));
    if (!retryOf) messages = [...messages, { id: "u_" + clientMessageId, role: "user", content: content.slice(0, max), status: "done", clientMessageId }];
    const assistant: UIMessage = { id: "a_" + clientMessageId, role: "assistant", content: "", status: "streaming" };
    this.set({ messages: [...messages, assistant], status: "sending", phase: "thinking" });
    this.fire("message", { role: "user", content });
    this.abort = new AbortController();
    const firstTouch = this.state.token ? undefined : this.firstTouch();
    let got = "";
    try {
      await this.api.chat({
        assistantId: this.api.assistantId, sessionToken: this.state.token, message: content.slice(0, max), clientMessageId,
        language: this.languageForced ? this.state.language : this.pageLanguage ?? this.state.language, surface, firstTouch, page: { url: location.href.slice(0, 1900), title: document.title.slice(0, 280) },
      }, (ev) => {
        if (ev.type === "session") this.set({ token: ev.sessionToken, conversationId: ev.conversationId });
        else if (ev.type === "status") this.set({ phase: ev.status, status: ev.status === "writing" ? "streaming" : this.state.status });
        else if (ev.type === "delta") { got += ev.text; this.patchMsg(assistant.id, { content: got }); this.set({ status: "streaming", phase: "writing" }); }
        else if (ev.type === "replace") { got = ev.text; this.patchMsg(assistant.id, { content: got }); }
        else if (ev.type === "actions") { this.patchMsg(assistant.id, { actions: ev.actions }); if (ev.actions.some((a) => a.type === "contact_saved")) this.fire("lead", { conversationId: this.state.conversationId }); }
        else if (ev.type === "done") {
          if (!ev.messageId) { this.set({ messages: this.state.messages.filter((m) => m.id !== assistant.id) }); if (ev.state === "HUMAN_HANDOFF") this.set({ handoff: true }); return; }
          this.patchMsg(assistant.id, { status: "done", id: ev.messageId });
          if (ev.state === "HUMAN_HANDOFF") this.set({ handoff: true });
          if (!this.languageForced) { this.pageLanguage = undefined; this.set({ language: ev.language }); }
        } else if (ev.type === "error") throw new ApiError(500, ev.code, ev.message);
      }, this.abort.signal);
      this.ensurePolling();
      const last = this.state.messages.find((m) => m.id === assistant.id);
      if (last && last.status === "streaming") this.patchMsg(assistant.id, { status: got ? "done" : "error", errorCode: got ? undefined : "empty" });
      this.fire("message", { role: "assistant", content: got });
      if (!this.state.floatingOpen && !this.state.inlineVisible) this.set({ unread: this.state.unread + 1 });
    } catch (e) {
      const code = e instanceof ApiError ? e.code : (e as Error).name === "AbortError" ? "aborted" : "network_error";
      this.patchMsg(assistant.id, { status: "error", errorCode: code, clientMessageId, content: got });
      this.fire("error", e);
    } finally {
      this.abort = null;
      this.set({ status: "idle", phase: null });
      this.saveLocal();
    }
  }

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  /** While a human handoff is in progress, poll the server so advisor replies appear live. */
  ensurePolling() {
    const want = (this.state.handoff || this.state.humanActive) && !!this.state.token;
    if (want && !this.pollTimer) {
      this.pollTimer = setInterval(() => { if (document.visibilityState === "visible" && this.state.status === "idle") void this.syncFromServer(); }, 4000);
    } else if (!want && this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  }

  retry(failed: UIMessage) {
    const idx = this.state.messages.findIndex((m) => m.id === failed.id);
    const user = [...this.state.messages.slice(0, idx)].reverse().find((m) => m.role === "user");
    if (user) void this.send(user.content, "inline", { ...failed, clientMessageId: user.clientMessageId });
  }

  private patchMsg(id: string, patch: Partial<UIMessage>) {
    this.set({ messages: this.state.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)) });
  }

  reset() {
    this.abort?.abort();
    this.set({ messages: [], token: null, conversationId: null, status: "idle", phase: null, unread: 0, humanActive: false, agentName: null, handoff: false });
    this.ensurePolling();
    this.saveLocal();
  }

  async deleteData() {
    if (this.state.token) await this.api.deleteSession(this.state.token).catch(() => {});
    this.reset();
  }

  setLanguage(lang: "fr" | "en") { this.languageForced = true; this.set({ language: lang }); this.saveLocal(); }
  setFloatingOpen(open: boolean) {
    if (open === this.state.floatingOpen) return;
    this.set({ floatingOpen: open, unread: open ? 0 : this.state.unread });
    if (open) this.api.track("chat_opened", this.state.token, { surface: "floating" });
    this.fire(open ? "open" : "close");
  }
  setInlineVisible(v: boolean) { this.set({ inlineVisible: v, unread: v ? 0 : this.state.unread }); }

  // ------------------------------------------------------------- persistence
  private retentionMs() { return (this.state.config?.settings.privacy.sessionRetentionDays ?? 30) * 86400_000; }
  private readLocal(): { token: string | null; messages: UIMessage[]; language?: string; savedAt: number; conversationId: string | null } | null {
    try { const raw = localStorage.getItem(this.key); return raw ? JSON.parse(raw) : null; } catch { return null; }
  }
  private loadLocal() {
    const d = this.readLocal();
    if (!d) return;
    if (Date.now() - d.savedAt > 30 * 86400_000) { try { localStorage.removeItem(this.key); } catch { /* */ } return; }
    this.state = { ...this.state, token: d.token, conversationId: d.conversationId, messages: (d.messages ?? []).filter((m) => m.status !== "streaming"), language: this.languageForced || this.pageLanguage ? this.state.language : ((d.language as "fr" | "en") ?? this.state.language) };
  }
  private purgeExpired() {
    const d = this.readLocal();
    if (d && Date.now() - d.savedAt > this.retentionMs()) this.reset();
  }
  private saveLocal() {
    try {
      localStorage.setItem(this.key, JSON.stringify({ token: this.state.token, conversationId: this.state.conversationId, messages: this.state.messages.slice(-80), language: this.state.language, savedAt: Date.now() }));
    } catch { /* storage unavailable (private mode) — conversation still works for this page view */ }
  }
  private firstTouch() {
    try {
      const p = new URLSearchParams(location.search);
      const ft: Record<string, string> = {};
      for (const k of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"]) { const v = p.get(k); if (v) ft[k] = v.slice(0, 190); }
      if (document.referrer) { try { ft.referrer = new URL(document.referrer).host; } catch { /* */ } }
      ft.landing = location.pathname.slice(0, 400);
      return ft;
    } catch { return undefined; }
  }
}

/** "en-US" → "en"; falls back to a /en/ or /fr/ path segment. */
export function detectPageLanguage(): "fr" | "en" | undefined {
  try {
    const l = (document.documentElement.lang || "").toLowerCase().slice(0, 2);
    if (l === "en" || l === "fr") return l;
    const m = location.pathname.match(/^\/(en|fr)(\/|$)/i);
    if (m) return m[1].toLowerCase() as "fr" | "en";
  } catch { /* not in a browser */ }
  return undefined;
}
