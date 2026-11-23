import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { STRINGS } from "../i18n";
import { renderMarkdown } from "../markdown";
import type { UIMessage, WidgetState, WidgetStore } from "../store";
import type { ChatAction } from "../types";
import { IconCalendar, IconCheck, IconMore, IconPhone, IconRefresh, IconSend } from "./icons";

export function useStore(store: WidgetStore): WidgetState {
  const [s, setS] = useState(store.state);
  useEffect(() => { const off = store.subscribe(setS); return () => { off(); }; }, [store]);
  return s;
}

export function assetUrl(store: WidgetStore, url: string) {
  if (!url) return "";
  try { return new URL(url, store.api.base + "/").toString(); } catch { return ""; }
}

export function Avatar({ store, size = 36 }: { store: WidgetStore; size?: number }) {
  const s = store.state.config?.settings;
  const src = assetUrl(store, s?.appearance.avatarUrl ?? "");
  return (
    <span class="u-avatar" style={{ width: size, height: size }} aria-hidden="true">
      {src ? <img src={src} alt="" width={size * 0.62} height={size * 0.62} /> : <span>{(s?.assistantName ?? "A").slice(0, 1)}</span>}
    </span>
  );
}

export function Header({ store, state, children }: { store: WidgetStore; state: WidgetState; children?: preact.ComponentChildren }) {
  const t = STRINGS[state.language];
  const [menu, setMenu] = useState(false);
  const s = state.config?.settings;
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => { if (!menuRef.current?.contains(e.composedPath()[0] as Node)) setMenu(false); };
    const host = menuRef.current?.getRootNode() as ShadowRoot;
    host.addEventListener("pointerdown", close);
    return () => host.removeEventListener("pointerdown", close);
  }, [menu]);
  return (
    <div class="u-header">
      <Avatar store={store} size={40} />
      <div class="u-header-text">
        <div class="u-title">{s?.assistantName ?? "Assistant"}</div>
        <div class="u-subtitle"><span class="u-dot" aria-hidden="true" />{t.online}</div>
      </div>
      <div class="u-header-actions">
        <div class="u-lang" role="group" aria-label={t.language}>
          {(["fr", "en"] as const).map((l) => (
            <button type="button" class={state.language === l ? "on" : ""} aria-pressed={state.language === l} onClick={() => store.setLanguage(l)}>{l.toUpperCase()}</button>
          ))}
        </div>
        <div class="u-menu-wrap" ref={menuRef}>
          <button type="button" class="u-icon-btn" aria-label={t.menu} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}><IconMore /></button>
          {menu && (
            <div class="u-menu" role="menu" onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setMenu(false); } }}>
              <button role="menuitem" type="button" onClick={() => { setMenu(false); store.reset(); }}><IconRefresh /> {t.newConversation}</button>
              <button role="menuitem" type="button" onClick={() => { setMenu(false); if (confirm(t.deleteConfirm)) void store.deleteData(); }}>{t.deleteData}</button>
            </div>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}

function Actions({ actions, store, lang }: { actions: ChatAction[]; store: WidgetStore; lang: "fr" | "en" }) {
  const t = STRINGS[lang];
  const busy = store.state.status !== "idle";
  const hosts = store.state.config?.approvedLinkHosts ?? [];
  return (
    <div class="u-actions">
      {actions.map((a) => {
        if (a.type === "booking") return (
          <a class="u-card u-booking" href={a.url} target="_blank" rel="noopener noreferrer" onClick={() => store.api.track("booking_clicked", store.state.token, { url: a.url })}>
            <span class="u-card-icon"><IconCalendar /></span><span class="u-card-label">{a.label}</span><span aria-hidden="true">→</span>
          </a>
        );
        if (a.type === "contact_saved") return <div class="u-chip-ok"><IconCheck /> {t.contactSaved}</div>;
        if (a.type === "ticket_created") return <div class="u-chip-ok"><IconCheck /> {t.ticketCreated} {a.reference}</div>;
        if (a.type === "handoff" && (a.phone || a.email)) return (
          <div class="u-card u-handoff">
            <span class="u-card-icon"><IconPhone /></span>
            <span class="u-card-label">{t.handoffTitle}{a.phone && <> · <a href={`tel:${a.phone.replace(/[^\d+]/g, "")}`}>{a.phone}</a></>}{a.email && <> · <a href={`mailto:${a.email}`}>{a.email}</a></>}</span>
          </div>
        );
        if (a.type === "sources") return (
          <div class="u-sources"><span>{t.sources} :</span>{a.items.map((s) => (hosts.some((h) => { try { return new URL(s.url).hostname.endsWith(h); } catch { return false; } }) ? <a href={s.url} target="_blank" rel="noopener noreferrer">{s.title}</a> : null))}</div>
        );
        if (a.type === "suggestions") return (
          <div class="u-suggestions">{a.items.map((x) => <button type="button" class="u-suggestion" disabled={busy} onClick={() => store.send(x, "inline")}>{x}</button>)}</div>
        );
        return null;
      })}
    </div>
  );
}

function Message({ m, store, state, isLast }: { m: UIMessage; store: WidgetStore; state: WidgetState; isLast: boolean }) {
  const t = STRINGS[state.language];
  const hosts = state.config?.approvedLinkHosts ?? [];
  if (m.role === "user") return <div class="u-row u-row-user"><div class="u-bubble u-user"><span class="u-sr">{t.you}: </span>{m.content}</div></div>;
  const showTyping = m.status === "streaming" && !m.content;
  return (
    <div class="u-row u-row-bot">
      <div class="u-bot-col">
        {showTyping ? (
          <div class="u-bubble u-bot u-typing" aria-label={t.typing}><span /><span /><span /></div>
        ) : m.content ? (
          <div class={`u-bubble u-bot${m.status === "streaming" ? " u-streaming" : ""}`}>{renderMarkdown(m.content, hosts)}</div>
        ) : null}
        {m.status === "error" && (
          <div class="u-error" role="alert">
            {m.errorCode === "busy" ? t.errorBusy : m.errorCode === "rate_limited" ? t.errorRate : m.errorCode === "origin_not_allowed" ? t.errorOrigin : t.errorGeneric}
            {m.errorCode !== "origin_not_allowed" && <button type="button" onClick={() => store.retry(m)} disabled={state.status !== "idle"}><IconRefresh /> {t.retry}</button>}
          </div>
        )}
        {m.actions && m.actions.length > 0 && m.status !== "streaming" && <Actions actions={m.actions.filter((a) => a.type !== "suggestions" || isLast)} store={store} lang={state.language} />}
      </div>
    </div>
  );
}

export function Conversation({ store, state, surface }: { store: WidgetStore; state: WidgetState; surface: "inline" | "floating" }) {
  const t = STRINGS[state.language];
  const s = state.config?.settings;
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const hasUser = state.messages.some((m) => m.role === "user");
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [state.messages, state.phase]);
  const onScroll = () => { const el = listRef.current; if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; };
  const welcome = s ? s.welcome[state.language] || s.welcome.fr : "";
  const suggestions = s ? s.suggestions[state.language] ?? [] : [];
  const lastId = state.messages[state.messages.length - 1]?.id;
  return (
    <div class="u-body" ref={listRef} onScroll={onScroll} role="log" aria-live="polite" aria-relevant="additions" aria-busy={state.status !== "idle"}>
      {welcome && (
        <div class="u-row u-row-bot u-welcome">
          <div class="u-bot-col">
            <div class="u-bubble u-bot">{renderMarkdown(welcome, [])}</div>
            {!hasUser && suggestions.length > 0 && (
              <div class="u-suggestions" role="group" aria-label="Suggestions">
                {suggestions.map((x) => <button type="button" class="u-suggestion" disabled={state.status !== "idle"} onClick={() => store.send(x, surface)}>{x}</button>)}
              </div>
            )}
          </div>
        </div>
      )}
      {state.messages.map((m) => <Message key={m.id} m={m} store={store} state={state} isLast={m.id === lastId} />)}
      {state.phase === "thinking" && state.messages[state.messages.length - 1]?.content && <div class="u-sr" aria-live="polite">{t.typing}</div>}
    </div>
  );
}

export function Composer({ store, state, surface, autoFocus }: { store: WidgetStore; state: WidgetState; surface: "inline" | "floating"; autoFocus?: boolean }) {
  const t = STRINGS[state.language];
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const max = state.config?.settings.maxMessageChars ?? 2000;
  const busy = state.status !== "idle";
  const disabled = !state.config;
  useEffect(() => { if (autoFocus) ref.current?.focus(); }, [autoFocus]);
  const resize = () => { const el = ref.current; if (el) { el.style.height = "auto"; el.style.height = Math.min(el.scrollHeight, 140) + "px"; } };
  const submit = () => {
    if (!text.trim() || busy || disabled) return;
    void store.send(text, surface);
    setText("");
    requestAnimationFrame(resize);
  };
  return (
    <div class="u-footer">
      <form class="u-composer" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <label class="u-sr" for={`u-input-${surface}`}>{t.placeholder}</label>
        <textarea id={`u-input-${surface}`} ref={ref} rows={1} maxLength={max} placeholder={t.placeholder} value={text} disabled={disabled}
          onInput={(e) => { setText((e.target as HTMLTextAreaElement).value); resize(); }}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); } }} />
        <button type="submit" class="u-send" aria-label={t.send} disabled={busy || !text.trim() || disabled}><IconSend /></button>
      </form>
      <div class="u-legal">
        <span>{t.poweredBy}</span>
        {state.config?.settings.privacy.privacyPolicyUrl[state.language] && <> · <a href={state.config.settings.privacy.privacyPolicyUrl[state.language]} target="_blank" rel="noopener noreferrer">{t.privacy}</a></>}
      </div>
      {state.config?.settings.privacy.notice[state.language] && !state.messages.length && <p class="u-notice">{state.config.settings.privacy.notice[state.language]}</p>}
    </div>
  );
}
