-- Utilmo AI Assistant — initial multi-tenant schema.
-- Tenant isolation: every tenant-owned row carries organization_id; the server
-- repository layer always scopes queries by organization (see server/repo/*).

CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  data_region text NOT NULL DEFAULT 'unspecified',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE assistants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  public_key text NOT NULL UNIQUE,           -- the public "assistant id" used by widget.js (NOT a secret)
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assistants_org_idx ON assistants(organization_id);

CREATE TABLE assistant_settings (
  assistant_id uuid PRIMARY KEY REFERENCES assistants(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 1,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,   -- validated by zod (packages/shared/src/settings.ts)
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);

CREATE TABLE assistant_allowed_domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  assistant_id uuid NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
  domain text NOT NULL,                         -- hostname, optionally "*.example.com"
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (assistant_id, domain)
);

-- Anonymous public visitors (no PII here).
CREATE TABLE visitors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  assistant_id uuid NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
  first_touch jsonb NOT NULL DEFAULT '{}'::jsonb,  -- utm_*, referrer host, landing path
  language text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX visitors_org_idx ON visitors(organization_id, created_at DESC);

-- Authenticated customer identities (future: account-aware support). Kept separate from visitors.
CREATE TABLE customer_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider text NOT NULL,                 -- e.g. 'utilmo_sso' (not implemented yet)
  external_subject text NOT NULL,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, provider, external_subject)
);

CREATE TABLE leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  assistant_id uuid NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
  visitor_id uuid REFERENCES visitors(id) ON DELETE SET NULL,
  first_name text, last_name text,
  email text, email_normalized text,
  phone_raw text, phone_e164 text,
  language text,
  brokerage text, city text,
  territory text[] NOT NULL DEFAULT '{}',
  user_type text,
  existing_customer text NOT NULL DEFAULT 'unknown' CHECK (existing_customer IN ('yes','no','unknown')),
  services_interest text[] NOT NULL DEFAULT '{}',
  qualification jsonb NOT NULL DEFAULT '{}'::jsonb,  -- main_goal, current_crm, website_status, timeline, ...
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','contact_captured','qualified','support','disqualified','archived')),
  score integer NOT NULL DEFAULT 0,
  priority text NOT NULL DEFAULT 'low' CHECK (priority IN ('low','medium','high')),
  consent jsonb NOT NULL DEFAULT '{}'::jsonb,
  sync_status text NOT NULL DEFAULT 'not_configured',
  summary text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX leads_org_email_uq ON leads(organization_id, email_normalized) WHERE email_normalized IS NOT NULL;
CREATE UNIQUE INDEX leads_org_phone_uq ON leads(organization_id, phone_e164) WHERE phone_e164 IS NOT NULL;
CREATE INDEX leads_org_created_idx ON leads(organization_id, created_at DESC);

CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  assistant_id uuid NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
  visitor_id uuid NOT NULL REFERENCES visitors(id) ON DELETE CASCADE,
  lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,
  state text NOT NULL DEFAULT 'GREETING',
  previous_state text,
  language text NOT NULL DEFAULT 'fr',
  intents text[] NOT NULL DEFAULT '{}',
  profile jsonb NOT NULL DEFAULT '{}'::jsonb,       -- structured qualification state with confidence/provenance
  summary text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed','handoff','deleted')),
  escalation_status text NOT NULL DEFAULT 'none' CHECK (escalation_status IN ('none','requested','ticket_created','resolved')),
  message_count integer NOT NULL DEFAULT 0,
  unresolved_count integer NOT NULL DEFAULT 0,
  score integer NOT NULL DEFAULT 0,
  processing_until timestamptz,                     -- per-conversation lock (prevents duplicate concurrent replies)
  first_touch jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_message_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversations_org_idx ON conversations(organization_id, created_at DESC);
CREATE INDEX conversations_visitor_idx ON conversations(visitor_id);

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user','assistant','event')),
  content text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  client_message_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_conv_idx ON messages(conversation_id, created_at);
CREATE UNIQUE INDEX messages_client_id_uq ON messages(conversation_id, client_message_id) WHERE client_message_id IS NOT NULL;

CREATE TABLE lead_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  score integer NOT NULL,
  priority text NOT NULL,
  breakdown jsonb NOT NULL,
  reasons jsonb NOT NULL,
  scoring_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lead_scores_lead_idx ON lead_scores(lead_id, created_at DESC);

-- Service catalog / recommendation rules (editable in admin).
CREATE TABLE recommended_services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  assistant_id uuid NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
  key text NOT NULL,
  name jsonb NOT NULL,                  -- {fr, en}
  description jsonb NOT NULL,           -- {fr, en}
  categories text[] NOT NULL DEFAULT '{}',
  problems jsonb NOT NULL DEFAULT '{}', -- {fr:[...], en:[...]}
  features jsonb NOT NULL DEFAULT '{}', -- verified features {fr:[...], en:[...]}
  price_note jsonb NOT NULL DEFAULT '{}', -- ONLY verified/approved prices
  next_step text NOT NULL DEFAULT 'demo' CHECK (next_step IN ('demo','callback','quote','support','info')),
  url text,
  enabled boolean NOT NULL DEFAULT true,
  sort integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (assistant_id, key)
);

CREATE TABLE conversation_recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  service_key text NOT NULL,
  confidence numeric NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, service_key)
);

CREATE TABLE support_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  assistant_id uuid NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,
  customer_name text, email text, phone text,
  category text NOT NULL DEFAULT 'general',
  description text NOT NULL,
  history_excerpt jsonb NOT NULL DEFAULT '[]'::jsonb,
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','waiting','resolved','closed')),
  assigned_team text NOT NULL DEFAULT 'support',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX support_tickets_org_idx ON support_tickets(organization_id, created_at DESC);

CREATE TABLE bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  assistant_id uuid NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,
  provider text NOT NULL,               -- 'link','calendly','cal_com','google_calendar'
  status text NOT NULL CHECK (status IN ('clicked','confirmed','cancelled','rescheduled')),
  external_id text,
  scheduled_at timestamptz,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  assistant_id uuid REFERENCES assistants(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('webhook','zapier','make','highlevel','utilmo_crm','email','cal_com','calendly')),
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,   -- url, events, field_mapping (never secrets)
  secret_encrypted text,                       -- AES-256-GCM, key from ENCRYPTION_KEY
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  integration_id uuid NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  event text NOT NULL,
  idempotency_key text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivering','success','failed','dead')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_status_code integer,
  last_error text,
  response_excerpt text,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  UNIQUE (integration_id, idempotency_key)
);
CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries(status, next_attempt_at);

CREATE TABLE analytics_events (
  id bigserial PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  assistant_id uuid REFERENCES assistants(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  visitor_id uuid REFERENCES visitors(id) ON DELETE SET NULL,
  event text NOT NULL,
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX analytics_events_org_idx ON analytics_events(organization_id, event, created_at DESC);

CREATE TABLE admin_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email text NOT NULL UNIQUE,
  name text,
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'viewer' CHECK (role IN ('owner','admin','editor','viewer')),
  active boolean NOT NULL DEFAULT true,
  failed_logins integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_logs (
  id bigserial PRIMARY KEY,
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  admin_user_id uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  action text NOT NULL,
  target_type text,
  target_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_org_idx ON audit_logs(organization_id, created_at DESC);

-- Knowledge base
CREATE TABLE knowledge_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  assistant_id uuid NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('website','faq','document','manual','seed')),
  name text NOT NULL,
  url text,
  collection text NOT NULL DEFAULT 'both' CHECK (collection IN ('sales','support','both')),
  priority integer NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 4),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,   -- crawl: allowed prefixes, max pages
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE knowledge_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  assistant_id uuid NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
  source_id uuid REFERENCES knowledge_sources(id) ON DELETE CASCADE,
  title text NOT NULL,
  url text,
  language text NOT NULL DEFAULT 'fr',
  collection text NOT NULL DEFAULT 'both' CHECK (collection IN ('sales','support','both')),
  priority integer NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 4),
  doc_type text NOT NULL DEFAULT 'page',  -- page, faq, pricing, service, document
  content text NOT NULL,
  content_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending_index' CHECK (status IN ('pending_index','active','disabled','superseded')),
  verified boolean NOT NULL DEFAULT false,
  verified_by uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  verified_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  fetched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX knowledge_documents_asst_idx ON knowledge_documents(assistant_id, status);
CREATE UNIQUE INDEX knowledge_documents_url_uq ON knowledge_documents(assistant_id, url) WHERE url IS NOT NULL AND status <> 'superseded' AND doc_type = 'page';

CREATE TABLE knowledge_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  assistant_id uuid NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL,
  heading text,
  content text NOT NULL,
  token_estimate integer NOT NULL DEFAULT 0,
  tsv tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(heading, '')), 'A') ||
    setweight(to_tsvector('french', coalesce(heading, '') || ' ' || content), 'B') ||
    setweight(to_tsvector('english', content), 'C')
  ) STORED,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX knowledge_chunks_tsv_idx ON knowledge_chunks USING gin(tsv);
CREATE INDEX knowledge_chunks_doc_idx ON knowledge_chunks(document_id);
CREATE INDEX knowledge_chunks_asst_idx ON knowledge_chunks(assistant_id);

CREATE TABLE knowledge_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  assistant_id uuid NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
  version integer NOT NULL,
  note text,
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (assistant_id, version)
);

CREATE TABLE knowledge_conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  assistant_id uuid NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
  topic text NOT NULL,
  description text NOT NULL,
  source_urls text[] NOT NULL DEFAULT '{}',
  detected_by text NOT NULL DEFAULT 'system',  -- seed, assistant, admin
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  resolution text,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE TABLE unanswered_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  assistant_id uuid NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  question text NOT NULL,
  language text,
  reason text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','dismissed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rate_limits (
  key text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  count integer NOT NULL DEFAULT 0
);

CREATE TABLE usage_daily (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  assistant_id uuid NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
  day date NOT NULL,
  requests integer NOT NULL DEFAULT 0,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  est_cost_usd numeric(12,6) NOT NULL DEFAULT 0,
  total_latency_ms bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (assistant_id, day)
);

-- Optional semantic retrieval: enabled only where pgvector is available.
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS vector;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pgvector not available; full-text retrieval only';
  END;
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    EXECUTE 'ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS embedding vector(1536)';
    EXECUTE 'ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS embedding_model text';
    EXECUTE 'CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding_idx ON knowledge_chunks USING hnsw (embedding vector_cosine_ops)';
  END IF;
END
$$;
