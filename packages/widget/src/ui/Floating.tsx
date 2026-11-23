import { useEffect, useRef, useState } from "preact/hooks";
import { STRINGS } from "../i18n";
import type { WidgetStore } from "../store";
import { Composer, Conversation, Header, useStore } from "./Chat";
import { IconChat, IconMinus, IconX } from "./icons";

export function Floating({ store }: { store: WidgetStore }) {
  const state = useStore(store);
  const t = STRINGS[state.language];
  const s = state.config?.settings;
  const launcherRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [teaser, setTeaser] = useState(false);
  const open = state.floatingOpen;

  useEffect(() => {
    if (!s?.appearance.teaser.enabled || open) return;
    let dismissed = false;
    try { dismissed = sessionStorage.getItem("utilmo-ai:teaser") === "1"; } catch { /* */ }
    if (dismissed || state.messages.length) return;
    const id = setTimeout(() => { if (!store.state.floatingOpen && !store.state.inlineVisible) setTeaser(true); }, s.appearance.teaser.delaySeconds * 1000);
    return () => clearTimeout(id);
  }, [s, open]);

  useEffect(() => {
    if (!open) return;
    setTeaser(false);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { store.setFloatingOpen(false); launcherRef.current?.focus(); } };
    const root = panelRef.current?.getRootNode() as ShadowRoot | undefined;
    root?.addEventListener("keydown", onKey as EventListener);
    return () => root?.removeEventListener("keydown", onKey as EventListener);
  }, [open]);

  const dismissTeaser = () => { setTeaser(false); try { sessionStorage.setItem("utilmo-ai:teaser", "1"); } catch { /* */ } };
  if (state.configError || !s) return null;
  const side = s.appearance.launcherPosition;
  return (
    <div class={`u-floating u-${side}${s.appearance.mobileFullscreen ? " u-mobile-full" : ""}`}>
      {open && (
        <div class="u-panel" ref={panelRef} role="dialog" aria-modal="false" aria-label={s.assistantName}>
          <Header store={store} state={state}>
            <button type="button" class="u-icon-btn" aria-label={t.closeChat} onClick={() => { store.setFloatingOpen(false); launcherRef.current?.focus(); }}><IconMinus /></button>
          </Header>
          <Conversation store={store} state={state} surface="floating" />
          <Composer store={store} state={state} surface="floating" autoFocus />
        </div>
      )}
      {!open && teaser && (
        <div class="u-teaser" role="status">
          <button type="button" class="u-teaser-text" onClick={() => store.setFloatingOpen(true)}>{s.appearance.teaser.text[state.language] || s.appearance.teaser.text.fr}</button>
          <button type="button" class="u-teaser-x" aria-label={t.dismiss} onClick={dismissTeaser}><IconX /></button>
        </div>
      )}
      <button ref={launcherRef} type="button" class={`u-launcher u-launcher-${s.appearance.launcherStyle}${s.appearance.attentionAnimation && !open && !state.messages.length ? " u-attention" : ""}`}
        aria-label={open ? t.closeChat : t.openChat} aria-expanded={open} onClick={() => store.setFloatingOpen(!open)}>
        {open ? <IconMinus /> : <IconChat />}
        {s.appearance.launcherStyle === "pill" && !open && <span class="u-launcher-label">{s.appearance.launcherLabel[state.language]}</span>}
        {!open && state.unread > 0 && <span class="u-badge" aria-label={t.unread(state.unread)}>{state.unread}</span>}
      </button>
    </div>
  );
}
