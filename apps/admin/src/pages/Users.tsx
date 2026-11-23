import { useState } from "react";
import { api } from "../api";
import type { Me } from "../main";
import { ErrorBox, Field, fmtDate, Loading, Modal, PageHeader, useAsync } from "../ui";

export function UsersPage({ me }: { me: Me }) {
  const { data, loading, reload } = useAsync(() => api("/users"), []);
  const [add, setAdd] = useState(false);
  const [f, setF] = useState({ email: "", name: "", role: "editor", password: "" });
  const [err, setErr] = useState<string | null>(null);
  const create = async () => { try { await api("/users", { body: f }); setAdd(false); reload(); } catch (e) { setErr((e as Error).message); } };
  const patch = async (id: string, body: object) => { try { await api(`/users/${id}`, { method: "PATCH", body }); reload(); } catch (e) { alert((e as Error).message); } };
  return (
    <>
      <PageHeader title="Utilisateurs" subtitle="Rôles : propriétaire > admin (paramètres, exports, intégrations) > éditeur (connaissances, leads) > lecteur." actions={<button className="btn-primary" onClick={() => setAdd(true)}>+ Utilisateur</button>} />
      {loading ? <Loading /> : <div className="card overflow-x-auto"><table className="w-full"><thead className="border-b bg-slate-50"><tr><th className="th">Courriel</th><th className="th">Rôle</th><th className="th">Actif</th><th className="th">Dernière connexion</th></tr></thead>
        <tbody className="divide-y divide-slate-100">{(data?.items ?? []).map((u: any) => (
          <tr key={u.id}><td className="td">{u.email}<div className="text-xs text-slate-500">{u.name}</div></td>
            <td className="td">{u.role === "owner" || u.id === me.user.id ? u.role : <select className="input w-auto" value={u.role} onChange={(e) => patch(u.id, { role: e.target.value })}>{["admin", "editor", "viewer"].map((r) => <option key={r}>{r}</option>)}</select>}</td>
            <td className="td">{u.id === me.user.id ? "oui" : <input type="checkbox" aria-label="Actif" checked={u.active} onChange={(e) => patch(u.id, { active: e.target.checked })} />}</td>
            <td className="td text-xs">{fmtDate(u.last_login_at)}</td></tr>))}</tbody></table></div>}
      {add && <Modal title="Nouvel utilisateur" onClose={() => setAdd(false)}><div className="space-y-3"><ErrorBox error={err} />
        <Field label="Courriel"><input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Nom"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Rôle"><select className="input" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{["admin", "editor", "viewer"].map((r) => <option key={r}>{r}</option>)}</select></Field>
        <Field label="Mot de passe initial" hint="12 caractères min. À transmettre de façon sécurisée."><input className="input" type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
        <div className="flex justify-end gap-2"><button className="btn-secondary" onClick={() => setAdd(false)}>Annuler</button><button className="btn-primary" onClick={create}>Créer</button></div></div></Modal>}
    </>
  );
}
