import { useState } from "react";
import { getLang, tr } from "../i18n";
import { api } from "../api";
import type { Me } from "../main";
import { ErrorBox, Field, ImagePicker, PageHeader, Toast } from "../ui";

const T = {
  fr: { title: tr("Mon profil"), sub: tr("Vos informations personnelles et vos préférences."), name: tr("Nom"), photo: "Photo de profil", upload: tr("Téléverser une photo"), lang: "Langue de l'interface", save: tr("Enregistrer"), saved: tr("Profil enregistré"), pw: tr("Mot de passe"), current: "Mot de passe actuel", next: tr("Nouveau mot de passe"), change: tr("Changer le mot de passe"), changed: tr("Mot de passe modifié"), hint: tr("12 caractères min., majuscule, minuscule et chiffre."), email: tr("Courriel"), role: tr("Rôle") },
  en: { title: "My profile", sub: "Your personal information and preferences.", name: "Name", photo: "Profile photo", upload: "Upload a photo", lang: "Interface language", save: "Save", saved: "Profile saved", pw: "Password", current: "Current password", next: "New password", change: "Change password", changed: "Password changed", hint: "12+ characters, upper and lower case and a digit.", email: "Email", role: "Role" },
};

export function Profile({ me, onSaved }: { me: Me; onSaved: () => void }) {
  const lang = getLang();
  const t = T[lang];
  const [name, setName] = useState(me.user.name ?? "");
  const [avatar, setAvatar] = useState(me.user.avatar ?? "");
  const [uiLang, setUiLang] = useState(lang);
  const [pw, setPw] = useState({ current: "", next: "" });
  const [err, setErr] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const save = async () => {
    setErr(null);
    try { await api("/me", { method: "PATCH", body: { name, avatar: avatar || null, ui_language: uiLang } }); setToast(t.saved); onSaved(); } catch (e) { setErr((e as Error).message); }
  };
  const changePw = async () => {
    setErr(null);
    try { await api("/me/password", { body: { current: pw.current, password: pw.next } }); setPw({ current: "", next: "" }); setToast(t.changed); } catch (e) { setErr((e as Error).message); }
  };
  return (
    <>
      <PageHeader title={t.title} subtitle={t.sub} />
      <ErrorBox error={err} />
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card space-y-4 p-5">
          <Field label={t.photo}><ImagePicker value={avatar} onChange={setAvatar} round label={t.upload} /></Field>
          <Field label={t.name}><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label={t.email}><input className="input" value={me.user.email} disabled /></Field>
          <Field label={t.role}><input className="input" value={me.user.role} disabled /></Field>
          <Field label={t.lang}><select className="input" value={uiLang} onChange={(e) => setUiLang(e.target.value as "fr" | "en")}><option value="fr">Français</option><option value="en">English</option></select></Field>
          <button className="btn-primary" onClick={save}>{t.save}</button>
        </div>
        <div className="card space-y-4 p-5">
          <h2 className="text-sm font-semibold">{t.pw}</h2>
          <Field label={t.current}><input className="input" type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></Field>
          <Field label={t.next} hint={t.hint}><input className="input" type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /></Field>
          <button className="btn-secondary" disabled={!pw.current || !pw.next} onClick={changePw}>{t.change}</button>
        </div>
      </div>
      <Toast msg={toast} onDone={() => setToast(null)} />
    </>
  );
}
