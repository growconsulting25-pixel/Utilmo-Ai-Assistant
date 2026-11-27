import { useEffect, useState } from "react";
import { tr, L } from "../i18n";
import { api } from "../api";
import { ErrorBox, Field, ImagePicker, Loading, PageHeader, Toast, useAsync } from "../ui";

type S = any;
const TABS = [["behavior", tr("Comportement IA")], ["appearance", tr("Apparence")], ["booking", tr("Réservation")], ["privacy", tr("Confidentialité & limites")], ["domains", tr("Domaines autorisés")], ["system", tr("Système")]] as const;
const FIELDS = ["first_name", "last_name", "email", "phone", "brokerage", "city", "territory", "user_type", "existing_customer", "main_goal", "services_interest", "current_crm", "website_status", "lead_methods", "biggest_challenge", "lead_volume", "automation_needs", "timeline", "budget_range", "demo_interest"];

export function SettingsPage({ role }: { role: string }) {
  const admin = role === "admin" || role === "owner";
  const { data, error, loading, reload } = useAsync(() => api("/settings"), []);
  const [s, setS] = useState<S | null>(null);
  const [domains, setDomains] = useState("");
  const [tab, setTab] = useState<string>("behavior");
  const [toast, setToast] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const sys = useAsync(() => api("/system"), []);
  useEffect(() => { if (data) { setS(structuredClone(data.settings)); setDomains(data.domains.join("\n")); } }, [data]);
  if (loading || !s) return <Loading />;
  const set = (path: string, value: unknown) => { const n = structuredClone(s); const keys = path.split("."); let o = n; for (const k of keys.slice(0, -1)) o = o[k]; o[keys[keys.length - 1]] = value; setS(n); };
  const save = async () => { setErr(null); try { await api("/settings", { method: "PUT", body: { settings: s } }); setToast(tr("Paramètres enregistrés (appliqués en moins d'une minute)")); reload(); } catch (e) { setErr((e as Error).message); } };
  const saveDomains = async () => { setErr(null); try { await api("/domains", { method: "PUT", body: { domains: domains.split(/\s+/).map((x) => x.trim()).filter(Boolean) } }); setToast(tr("Domaines enregistrés")); reload(); } catch (e) { setErr((e as Error).message); } };
  const bi = (label: string, path: string, area = false) => {
    const v = path.split(".").reduce((o: any, k) => o[k], s);
    return <div className="grid gap-3 sm:grid-cols-2">{(["fr", "en"] as const).map((l) => <Field key={l} label={`${label} (${l.toUpperCase()})`}>{area ? <textarea className="input h-24" disabled={!admin} value={v[l]} onChange={(e) => set(`${path}.${l}`, e.target.value)} /> : <input className="input" disabled={!admin} value={v[l]} onChange={(e) => set(`${path}.${l}`, e.target.value)} />}</Field>)}</div>;
  };
  const num = (label: string, path: string, hint?: string) => <Field label={label} hint={hint}><input className="input" type="number" disabled={!admin} value={path.split(".").reduce((o: any, k) => o[k], s)} onChange={(e) => set(path, Number(e.target.value))} /></Field>;
  return (
    <>
      <PageHeader title={tr("Comportement & apparence")} subtitle={L(`Assistant « ${data.assistant.name} » · identifiant public : ${data.assistant.public_key}`, `Assistant “${data.assistant.name}” · public id: ${data.assistant.public_key}`)} actions={admin && tab !== "domains" && tab !== "system" && <button className="btn-primary" onClick={save}>{tr("Enregistrer")}</button>} />
      <ErrorBox error={error ?? err} />
      <div className="mb-4 flex flex-wrap gap-1 border-b border-slate-200" role="tablist">{TABS.map(([id, l]) => <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={`-mb-px border-b-2 px-3 py-2 text-sm font-semibold ${tab === id ? "border-brand text-brand" : "border-transparent text-slate-500"}`}>{l}</button>)}</div>
      <div className="card space-y-4 p-5">
        {tab === "behavior" && <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={tr("Nom de l'assistant")}><input className="input" disabled={!admin} value={s.behavior.assistantName} onChange={(e) => set("behavior.assistantName", e.target.value)} /></Field>
            <Field label={tr("Entreprise")}><input className="input" disabled={!admin} value={s.behavior.companyName} onChange={(e) => set("behavior.companyName", e.target.value)} /></Field>
            <Field label={tr("Langue par défaut")}><select className="input" disabled={!admin} value={s.behavior.defaultLanguage} onChange={(e) => set("behavior.defaultLanguage", e.target.value)}><option value="fr">Français</option><option value="en">English</option></select></Field>
            <Field label={tr("Ton")}><select className="input" disabled={!admin} value={s.behavior.tone} onChange={(e) => set("behavior.tone", e.target.value)}><option value="friendly_professional">{tr("Amical et professionnel")}</option><option value="formal">{tr("Formel")}</option><option value="casual">{tr("Décontracté")}</option></select></Field>
            {num(tr("Longueur max. (mots)"), "behavior.maxResponseWords")}
            {num(tr("Proposer la prise de coordonnées après (tours)"), "behavior.contactCaptureAfterTurns", tr("Jamais imposée ; seulement proposée."))}
          </div>
          <h3 className="pt-2 text-sm font-semibold">{tr("Langues")}</h3>
          <div className="grid gap-3 sm:grid-cols-4">
            <Field label={tr("Langues actives")}><div className="flex gap-4 pt-2">{(["fr", "en"] as const).map((l) => <label key={l} className="flex items-center gap-1 text-sm"><input type="checkbox" disabled={!admin} checked={s.behavior.languages.enabled.includes(l)} onChange={(e) => { const cur: string[] = s.behavior.languages.enabled; const next = e.target.checked ? [...new Set([...cur, l])] : cur.filter((x) => x !== l); if (next.length) set("behavior.languages.enabled", next); }} />{l === "fr" ? "Français" : "English"}</label>)}</div></Field>
            <label className="mt-6 flex items-center gap-2 text-sm"><input type="checkbox" disabled={!admin} checked={s.behavior.languages.autoDetect} onChange={(e) => set("behavior.languages.autoDetect", e.target.checked)} /> {tr("Détecter la langue du visiteur")}</label>
            <label className="mt-6 flex items-center gap-2 text-sm"><input type="checkbox" disabled={!admin} checked={s.behavior.languages.showSwitcher} onChange={(e) => set("behavior.languages.showSwitcher", e.target.checked)} /> {tr("Afficher le sélecteur FR / EN")}</label>
            <label className="mt-6 flex items-center gap-2 text-sm"><input type="checkbox" disabled={!admin} checked={!!s.behavior.showSources} onChange={(e) => set("behavior.showSources", e.target.checked)} /> {L("Afficher les liens « Sources » sous les réponses", "Show “Sources” links under answers")}</label>
          </div>
          {bi(tr("Description de l'entreprise (contexte fourni à l'IA)"), "behavior.companyDescription", true)}
          {bi("Message d'accueil", "behavior.welcome", true)}
          <div className="grid gap-3 sm:grid-cols-2">{(["fr", "en"] as const).map((l) => <Field key={l} label={L(`Suggestions (${l.toUpperCase()}, une par ligne)`, `Suggestions (${l.toUpperCase()}, one per line)`)}><textarea className="input h-32" disabled={!admin} value={s.behavior.suggestions[l].join("\n")} onChange={(e) => set(`behavior.suggestions.${l}`, e.target.value.split("\n").filter((x) => x.trim()))} /></Field>)}</div>
          <Field label={tr("Questions de qualification autorisées (ordre de préférence)")}><div className="flex flex-wrap gap-3">{FIELDS.map((f) => <label key={f} className="flex items-center gap-1 text-xs"><input type="checkbox" disabled={!admin} checked={s.behavior.qualificationFields.includes(f)} onChange={(e) => set("behavior.qualificationFields", e.target.checked ? [...s.behavior.qualificationFields, f] : s.behavior.qualificationFields.filter((x: string) => x !== f))} />{f}</label>)}</div></Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={!admin} checked={s.behavior.askBudget} onChange={(e) => set("behavior.askBudget", e.target.checked)} /> {tr("Autoriser une question sur le budget (lorsque pertinent)")}</label>
          <div className="grid gap-3 sm:grid-cols-4">
            {num(tr("Escalade après N réponses non résolues"), "behavior.escalation.unresolvedThreshold")}
            <Field label={tr("Courriel de soutien")}><input className="input" disabled={!admin} value={s.behavior.escalation.supportEmail} onChange={(e) => set("behavior.escalation.supportEmail", e.target.value)} /></Field>
            <Field label={tr("Téléphone soutien")}><input className="input" disabled={!admin} value={s.behavior.escalation.supportPhone} onChange={(e) => set("behavior.escalation.supportPhone", e.target.value)} /></Field>
            <Field label={tr("Téléphone ventes")}><input className="input" disabled={!admin} value={s.behavior.escalation.salesPhone} onChange={(e) => set("behavior.escalation.salesPhone", e.target.value)} /></Field>
          </div>
          <Field label={tr("Instructions supplémentaires (opérateur)")} hint={tr("Ne peut pas contourner les règles de sécurité et de véracité.")}><textarea className="input h-24" disabled={!admin} value={s.behavior.extraInstructions} onChange={(e) => set("behavior.extraInstructions", e.target.value)} /></Field>
          <h3 className="pt-2 text-sm font-semibold">{tr("Modèles IA")}</h3>
          <div className="grid gap-3 sm:grid-cols-5">
            <Field label={tr("Fournisseur")}><select className="input" disabled={!admin} value={s.ai.provider} onChange={(e) => set("ai.provider", e.target.value)}><option value="anthropic">Anthropic (Claude)</option><option value="openai">OpenAI</option></select></Field>
            <Field label={tr("Modèle de réponse")}><input className="input" disabled={!admin} value={s.ai.responseModel} onChange={(e) => set("ai.responseModel", e.target.value)} /></Field>
            <Field label={tr("Modèle d'analyse")}><input className="input" disabled={!admin} value={s.ai.analysisModel} onChange={(e) => set("ai.analysisModel", e.target.value)} /></Field>
            <Field label="Effort"><select className="input" disabled={!admin} value={s.ai.effort} onChange={(e) => set("ai.effort", e.target.value)}><option value="low">{tr("Faible (rapide)")}</option><option value="medium">{tr("Moyen")}</option><option value="high">{tr("Élevé")}</option></select></Field>
            {num(tr("Sources par réponse"), "ai.retrievalTopK")}
          </div>
          <h3 className="pt-2 text-sm font-semibold">{tr("Pondération du score (0–100)")}</h3>
          <div className="grid gap-3 sm:grid-cols-6">{["intent", "need", "timeline", "contact", "fit", "readiness"].map((k) => <div key={k}>{num(k, `scoring.weights.${k}`)}</div>)}</div>
          <div className="grid gap-3 sm:grid-cols-3">{num(tr("Seuil priorité moyenne"), "scoring.thresholds.medium")}{num(tr("Seuil priorité élevée"), "scoring.thresholds.high")}{num(tr("Score min. « qualifié »"), "scoring.qualifiedMinScore")}</div>
        </>}
        {tab === "appearance" && <>
          <div className="grid gap-3 sm:grid-cols-4">
            {[["Couleur principale", "primaryColor"], ["Couleur d'accent", "accentColor"], ["Fond", "backgroundColor"], ["Texte", "textColor"]].map(([l, k]) => <Field key={k} label={l}><div className="flex gap-2"><input type="color" aria-label={l} disabled={!admin} value={s.appearance[k]} onChange={(e) => set(`appearance.${k}`, e.target.value)} className="h-9 w-12 rounded border" /><input className="input" disabled={!admin} value={s.appearance[k]} onChange={(e) => set(`appearance.${k}`, e.target.value)} /></div></Field>)}
            <Field label={tr("Police du texte")}><input className="input" disabled={!admin} value={s.appearance.fontFamily} onChange={(e) => set("appearance.fontFamily", e.target.value)} /></Field>
            <Field label={tr("Police des titres")}><input className="input" disabled={!admin} value={s.appearance.headingFontFamily} onChange={(e) => set("appearance.headingFontFamily", e.target.value)} /></Field>
            {num("Arrondi (px)", "appearance.radius")}{num(tr("Hauteur du clavardage intégré (px)"), "appearance.inlineHeight")}
            <div className="sm:col-span-2"><Field label={tr("Photo de profil de l'assistant (avatar et bulle)")} hint={tr("PNG/JPG/WebP, redimensionnée automatiquement. Évitez les photos de personnes non approuvées.")}><ImagePicker value={s.appearance.avatarUrl.startsWith("/") ? location.origin + s.appearance.avatarUrl : s.appearance.avatarUrl} onChange={(v) => set("appearance.avatarUrl", v)} disabled={!admin} round label={tr("Téléverser l'avatar")} /></Field></div>
            <div className="sm:col-span-2"><Field label="Logo"><ImagePicker value={s.appearance.logoUrl.startsWith("/") ? location.origin + s.appearance.logoUrl : s.appearance.logoUrl} onChange={(v) => set("appearance.logoUrl", v)} disabled={!admin} label={tr("Téléverser le logo")} /></Field></div>
            <Field label={tr("Position du lanceur")}><select className="input" disabled={!admin} value={s.appearance.launcherPosition} onChange={(e) => set("appearance.launcherPosition", e.target.value)}><option value="right">{tr("Bas droite")}</option><option value="left">{tr("Bas gauche")}</option></select></Field>
            <Field label={tr("Style du bouton")}><select className="input" disabled={!admin} value={s.appearance.launcherStyle} onChange={(e) => set("appearance.launcherStyle", e.target.value)}><option value="circle">{tr("Cercle")}</option><option value="pill">{tr("Pilule avec libellé")}</option></select></Field>
          </div>
          {bi(tr("Libellé du bouton (style pilule)"), "appearance.launcherLabel")}
          {bi("Message d'accroche (teaser)", "appearance.teaser.text")}
          <div className="grid gap-3 sm:grid-cols-4">{num(tr("Délai du teaser (s)"), "appearance.teaser.delaySeconds")}
            {[[tr("Teaser activé"), "appearance.teaser.enabled"], ["Animation d'attention", "appearance.attentionAnimation"], [tr("Plein écran sur mobile"), "appearance.mobileFullscreen"], ["Charger Google Fonts", "appearance.loadGoogleFonts"]].map(([l, p]) => <label key={p} className="mt-6 flex items-center gap-2 text-sm"><input type="checkbox" disabled={!admin} checked={p.split(".").reduce((o: any, k) => o[k], s)} onChange={(e) => set(p, e.target.checked)} />{l}</label>)}</div>
          <p className="text-sm text-slate-500">{tr("Aperçu : enregistrez puis ouvrez")} <a className="text-brand" href="/" target="_blank">{tr("la page de démonstration")}</a>.</p>
        </>}
        {tab === "booking" && <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={tr("Fournisseur")}><select className="input" disabled={!admin} value={s.booking.provider} onChange={(e) => set("booking.provider", e.target.value)}><option value="none">{tr("Aucun")}</option><option value="link">{tr("Lien de réservation")}</option><option value="calendly">Calendly</option><option value="cal_com">Cal.com</option></select></Field>
            <div className="sm:col-span-2"><Field label={tr("URL de réservation (https)")}><input className="input" disabled={!admin} value={s.booking.url} onChange={(e) => set("booking.url", e.target.value)} /></Field></div>
          </div>
          {bi(tr("Libellé du bouton"), "booking.label")}
          <p className="text-sm text-slate-500">{tr("L'assistant n'invente jamais de disponibilités. Les clics sont suivis (« booking_clicked ») ; les réservations confirmées (« booking_confirmed ») proviennent uniquement d'un webhook Cal.com/Calendly vérifié (voir Intégrations).")}</p>
        </>}
        {tab === "privacy" && <>
          {bi(tr("Avis de confidentialité affiché"), "privacy.notice", true)}
          {bi(tr("URL de la politique de confidentialité"), "privacy.privacyPolicyUrl")}
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={tr("Version de l'avis")}><input className="input" disabled={!admin} value={s.privacy.noticeVersion} onChange={(e) => set("privacy.noticeVersion", e.target.value)} /></Field>
            {num(tr("Conservation des conversations (jours)"), "privacy.conversationRetentionDays", tr("Conversations sans lead purgées automatiquement."))}{num(tr("Durée de session visiteur (jours)"), "privacy.sessionRetentionDays")}
            {num("Messages / minute / visiteur", "limits.messagesPerMinute")}{num("Messages max. / conversation", "limits.messagesPerConversation")}{num(tr("Plafond quotidien de réponses"), "limits.dailyMessageCap", tr("Protection des coûts."))}{num(tr("Longueur max. d'un message"), "limits.maxMessageChars")}
          </div>
        </>}
        {tab === "domains" && <>
          <Field label={tr("Domaines autorisés à intégrer le widget (un par ligne, *.exemple.com accepté)")} hint={tr("Le domaine de cette application est toujours autorisé. L'identifiant public de l'assistant n'est pas une authentification : seules les origines listées peuvent l'utiliser, avec limitation de débit.")}><textarea className="input h-40 font-mono text-sm" disabled={!admin} value={domains} onChange={(e) => setDomains(e.target.value)} /></Field>
          {admin && <button className="btn-primary" onClick={saveDomains}>{tr("Enregistrer les domaines")}</button>}
        </>}
        {tab === "system" && (sys.data ? <dl className="grid gap-2 text-sm sm:grid-cols-2">{Object.entries(sys.data).map(([k, v]) => <div key={k} className="flex justify-between gap-3 border-b border-slate-100 pb-1"><dt className="text-slate-500">{k}</dt><dd className="text-right font-mono text-xs">{typeof v === "object" ? JSON.stringify(v) : String(v)}</dd></div>)}</dl> : <Loading />)}
      </div>
      <Toast msg={toast} onDone={() => setToast(null)} />
    </>
  );
}
