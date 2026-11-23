import { api } from "../api";
import { Loading, PageHeader, useAsync } from "../ui";

function Code({ children }: { children: string }) {
  return <div className="relative"><pre className="overflow-x-auto rounded-lg bg-slate-900 p-4 text-xs text-slate-100"><code>{children}</code></pre><button className="absolute right-2 top-2 rounded bg-white/10 px-2 py-1 text-xs text-white hover:bg-white/20" onClick={() => navigator.clipboard.writeText(children)}>Copier</button></div>;
}

export function Embed() {
  const { data, loading } = useAsync(() => api("/settings"), []);
  if (loading) return <Loading />;
  const id = data.assistant.public_key;
  const base = location.origin;
  return (
    <>
      <PageHeader title="Intégrer l'assistant" subtitle="Un seul script, aucune dépendance au site hôte (Shadow DOM, styles isolés). Ajoutez d'abord le domaine du site dans « Domaines autorisés »." />
      <div className="space-y-6">
        <section className="card p-5"><h2 className="mb-2 font-semibold">Bulle flottante</h2>
          <Code>{`<script src="${base}/widget.js" data-assistant-id="${id}" data-mode="floating" defer></script>`}</Code></section>
        <section className="card p-5"><h2 className="mb-2 font-semibold">Clavardage intégré dans une section</h2>
          <Code>{`<div id="utilmo-ai-chat"></div>\n<script src="${base}/widget.js" data-assistant-id="${id}" data-mode="inline" data-container="#utilmo-ai-chat" defer></script>`}</Code></section>
        <section className="card p-5"><h2 className="mb-2 font-semibold">Les deux, même conversation (API JavaScript)</h2>
          <Code>{`<div id="utilmo-ai-chat"></div>\n<script src="${base}/widget.js" defer></script>\n<script>\n  window.addEventListener("DOMContentLoaded", function () {\n    UtilmoAI.init({ assistantId: "${id}", floating: true, inlineContainer: "#utilmo-ai-chat", language: "fr" });\n  });\n</script>`}</Code>
          <p className="mt-3 text-sm text-slate-600">Méthodes : <code>UtilmoAI.open()</code>, <code>close()</code>, <code>toggle()</code>, <code>reset()</code>, <code>setLanguage("en")</code>, <code>send("…")</code>, <code>on("lead", fn)</code>, <code>destroy()</code>. Version : <code>UtilmoAI.version</code>. Version figée : <code>{base}/widget/v1/widget.js</code>.</p></section>
        <section className="card p-5"><h2 className="mb-2 font-semibold">React / Next.js</h2>
          <Code>{`import Script from "next/script";\n\nexport function UtilmoChat() {\n  return (<>\n    <div id="utilmo-ai-chat" />\n    <Script src="${base}/widget.js" strategy="afterInteractive"\n      onLoad={() => window.UtilmoAI?.init({ assistantId: "${id}", floating: true, inlineContainer: "#utilmo-ai-chat" })} />\n  </>);\n}`}</Code></section>
        <section className="card p-5"><h2 className="mb-2 font-semibold">WordPress / Shopify</h2>
          <p className="text-sm text-slate-600">WordPress : ajoutez le script flottant via un bloc « HTML personnalisé » dans le pied de page (ou une extension d'insertion d'en-tête/pied), et le bloc inline dans la page souhaitée. Shopify : <em>Boutique en ligne → Thèmes → Modifier le code → theme.liquid</em>, collez le script avant <code>&lt;/body&gt;</code>.</p></section>
      </div>
    </>
  );
}
