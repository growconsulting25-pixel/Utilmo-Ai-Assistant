-- Utilmo: use the Utilmo bot mascot as chat avatar and floating launcher.
UPDATE assistant_settings SET
  settings = jsonb_set(settings, '{appearance,avatarUrl}', '"/brand/utilmo-bot.png"'::jsonb),
  version = version + 1, updated_at = now()
WHERE assistant_id = (SELECT id FROM assistants WHERE public_key = 'utilmo');
