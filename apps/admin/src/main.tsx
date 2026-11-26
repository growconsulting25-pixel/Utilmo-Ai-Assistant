import React, { StrictMode, useEffect, useState } from "react";
import { getLang, setLang, tr } from "./i18n";
import { createRoot } from "react-dom/client";
import { BarChart3, BookOpen, UserCog, Code2, LifeBuoy, LogOut, MessagesSquare, Plug, ScrollText, Settings, Sparkles, Users, UserRound, Menu } from "lucide-react";
import "./index.css";
import { api, getAssistant, setAssistant } from "./api";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import { Conversations } from "./pages/Conversations";
import { Leads } from "./pages/Leads";
import { Knowledge } from "./pages/Knowledge";
import { Services } from "./pages/Services";
import { Tickets } from "./pages/Tickets";
import { Integrations } from "./pages/Integrations";
import { SettingsPage } from "./pages/Settings";
import { Embed } from "./pages/Embed";
import { UsersPage } from "./pages/Users";
import { Audit } from "./pages/Audit";
import { Profile } from "./pages/Profile";

export interface Me { user: { id: string; email: string; role: "owner" | "admin" | "editor" | "viewer"; name?: string | null; avatar?: string | null; ui_language?: "fr" | "en" }; organization: { name: string; slug: string } }

const NAV = [
  { id: "dashboard", label: tr("Tableau de bord"), icon: BarChart3 },
  { id: "conversations", label: "Conversations", icon: MessagesSquare },
  { id: "leads", label: "Leads", icon: UserRound },
  { id: "knowledge", label: tr("Base de connaissances"), icon: BookOpen },
  { id: "services", label: tr("Recommandations"), icon: Sparkles },
  { id: "tickets", label: tr("Soutien"), icon: LifeBuoy },
  { id: "integrations", label: tr("Intégrations"), icon: Plug },
  { id: "settings", label: tr("Comportement & apparence"), icon: Settings },
  { id: "embed", label: tr("Intégration du widget"), icon: Code2 },
  { id: "users", label: tr("Utilisateurs"), icon: Users, minRole: "admin" },
  { id: "audit", label: tr("Journal d'audit"), icon: ScrollText, minRole: "admin" },
  { id: "profile", label: tr("Mon profil"), icon: UserCog },
] as const;
const RANK = { viewer: 1, editor: 2, admin: 3, owner: 4 };

function useHash() {
  const [h, setH] = useState(() => location.hash.slice(2) || "dashboard");
  useEffect(() => { const f = () => setH(location.hash.slice(2) || "dashboard"); window.addEventListener("hashchange", f); return () => window.removeEventListener("hashchange", f); }, []);
  return h;
}

function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [assistants, setAssistants] = useState<{ id: string; name: string; public_key: string }[]>([]);
  const [asst, setAsst] = useState<string | null>(getAssistant());
  const [mobileNav, setMobileNav] = useState(false);
  const hash = useHash();
  const [page, ...rest] = hash.split("/");

  const loadMe = () => api<Me>("/me").then((m) => {
    // The interface language follows the user's profile (cached in the browser so it applies before render).
    if (m.user.ui_language && m.user.ui_language !== getLang()) { setLang(m.user.ui_language); return; }
    setMe(m);
  }).catch(() => setMe(null));
  useEffect(() => { loadMe(); const f = () => setMe(null); window.addEventListener("uai-unauth", f); return () => window.removeEventListener("uai-unauth", f); }, []);
  useEffect(() => {
    if (!me) return;
    api<{ items: typeof assistants }>("/assistants").then((r) => {
      setAssistants(r.items);
      const cur = r.items.find((a) => a.id === getAssistant()) ?? r.items[0];
      if (cur) { setAssistant(cur.id); setAsst(cur.id); }
    });
  }, [me]);

  if (me === undefined) return <div className="p-10 text-sm text-slate-500">{tr("Chargement…")}</div>;
  if (me === null) return <Login onLoggedIn={loadMe} />;
  const role = me.user.role;
  const nav = NAV.filter((n) => !("minRole" in n) || RANK[role] >= RANK[n.minRole]);
  const pages: Record<string, React.ReactElement> = {
    dashboard: <Dashboard />, conversations: <Conversations id={rest[0]} role={role} />, leads: <Leads id={rest[0]} role={role} />,
    knowledge: <Knowledge tab={rest[0]} role={role} />, services: <Services role={role} />, tickets: <Tickets role={role} />,
    integrations: <Integrations role={role} />, settings: <SettingsPage role={role} />, embed: <Embed />, users: <UsersPage me={me} />, audit: <Audit />,
    profile: <Profile me={me} onSaved={loadMe} />,
  };
  const changePassword = async () => {
    const current = prompt("Mot de passe actuel"); if (!current) return;
    const next = prompt(tr("Nouveau mot de passe (12 caractères min., majuscule, minuscule et chiffre)")); if (!next) return;
    try { await api("/me/password", { body: { current, password: next } }); alert(tr("Mot de passe modifié.")); } catch (e) { alert((e as Error).message); }
  };
  const logout = async () => { await api("/logout", { method: "POST" }).catch(() => {}); setMe(null); };
  return (
    <div className="flex min-h-screen">
      <aside className={`${mobileNav ? "fixed inset-0 z-40 flex" : "hidden"} w-64 flex-col border-r border-slate-200 bg-white md:static md:flex`}>
        <div className="flex items-center gap-2 px-5 py-5"><img src="/brand/utilmo-logo_2024.png" alt="Utilmo" className="h-7" /><span className="rounded bg-brand-accent/10 px-1.5 py-0.5 text-[11px] font-bold text-brand-accent">AI</span></div>
        {assistants.length > 1 && (
          <div className="px-4 pb-3"><label className="label" htmlFor="asst">Assistant</label>
            <select id="asst" className="input" value={asst ?? ""} onChange={(e) => { setAssistant(e.target.value); setAsst(e.target.value); location.reload(); }}>
              {assistants.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.public_key})</option>)}
            </select></div>
        )}
        <nav className="flex-1 space-y-0.5 px-3" aria-label={tr("Navigation principale")}>
          {nav.map((n) => (
            <a key={n.id} href={`#/${n.id}`} onClick={() => setMobileNav(false)} aria-current={page === n.id ? "page" : undefined}
              className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium ${page === n.id ? "bg-brand/10 text-brand" : "text-slate-600 hover:bg-slate-100"}`}>
              <n.icon size={17} />{n.label}
            </a>
          ))}
        </nav>
        <div className="border-t border-slate-200 p-4 text-xs text-slate-500">
          <a href="#/profile" className="mb-2 flex items-center gap-2">
            {me.user.avatar ? <img src={me.user.avatar} alt="" className="h-9 w-9 rounded-full object-cover" /> : <span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand/10 font-semibold text-brand">{(me.user.name || me.user.email).slice(0, 1).toUpperCase()}</span>}
            <span className="min-w-0"><span className="block truncate font-semibold text-slate-700">{me.user.name || me.user.email}</span>{me.user.name && <span className="block truncate">{me.user.email}</span>}</span>
          </a>
          <div>{me.organization?.name} · {role}</div>
          <button className="mt-2 inline-flex items-center gap-1.5 text-slate-600 hover:text-brand" onClick={logout}><LogOut size={14} /> {me.user.ui_language === "en" ? "Log out" : tr("Déconnexion")}</button>
        </div>
      </aside>
      <main className="min-w-0 flex-1">
        <div className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-3 md:hidden">
          <button aria-label="Menu" onClick={() => setMobileNav(!mobileNav)}><Menu /></button><img src="/brand/utilmo-logo_2024.png" alt="Utilmo" className="h-6" />
        </div>
        <div className="mx-auto max-w-7xl p-4 sm:p-8" key={asst ?? ""}>{asst ? pages[page] ?? pages.dashboard : <div className="text-sm text-slate-500">{tr("Aucun assistant.")}</div>}</div>
      </main>
    </div>
  );
}

document.documentElement.lang = getLang();
createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
