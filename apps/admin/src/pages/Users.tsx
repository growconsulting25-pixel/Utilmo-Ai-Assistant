import { useState } from "react";
import { tr, L } from "../i18n";
import { api } from "../api";
import type { Me } from "../main";
import { ErrorBox, Field, fmtDate, Loading, Modal, PageHeader, useAsync } from "../ui";

export function UsersPage({ me }: { me: Me }) {
  const { data, loading, reload } = useAsync(() => api("/users"), []);
  const [add, setAdd] = useState(false);
  const [f, setF] = useState({ email: "", name: "", role: "editor", password: "" });
  const [info, setInfo] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const create = async () => {
    try {
      const r = await api("/users", { body: { ...f, password: f.password || undefined } });
      setAdd(false); setInfo(r.invited ? L(`Invitation envoyée à ${f.email}.`, `Invitation sent to ${f.email}.`) : L("Utilisateur créé.", "User created."));
      setF({ email: "", name: "", role: "editor", password: "" }); reload();
    } catch (e) { setErr((e as Error).message); }
  };
  const patch = async (id: string, body: object) => { try { await api(`/users/${id}`, { method: "PATCH", body }); reload(); } catch (e) { alert((e as Error).message); } };
  return (
    <>
      <PageHeader title={tr("Utilisateurs")} subtitle={tr("Rôles : propriétaire > admin (paramètres, exports, intégrations) > éditeur (connaissances, leads) > lecteur.")} actions={<button className="btn-primary" onClick={() => setAdd(true)}>{tr("+ Utilisateur")}</button>} />
      {info && <div className="mb-3 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">{info}</div>}
      {loading ? <Loading /> : <div className="card overflow-x-auto"><table className="w-full"><thead className="border-b bg-slate-50"><tr><th className="th">{tr("Courriel")}</th><th className="th">{tr("Rôle")}</th><th className="th">{tr("Actif")}</th><th className="th">{tr("Dernière connexion")}</th><th className="th" /></tr></thead>
        <tbody className="divide-y divide-slate-100">{(data?.items ?? []).map((u: any) => (
          <tr key={u.id}><td className="td">{u.email}<div className="text-xs text-slate-500">{u.name}</div></td>
            <td className="td">{u.role === "owner" || u.id === me.user.id ? u.role : <select className="input w-auto" value={u.role} onChange={(e) => patch(u.id, { role: e.target.value })}>{["admin", "editor", "viewer"].map((r) => <option key={r}>{r}</option>)}</select>}</td>
            <td className="td">{u.id === me.user.id ? tr("oui") : <input type="checkbox" aria-label={tr("Actif")} checked={u.active} onChange={(e) => patch(u.id, { active: e.target.checked })} />}</td>
            <td className="td text-xs">{fmtDate(u.last_login_at)}</td>
            <td className="td">{u.id !== me.user.id && (u.role !== "owner" || me.user.role === "owner") && <button className="btn-secondary" onClick={() => { const pw = prompt(L(`Nouveau mot de passe pour ${u.email} (12 caractères min., majuscule, minuscule et chiffre)`, `New password for ${u.email} (12+ characters, upper and lower case and a digit)`)); if (pw) patch(u.id, { password: pw }); }}>{tr("Réinitialiser le mot de passe")}</button>}</td></tr>))}</tbody></table></div>}
      {add && <Modal title={tr("Nouvel utilisateur")} onClose={() => setAdd(false)}><div className="space-y-3"><ErrorBox error={err} />
        <Field label={tr("Courriel")}><input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label={tr("Nom")}><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label={tr("Rôle")}><select className="input" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{["admin", "editor", "viewer"].map((r) => <option key={r}>{r}</option>)}</select></Field>
        <Field label={tr("Mot de passe initial")} hint={L("Laissez vide pour envoyer une invitation par courriel (l'utilisateur choisit son mot de passe). Sinon : 12 caractères min.", "Leave empty to send an email invitation (the user picks their password). Otherwise: 12+ characters.")}><input className="input" type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
        <div className="flex justify-end gap-2"><button className="btn-secondary" onClick={() => setAdd(false)}>{tr("Annuler")}</button><button className="btn-primary" onClick={create}>{tr("Créer")}</button></div></div></Modal>}
    </>
  );
}
