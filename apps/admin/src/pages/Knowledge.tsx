import { useState } from "react";
import { api } from "../api";
import { Empty, ErrorBox, Field, fmtDate, Loading, Modal, PageHeader, Toast, useAsync } from "../ui";

const TABS = [["documents", "Documents"], ["sources", "Sources & exploration"], ["conflicts", "Conflits"], ["unanswered", "Questions sans réponse"], ["test", "Tester la recherche"], ["versions", "Versions"]] as const;
const PRIO = { 1: "1 · Interne approuvé", 2: "2 · Documentation vérifiée", 3: "3 · Site officiel", 4: "4 · Contexte général" } as Record<number, string>;

export function Knowledge({ tab = "documents", role }: { tab?: string; role: string }) {
  const [toast, setToast] = useState<string | null>(null);
  const canEdit = role !== "viewer";
  return (
    <>
      <PageHeader title="Base de connaissances" subtitle="Les réponses de l'assistant s'appuient uniquement sur ces sources (priorité : interne approuvé > documentation vérifiée > site officiel > contexte général)." />
      <div className="mb-4 flex flex-wrap gap-1 border-b border-slate-200" role="tablist">
        {TABS.map(([id, label]) => <a key={id} role="tab" aria-selected={tab === id} href={`#/knowledge/${id}`} className={`-mb-px border-b-2 px-3 py-2 text-sm font-semibold ${tab === id ? "border-brand text-brand" : "border-transparent text-slate-500 hover:text-slate-800"}`}>{label}</a>)}
      </div>
      {tab === "documents" && <Documents canEdit={canEdit} toast={setToast} />}
      {tab === "sources" && <Sources canEdit={canEdit} admin={role === "admin" || role === "owner"} toast={setToast} />}
      {tab === "conflicts" && <Conflicts canEdit={canEdit} />}
      {tab === "unanswered" && <Unanswered canEdit={canEdit} />}
      {tab === "test" && <SearchTest />}
      {tab === "versions" && <Versions />}
      <Toast msg={toast} onDone={() => setToast(null)} />
    </>
  );
}

function Documents({ canEdit, toast }: { canEdit: boolean; toast: (m: string) => void }) {
  const { data, error, loading, reload } = useAsync(() => api("/knowledge/documents"), []);
  const [edit, setEdit] = useState<any | null>(null);
  const [upload, setUpload] = useState(false);
  const [filter, setFilter] = useState("");
  const open = async (id: string) => setEdit((await api(`/knowledge/documents/${id}`)).document);
  const items = (data?.items ?? []).filter((d: any) => !filter || `${d.title} ${d.url ?? ""}`.toLowerCase().includes(filter.toLowerCase()));
  const reindex = async () => { const r = await api("/knowledge/reindex", { method: "POST" }); toast(`${r.reindexed} documents réindexés (embeddings : ${r.embeddings})`); reload(); };
  return (
    <>
      <div className="mb-3 flex flex-wrap gap-2">
        <input className="input max-w-xs" placeholder="Filtrer…" aria-label="Filtrer" value={filter} onChange={(e) => setFilter(e.target.value)} />
        {canEdit && <><button className="btn-primary" onClick={() => setEdit({ title: "", content: "", priority: 1, collection: "both", doc_type: "faq", language: "fr", verified: true })}>+ FAQ / réponse officielle</button>
          <button className="btn-secondary" onClick={() => setUpload(true)}>Téléverser PDF / TXT / MD</button><button className="btn-secondary" onClick={reindex}>Réindexer</button></>}
      </div>
      <ErrorBox error={error} />
      {loading ? <Loading /> : !items.length ? <Empty>Aucun document.</Empty> : (
        <div className="card overflow-x-auto"><table className="w-full">
          <thead className="border-b border-slate-200 bg-slate-50"><tr><th className="th">Titre</th><th className="th">Type</th><th className="th">Collection</th><th className="th">Priorité</th><th className="th">Statut</th><th className="th">Vérifié</th><th className="th">Mis à jour</th></tr></thead>
          <tbody className="divide-y divide-slate-100">{items.map((d: any) => (
            <tr key={d.id} className="cursor-pointer hover:bg-slate-50" onClick={() => open(d.id)}>
              <td className="td"><div className="font-medium">{d.title}</div>{d.url && <div className="max-w-md truncate text-xs text-slate-500">{d.url}</div>}</td>
              <td className="td text-xs">{d.doc_type} · v{d.version}</td><td className="td text-xs">{d.collection}</td><td className="td text-xs">{PRIO[d.priority]}</td>
              <td className="td"><span className={`badge ${d.status === "active" ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-500"}`}>{d.status}</span></td>
              <td className="td">{d.verified ? <span className="badge bg-brand/10 text-brand">Vérifié</span> : <span className="text-xs text-slate-400">non</span>}</td>
              <td className="td whitespace-nowrap text-xs text-slate-500">{fmtDate(d.fetched_at ?? d.updated_at)}</td>
            </tr>))}</tbody></table></div>
      )}
      {edit && <DocEditor doc={edit} canEdit={canEdit} onClose={() => setEdit(null)} onSaved={(m) => { setEdit(null); toast(m); reload(); }} />}
      {upload && <UploadModal onClose={() => setUpload(false)} onDone={(m) => { setUpload(false); toast(m); reload(); }} />}
    </>
  );
}

function DocEditor({ doc, canEdit, onClose, onSaved }: { doc: any; canEdit: boolean; onClose: () => void; onSaved: (m: string) => void }) {
  const [d, setD] = useState(doc);
  const [err, setErr] = useState<string | null>(null);
  const isNew = !doc.id;
  const save = async () => {
    try {
      if (isNew) await api("/knowledge/documents", { body: { title: d.title, content: d.content, url: d.url || null, language: d.language, collection: d.collection, priority: +d.priority, doc_type: d.doc_type, verified: !!d.verified } });
      else await api(`/knowledge/documents/${doc.id}`, { method: "PATCH", body: { title: d.title, content: d.content !== doc.content ? d.content : undefined, collection: d.collection, priority: +d.priority, verified: !!d.verified, status: d.status === "disabled" ? "disabled" : "active" } });
      onSaved(isNew ? "Document ajouté et indexé" : "Document enregistré (nouvelle version si le contenu a changé)");
    } catch (e) { setErr((e as Error).message); }
  };
  const remove = async () => { if (confirm("Supprimer ce document ?")) { await api(`/knowledge/documents/${doc.id}`, { method: "DELETE" }); onSaved("Document supprimé"); } };
  return (
    <Modal title={isNew ? "Nouvelle connaissance" : d.title} onClose={onClose} wide>
      <ErrorBox error={err} />
      <div className="grid gap-3 sm:grid-cols-4">
        <div className="sm:col-span-4"><Field label="Titre"><input className="input" value={d.title} disabled={!canEdit} onChange={(e) => setD({ ...d, title: e.target.value })} /></Field></div>
        {isNew && <Field label="Type"><select className="input" value={d.doc_type} onChange={(e) => setD({ ...d, doc_type: e.target.value })}>{["faq", "pricing", "service", "manual", "correction", "document"].map((x) => <option key={x}>{x}</option>)}</select></Field>}
        <Field label="Collection"><select className="input" value={d.collection} disabled={!canEdit} onChange={(e) => setD({ ...d, collection: e.target.value })}><option value="both">Ventes + soutien</option><option value="sales">Ventes</option><option value="support">Soutien</option></select></Field>
        <Field label="Priorité de source"><select className="input" value={d.priority} disabled={!canEdit} onChange={(e) => setD({ ...d, priority: e.target.value })}>{[1, 2, 3, 4].map((p) => <option key={p} value={p}>{PRIO[p]}</option>)}</select></Field>
        {!isNew && <Field label="Statut"><select className="input" value={d.status} disabled={!canEdit} onChange={(e) => setD({ ...d, status: e.target.value })}><option value="active">Actif</option><option value="disabled">Désactivé (périmé)</option></select></Field>}
        {isNew && <Field label="Langue"><select className="input" value={d.language} onChange={(e) => setD({ ...d, language: e.target.value })}><option value="fr">FR</option><option value="en">EN</option><option value="multi">FR + EN</option></select></Field>}
        <div className="sm:col-span-4"><Field label="Contenu (Markdown)" hint="Pour corriger une réponse : écrivez la réponse officielle ici avec la priorité 1 et cochez « vérifié »."><textarea className="input h-80 font-mono text-xs" value={d.content} disabled={!canEdit} onChange={(e) => setD({ ...d, content: e.target.value })} /></Field></div>
        {isNew && <div className="sm:col-span-4"><Field label="URL de référence (optionnel)"><input className="input" value={d.url ?? ""} onChange={(e) => setD({ ...d, url: e.target.value })} /></Field></div>}
        <label className="flex items-center gap-2 text-sm sm:col-span-4"><input type="checkbox" checked={!!d.verified} disabled={!canEdit} onChange={(e) => setD({ ...d, verified: e.target.checked })} /> Information vérifiée / approuvée par Utilmo</label>
      </div>
      {canEdit && <div className="mt-4 flex justify-between"><div>{!isNew && <button className="btn-danger" onClick={remove}>Supprimer</button>}</div><div className="flex gap-2"><button className="btn-secondary" onClick={onClose}>Annuler</button><button className="btn-primary" onClick={save}>Enregistrer</button></div></div>}
    </Modal>
  );
}

function UploadModal({ onClose, onDone }: { onClose: () => void; onDone: (m: string) => void }) {
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { const r = await api("/knowledge/upload", { form: new FormData(e.currentTarget) }); onDone(`Document importé (${r.chars} caractères)`); } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal title="Téléverser un document" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <ErrorBox error={err} />
        <Field label="Fichier (PDF, TXT, Markdown — 4 Mo max)"><input className="input" type="file" name="file" accept=".pdf,.txt,.md,.markdown,text/plain,application/pdf" required /></Field>
        <Field label="Titre"><input className="input" name="title" /></Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Collection"><select className="input" name="collection"><option value="both">Ventes + soutien</option><option value="sales">Ventes</option><option value="support">Soutien</option></select></Field>
          <Field label="Priorité"><select className="input" name="priority" defaultValue="2">{[1, 2, 3, 4].map((p) => <option key={p} value={p}>{PRIO[p]}</option>)}</select></Field>
          <Field label="Langue"><select className="input" name="language"><option value="fr">FR</option><option value="en">EN</option><option value="multi">FR+EN</option></select></Field>
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="verified" value="true" /> Documentation vérifiée</label>
        <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={onClose}>Annuler</button><button className="btn-primary" disabled={busy}>{busy ? "Import…" : "Importer"}</button></div>
      </form>
    </Modal>
  );
}

function Sources({ canEdit, admin, toast }: { canEdit: boolean; admin: boolean; toast: (m: string) => void }) {
  const { data, error, loading, reload } = useAsync(() => api("/knowledge/sources"), []);
  const [add, setAdd] = useState(false);
  const [form, setForm] = useState({ name: "", url: "", sitemaps: "", max_pages: 60 });
  const crawl = async (id: string) => { await api(`/knowledge/sources/${id}/crawl`, { method: "POST" }); toast("Exploration lancée en arrière-plan (quelques minutes)"); };
  const toggle = async (s: any) => { await api(`/knowledge/sources/${s.id}`, { method: "PATCH", body: { status: s.status === "active" ? "disabled" : "active" } }); reload(); };
  const bootstrap = async () => { const r = await api("/knowledge/bootstrap", { method: "POST" }); toast(r.imported ? "Base initiale importée" : "Base initiale déjà importée"); reload(); };
  const create = async () => { await api("/knowledge/sources", { body: { name: form.name, url: form.url, sitemaps: form.sitemaps.split(/\s+/).filter(Boolean), max_pages: +form.max_pages } }); setAdd(false); reload(); };
  return (
    <>
      <div className="mb-3 flex gap-2">{admin && <><button className="btn-primary" onClick={() => setAdd(true)}>+ Site web à explorer</button><button className="btn-secondary" onClick={bootstrap}>Importer la base initiale</button></>}</div>
      <p className="mb-3 text-sm text-slate-500">L'explorateur respecte robots.txt, utilise les sitemaps, retire la navigation et le contenu répété, conserve l'URL et la date de chaque page, et ne remplace jamais un document corrigé manuellement.</p>
      <ErrorBox error={error} />
      {loading ? <Loading /> : (
        <div className="card divide-y divide-slate-100">{(data?.items ?? []).map((s: any) => (
          <div key={s.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div><div className="font-semibold">{s.name} <span className="badge ml-1 bg-slate-100 text-slate-600">{s.type}</span>{s.status !== "active" && <span className="badge ml-1 bg-red-50 text-red-700">désactivée</span>}</div>
              <div className="text-xs text-slate-500">{s.url ?? "—"} · {s.documents} documents · dernière synchro {fmtDate(s.last_synced_at)}{s.config?.last_stats && ` · ${JSON.stringify(s.config.last_stats)}`}</div></div>
            <div className="flex gap-2">{s.type === "website" && canEdit && s.status === "active" && <button className="btn-secondary" onClick={() => crawl(s.id)}>Explorer maintenant</button>}{admin && <button className="btn-secondary" onClick={() => toggle(s)}>{s.status === "active" ? "Désactiver" : "Activer"}</button>}</div>
          </div>))}</div>
      )}
      {add && <Modal title="Nouvelle source web" onClose={() => setAdd(false)}>
        <div className="space-y-3">
          <Field label="Nom"><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="URL de départ" hint="Doit appartenir à un domaine autorisé de l'assistant."><input className="input" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} /></Field>
          <Field label="Sitemaps (séparés par des espaces)"><input className="input" value={form.sitemaps} onChange={(e) => setForm({ ...form, sitemaps: e.target.value })} /></Field>
          <Field label="Pages max."><input className="input" type="number" value={form.max_pages} onChange={(e) => setForm({ ...form, max_pages: +e.target.value })} /></Field>
          <div className="flex justify-end gap-2"><button className="btn-secondary" onClick={() => setAdd(false)}>Annuler</button><button className="btn-primary" onClick={create}>Créer</button></div>
        </div></Modal>}
    </>
  );
}

function Conflicts({ canEdit }: { canEdit: boolean }) {
  const { data, loading, reload } = useAsync(() => api("/knowledge/conflicts"), []);
  const set = async (id: string, status: string) => { const resolution = status === "resolved" ? prompt("Résolution (ex. : la bonne valeur, ajoutée en connaissance prioritaire)") ?? undefined : undefined; await api(`/knowledge/conflicts/${id}`, { method: "PATCH", body: { status, resolution } }); reload(); };
  if (loading) return <Loading />;
  return (
    <>
      <p className="mb-3 text-sm text-slate-500">Tant qu'un conflit est ouvert, l'assistant ne choisit pas de valeur et indique que l'information doit être confirmée. Pour résoudre : ajoutez la bonne information en priorité 1 (vérifiée), puis marquez le conflit comme résolu.</p>
      {!data?.items.length ? <Empty>Aucun conflit.</Empty> : <div className="card divide-y divide-slate-100">{data.items.map((c: any) => (
        <div key={c.id} className="p-4"><div className="flex flex-wrap items-center justify-between gap-2"><div className="font-semibold">{c.topic} <span className={`badge ml-1 ${c.status === "open" ? "bg-amber-100 text-amber-800" : "bg-slate-100 text-slate-500"}`}>{c.status}</span> <span className="text-xs text-slate-400">{c.detected_by}</span></div>
          {canEdit && c.status === "open" && <div className="flex gap-2"><button className="btn-secondary" onClick={() => set(c.id, "resolved")}>Résolu</button><button className="btn-secondary" onClick={() => set(c.id, "dismissed")}>Ignorer</button></div>}
          {canEdit && c.status !== "open" && <button className="btn-secondary" onClick={() => set(c.id, "open")}>Rouvrir</button>}</div>
          <p className="mt-1 text-sm text-slate-600">{c.description}</p>{c.source_urls?.length > 0 && <div className="mt-1 text-xs text-slate-500">{c.source_urls.join(" · ")}</div>}{c.resolution && <p className="mt-1 text-sm text-emerald-700">Résolution : {c.resolution}</p>}
        </div>))}</div>}
    </>
  );
}

function Unanswered({ canEdit }: { canEdit: boolean }) {
  const { data, loading, reload } = useAsync(() => api("/knowledge/unanswered"), []);
  const set = async (id: string, status: string) => { await api(`/knowledge/unanswered/${id}`, { method: "PATCH", body: { status } }); reload(); };
  if (loading) return <Loading />;
  return !data?.items.length ? <Empty>Aucune question sans réponse.</Empty> : (
    <div className="card divide-y divide-slate-100">{data.items.map((u: any) => (
      <div key={u.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div><div className="font-medium">{u.question}</div><div className="text-xs text-slate-500">{fmtDate(u.created_at)} · {u.language} · {u.reason} · <a className="text-brand" href={`#/conversations/${u.conversation_id}`}>conversation</a></div></div>
        {canEdit && u.status === "open" && <div className="flex gap-2"><a className="btn-secondary" href="#/knowledge/documents">Ajouter une réponse</a><button className="btn-secondary" onClick={() => set(u.id, "answered")}>Traitée</button><button className="btn-secondary" onClick={() => set(u.id, "dismissed")}>Ignorer</button></div>}
        {u.status !== "open" && <span className="badge bg-slate-100 text-slate-500">{u.status}</span>}
      </div>))}</div>
  );
}

function SearchTest() {
  const [q, setQ] = useState(""); const [col, setCol] = useState("sales"); const [res, setRes] = useState<any[] | null>(null);
  const run = async (e: React.FormEvent) => { e.preventDefault(); setRes((await api("/knowledge/search-test", { body: { query: q, collection: col } })).results); };
  return (
    <>
      <form onSubmit={run} className="mb-4 flex flex-wrap gap-2"><input className="input max-w-lg" placeholder="Ex. : intégration Centris" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Requête" />
        <select className="input w-auto" value={col} onChange={(e) => setCol(e.target.value)} aria-label="Collection"><option value="sales">Ventes</option><option value="support">Soutien</option></select><button className="btn-primary">Rechercher</button></form>
      {res && (!res.length ? <Empty>Aucun résultat : l'assistant dirait qu'il n'a pas l'information confirmée.</Empty> : <ol className="space-y-3">{res.map((r, i) => (
        <li key={r.id} className="card p-4"><div className="flex justify-between text-sm"><b>{i + 1}. {r.title}</b><span className="text-xs text-slate-500">score {r.score.toFixed(3)} · P{r.priority} {r.verified ? "· vérifié" : ""}</span></div>
          {r.heading && <div className="text-xs text-slate-500">{r.heading}</div>}<p className="mt-1 whitespace-pre-wrap text-sm text-slate-600">{r.content}</p></li>))}</ol>)}
    </>
  );
}

function Versions() {
  const { data, loading } = useAsync(() => api("/knowledge/versions"), []);
  if (loading) return <Loading />;
  return (
    <div className="card overflow-x-auto"><table className="w-full"><thead className="border-b bg-slate-50"><tr><th className="th">Version</th><th className="th">Note</th><th className="th">Statistiques</th><th className="th">Par</th><th className="th">Date</th></tr></thead>
      <tbody className="divide-y divide-slate-100">{(data?.items ?? []).map((v: any) => <tr key={v.id}><td className="td font-semibold">v{v.version}</td><td className="td">{v.note}</td><td className="td text-xs">{v.stats?.docs} docs · {v.stats?.chunks} fragments</td><td className="td text-xs">{v.created_by_email ?? "système"}</td><td className="td text-xs">{fmtDate(v.created_at)}</td></tr>)}</tbody></table></div>
  );
}
