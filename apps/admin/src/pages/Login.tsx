import { useEffect, useState } from "react";
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
      else { await api("/login", { body: { email, password } }); onLoggedIn(); }
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-brand/5 to-slate-50 p-4">
      <form onSubmit={submit} className="card w-full max-w-sm space-y-4 p-7">
        <div className="flex items-center gap-2"><img src="/brand/utilmo-logo_2024.png" alt="Utilmo" className="h-8" /><span className="rounded bg-brand-accent/10 px-1.5 py-0.5 text-[11px] font-bold text-brand-accent">AI</span></div>
        <div><h1 className="text-xl font-semibold">{recover ? "Récupération du compte" : needsSetup ? "Configuration initiale" : "Administration"}</h1>
          <p className="text-sm text-slate-500">{recover ? "Utilisez le jeton ADMIN_RECOVERY_TOKEN défini dans Netlify pour créer ou réinitialiser un compte propriétaire (usage unique)." : needsSetup ? "Créez le compte propriétaire avec le jeton ADMIN_SETUP_TOKEN défini dans Netlify." : "Connectez-vous pour gérer l'assistant."}</p></div>
        {needsSetup && !tokenConfigured && <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">Définissez d'abord la variable d'environnement <b>ADMIN_SETUP_TOKEN</b> (16 caractères min.) dans Netlify → Configuration du site → Variables d'environnement, puis redéployez.</div>}
        {done && <div className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">Compte créé. Vous pouvez vous connecter.</div>}
        <ErrorBox error={error} />
        {(needsSetup || recover) && <Field label={recover ? "Jeton de récupération" : "Jeton de configuration"}><input className="input" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} required /></Field>}
        {(needsSetup || recover) && <Field label="Nom"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>}
        <Field label="Courriel"><input className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
        <Field label="Mot de passe" hint={needsSetup || recover ? "12 caractères min., majuscule, minuscule et chiffre." : undefined}><input className="input" type="password" autoComplete={needsSetup || recover ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
        <button className="btn-primary w-full justify-center" disabled={busy}>{busy ? "…" : recover ? "Récupérer le compte" : needsSetup ? "Créer le compte" : "Se connecter"}</button>
        {!needsSetup && <button type="button" className="w-full text-center text-xs text-slate-500 hover:text-brand" onClick={() => { setRecover(!recover); setError(null); }}>{recover ? "← Retour à la connexion" : "Accès perdu ? Récupérer le compte"}</button>}
      </form>
    </div>
  );
}
