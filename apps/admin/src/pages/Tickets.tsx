import { useState } from "react";
import { tr, L } from "../i18n";
import { api } from "../api";
import { Empty, ErrorBox, fmtDate, Loading, PageHeader, useAsync } from "../ui";

export function Tickets({ role }: { role: string }) {
  const [status, setStatus] = useState("");
  const { data, error, loading, reload } = useAsync(() => api(`/tickets${status ? `?status=${status}` : ""}`), [status]);
  const [open, setOpen] = useState<string | null>(null);
  const patch = async (id: string, body: object) => { await api(`/tickets/${id}`, { method: "PATCH", body }); reload(); };
  return (
    <>
      <PageHeader title={tr("Demandes de soutien")} subtitle={tr("Créées par l'assistant lorsqu'une question de client existant ne peut pas être résolue avec la documentation vérifiée.")}
        actions={<select className="input w-auto" value={status} onChange={(e) => setStatus(e.target.value)} aria-label={tr("Statut")}><option value="">{tr("Tous")}</option>{["open", "in_progress", "waiting", "resolved", "closed"].map((s) => <option key={s}>{s}</option>)}</select>} />
      <ErrorBox error={error} />
      {loading ? <Loading /> : !data?.items.length ? <Empty>{tr("Aucune demande.")}</Empty> : (
        <div className="card divide-y divide-slate-100">{data.items.map((t: any) => (
          <div key={t.id} className="p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <button className="text-left" onClick={() => setOpen(open === t.id ? null : t.id)}><div className="font-semibold">#{t.id.slice(0, 8).toUpperCase()} · {t.category} · {t.customer_name ?? L("Client", "Customer")}</div><div className="text-xs text-slate-500">{fmtDate(t.created_at)} · {t.email ?? ""} {t.phone ?? ""} · {L("équipe", "team")} {t.assigned_team}</div></button>
              <div className="flex gap-2">
                <select className="input w-auto" disabled={role === "viewer"} value={t.priority} onChange={(e) => patch(t.id, { priority: e.target.value })} aria-label={tr("Priorité")}>{["low", "normal", "high", "urgent"].map((x) => <option key={x}>{x}</option>)}</select>
                <select className="input w-auto" disabled={role === "viewer"} value={t.status} onChange={(e) => patch(t.id, { status: e.target.value })} aria-label={tr("Statut")}>{["open", "in_progress", "waiting", "resolved", "closed"].map((x) => <option key={x}>{x}</option>)}</select>
              </div>
            </div>
            <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700">{t.description}</p>
            {open === t.id && <div className="mt-3 space-y-2 rounded-lg bg-slate-50 p-3 text-sm">{t.history_excerpt.map((m: any, i: number) => <div key={i}><b>{m.role === "user" ? L("Client", "Customer") : "Assistant"} :</b> {m.content}</div>)}{t.conversation_id && <a className="text-brand" href={`#/conversations/${t.conversation_id}`}>{tr("Voir la conversation →")}</a>}</div>}
          </div>))}</div>
      )}
    </>
  );
}
