import { useState } from "react";
import { tr, L } from "../i18n";
import { api } from "../api";
import { Empty, ErrorBox, Field, fmtDate, Loading, Modal, PageHeader, Toast, useAsync } from "../ui";

const TYPES: Record<string, { label: string; help: string; status: string }> = {
  webhook: { label: tr("Webhook générique (REST)"), help: tr("POST JSON signé HMAC-SHA256 (en-tête X-Utilmo-Signature: t=…,v1=…) avec Idempotency-Key."), status: tr("Prêt") },
  zapier: { label: "Zapier (Catch Hook)", help: tr("Collez l'URL « Catch Hook » de votre Zap."), status: tr("Prêt") },
  make: { label: "Make (Custom webhook)", help: tr("Collez l'URL du webhook Make."), status: tr("Prêt") },
  highlevel: { label: "HighLevel (API v2)", help: tr("Jeton d'intégration privée + Location ID. Crée/met à jour le contact (upsert). Nécessite une autorisation HighLevel."), status: tr("À tester avec votre compte") },
  email: { label: "Notification courriel (Resend)", help: tr("Clé API Resend comme secret, expéditeur vérifié et destinataires."), status: tr("Nécessite un compte Resend") },
  utilmo_crm: { label: "CRM Utilmo (API)", help: tr("Aucun point d'accès d'API Utilmo documenté n'a été fourni : utilisez un webhook (Zapier/Make) en attendant la documentation de l'API."), status: "Non disponible" },
  cal_com: { label: tr("Cal.com (réservations confirmées)"), help: tr("Secret de signature du webhook Cal.com. URL à configurer dans Cal.com : /api/booking/webhook/<id>."), status: tr("Prêt") },
  calendly: { label: tr("Calendly (réservations confirmées)"), help: tr("Clé de signature du webhook Calendly (forfait payant requis). URL : /api/booking/webhook/<id>."), status: tr("Prêt") },
};
const EVENTS = ["lead.captured", "lead.qualified", "support.ticket_created"];

export function Integrations({ role }: { role: string }) {
  const admin = role === "admin" || role === "owner";
  const { data, error, loading, reload } = useAsync(() => api("/integrations"), []);
  const deliveries = useAsync(() => api("/deliveries"), []);
  const [edit, setEdit] = useState<any | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const test = async (id: string) => { const r = await api(`/integrations/${id}/test`, { method: "POST" }); setToast(`Test : ${r.result}${r.delivery?.last_status_code ? ` (HTTP ${r.delivery.last_status_code})` : ""}${r.delivery?.last_error ? ` — ${r.delivery.last_error}` : ""}`); deliveries.reload(); };
  const retry = async (id: string) => { const r = await api(`/deliveries/${id}/retry`, { method: "POST" }); setToast(`Relance : ${r.result}`); deliveries.reload(); };
  return (
    <>
      <PageHeader title={tr("Intégrations")} subtitle={tr("Les leads ne sont jamais déclarés « synchronisés » sans une réponse 2xx de la destination. Les secrets sont chiffrés (AES-256-GCM).")}
        actions={admin && <button className="btn-primary" onClick={() => setEdit({ type: "webhook", name: "", enabled: true, config: { url: "", events: ["lead.captured", "lead.qualified"] }, secret: "" })}>{tr("+ Intégration")}</button>} />
      <ErrorBox error={error} />
      {loading ? <Loading /> : !data?.items.length ? <Empty>{tr("Aucune intégration. Les leads restent enregistrés dans la base de données et visibles dans l'onglet Leads.")}</Empty> : (
        <div className="card divide-y divide-slate-100">{data.items.map((i: any) => (
          <div key={i.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div><div className="font-semibold">{i.name} <span className="badge ml-1 bg-slate-100 text-slate-600">{TYPES[i.type]?.label ?? i.type}</span> <span className={`badge ml-1 ${i.enabled ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-500"}`}>{i.enabled ? tr("actif") : tr("inactif")}</span></div>
              <div className="text-xs text-slate-500">{i.config.url ? new URL(i.config.url).host : ""} · événements : {(i.config.events ?? []).join(", ") || "tous"} · secret {i.has_secret ? tr("configuré") : tr("absent")}{["cal_com", "calendly"].includes(i.type) && ` · URL : ${location.origin}/api/booking/webhook/${i.id}`}</div></div>
            {admin && <div className="flex gap-2"><button className="btn-secondary" onClick={() => test(i.id)}>{tr("Tester")}</button><button className="btn-secondary" onClick={() => setEdit({ ...i, secret: "" })}>{tr("Modifier")}</button></div>}
          </div>))}</div>
      )}
      <h2 className="mb-2 mt-8 text-lg font-semibold">{tr("Journal des livraisons")}</h2>
      {deliveries.loading ? <Loading /> : !deliveries.data?.items.length ? <Empty>{tr("Aucune livraison.")}</Empty> : (
        <div className="card overflow-x-auto"><table className="w-full"><thead className="border-b bg-slate-50"><tr><th className="th">Date</th><th className="th">{tr("Intégration")}</th><th className="th">{L("Événement", "Event")}</th><th className="th">{tr("Statut")}</th><th className="th">{tr("Essais")}</th><th className="th">{tr("Dernière erreur")}</th><th className="th" /></tr></thead>
          <tbody className="divide-y divide-slate-100">{deliveries.data.items.map((d: any) => (
            <tr key={d.id}><td className="td whitespace-nowrap text-xs">{fmtDate(d.created_at)}</td><td className="td text-xs">{d.integration}</td><td className="td font-mono text-xs">{d.event}</td>
              <td className="td"><span className={`badge ${d.status === "success" ? "bg-emerald-100 text-emerald-800" : d.status === "dead" ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-800"}`}>{d.status}</span></td>
              <td className="td text-xs">{d.attempts}{d.status === "failed" && <div className="text-slate-400">proch. {fmtDate(d.next_attempt_at)}</div>}</td><td className="td max-w-xs truncate text-xs text-red-700">{d.last_error ?? (d.last_status_code ? `HTTP ${d.last_status_code}` : "")}</td>
              <td className="td">{role !== "viewer" && ["failed", "dead"].includes(d.status) && <button className="btn-secondary" onClick={() => retry(d.id)}>{tr("Relancer")}</button>}</td></tr>))}</tbody></table></div>
      )}
      {edit && <IntegrationEditor it={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
      <Toast msg={toast} onDone={() => setToast(null)} />
    </>
  );
}

function IntegrationEditor({ it, onClose, onSaved }: { it: any; onClose: () => void; onSaved: () => void }) {
  const [d, setD] = useState(it);
  const [err, setErr] = useState<string | null>(null);
  const isNew = !it.id;
  const t = TYPES[d.type];
  const save = async () => {
    try {
      const body = { type: d.type, name: d.name, enabled: d.enabled, config: { ...d.config, url: d.config.url || undefined }, secret: d.secret || undefined };
      if (isNew) await api("/integrations", { body }); else await api(`/integrations/${it.id}`, { method: "PATCH", body: { name: body.name, enabled: body.enabled, config: body.config, secret: body.secret } });
      onSaved();
    } catch (e) { setErr((e as Error).message); }
  };
  const del = async () => { if (confirm(tr("Supprimer cette intégration ?"))) { await api(`/integrations/${it.id}`, { method: "DELETE" }); onSaved(); } };
  return (
    <Modal title={isNew ? tr("Nouvelle intégration") : it.name} onClose={onClose}>
      <ErrorBox error={err} />
      <div className="space-y-3">
        <Field label="Type"><select className="input" disabled={!isNew} value={d.type} onChange={(e) => setD({ ...d, type: e.target.value })}>{Object.entries(TYPES).map(([k, v]) => <option key={k} value={k}>{v.label} — {v.status}</option>)}</select></Field>
        <p className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600">{t?.help}</p>
        <Field label={tr("Nom")}><input className="input" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} /></Field>
        {["webhook", "zapier", "make"].includes(d.type) && <Field label={tr("URL de destination (https)")}><input className="input" value={d.config.url ?? ""} onChange={(e) => setD({ ...d, config: { ...d.config, url: e.target.value } })} /></Field>}
        {d.type === "highlevel" && <Field label="Location ID"><input className="input" value={d.config.location_id ?? ""} onChange={(e) => setD({ ...d, config: { ...d.config, location_id: e.target.value } })} /></Field>}
        {d.type === "email" && <><Field label={tr("Expéditeur (domaine vérifié)")}><input className="input" value={d.config.from ?? ""} onChange={(e) => setD({ ...d, config: { ...d.config, from: e.target.value } })} /></Field><Field label={tr("Destinataires (séparés par des virgules)")}><input className="input" value={d.config.to ?? ""} onChange={(e) => setD({ ...d, config: { ...d.config, to: e.target.value } })} /></Field></>}
        {!["cal_com", "calendly"].includes(d.type) && <Field label={L("Événements", "Events")}><div className="flex flex-wrap gap-3">{EVENTS.map((ev) => <label key={ev} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={(d.config.events ?? []).includes(ev)} onChange={(e) => setD({ ...d, config: { ...d.config, events: e.target.checked ? [...(d.config.events ?? []), ev] : d.config.events.filter((x: string) => x !== ev) } })} />{ev}</label>)}</div></Field>}
        {d.type === "webhook" && <Field label={tr("Correspondance de champs (JSON optionnel)")} hint='Ex. : {"email":"lead.email","nom":"lead.last_name"} — vide = charge utile complète versionnée.'><textarea className="input h-20 font-mono text-xs" defaultValue={d.config.field_mapping ? JSON.stringify(d.config.field_mapping) : ""} onBlur={(e) => { try { setD({ ...d, config: { ...d.config, field_mapping: e.target.value ? JSON.parse(e.target.value) : undefined } }); setErr(null); } catch { setErr("JSON de correspondance invalide"); } }} /></Field>}
        <Field label={isNew ? tr("Secret (signature / jeton / clé API)") : tr("Nouveau secret (laisser vide pour conserver)")} hint={tr("Stocké chiffré ; jamais réaffiché.")}><input className="input" type="password" autoComplete="off" value={d.secret} onChange={(e) => setD({ ...d, secret: e.target.value })} /></Field>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={d.enabled} onChange={(e) => setD({ ...d, enabled: e.target.checked })} /> Active</label>
      </div>
      <div className="mt-4 flex justify-between"><div>{!isNew && <button className="btn-danger" onClick={del}>{tr("Supprimer")}</button>}</div><div className="flex gap-2"><button className="btn-secondary" onClick={onClose}>{tr("Annuler")}</button><button className="btn-primary" onClick={save}>{tr("Enregistrer")}</button></div></div>
    </Modal>
  );
}
