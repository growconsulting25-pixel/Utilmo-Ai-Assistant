import { useCallback, useEffect, useState, type ReactNode } from "react";
import { X } from "lucide-react";

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(() => {
    setLoading(true);
    fn().then((d) => { setData(d); setError(null); }).catch((e) => setError(e.message ?? String(e))).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { reload(); }, [reload]);
  return { data, error, loading, reload, setData };
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div><h1 className="text-2xl font-semibold text-slate-900">{title}</h1>{subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}</div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Loading() { return <div className="p-8 text-sm text-slate-500">Chargement…</div>; }
export function ErrorBox({ error }: { error: string | null }) { return error ? <div role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div> : null; }
export function Empty({ children }: { children: ReactNode }) { return <div className="p-10 text-center text-sm text-slate-500">{children}</div>; }

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === "Escape" && onClose(); window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 sm:p-10" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={title} className={`card w-full ${wide ? "max-w-5xl" : "max-w-2xl"}`}>
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3"><h2 className="text-lg font-semibold">{title}</h2><button className="rounded p-1 hover:bg-slate-100" aria-label="Fermer" onClick={onClose}><X size={18} /></button></div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

const PRIORITY: Record<string, string> = { high: "bg-emerald-100 text-emerald-800", medium: "bg-amber-100 text-amber-800", low: "bg-slate-100 text-slate-600" };
export const PriorityBadge = ({ p }: { p: string }) => <span className={`badge ${PRIORITY[p] ?? PRIORITY.low}`}>{p === "high" ? "Élevée" : p === "medium" ? "Moyenne" : "Faible"}</span>;
const SYNC: Record<string, string> = { synced: "bg-emerald-100 text-emerald-800", pending: "bg-amber-100 text-amber-800", failed: "bg-red-100 text-red-700", not_configured: "bg-slate-100 text-slate-500" };
export const SyncBadge = ({ s }: { s: string }) => <span className={`badge ${SYNC[s] ?? SYNC.not_configured}`}>{s === "synced" ? "Synchronisé" : s === "pending" ? "En attente" : s === "failed" ? "Échec" : "Non configuré"}</span>;
export const StatusBadge = ({ s }: { s: string }) => <span className="badge bg-brand/10 text-brand">{s}</span>;
export const fmtDate = (d?: string | null) => (d ? new Date(d).toLocaleString("fr-CA", { dateStyle: "medium", timeStyle: "short" }) : "—");
export const fmtNum = (n?: number | null) => (n ?? 0).toLocaleString("fr-CA");

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="block"><span className="label">{label}</span>{children}{hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}</label>;
}

export function Toast({ msg, onDone }: { msg: string | null; onDone: () => void }) {
  useEffect(() => { if (msg) { const t = setTimeout(onDone, 3000); return () => clearTimeout(t); } }, [msg, onDone]);
  return msg ? <div role="status" className="fixed bottom-5 right-5 z-50 rounded-lg bg-slate-900 px-4 py-2.5 text-sm text-white shadow-lg">{msg}</div> : null;
}
