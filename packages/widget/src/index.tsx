import { render } from "preact";
import { Api } from "./api";
import { WidgetStore } from "./store";
import { Floating } from "./ui/Floating";
import { Inline } from "./ui/Inline";
import css from "./styles.css?inline";

export const VERSION = "1.0.0";

export interface InitOptions {
  assistantId: string;
  floating?: boolean;
  inlineContainer?: string | HTMLElement;
  language?: "fr" | "en";
  apiBase?: string;
  open?: boolean;
}

interface Instance { store: WidgetStore; hosts: HTMLElement[]; unmount: () => void }
const instances = new Map<string, Instance>();
let fontsLoaded = false;

function scriptOrigin(): string {
  const s = (document.currentScript as HTMLScriptElement | null) ?? Array.from(document.querySelectorAll<HTMLScriptElement>("script[src*='widget']")).pop();
  try { return s?.src ? new URL(s.src).origin : location.origin; } catch { return location.origin; }
}
const ORIGIN = scriptOrigin();

function applyTheme(host: HTMLElement, store: WidgetStore) {
  const a = store.state.config?.settings.appearance;
  if (!a) return;
  const font = `"${a.fontFamily}", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  const vars: Record<string, string> = { "--u-primary": a.primaryColor, "--u-accent": a.accentColor, "--u-bg": a.backgroundColor, "--u-text": a.textColor, "--u-radius": `${a.radius}px`, "--u-font": font, "--u-heading": `"${a.headingFontFamily}", ${font}` };
  for (const [k, v] of Object.entries(vars)) host.style.setProperty(k, v);
  if (a.loadGoogleFonts && !fontsLoaded) {
    fontsLoaded = true;
    // Fonts must be declared at document level to be usable inside Shadow DOM; this adds no global styles.
    const fam = Array.from(new Set([a.fontFamily, a.headingFontFamily])).map((f) => `family=${encodeURIComponent(f)}:wght@400;500;600;700`).join("&");
    const link = document.createElement("link");
    link.rel = "stylesheet"; link.href = `https://fonts.googleapis.com/css2?${fam}&display=swap`; link.dataset.utilmoAi = "fonts";
    document.head.appendChild(link);
  }
}

function mount(container: HTMLElement, store: WidgetStore, kind: "inline" | "floating"): HTMLElement {
  const host = document.createElement("div");
  host.setAttribute("data-utilmo-ai", kind);
  if (kind === "floating") host.style.cssText = "position:relative;z-index:2147483000;";
  else host.style.cssText = "display:block;width:100%;";
  container.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = css;
  shadow.appendChild(style);
  const root = document.createElement("div");
  root.className = "u-root";
  shadow.appendChild(root);
  render(kind === "inline" ? <Inline store={store} /> : <Floating store={store} />, root);
  const off = store.subscribe(() => applyTheme(host, store));
  (host as HTMLElement & { __off?: () => void }).__off = () => { off(); render(null, root); };
  return host;
}

/** Initialise (or extend) the assistant on this page. Safe to call multiple times. */
function init(opts: InitOptions) {
  if (!opts?.assistantId || !/^[a-z0-9_-]{1,64}$/i.test(opts.assistantId)) { console.error("[UtilmoAI] invalid assistantId"); return api; }
  let inst = instances.get(opts.assistantId);
  if (!inst) {
    const store = new WidgetStore(new Api((opts.apiBase ?? ORIGIN).replace(/\/$/, ""), opts.assistantId), opts.language);
    inst = { store, hosts: [], unmount: () => {} };
    instances.set(opts.assistantId, inst);
    void store.init();
  }
  const { store } = inst;
  if (opts.inlineContainer) {
    const el = typeof opts.inlineContainer === "string" ? document.querySelector<HTMLElement>(opts.inlineContainer) : opts.inlineContainer;
    if (!el) console.error(`[UtilmoAI] inline container not found: ${String(opts.inlineContainer)}`);
    else if (!el.querySelector("[data-utilmo-ai=inline]")) inst.hosts.push(mount(el, store, "inline"));
  }
  if (opts.floating && !document.querySelector("[data-utilmo-ai=floating]")) inst.hosts.push(mount(document.body, store, "floating"));
  if (opts.open) store.setFloatingOpen(true);
  return api;
}

function first(id?: string) { return id ? instances.get(id) : instances.values().next().value; }

const api = {
  version: VERSION,
  init,
  open: (id?: string) => first(id)?.store.setFloatingOpen(true),
  close: (id?: string) => first(id)?.store.setFloatingOpen(false),
  toggle: (id?: string) => { const i = first(id); i?.store.setFloatingOpen(!i.store.state.floatingOpen); },
  reset: (id?: string) => first(id)?.store.reset(),
  setLanguage: (lang: "fr" | "en", id?: string) => first(id)?.store.setLanguage(lang),
  send: (text: string, id?: string) => first(id)?.store.send(text, "floating"),
  on: (event: "ready" | "open" | "close" | "message" | "lead" | "error", fn: (d: unknown) => void, id?: string) => first(id)?.store.on(event, fn),
  destroy: (id?: string) => {
    for (const [k, inst] of instances) {
      if (id && k !== id) continue;
      for (const h of inst.hosts) { (h as HTMLElement & { __off?: () => void }).__off?.(); h.remove(); }
      instances.delete(k);
    }
  },
};

declare global { interface Window { UtilmoAI?: typeof api & { _q?: unknown[][] } } }

// Expose a single global even if the script is included more than once.
const existing = window.UtilmoAI as unknown as ({ version?: string; _q?: unknown[][] } | undefined);
if (!existing || !("version" in existing)) {
  const queued = existing?._q ?? [];
  window.UtilmoAI = api;
  for (const [method, ...args] of queued) (api as unknown as Record<string, (...a: unknown[]) => unknown>)[method as string]?.(...args);
}

// Declarative usage: <script src=".../widget.js" data-assistant-id="utilmo" data-mode="floating|inline|both" data-container="#id" defer>
(function autoInit() {
  const script = document.currentScript as HTMLScriptElement | null;
  if (!script?.dataset.assistantId) return;
  const d = script.dataset;
  const mode = (d.mode ?? "floating").toLowerCase();
  const run = () => window.UtilmoAI!.init({
    assistantId: d.assistantId!, language: d.language === "en" ? "en" : d.language === "fr" ? "fr" : undefined,
    floating: mode === "floating" || mode === "both", inlineContainer: mode === "inline" || mode === "both" ? d.container ?? "#utilmo-ai-chat" : undefined,
    apiBase: d.apiBase,
  });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run, { once: true }); else run();
})();
