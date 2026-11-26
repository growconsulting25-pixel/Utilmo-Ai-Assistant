-- Password reset / invitation links (only a hash of the token is stored; single use; expiring).
CREATE TABLE IF NOT EXISTS password_resets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id uuid NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  purpose text NOT NULL DEFAULT 'reset' CHECK (purpose IN ('reset','invite')),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
