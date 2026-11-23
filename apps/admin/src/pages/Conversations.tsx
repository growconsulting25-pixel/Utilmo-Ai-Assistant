import { useState } from "react";
import { api } from "../api";
import { Empty, ErrorBox, fmtDate, Loading, PageHeader, PriorityBadge, StatusBadge, useAsync } from "../ui";

const INTENTS = ["LEAD_GENERATION", "CRM", "WEBSITE", "AUTOMATION", "MARKETING", "BRANDING", "AI_ASSISTANT", "CUSTOMER_SUPPORT"];

export function Conversations({ id, role }: { id?: string; role: string }) {
  if (id) return <ConversationDetail id={id} role={role} />;
  const [f, setF] = useState({ q: "", from: "", to: "", intent: "", minScore: "", escalation: "" });
  const [applied, setApplied] = useState(f);
  const qs = new URLSearchParams(Object.entries(applied).filter(([, v]) => v)).toString();
  const { data, error, loading } = useAsync(() => api(`/conversations?limit=100&${qs}`), [qs]);
  return (
    <>
      <PageHeader title="Conversations" subtitle="Historique, résumés IA, profils extraits et escalades." />
      <form className="card mb-4 grid gap-3 p-4 sm:grid-cols-3 lg:grid-cols-7" onSubmit={(e) => { e.preventDefault(); setApplied(f); }}>
        <input className="input lg:col-span-2" placeholder="Rechercher (texte, nom, courriel)…" aria-label="Rechercher" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
        <input className="input" type="date" aria-label="Depuis" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
        <input className="input" type="date" aria-label="Jusqu'au" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
        <select className="input" aria-label="Intention" value={f.intent} onChange={(e) => setF({ ...f, intent: e.target.value })}><option value="">Toutes intentions</option>{INTENTS.map((i) => <option key={i}>{i}</option>)}</select>
        <select className="input" aria-label="Score minimum" value={f.minScore} onChange={(e) => setF({ ...f, minScore: e.target.value })}><option value="">Tout score</option><option value="40">≥ 40</option><option value="70">≥ 70</option></select>
        <button className="btn-primary justify-center">Filtrer</button>
      </form>
      <ErrorBox error={error} />
      {loading ? <Loading /> : !data?.items.length ? <Empty>Aucune conversation.</Empty> : (
        <div className="card overflow-x-auto"><table className="w-full">
          <thead className="border-b border-slate-200 bg-slate-50"><tr><th className="th">Date</th><th className="th">Visiteur</th><th className="th">Résumé</th><th className="th">Intérêts</th><th className="th">État</th><th className="th">Score</th></tr></thead>
          <tbody className="divide-y divide-slate-100">{data.items.map((c: any) => (
            <tr key={c.id} className="cursor-pointer hover:bg-slate-50" onClick={() => (location.hash = `#/conversations/${c.id}`)}>
              <td className="td whitespace-nowrap text-slate-500">{fmtDate(c.last_message_at ?? c.created_at)}</td>
              <td className="td">{c.first_name ? `${c.first_name} ${c.last_name ?? ""}` : <span className="text-slate-400">Anonyme</span>}<div className="text-xs text-slate-500">{c.email}</div></td>
              <td className="td max-w-md text-slate-600"><a href={`#/conversations/${c.id}`} className="line-clamp-2">{c.summary ?? `${c.message_count} messages`}</a></td>
              <td className="td"><div className="flex flex-wrap gap-1">{c.intents?.slice(0, 3).map((i: string) => <span key={i} className="badge bg-slate-100 text-slate-600">{i}</span>)}</div></td>
              <td className="td"><StatusBadge s={c.state} />{c.escalation_status !== "none" && <div className="mt-1"><span className="badge bg-red-50 text-red-700">{c.escalation_status}</span></div>}</td>
              <td className="td font-semibold tabular-nums">{c.score}</td>
            </tr>))}</tbody></table></div>
      )}
    </>
  );
}

function ConversationDetail({ id, role }: { id: string; role: string }) {
  const { data, error, loading, reload } = useAsync(() => api(`/conversations/${id}`), [id]);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const c = data.conversation, lead = data.lead;
  const profile = Object.entries(c.profile ?? {}).filter(([k]) => k !== "flags") as [string, { value: unknown; source: string }][];
  const setEsc = async (v: string) => { await api(`/conversations/${id}`, { method: "PATCH", body: { escalation_status: v } }); reload(); };
  const del = async () => { if (confirm("Supprimer définitivement cette conversation (demande d'accès/suppression) ?")) { await api(`/conversations/${id}`, { method: "DELETE" }); location.hash = "#/conversations"; } };
  return (
    <>
      <PageHeader title="Conversation" subtitle={`${fmtDate(c.created_at)} · ${c.language.toUpperCase()} · ${c.message_count} messages`}
        actions={<><a className="btn-secondary" href="#/conversations">← Retour</a>{role !== "viewer" && <select className="input w-auto" value={c.escalation_status} onChange={(e) => setEsc(e.target.value)} aria-label="Escalade"><option value="none">Aucune escalade</option><option value="requested">Escalade demandée</option><option value="ticket_created">Billet créé</option><option value="resolved">Résolue</option></select>}{(role === "admin" || role === "owner") && <button className="btn-danger" onClick={del}>Supprimer</button>}</>} />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="card p-5 lg:col-span-2">
          <h2 className="mb-3 text-sm font-semibold">Transcription</h2>
          <ol className="space-y-3">{data.messages.map((m: any) => (
            <li key={m.id} className={m.role === "user" ? "flex justify-end" : ""}>
              <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm ${m.role === "user" ? "bg-brand text-white" : "bg-slate-100"}`}>
                <div className="whitespace-pre-wrap">{m.content}</div>
                {m.role === "assistant" && m.metadata && (
                  <details className="mt-2 text-xs text-slate-500"><summary className="cursor-pointer">Détails ({m.metadata.state}{m.metadata.latency_ms ? ` · ${(m.metadata.latency_ms / 1000).toFixed(1)} s` : ""})</summary>
                    <div className="mt-1 space-y-1"><div>Intentions : {(m.metadata.intents ?? []).join(", ")}</div><div>Question posée : {m.metadata.ask_field ?? "—"}</div>
                      <div>Sources : {(m.metadata.sources ?? []).map((s: any) => `${s.title} (P${s.priority})`).join(" · ") || "aucune"}</div>
                      <div>Modèle : {m.metadata.model} · jetons {m.metadata.usage?.inputTokens}/{m.metadata.usage?.outputTokens}</div></div></details>)}
              </div>
            </li>))}</ol>
        </div>
        <div className="space-y-4">
          <div className="card p-5"><h2 className="mb-2 text-sm font-semibold">Résumé IA</h2><p className="text-sm text-slate-600">{c.summary ?? "—"}</p></div>
          <div className="card p-5"><h2 className="mb-2 text-sm font-semibold">Profil extrait</h2>
            {profile.length ? <dl className="space-y-1.5 text-sm">{profile.map(([k, f]) => <div key={k} className="flex justify-between gap-3"><dt className="text-slate-500">{k}</dt><dd className="text-right font-medium">{Array.isArray(f.value) ? f.value.join(", ") : String(f.value)} <span className="text-[10px] text-slate-400">{f.source}</span></dd></div>)}</dl> : <p className="text-sm text-slate-500">Aucune information.</p>}
          </div>
          {lead && <div className="card p-5"><h2 className="mb-2 text-sm font-semibold">Lead</h2><a className="text-sm font-semibold text-brand" href={`#/leads/${lead.id}`}>{lead.first_name} {lead.last_name}</a><div className="mt-1 flex items-center gap-2 text-sm">Score {lead.score} <PriorityBadge p={lead.priority} /></div></div>}
          {data.recommendations.length > 0 && <div className="card p-5"><h2 className="mb-2 text-sm font-semibold">Recommandations</h2><ul className="space-y-1 text-sm">{data.recommendations.map((r: any) => <li key={r.service_key}><b>{r.service_key}</b> · confiance {Math.round(r.confidence * 100)} %</li>)}</ul></div>}
          {data.tickets.length > 0 && <div className="card p-5"><h2 className="mb-2 text-sm font-semibold">Billets de soutien</h2>{data.tickets.map((t: any) => <div key={t.id} className="text-sm">{t.id.slice(0, 8).toUpperCase()} · {t.status} · {t.priority}</div>)}</div>}
          <div className="card p-5 text-xs text-slate-500"><div>Première visite : {JSON.stringify(c.first_touch ?? {})}</div></div>
        </div>
      </div>
    </>
  );
}
