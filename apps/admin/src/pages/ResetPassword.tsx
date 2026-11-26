import { useState } from "react";
import { api } from "../api";
import { getLang, L, setLang } from "../i18n";
import { ErrorBox, Field } from "../ui";

/** Landing page for password-reset and invitation links (#/reset?token=…). */
export function ResetPassword() {
  const token = new URLSearchParams(location.hash.split("?")[1] ?? "").get("token") ?? "";
  const [pw, setPw] = useState(""); const [pw2, setPw2] = useState("");
  const [err, setErr] = useState<string | null>(null); const [done, setDone] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null);
    if (pw !== pw2) { setErr(L("Les mots de passe ne correspondent pas.", "Passwords don't match.")); return; }
    setBusy(true);
    try { const r = await api<{ email: string }>("/reset", { body: { token, password: pw } }); setDone(r.email); } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-brand/5 to-slate-50 p-4">
      <form onSubmit={submit} className="card w-full max-w-sm space-y-4 p-7">
        <div className="flex items-center gap-2"><img src="/brand/utilmo-logo_2024.png" alt="Utilmo" className="h-8" /><span className="rounded bg-brand-accent/10 px-1.5 py-0.5 text-[11px] font-bold text-brand-accent">AI</span>
          <div className="ml-auto inline-flex rounded-full border border-slate-200 p-0.5 text-xs font-semibold">{(["fr", "en"] as const).map((l) => <button key={l} type="button" onClick={() => setLang(l)} className={`rounded-full px-2.5 py-1 ${getLang() === l ? "bg-brand text-white" : "text-slate-500"}`}>{l.toUpperCase()}</button>)}</div></div>
        <h1 className="text-xl font-semibold">{L("Choisir un mot de passe", "Choose a password")}</h1>
        {done ? (
          <>
            <div className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">{L(`Mot de passe enregistré pour ${done}.`, `Password saved for ${done}.`)}</div>
            <a href="#/" onClick={() => setTimeout(() => location.reload(), 0)} className="btn-primary w-full justify-center">{L("Se connecter", "Log in")}</a>
          </>
        ) : (
          <>
            <ErrorBox error={err} />
            {!token && <ErrorBox error={L("Lien incomplet.", "Incomplete link.")} />}
            <Field label={L("Nouveau mot de passe", "New password")} hint={L("12 caractères min., majuscule, minuscule et chiffre.", "12+ characters, upper and lower case and a digit.")}><input className="input" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} required /></Field>
            <Field label={L("Confirmer le mot de passe", "Confirm password")}><input className="input" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} required /></Field>
            <button className="btn-primary w-full justify-center" disabled={busy || !token}>{busy ? "…" : L("Enregistrer le mot de passe", "Save password")}</button>
          </>
        )}
      </form>
    </div>
  );
}
