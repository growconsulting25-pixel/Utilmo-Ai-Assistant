import { useEffect, useState } from "react";
import { getLang, setLang, tr } from "../i18n";
import { api } from "../api";
import { ErrorBox, Field } from "../ui";

export function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [needsSetup, setNeedsSetup] = useState(false);
  const [tokenConfigured, setTokenConfigured] = useState(true);
  const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [token, setToken] = useState(""); const [name, setName] = useState("");
  const [recover, setRecover] = useState(false);
  const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [done, setDone] = useState(false);
  useEffect(() => { api<{ needsSetup: boolean; setupTokenConfigured: boolean }>("/setup-status").then((r) => { setNeedsSetup(r.needsSetup); setTokenConfigured(r.setupTokenConfigured); }).catch(() => {}); }, []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      if (recover) { await api("/recover", { body: { token, email, password, name } }); setDone(true); setRecover(false); setToken(""); }
      else if (needsSetup) { await api("/setup", { body: { token, email, password, name } }); setDone(true); setNeedsSetup(false); }
      else { await api("/login", { body: { email, password } }); await api("/me", { method: "PATCH", body: { ui_language: getLang() } }).catch(() => {}); onLoggedIn(); }
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-brand/5 to-slate-50 p-4">
      <form onSubmit={submit} className="card w-full max-w-sm space-y-4 p-7">
        <div className="flex items-center gap-2"><img src="/brand/utilmo-logo_2024.png" alt="Utilmo" className="h-8" /><span className="rounded bg-brand-accent/10 px-1.5 py-0.5 text-[11px] font-bold text-brand-accent">AI</span>
          <div className="ml-auto inline-flex rounded-full border border-slate-200 p-0.5 text-xs font-semibold" role="group" aria-label="Langue / Language">
            {(["fr", "en"] as const).map((l) => <button key={l} type="button" onClick={() => setLang(l)} className={`rounded-full px-2.5 py-1 ${getLang() === l ? "bg-brand text-white" : "text-slate-500"}`}>{l.toUpperCase()}</button>)}
          </div></div>
        <div><h1 className="text-xl font-semibold">{recover ? tr("Récupération du compte") : needsSetup ? tr("Configuration initiale") : "Administration"}</h1>
          <p className="text-sm text-slate-500">{recover ? tr("Utilisez le jeton ADMIN_RECOVERY_TOKEN défini dans Netlify pour créer ou réinitialiser un compte propriétaire (usage unique).") : needsSetup ? tr("Créez le compte propriétaire avec le jeton ADMIN_SETUP_TOKEN défini dans Netlify.") : tr("Connectez-vous pour gérer l'assistant.")}</p></div>
        {needsSetup && !tokenConfigured && <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{tr("Définissez d'abord la variable d'environnement")} <b>ADMIN_SETUP_TOKEN</b> {tr("(16 caractères min.) dans Netlify → Configuration du site → Variables d'environnement, puis redéployez.")}</div>}
        {done && <div className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">{tr("Compte créé. Vous pouvez vous connecter.")}</div>}
        <ErrorBox error={error} />
        {(needsSetup || recover) && <Field label={recover ? tr("Jeton de récupération") : tr("Jeton de configuration")}><input className="input" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} required /></Field>}
        {(needsSetup || recover) && <Field label={tr("Nom")}><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>}
        <Field label={tr("Courriel")}><input className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
        <Field label={tr("Mot de passe")} hint={needsSetup || recover ? tr("12 caractères min., majuscule, minuscule et chiffre.") : undefined}><input className="input" type="password" autoComplete={needsSetup || recover ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
        <button className="btn-primary w-full justify-center" disabled={busy}>{busy ? "…" : recover ? tr("Récupérer le compte") : needsSetup ? tr("Créer le compte") : tr("Se connecter")}</button>
        {!needsSetup && <button type="button" className="w-full text-center text-xs text-slate-500 hover:text-brand" onClick={() => { setRecover(!recover); setError(null); }}>{recover ? tr("← Retour à la connexion") : tr("Accès perdu ? Récupérer le compte")}</button>}
      </form>
    </div>
  );
}
