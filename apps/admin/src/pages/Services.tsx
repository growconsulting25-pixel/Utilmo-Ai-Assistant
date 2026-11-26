import { useState } from "react";
import { getLang, L, tr } from "../i18n";
import { api } from "../api";
import { ErrorBox, Field, Loading, Modal, PageHeader, useAsync } from "../ui";

const CATS = ["LEAD_GENERATION", "CRM", "WEBSITE", "AUTOMATION", "MARKETING", "BRANDING", "AI_ASSISTANT", "CUSTOMER_SUPPORT", "GENERAL_INFORMATION", "OTHER"];
const lines = (a?: string[]) => (a ?? []).join("\n");
const split = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);

export function Services({ role }: { role: string }) {
  const { data, error, loading, reload } = useAsync(() => api("/services"), []);
  const [edit, setEdit] = useState<any | null>(null);
  const canEdit = role !== "viewer";
  return (
    <>
      <PageHeader title={tr("Moteur de recommandation")} subtitle={tr("Catalogue des services : l'assistant ne recommande que ces services, avec leurs caractéristiques et prix approuvés.")}
        actions={canEdit && <button className="btn-primary" onClick={() => setEdit({ key: "", name: { fr: "", en: "" }, description: { fr: "", en: "" }, categories: [], problems: { fr: [], en: [] }, features: { fr: [], en: [] }, price_note: { fr: "", en: "" }, next_step: "demo", url: "", enabled: true, sort: 100 })}>+ Service</button>} />
      <ErrorBox error={error} />
      {loading ? <Loading /> : <div className="grid gap-3 md:grid-cols-2">{(data?.items ?? []).map((s: any) => (
        <button key={s.key} className="card p-4 text-left hover:border-brand/40" onClick={() => setEdit(s)}>
          <div className="flex items-center justify-between"><div className="font-semibold">{s.name[getLang()] || s.name.fr}</div>{!s.enabled && <span className="badge bg-slate-100 text-slate-500">{tr("désactivé")}</span>}</div>
          <p className="mt-1 text-sm text-slate-600">{s.description[getLang()] || s.description.fr}</p>
          <div className="mt-2 flex flex-wrap gap-1">{s.categories.map((c: string) => <span key={c} className="badge bg-slate-100 text-slate-600">{c}</span>)}</div>
          <div className="mt-2 text-xs text-slate-500">{L("Prix approuvé", "Approved price")} : {s.price_note[getLang()] || s.price_note.fr || tr("aucun (l'assistant ne cite pas de prix)")} · {tr("Étape suivante")} : {s.next_step}</div>
        </button>))}</div>}
      {edit && <ServiceEditor s={edit} canEdit={canEdit} admin={role === "admin" || role === "owner"} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
    </>
  );
}

function ServiceEditor({ s, canEdit, admin, onClose, onSaved }: { s: any; canEdit: boolean; admin: boolean; onClose: () => void; onSaved: () => void }) {
  const [d, setD] = useState({ ...s, problemsFr: lines(s.problems.fr), problemsEn: lines(s.problems.en), featuresFr: lines(s.features.fr), featuresEn: lines(s.features.en) });
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    try {
      await api("/services", { method: "PUT", body: { key: d.key, name: d.name, description: d.description, categories: d.categories, problems: { fr: split(d.problemsFr), en: split(d.problemsEn) }, features: { fr: split(d.featuresFr), en: split(d.featuresEn) }, price_note: d.price_note, next_step: d.next_step, url: d.url || null, enabled: d.enabled, sort: +d.sort } });
      onSaved();
    } catch (e) { setErr((e as Error).message); }
  };
  const del = async () => { if (confirm(tr("Supprimer ce service ?"))) { await api(`/services/${d.key}`, { method: "DELETE" }); onSaved(); } };
  const bi = (label: string, k: "name" | "description" | "price_note", area = false) => (
    <div className="grid gap-3 sm:grid-cols-2">{(["fr", "en"] as const).map((l) => <Field key={l} label={`${label} (${l.toUpperCase()})`}>{area ? <textarea className="input h-20" disabled={!canEdit} value={d[k][l]} onChange={(e) => setD({ ...d, [k]: { ...d[k], [l]: e.target.value } })} /> : <input className="input" disabled={!canEdit} value={d[k][l]} onChange={(e) => setD({ ...d, [k]: { ...d[k], [l]: e.target.value } })} />}</Field>)}</div>
  );
  return (
    <Modal title={s.key ? `Service : ${s.key}` : tr("Nouveau service")} onClose={onClose} wide>
      <ErrorBox error={err} />
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label={tr("Clé")}><input className="input" disabled={!!s.key} value={d.key} onChange={(e) => setD({ ...d, key: e.target.value })} /></Field>
          <Field label={tr("Étape suivante")}><select className="input" disabled={!canEdit} value={d.next_step} onChange={(e) => setD({ ...d, next_step: e.target.value })}>{["demo", "callback", "quote", "support", "info"].map((x) => <option key={x}>{x}</option>)}</select></Field>
          <Field label={tr("Ordre")}><input className="input" type="number" disabled={!canEdit} value={d.sort} onChange={(e) => setD({ ...d, sort: e.target.value })} /></Field>
          <label className="mt-6 flex items-center gap-2 text-sm"><input type="checkbox" disabled={!canEdit} checked={d.enabled} onChange={(e) => setD({ ...d, enabled: e.target.checked })} /> {tr("Actif")}</label>
        </div>
        {bi(tr("Nom"), "name")}{bi("Pourquoi / description", "description", true)}
        <Field label={tr("Catégories d'intérêt (la première est la principale)")}><div className="flex flex-wrap gap-2">{CATS.map((c) => <label key={c} className="flex items-center gap-1 text-xs"><input type="checkbox" disabled={!canEdit} checked={d.categories.includes(c)} onChange={(e) => setD({ ...d, categories: e.target.checked ? [...d.categories, c] : d.categories.filter((x: string) => x !== c) })} />{c}</label>)}</div></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={tr("Problèmes résolus (FR, un par ligne)")}><textarea className="input h-24" disabled={!canEdit} value={d.problemsFr} onChange={(e) => setD({ ...d, problemsFr: e.target.value })} /></Field>
          <Field label="Problems (EN)"><textarea className="input h-24" disabled={!canEdit} value={d.problemsEn} onChange={(e) => setD({ ...d, problemsEn: e.target.value })} /></Field>
          <Field label={tr("Caractéristiques vérifiées (FR)")}><textarea className="input h-28" disabled={!canEdit} value={d.featuresFr} onChange={(e) => setD({ ...d, featuresFr: e.target.value })} /></Field>
          <Field label="Verified features (EN)"><textarea className="input h-28" disabled={!canEdit} value={d.featuresEn} onChange={(e) => setD({ ...d, featuresEn: e.target.value })} /></Field>
        </div>
        {bi(tr("Prix approuvé (laisser vide si non vérifié)"), "price_note")}
        <Field label={tr("Page de référence")}><input className="input" disabled={!canEdit} value={d.url ?? ""} onChange={(e) => setD({ ...d, url: e.target.value })} /></Field>
      </div>
      {canEdit && <div className="mt-4 flex justify-between"><div>{admin && s.key && <button className="btn-danger" onClick={del}>{tr("Supprimer")}</button>}</div><div className="flex gap-2"><button className="btn-secondary" onClick={onClose}>{tr("Annuler")}</button><button className="btn-primary" onClick={save}>{tr("Enregistrer")}</button></div></div>}
    </Modal>
  );
}
