import { useEffect, useState } from "react";
import { tr, L } from "../i18n";
import { api } from "../api";
import { Empty, ErrorBox, fmtDate, Loading, PageHeader, PriorityBadge, StatusBadge, useAsync } from "../ui";

const INTENTS = ["LEAD_GENERATION", "CRM", "WEBSITE", "AUTOMATION", "MARKETING", "BRANDING", "AI_ASSISTANT", "CUSTOMER_SUPPORT"];

export function Conversations({ id, role }: { id?: string; role: string }) {
  if (id) return <ConversationDetail id={id} role={role} />;
  const [f, setF] = useState(() => ({ ...{ q: "", from: "", to: "", intent: "", minScore: "", escalation: "" }, ...Object.fromEntries(new URLSearchParams(location.hash.split("?")[1] ?? "")) }));
  const [applied, setApplied] = useState(f);
  const qs = new URLSearchParams(Object.entries(applied).filter(([, v]) => v)).toString();
  const { data, error, loading } = useAsync(() => api(`/conversations?limit=100&${qs}`), [qs]);
  return (
    <>
      <PageHeader title="Conversations" subtitle={tr("Historique, résumés IA, profils extraits et escalades.")} />
      <form className="card mb-4 grid gap-3 p-4 sm:grid-cols-3 lg:grid-cols-7" onSubmit={(e) => { e.preventDefault(); setApplied(f); }}>
        <input className="input lg:col-span-2" placeholder={tr("Rechercher (texte, nom, courriel)…")} aria-label={tr("Rechercher")} value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
        <input className="input" type="date" aria-label={tr("Depuis")} value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
        <input className="input" type="date" aria-label={tr("Jusqu'au")} value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
        <select className="input" aria-label={tr("Intention")} value={f.intent} onChange={(e) => setF({ ...f, intent: e.target.value })}><option value="">{tr("Toutes intentions")}</option>{INTENTS.map((i) => <option key={i}>{i}</option>)}</select>
        <select className="input" aria-label={tr("Score minimum")} value={f.minScore} onChange={(e) => setF({ ...f, minScore: e.target.value })}><option value="">{tr("Tout score")}</option><option value="40">≥ 40</option><option value="70">≥ 70</option></select>
        <button className="btn-primary justify-center">{tr("Filtrer")}</button>
      </form>
      <ErrorBox error={error} />
      {loading ? <Loading /> : !data?.items.length ? <Empty>{tr("Aucune conversation.")}</Empty> : (
        <div className="card overflow-x-auto"><table className="w-full">
          <thead className="border-b border-slate-200 bg-slate-50"><tr><th className="th">Date</th><th className="th">{tr("Visiteur")}</th><th className="th">{tr("Résumé")}</th><th className="th">{tr("Intérêts")}</th><th className="th">{L("État", "State")}</th><th className="th">Score</th></tr></thead>
          <tbody className="divide-y divide-slate-100">{data.items.map((c: any) => (
            <tr key={c.id} className="cursor-pointer hover:bg-slate-50" onClick={() => (location.hash = `#/conversations/${c.id}`)}>
              <td className="td whitespace-nowrap text-slate-500">{fmtDate(c.last_message_at ?? c.created_at)}</td>
              <td className="td">{c.first_name ? `${c.first_name} ${c.last_name ?? ""}` : <span className="text-slate-400">{tr("Anonyme")}</span>}<div className="text-xs text-slate-500">{c.email}</div></td>
              <td className="td max-w-md text-slate-600"><a href={`#/conversations/${c.id}`} className="line-clamp-2">{c.summary ?? `${c.message_count} ${L("messages", "messages")}`}</a></td>
              <td className="td"><div className="flex flex-wrap gap-1">{c.intents?.slice(0, 3).map((i: string) => <span key={i} className="badge bg-slate-100 text-slate-600">{i}</span>)}</div></td>
              <td className="td"><StatusBadge s={c.state} />{c.escalation_status !== "none" && <div className="mt-1"><span className="badge bg-red-50 text-red-700">{c.escalation_status === "requested" ? L("🔔 Veut parler à quelqu'un", "🔔 Wants a human") : c.escalation_status}</span></div>}</td>
              <td className="td font-semibold tabular-nums">{c.score}</td>
            </tr>))}</tbody></table></div>
      )}
    </>
  );
}

function ConversationDetail({ id, role }: { id: string; role: string }) {
  const { data, error, loading, reload } = useAsync(() => api(`/conversations/${id}`), [id]);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const human = !!data?.conversation?.human_active;
  // Live view: refresh every 4 s while a handoff is requested or a team member is in the conversation.
  useEffect(() => {
    if (!data || (!human && data.conversation.escalation_status !== "requested")) return;
    const t = setInterval(() => { if (document.visibilityState === "visible") reload(); }, 4000);
    return () => clearInterval(t);
  }, [data, human]);
  const takeover = async (active: boolean) => { await api(`/conversations/${id}/takeover`, { body: { active } }); reload(); };
  const sendReply = async (e: React.FormEvent) => {
    e.preventDefault(); if (!reply.trim()) return; setSending(true);
    try { await api(`/conversations/${id}/messages`, { body: { content: reply } }); setReply(""); reload(); } finally { setSending(false); }
  };
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const c = data.conversation, lead = data.lead;
  const profile = Object.entries(c.profile ?? {}).filter(([k]) => k !== "flags") as [string, { value: unknown; source: string }][];
  const setEsc = async (v: string) => { await api(`/conversations/${id}`, { method: "PATCH", body: { escalation_status: v } }); reload(); };
  const del = async () => { if (confirm(tr("Supprimer définitivement cette conversation (demande d'accès/suppression) ?"))) { await api(`/conversations/${id}`, { method: "DELETE" }); location.hash = "#/conversations"; } };
  return (
    <>
      <PageHeader title="Conversation" subtitle={`${fmtDate(c.created_at)} · ${c.language.toUpperCase()} · ${c.message_count} messages`}
        actions={<><a className="btn-secondary" href="#/conversations">{tr("← Retour")}</a>{role !== "viewer" && <select className="input w-auto" value={c.escalation_status} onChange={(e) => setEsc(e.target.value)} aria-label={tr("Escalade")}><option value="none">{tr("Aucune escalade")}</option><option value="requested">{tr("Escalade demandée")}</option><option value="ticket_created">{tr("Billet créé")}</option><option value="resolved">{tr("Résolue")}</option></select>}{(role === "admin" || role === "owner") && <button className="btn-danger" onClick={del}>{tr("Supprimer")}</button>}</>} />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="card p-5 lg:col-span-2">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">{tr("Transcription")}</h2>
            {role !== "viewer" && (human
              ? <button className="btn-secondary" onClick={() => takeover(false)}>{L("Rendre la conversation à l'IA", "Hand back to the AI")}</button>
              : <button className="btn-primary" onClick={() => takeover(true)}>{L("Prendre le relais (répondre en direct)", "Take over (reply live)")}</button>)}
          </div>
          {c.escalation_status === "requested" && !human && <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">🔔 {L("Le visiteur demande à parler à quelqu'un. Prenez le relais pour lui répondre directement dans le clavardage.", "The visitor asked to talk to someone. Take over to reply directly in the chat.")}</div>}
          {human && <div className="mb-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">{L(`Vous êtes en direct (${c.human_agent_name ?? ""}). L'IA est en pause ; vos messages apparaissent dans le clavardage du visiteur.`, `You are live (${c.human_agent_name ?? ""}). The AI is paused; your messages appear in the visitor's chat.`)}</div>}
          <ol className="space-y-3">{data.messages.map((m: any) => m.role === "event" ? (
            <li key={m.id} className="text-center text-xs text-slate-500">— {m.content} —</li>
          ) : (
            <li key={m.id} className={m.role === "user" ? "flex justify-end" : ""}>
              <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm ${m.role === "user" ? "bg-brand text-white" : m.role === "agent" ? "border-2 border-brand-accent/50 bg-white" : "bg-slate-100"}`}>
                {m.role === "agent" && <div className="mb-1 text-xs font-semibold text-brand-accent">{m.metadata?.agent_name ?? L("Équipe", "Team")}</div>}
                <div className="whitespace-pre-wrap">{m.content}</div>
                {m.role === "assistant" && m.metadata && (
                  <details className="mt-2 text-xs text-slate-500"><summary className="cursor-pointer">{tr("Détails")} ({m.metadata.state}{m.metadata.latency_ms ? ` · ${(m.metadata.latency_ms / 1000).toFixed(1)} s` : ""})</summary>
                    <div className="mt-1 space-y-1"><div>{L("Intentions", "Intents")} : {(m.metadata.intents ?? []).join(", ")}</div><div>{L("Question posée", "Question asked")} : {m.metadata.ask_field ?? "—"}</div>
                      <div>{L("Sources", "Sources")} : {(m.metadata.sources ?? []).map((s: any) => `${s.title} (P${s.priority})`).join(" · ") || tr("aucune")}</div>
                      <div>{L("Modèle", "Model")} : {m.metadata.model} · {L("jetons", "tokens")} {m.metadata.usage?.inputTokens}/{m.metadata.usage?.outputTokens}</div></div></details>)}
              </div>
            </li>))}</ol>
          {human && role !== "viewer" && (
            <form onSubmit={sendReply} className="mt-4 flex gap-2">
              <textarea className="input h-20" placeholder={L("Votre réponse au visiteur…", "Your reply to the visitor…")} value={reply} onChange={(e) => setReply(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); (e.currentTarget.form as HTMLFormElement).requestSubmit(); } }} />
              <button className="btn-primary self-end" disabled={sending || !reply.trim()}>{L("Envoyer", "Send")}</button>
            </form>
          )}
        </div>
        <div className="space-y-4">
          <div className="card p-5"><h2 className="mb-2 text-sm font-semibold">{tr("Résumé IA")}</h2><p className="text-sm text-slate-600">{c.summary ?? "—"}</p></div>
          <div className="card p-5"><h2 className="mb-2 text-sm font-semibold">{tr("Profil extrait")}</h2>
            {profile.length ? <dl className="space-y-1.5 text-sm">{profile.map(([k, f]) => <div key={k} className="flex justify-between gap-3"><dt className="text-slate-500">{k}</dt><dd className="text-right font-medium">{Array.isArray(f.value) ? f.value.join(", ") : String(f.value)} <span className="text-[10px] text-slate-400">{f.source}</span></dd></div>)}</dl> : <p className="text-sm text-slate-500">{tr("Aucune information.")}</p>}
          </div>
          {lead && <div className="card p-5"><h2 className="mb-2 text-sm font-semibold">Lead</h2><a className="text-sm font-semibold text-brand" href={`#/leads/${lead.id}`}>{lead.first_name} {lead.last_name}</a><div className="mt-1 flex items-center gap-2 text-sm">Score {lead.score} <PriorityBadge p={lead.priority} /></div></div>}
          {data.recommendations.length > 0 && <div className="card p-5"><h2 className="mb-2 text-sm font-semibold">{tr("Recommandations")}</h2><ul className="space-y-1 text-sm">{data.recommendations.map((r: any) => <li key={r.service_key}><b>{r.service_key}</b> · {L("confiance", "confidence")} {Math.round(r.confidence * 100)} %</li>)}</ul></div>}
          {data.tickets.length > 0 && <div className="card p-5"><h2 className="mb-2 text-sm font-semibold">{tr("Billets de soutien")}</h2>{data.tickets.map((t: any) => <div key={t.id} className="text-sm">{t.id.slice(0, 8).toUpperCase()} · {t.status} · {t.priority}</div>)}</div>}
          <div className="card p-5 text-xs text-slate-500"><div>{L("Première visite", "First visit")} : {JSON.stringify(c.first_touch ?? {})}</div></div>
        </div>
      </div>
    </>
  );
}
