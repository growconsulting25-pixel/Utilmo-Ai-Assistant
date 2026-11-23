import { api } from "../api";
import { fmtDate, Loading, PageHeader, useAsync } from "../ui";

export function Audit() {
  const { data, loading } = useAsync(() => api("/audit"), []);
  return (
    <>
      <PageHeader title="Journal d'audit" subtitle="Actions administratives et événements de sécurité (adresses IP hachées)." />
      {loading ? <Loading /> : <div className="card overflow-x-auto"><table className="w-full"><thead className="border-b bg-slate-50"><tr><th className="th">Date</th><th className="th">Utilisateur</th><th className="th">Action</th><th className="th">Cible</th><th className="th">Détails</th></tr></thead>
        <tbody className="divide-y divide-slate-100">{(data?.items ?? []).map((a: any) => <tr key={a.id}><td className="td whitespace-nowrap text-xs">{fmtDate(a.created_at)}</td><td className="td text-xs">{a.email ?? "—"}</td><td className="td font-mono text-xs">{a.action}</td><td className="td text-xs">{a.target_type} {a.target_id?.slice(0, 8)}</td><td className="td max-w-md truncate font-mono text-xs text-slate-500">{JSON.stringify(a.details)}</td></tr>)}</tbody></table></div>}
    </>
  );
}
