import { useState } from "react";
import { tr, L } from "../i18n";
import { api, downloadUrl } from "../api";
import { Empty, ErrorBox, fmtDate, Loading, PageHeader, PriorityBadge, StatusBadge, SyncBadge, Toast, useAsync } from "../ui";

export function Leads({ id, role }: { id?: string; role: string }) {
  if (id) return <LeadDetail id={id} role={role} />;
  const [f, setF] = useState({ q: "", status: "", priority: "", sync: "", service: "", from: "", to: "" });
  const [applied, setApplied] = useState(f);
  const qs = new URLSearchParams(Object.entries(applied).filter(([, v]) => v)).toString();
  const { data, error, loading } = useAsync(() => api(`/leads?limit=200&${qs}`), [qs]);
  return (
    <>
      <PageHeader title="Leads" subtitle={tr("Profils structurés, score explicable et statut de synchronisation CRM.")}
        actions={(role === "admin" || role === "owner") && <a className="btn-secondary" href={downloadUrl(`/leads/export.csv?${qs}`)}>{tr("Exporter CSV")}</a>} />
      <form className="card mb-4 grid gap-3 p-4 sm:grid-cols-3 lg:grid-cols-8" onSubmit={(e) => { e.preventDefault(); setApplied(f); }}>
        <input className="input lg:col-span-2" placeholder={tr("Nom, courriel, ville…")} aria-label={tr("Rechercher")} value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
        <select className="input" aria-label={tr("Statut")} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="">{tr("Tous statuts")}</option>{["contact_captured", "qualified", "support", "disqualified", "archived"].map((s) => <option key={s}>{s}</option>)}</select>
        <select className="input" aria-label={tr("Priorité")} value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}><option value="">{tr("Toute priorité")}</option><option value="high">{tr("Élevée")}</option><option value="medium">{tr("Moyenne")}</option><option value="low">{tr("Faible")}</option></select>
        <select className="input" aria-label={tr("Synchronisation")} value={f.sync} onChange={(e) => setF({ ...f, sync: e.target.value })}><option value="">{tr("Toute synchro")}</option><option value="synced">{tr("Synchronisé")}</option><option value="pending">{tr("En attente")}</option><option value="failed">{tr("Échec")}</option><option value="not_configured">{tr("Non configuré")}</option></select>
        <input className="input" type="date" aria-label={tr("Depuis")} value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
        <input className="input" type="date" aria-label={tr("Jusqu'au")} value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
        <button className="btn-primary justify-center">{tr("Filtrer")}</button>
      </form>
      <ErrorBox error={error} />
      {loading ? <Loading /> : !data?.items.length ? <Empty>{tr("Aucun lead pour le moment.")}</Empty> : (
        <div className="card overflow-x-auto"><table className="w-full">
          <thead className="border-b border-slate-200 bg-slate-50"><tr><th className="th">Lead</th><th className="th">{tr("Coordonnées")}</th><th className="th">{tr("Secteur")}</th><th className="th">{tr("Intérêts")}</th><th className="th">Score</th><th className="th">{tr("Statut")}</th><th className="th">CRM</th><th className="th">{tr("Mis à jour")}</th></tr></thead>
          <tbody className="divide-y divide-slate-100">{data.items.map((l: any) => (
            <tr key={l.id} className="cursor-pointer hover:bg-slate-50" onClick={() => (location.hash = `#/leads/${l.id}`)}>
              <td className="td font-semibold"><a href={`#/leads/${l.id}`}>{[l.first_name, l.last_name].filter(Boolean).join(" ") || "—"}</a><div className="text-xs font-normal text-slate-500">{l.brokerage}</div></td>
              <td className="td text-slate-600">{l.email_normalized}<div>{l.phone_e164}</div></td>
              <td className="td text-slate-600">{[l.city, ...(l.territory ?? [])].filter(Boolean).filter((x: string, i: number, a: string[]) => a.indexOf(x) === i).join(", ") || "—"}</td>
              <td className="td"><div className="flex flex-wrap gap-1">{(l.services_interest ?? []).map((s: string) => <span key={s} className="badge bg-slate-100 text-slate-600">{s}</span>)}</div></td>
              <td className="td"><div className="font-semibold tabular-nums">{l.score}</div><PriorityBadge p={l.priority} /></td>
              <td className="td"><StatusBadge s={l.status} /></td>
              <td className="td"><SyncBadge s={l.sync_status} /></td>
              <td className="td whitespace-nowrap text-xs text-slate-500">{fmtDate(l.updated_at)}</td>
            </tr>))}</tbody></table></div>
      )}
    </>
  );
}

function LeadDetail({ id, role }: { id: string; role: string }) {
  const { data, error, loading, reload } = useAsync(() => api(`/leads/${id}`), [id]);
  const [toast, setToast] = useState<string | null>(null);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const l = data.lead, q = l.qualification ?? {};
  const latest = data.scores[0];
  const setStatus = async (status: string) => { await api(`/leads/${id}`, { method: "PATCH", body: { status } }); reload(); };
  const resync = async () => { const r = await api(`/leads/${id}/resync`, { method: "POST" }); setToast(L(`${r.retried} livraison(s) relancée(s) : ${r.results.join(", ") || "aucune en échec"}`, `${r.retried} delivery(ies) retried: ${r.results.join(", ") || "none failed"}`)); reload(); };
  const erase = async () => { if (confirm(tr("Effacer définitivement ce lead, ses conversations et billets (droit à l'effacement) ?"))) { await api(`/leads/${id}`, { method: "DELETE" }); location.hash = "#/leads"; } };
  const rows: [string, unknown][] = [[tr("Courriel"), l.email_normalized], [tr("Téléphone"), l.phone_e164], [tr("Langue"), l.language], [tr("Agence / bannière"), l.brokerage], ["Ville", l.city], ["Territoire", (l.territory ?? []).join(", ")], ["Type", l.user_type], [L("Client existant", "Existing customer"), l.existing_customer],
    ["Objectif", q.main_goal], ["CRM actuel", q.current_crm], ["Site web", q.website_status], [tr("Méthodes de leads"), q.lead_methods], [tr("Défi principal"), q.biggest_challenge], ["Volume", q.lead_volume], [tr("Échéancier"), q.timeline], [tr("Intérêt démo"), q.demo_interest], ["Consentement", JSON.stringify(l.consent)]];
  return (
    <>
      <PageHeader title={[l.first_name, l.last_name].filter(Boolean).join(" ") || "Lead"} subtitle={`${L("Créé", "Created")} ${fmtDate(l.created_at)} · ${l.status}`}
        actions={<><a className="btn-secondary" href="#/leads">{tr("← Retour")}</a>{role !== "viewer" && <select className="input w-auto" aria-label={tr("Statut")} value={l.status} onChange={(e) => setStatus(e.target.value)}>{["new", "contact_captured", "qualified", "support", "disqualified", "archived"].map((s) => <option key={s}>{s}</option>)}</select>}
          {role !== "viewer" && <button className="btn-secondary" onClick={resync}>{tr("Relancer la synchro")}</button>}{(role === "admin" || role === "owner") && <button className="btn-danger" onClick={erase}>{tr("Effacer")}</button>}</>} />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="card p-5 lg:col-span-2"><h2 className="mb-3 text-sm font-semibold">{tr("Profil")}</h2>
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">{rows.map(([k, v]) => <div key={k} className="flex justify-between gap-3 border-b border-slate-100 pb-1"><dt className="text-slate-500">{k}</dt><dd className="text-right font-medium">{v ? String(v) : "—"}</dd></div>)}</dl>
          {l.summary && <><h3 className="mb-1 mt-4 text-sm font-semibold">{tr("Résumé")}</h3><p className="text-sm text-slate-600">{l.summary}</p></>}
          <h3 className="mb-1 mt-4 text-sm font-semibold">Conversations</h3>
          <ul className="text-sm">{data.conversations.map((c: any) => <li key={c.id}><a className="text-brand" href={`#/conversations/${c.id}`}>{fmtDate(c.created_at)} — {c.state}</a></li>)}</ul>
        </div>
        <div className="space-y-4">
          <div className="card p-5"><h2 className="text-sm font-semibold">Score</h2><div className="mt-1 flex items-center gap-2"><span className="text-3xl font-semibold">{l.score}</span><PriorityBadge p={l.priority} /></div>
            {latest && <><ul className="mt-3 space-y-1 text-sm">{Object.entries(latest.breakdown).map(([k, v]) => <li key={k} className="flex justify-between"><span className="text-slate-500">{k}</span><span className="tabular-nums">{String(v)}</span></li>)}</ul>
              <ul className="mt-3 list-disc pl-5 text-sm text-slate-600">{latest.reasons.map((r: string) => <li key={r}>{r}</li>)}</ul></>}
          </div>
          <div className="card p-5"><div className="flex items-center justify-between"><h2 className="text-sm font-semibold">{tr("Synchronisation CRM")}</h2><SyncBadge s={l.sync_status} /></div>
            {data.deliveries.length ? <ul className="mt-2 space-y-2 text-xs">{data.deliveries.map((d: any) => <li key={d.id} className="rounded bg-slate-50 p-2"><b>{d.integration}</b> · {d.event} · <span className={d.status === "success" ? "text-emerald-700" : "text-red-700"}>{d.status}</span> ({d.attempts} {L("essai(s)", "attempt(s)")}){d.last_error && <div className="text-red-700">{d.last_error}</div>}</li>)}</ul> : <p className="mt-2 text-xs text-slate-500">{tr("Aucune livraison (aucune intégration active).")}</p>}
          </div>
          {data.bookings.length > 0 && <div className="card p-5"><h2 className="text-sm font-semibold">{tr("Réservations")}</h2>{data.bookings.map((b: any, i: number) => <div key={i} className="text-sm">{b.status} · {b.provider} · {fmtDate(b.scheduled_at ?? b.created_at)}</div>)}</div>}
        </div>
      </div>
      <Toast msg={toast} onDone={() => setToast(null)} />
    </>
  );
}
