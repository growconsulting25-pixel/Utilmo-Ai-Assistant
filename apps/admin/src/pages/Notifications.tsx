import { useEffect, useState } from "react";
import { api } from "../api";
import { L } from "../i18n";
import { ErrorBox, Field, Loading, PageHeader, Toast, useAsync } from "../ui";

const EVENTS: [string, string, string][] = [
  ["lead.captured", "Nouveaux leads (coordonnées reçues)", "New leads (contact details received)"],
  ["lead.qualified", "Leads qualifiés", "Qualified leads"],
  ["support.ticket_created", "Demandes de soutien (billets)", "Support requests (tickets)"],
  ["human.requested", "Visiteur qui veut parler à quelqu'un", "Visitor who wants to talk to someone"],
];
const PRESETS: Record<string, { host: string; port: number; label: string }> = {
  google: { host: "smtp.gmail.com", port: 465, label: "Google Workspace / Gmail" },
  microsoft: { host: "smtp.office365.com", port: 587, label: "Microsoft 365 / Outlook" },
};

export function Notifications({ role }: { role: string }) {
  const admin = role === "admin" || role === "owner";
  const { data, error, loading, reload } = useAsync(() => api("/integrations"), []);
  const existing = (data?.items ?? []).find((i: any) => i.type === "email");
  const [f, setF] = useState<any>(null);
  const [secret, setSecret] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!data) return;
    const c = existing?.config ?? {};
    setF({ enabled: existing?.enabled ?? false, to: c.to ?? "support@marketingwebsites.ca, jean@marketingwebsites.ca, support@utilmo.com", events: c.events ?? EVENTS.filter((e) => e[0] !== "lead.qualified").map((e) => e[0]), provider: c.provider ?? "smtp", smtp_host: c.smtp_host ?? "", smtp_port: c.smtp_port ?? 465, smtp_user: c.smtp_user ?? "", from: c.from ?? "" });
  }, [data]);
  if (loading || !f) return <Loading />;
  const save = async (thenTest = false) => {
    setErr(null); setBusy(true);
    try {
      const config = { to: f.to, events: f.events, provider: f.provider, smtp_host: f.smtp_host || undefined, smtp_port: Number(f.smtp_port) || undefined, smtp_user: f.smtp_user || undefined, from: f.from || undefined };
      let id = existing?.id;
      if (id) await api(`/integrations/${id}`, { method: "PATCH", body: { enabled: f.enabled, config, secret: secret || undefined } });
      else id = (await api("/integrations", { body: { type: "email", name: "Notifications courriel", enabled: f.enabled, config, secret: secret || undefined } })).id;
      setSecret("");
      if (thenTest) {
        const r = await api(`/integrations/${id}/test`, { method: "POST" });
        setToast(r.result === "success" ? (f.enabled ? L("Courriel test envoyé ✔ Vérifiez les boîtes de réception.", "Test email sent ✔ Check the inboxes.") : L("Courriel test envoyé ✔ Cochez « Notifications activées » puis Enregistrer pour recevoir les vraies alertes.", "Test email sent ✔ Tick “Notifications enabled” and Save to receive real alerts.")) : L(`Échec de l'envoi : ${r.delivery?.last_error ?? r.result}`, `Sending failed: ${r.delivery?.last_error ?? r.result}`));
      } else setToast(L("Notifications enregistrées", "Notifications saved"));
      reload();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const configured = !!existing?.has_secret && (f.provider === "resend" || (f.smtp_host && f.smtp_user));
  return (
    <>
      <PageHeader title="Notifications" subtitle={L("Courriels envoyés à l'équipe pour les nouveaux leads, les demandes de soutien et les visiteurs qui veulent parler à quelqu'un (avec un lien direct vers la conversation).", "Emails sent to the team for new leads, support requests and visitors who want to talk to someone (with a direct link to the conversation).")} />
      <ErrorBox error={error ?? err} />
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card space-y-4 p-5">
          <h2 className="text-sm font-semibold">{L("Qui reçoit quoi", "Who gets what")}</h2>
          <Field label={L("Destinataires (séparés par des virgules)", "Recipients (comma-separated)")}><textarea className="input h-20" disabled={!admin} value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
          <Field label={L("Événements", "Events")}><div className="space-y-2">{EVENTS.map(([k, fr, en]) => (
            <label key={k} className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={!admin} checked={f.events.includes(k)} onChange={(e) => setF({ ...f, events: e.target.checked ? [...f.events, k] : f.events.filter((x: string) => x !== k) })} />{L(fr, en)}</label>))}</div></Field>
          <label className="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" disabled={!admin} checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} />{L("Notifications activées", "Notifications enabled")}</label>
          {configured && !f.enabled && <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{L("Les notifications sont désactivées : cochez « Notifications activées » puis Enregistrer.", "Notifications are disabled: tick “Notifications enabled” then Save.")}</div>}
          {!configured && <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{L("Configurez l'expéditeur (à droite) pour que les courriels partent.", "Configure the sender (right) so emails can be sent.")}</div>}
        </div>
        <div className="card space-y-4 p-5">
          <h2 className="text-sm font-semibold">{L("Expéditeur", "Sender")}</h2>
          <Field label={L("Méthode d'envoi", "Sending method")}><select className="input" disabled={!admin} value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value })}><option value="smtp">{L("Boîte courriel (SMTP) — Google Workspace, Microsoft 365…", "Mailbox (SMTP) — Google Workspace, Microsoft 365…")}</option><option value="resend">Resend (API)</option></select></Field>
          {f.provider === "smtp" && <>
            <div className="flex flex-wrap gap-2">{Object.values(PRESETS).map((p) => <button key={p.host} type="button" disabled={!admin} className="btn-secondary" onClick={() => setF({ ...f, smtp_host: p.host, smtp_port: p.port })}>{p.label}</button>)}</div>
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2"><Field label={L("Serveur SMTP", "SMTP server")}><input className="input" disabled={!admin} value={f.smtp_host} onChange={(e) => setF({ ...f, smtp_host: e.target.value })} placeholder="smtp.gmail.com" /></Field></div>
              <Field label="Port"><input className="input" type="number" disabled={!admin} value={f.smtp_port} onChange={(e) => setF({ ...f, smtp_port: e.target.value })} /></Field>
            </div>
            <Field label={L("Adresse de connexion", "Login address")}><input className="input" disabled={!admin} value={f.smtp_user} onChange={(e) => setF({ ...f, smtp_user: e.target.value })} placeholder="notifications@marketingwebsites.ca" /></Field>
          </>}
          <Field label={L("Adresse d'expédition (optionnel)", "From address (optional)")}><input className="input" disabled={!admin} value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} placeholder="Utilmo AI <notifications@marketingwebsites.ca>" /></Field>
          <Field label={f.provider === "smtp" ? L("Mot de passe d'application", "App password") : L("Clé API Resend", "Resend API key")} hint={existing?.has_secret ? L("Déjà enregistré (chiffré). Laissez vide pour le conserver.", "Already saved (encrypted). Leave empty to keep it.") : f.provider === "smtp" ? L("Google : créez un « mot de passe d'application » (compte Google → Sécurité → Validation en 2 étapes → Mots de passe des applications). Microsoft 365 : SMTP authentifié doit être activé.", "Google: create an “app password” (Google account → Security → 2-Step Verification → App passwords). Microsoft 365: authenticated SMTP must be enabled.") : undefined}>
            <input className="input" type="password" autoComplete="off" disabled={!admin} value={secret} onChange={(e) => setSecret(e.target.value)} />
          </Field>
          {admin && <div className="flex flex-wrap gap-2"><button className="btn-primary" disabled={busy} onClick={() => save(false)}>{L("Enregistrer", "Save")}</button><button className="btn-secondary" disabled={busy} onClick={() => save(true)}>{L("Enregistrer et envoyer un test", "Save and send a test")}</button></div>}
        </div>
      </div>
      <Toast msg={toast} onDone={() => setToast(null)} />
    </>
  );
}
