import { useState } from "react";
import { getLang, tr, L } from "../i18n";
import { api } from "../api";
import { ErrorBox, fmtDate, fmtNum, Loading, PageHeader, useAsync } from "../ui";

const CAT: Record<string, string> = { LEAD_GENERATION: tr("Génération de leads"), CRM: "CRM", WEBSITE: "Site web", AUTOMATION: "Automatisation", MARKETING: "Marketing", BRANDING: "Image de marque", AI_ASSISTANT: "IA", CUSTOMER_SUPPORT: tr("Soutien"), GENERAL_INFORMATION: "Information", OTHER: "Autre" };

function Stat({ label, value, sub, href }: { label: string; value: string | number; sub?: string; href: string }) {
  return (
    <a href={href} className="card group block p-4 transition hover:-translate-y-0.5 hover:border-brand/40 hover:shadow-md focus-visible:ring-2 focus-visible:ring-brand-accent">
      <div className="flex items-start justify-between gap-2"><div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</div><span className="text-slate-300 transition group-hover:text-brand" aria-hidden="true">→</span></div>
      <div className="mt-1 text-2xl font-semibold text-slate-900">{value}</div>{sub && <div className="text-xs text-slate-500">{sub}</div>}
    </a>
  );
}

function Bars({ rows, label, more }: { rows: { label: string; n: number; href: string }[]; label: string; more?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  return (
    <div className="card p-5"><div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-semibold">{label}</h2>{more && <a className="text-xs font-semibold text-brand" href={more}>{tr("Tout voir →")}</a>}</div>
      {rows.length ? <ul className="space-y-1">{rows.map((r) => (
        <li key={r.label} className="text-sm"><a href={r.href} className="-mx-2 block rounded-lg px-2 py-1 hover:bg-slate-50"><div className="flex justify-between gap-3"><span className="truncate">{r.label}</span><span className="font-semibold tabular-nums">{r.n}</span></div>
          <div className="mt-1 h-1.5 rounded bg-slate-100"><div className="h-1.5 rounded bg-brand" style={{ width: `${(r.n / max) * 100}%` }} /></div></a></li>))}</ul>
        : <p className="text-sm text-slate-500">{tr("Aucune donnée pour la période.")}</p>}
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
  const from = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  const cad = (n: number) => `${n.toLocaleString(getLang() === "en" ? "en-CA" : "fr-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $ CA`;
  return (
    <>
      <PageHeader title={tr("Tableau de bord")} subtitle={tr("Données réelles issues des conversations (aucune donnée de démonstration).")}
        actions={<select className="input w-auto" value={days} onChange={(e) => setDays(+e.target.value)} aria-label={tr("Période")}>{[7, 30, 90, 365].map((d) => <option key={d} value={d}>{L(`${d} derniers jours`, `Last ${d} days`)}</option>)}</select>} />
      <ErrorBox error={error} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Stat href={`#/conversations?from=${from}`} label="Conversations" value={fmtNum(t.conversations)} sub={`${fmtNum(t.visitors)} ${L("visiteurs uniques", "unique visitors")}`} />
        <Stat href={`#/leads?from=${from}`} label={tr("Leads captés")} value={fmtNum(t.leads)} sub={L(`Taux de conversion ${t.conversion_rate ?? 0} %`, `Conversion rate ${t.conversion_rate ?? 0}%`)} />
        <Stat href={`#/leads?status=qualified&from=${from}`} label={tr("Leads qualifiés")} value={fmtNum(t.qualified)} />
        <Stat href={`#/leads?demo=yes&from=${from}`} label={tr("Demandes de démo")} value={fmtNum(t.demo_requests)} sub={`${fmtNum(t.booking_clicks)} ${L("clics", "clicks")} · ${fmtNum(t.bookings_confirmed)} ${L("confirmées", "confirmed")}`} />
        <Stat href={`#/conversations?escalation=requested&from=${from}`} label={L("Veulent parler à quelqu'un", "Want to talk to someone")} value={fmtNum(t.human_requests)} />
        <Stat href="#/tickets" label={tr("Demandes de soutien")} value={fmtNum(t.support_requests)} />
        <Stat href="#/knowledge/unanswered" label={tr("Questions sans réponse")} value={fmtNum(t.unanswered)} />
        <Stat href={`#/conversations?from=${from}`} label={tr("Latence moyenne")} value={t.avg_latency_ms ? `${(t.avg_latency_ms / 1000).toFixed(1)} s` : "—"} sub={L("réponse complète", "full reply")} />
        <Stat href="#/settings" label={tr("Coût IA estimé")} value={cad(Number(t.est_cost_cad ?? 0))} sub={`${fmtNum(t.ai_replies)} ${L("réponses", "replies")} · ${fmtNum(Number(t.input_tokens) + Number(t.output_tokens))} ${L("jetons", "tokens")}`} />
        <Stat href="#/integrations" label={L("Envois (courriels, webhooks)", "Deliveries (emails, webhooks)")} value={L("Voir", "View")} sub={L("Journal des livraisons", "Delivery log")} />
      </div>
      <div className="card mt-4 p-5">
        <h2 className="mb-3 text-sm font-semibold">{tr("Activité quotidienne")}</h2>
        <div className="flex h-32 items-end gap-[2px]" role="img" aria-label={tr("Conversations et leads par jour")}>
          {daily.map((d) => (
            <a key={d.day} href={`#/conversations?from=${String(d.day).slice(0, 10)}&to=${String(d.day).slice(0, 10)}`} className="group relative block h-full flex-1 hover:opacity-80" title={`${String(d.day).slice(0, 10)}: ${d.conversations} conversations, ${d.leads} leads`}><div className="absolute bottom-0 w-full">
              <div className="w-full rounded-t bg-brand/25" style={{ height: `${(d.conversations / maxD) * 120}px` }} />
              <div className="absolute bottom-0 w-full rounded-t bg-brand-accent" style={{ height: `${(d.leads / maxD) * 120}px` }} />
            </div></a>))}
        </div>
        <div className="mt-2 flex gap-4 text-xs text-slate-500"><span><span className="mr-1 inline-block h-2 w-2 rounded bg-brand/25" />Conversations</span><span><span className="mr-1 inline-block h-2 w-2 rounded bg-brand-accent" />Leads</span></div>
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Bars label={tr("Intérêts détectés")} more="#/conversations" rows={(data?.interests ?? []).map((r: { category: string; n: number }) => ({ label: CAT[r.category] ?? r.category, n: r.n, href: `#/conversations?intent=${r.category}&from=${from}` }))} />
        <Bars label={tr("Services recommandés")} more="#/services" rows={(data?.services ?? []).map((r: { key: string; n: number }) => ({ label: r.key, n: r.n, href: "#/services" }))} />
        <Bars label={tr("Questions fréquentes")} rows={(data?.questions ?? []).map((r: { question: string; n: number }) => ({ label: r.question, n: r.n, href: `#/conversations?q=${encodeURIComponent(r.question.slice(0, 60))}` }))} />
      </div>
      <div className="card mt-4 p-5">
        <div className="mb-2 flex items-center justify-between"><h2 className="text-sm font-semibold">{tr("Questions sans réponse récentes")}</h2><a className="text-sm font-semibold text-brand" href="#/knowledge/unanswered">{tr("Tout voir →")}</a></div>
        {(data?.unanswered ?? []).length ? <ul className="divide-y divide-slate-100">{data.unanswered.map((u: { id: string; question: string; created_at: string }) => <li key={u.id} className="flex justify-between gap-4 py-2 text-sm"><a className="hover:text-brand" href="#/knowledge/unanswered">{u.question}</a><span className="shrink-0 text-xs text-slate-500">{fmtDate(u.created_at)}</span></li>)}</ul> : <p className="text-sm text-slate-500">{tr("Aucune.")}</p>}
      </div>
    </>
  );
}
