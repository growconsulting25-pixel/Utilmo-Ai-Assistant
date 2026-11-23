import { useEffect, useRef } from "preact/hooks";
import type { WidgetStore } from "../store";
import { Composer, Conversation, Header, useStore } from "./Chat";

export function Inline({ store }: { store: WidgetStore }) {
  const state = useStore(store);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current || !("IntersectionObserver" in window)) return;
    const io = new IntersectionObserver(([e]) => store.setInlineVisible(e.isIntersecting && e.intersectionRatio > 0.3), { threshold: [0, 0.3, 0.6] });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [store]);
  if (state.configError) return <div class="u-inline u-unavailable" role="note">{state.configError === "origin_not_allowed" ? "Assistant unavailable on this domain." : "Assistant temporarily unavailable."}</div>;
  return (
    <section class="u-inline" ref={ref} aria-label={state.config?.settings.assistantName ?? "Assistant"} style={{ height: `${state.config?.settings.appearance.inlineHeight ?? 600}px` }}>
      <Header store={store} state={state} />
      <Conversation store={store} state={state} surface="inline" />
      <Composer store={store} state={state} surface="inline" />
    </section>
  );
}
