# Architecture

## Overview

```
 Any website (WordPress, Shopify, Next.js, static…)          Netlify (this repo)
 ┌─────────────────────────────────────────┐                 ┌──────────────────────────────────────────────┐
 │ <script src=…/widget.js data-…>          │  HTTPS (CORS,  │ Static: /widget.js, /widget/v1/widget.js,     │
 │  ├─ Inline chat   (Shadow DOM)           │  allowed       │         / (demo), /admin (React admin SPA)    │
 │  └─ Floating chat (Shadow DOM)           │  origins only) │ Functions (TypeScript, Zod):                  │
 │     one shared store per assistant       │ ─────────────▶ │  /api/chat  (NDJSON stream)                   │
 │     (localStorage + cross-tab sync)      │                │  /api/session, /api/widget-config, /api/event │
 └─────────────────────────────────────────┘                 │  /api/admin/*  (cookie auth, RBAC, audit)     │
                                                              │  /api/internal/crawl (background, signed)     │
                                                              │  /api/booking/webhook/:id (Cal.com/Calendly)  │
                                                              │  maintenance (scheduled, every 10 min)        │
                                                              ├──────────────────────────────────────────────┤
                                                              │ Netlify Database (Postgres) — migrations in   │
                                                              │ netlify/database/migrations; pgvector optional│
                                                              ├──────────────────────────────────────────────┤
                                                              │ Netlify AI Gateway → Anthropic Claude         │
                                                              │ (provider adapters: Anthropic / OpenAI)       │
                                                              └──────────────────────────────────────────────┘
```

## Key decisions (and why)

| Decision | Reason |
|---|---|
| **Netlify Database** instead of Supabase | Zero-config Postgres provisioned with the site, migrations applied on deploy, per-preview branches. `DATABASE_URL` switches to Supabase/Neon without code changes (`server/db.ts`). |
| **Netlify AI Gateway** for the LLM | No provider account or key to manage; credentials are injected at runtime and never reach the browser. `AI_API_KEY` switches to your own key. |
| **Two-model pipeline** — analysis (`claude-haiku-5-5`, structured JSON) + reply (`claude-opus-5-5`, streamed) | The LLM is used for language understanding and natural replies; **deterministic code** owns state transitions, validation, persistence, scoring, tool execution and webhooks. Models are configurable per assistant. |
| **Full-text retrieval by default, pgvector hybrid optional** | The AI Gateway does not serve embedding models. Postgres FTS (French + English + simple configs) with LLM query expansion (FR+EN keywords) and term-coverage ranking works well on a ~100-page knowledge base. Set `EMBEDDING_PROVIDER=openai` + `EMBEDDING_API_KEY` to enable vector search (reciprocal-rank fusion). |
| **Preact + Shadow DOM widget** (≈18 KB gzip) | No dependency on the host's React, no CSS leaks either way, works on any site. The admin uses React + Tailwind. |
| **One store, two views** | Inline and floating instances render the same store → identical history; only one reply can be in flight (client) and a per-conversation DB lock prevents concurrent replies (server). |
| **NDJSON streaming** | Simple, proxy-friendly incremental rendering (`session` → `status` → `delta…` → `actions` → `done`). |

## Turn pipeline (`packages/ai-core/src/orchestrator.ts`)

1. Validate (Zod), origin check, rate limits (per IP, per visitor, daily cap), idempotency (`clientMessageId`), conversation lock.
2. Redact card numbers / passwords, persist visitor message.
3. **Deterministic extraction**: e-mail, phone (E.164 via libphonenumber), explicit names.
4. **Analysis model** (structured output, validated with Zod; deterministic fallback on failure): language, intents, interest categories, existing-customer flag, extracted business facts, refusal/human/demo signals, search queries.
5. **Profile merge**: never overwrites a stronger value (pattern > LLM) unless the visitor explicitly corrects it.
6. **Retrieval** (sales vs support collection) with authority boosts (internal > verified docs > website > blog).
7. **Policy / state machine** (`policy.ts`): decides state, the single next question (never repeated), contact-capture timing, booking/ticket/handoff actions.
8. **Recommendations** from the admin-editable catalog (`recommend.ts`), only verified features/prices.
9. **Reply model** (streamed) with the stable system prompt (cached) + a per-turn operator note (sources as data, open conflicts, masked profile, guidance).
10. **Deterministic actions**: lead upsert + dedupe + score history, support ticket, booking card, webhooks (idempotent, signed, retried).
11. **Post-turn evaluation** (background): conversation summary, unanswered questions, newly detected conflicts.

## Conversation states

`GREETING → GENERAL_INFORMATION | NEEDS_DISCOVERY → SERVICE_RECOMMENDATION → CONTACT_CAPTURE → LEAD_QUALIFICATION → BOOKING → COMPLETED`,
with `EXISTING_CUSTOMER_SUPPORT → SUPPORT_ESCALATION` and `HUMAN_HANDOFF` reachable from any state. States are recomputed every turn,
so visitors can change topics at any time; questions are answered first, then the flow resumes.

## Multi-tenancy

`organizations → assistants → assistant_settings / allowed_domains / knowledge / services / conversations / leads …`.
Every tenant row has `organization_id`; all admin queries are scoped by the authenticated admin's organization and
the public API resolves the tenant from the assistant's public id + allowed origin. A new assistant (another company)
is created from the admin (`POST /api/admin/assistants`) and gets its own knowledge base, branding, domains, services,
integrations and analytics — no frontend rebuild.
