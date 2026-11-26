-- Admin user profile: photo and interface language.
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS avatar text;
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS ui_language text NOT NULL DEFAULT 'fr';
