import { useState } from "react";
import { api } from "../api";
import { ErrorBox, fmtDate, fmtNum, Loading, PageHeader, useAsync } from "../ui";

const CAT: Record<string, string> = { LEAD_GENERATION: "Génération de leads", CRM: "CRM", WEBSITE: "Site web", AUTOMATION: "Automatisation", MARKETING: "Marketing", BRANDING: "Image de marque", AI_ASSISTANT: "IA", CUSTOMER_SUPPORT: "Soutien", GENERAL_INFORMATION: "Information", OTHER: "Autre" };

function Stat({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return <div className="card p-4"><div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</div><div className="mt-1 text-2xl font-semibold text-slate-900">{value}</div>{sub && <div className="text-xs text-slate-500">{sub}</div>}</div>;
}

function Bars({ rows, label }: { rows: { label: string; n: number }[]; label: string }) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  return (
    <div className="card p-5"><h2 className="mb-3 text-sm font-semibold">{label}</h2>
      {rows.length ? <ul className="space-y-2">{rows.map((r) => (
        <li key={r.label} className="text-sm"><div className="flex justify-between gap-3"><span className="truncate">{r.label}</span><span className="font-semibold tabular-nums">{r.n}</span></div>
          <div className="mt-1 h-1.5 rounded bg-slate-100"><div className="h-1.5 rounded bg-brand" style={{ width: `${(r.n / max) * 100}%` }} /></div></li>))}</ul>
        : <p className="text-sm text-slate-500">Aucune donnée pour la période.</p>}
    </div>
  );
}

export function Dashboard() {
  const [days, setDays] = useState(30);
  const { data, error, loading } = useAsync(() => api(`/dashboard?days=${days}`), [days]);
  if (loading && !data) return <Loading />;
  const t = data?.totals ?? {};
  const daily: { day: string; conversations: number; leads: number }[] = data?.daily ?? [];
  const maxD = Math.max(1, ...daily.map((d) => d.conversations));
  return (
    <>
      <PageHeader title="Tableau de bord" subtitle="Données réelles issues des conversations (aucune donnée de démonstration)."
        actions={<select className="input w-auto" value={days} onChange={(e) => setDays(+e.target.value)} aria-label="Période">{[7, 30, 90, 365].map((d) => <option key={d} value={d}>{d} derniers jours</option>)}</select>} />
      <ErrorBox error={error} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Conversations" value={fmtNum(t.conversations)} sub={`${fmtNum(t.visitors)} visiteurs uniques`} />
        <Stat label="Leads captés" value={fmtNum(t.leads)} sub={`Taux de conversion ${t.conversion_rate ?? 0} %`} />
        <Stat label="Leads qualifiés" value={fmtNum(t.qualified)} />
        <Stat label="Demandes de démo" value={fmtNum(t.demo_requests)} sub={`${fmtNum(t.booking_clicks)} clics · ${fmtNum(t.bookings_confirmed)} confirmées`} />
        <Stat label="Demandes de soutien" value={fmtNum(t.support_requests)} />
        <Stat label="Questions sans réponse" value={fmtNum(t.unanswered)} />
        <Stat label="Latence moyenne" value={t.avg_latency_ms ? `${(t.avg_latency_ms / 1000).toFixed(1)} s` : "—"} sub="réponse complète" />
        <Stat label="Coût IA estimé" value={`${(t.est_cost_usd ?? 0).toFixed(2)} $ US`} sub={`${fmtNum(t.ai_replies)} réponses · ${fmtNum(Number(t.input_tokens) + Number(t.output_tokens))} jetons`} />
      </div>
      <div className="card mt-4 p-5">
        <h2 className="mb-3 text-sm font-semibold">Activité quotidienne</h2>
        <div className="flex h-32 items-end gap-[2px]" role="img" aria-label="Conversations et leads par jour">
          {daily.map((d) => (
            <div key={d.day} className="group relative flex-1" title={`${d.day}: ${d.conversations} conversations, ${d.leads} leads`}>
              <div className="w-full rounded-t bg-brand/25" style={{ height: `${(d.conversations / maxD) * 120}px` }} />
              <div className="absolute bottom-0 w-full rounded-t bg-brand-accent" style={{ height: `${(d.leads / maxD) * 120}px` }} />
            </div>))}
        </div>
        <div className="mt-2 flex gap-4 text-xs text-slate-500"><span><span className="mr-1 inline-block h-2 w-2 rounded bg-brand/25" />Conversations</span><span><span className="mr-1 inline-block h-2 w-2 rounded bg-brand-accent" />Leads</span></div>
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Bars label="Intérêts détectés" rows={(data?.interests ?? []).map((r: { category: string; n: number }) => ({ label: CAT[r.category] ?? r.category, n: r.n }))} />
        <Bars label="Services recommandés" rows={(data?.services ?? []).map((r: { key: string; n: number }) => ({ label: r.key, n: r.n }))} />
        <Bars label="Questions fréquentes" rows={(data?.questions ?? []).map((r: { question: string; n: number }) => ({ label: r.question, n: r.n }))} />
      </div>
      <div className="card mt-4 p-5">
        <div className="mb-2 flex items-center justify-between"><h2 className="text-sm font-semibold">Questions sans réponse récentes</h2><a className="text-sm font-semibold text-brand" href="#/knowledge/unanswered">Tout voir →</a></div>
        {(data?.unanswered ?? []).length ? <ul className="divide-y divide-slate-100">{data.unanswered.map((u: { id: string; question: string; created_at: string }) => <li key={u.id} className="flex justify-between gap-4 py-2 text-sm"><span>{u.question}</span><span className="shrink-0 text-xs text-slate-500">{fmtDate(u.created_at)}</span></li>)}</ul> : <p className="text-sm text-slate-500">Aucune.</p>}
      </div>
    </>
  );
}
