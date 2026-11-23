-- Server-generated secrets used when the corresponding environment variables are not set.
-- Values never leave the server; environment variables always take precedence.
CREATE TABLE IF NOT EXISTS app_secrets (
  name text PRIMARY KEY,
  value text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
