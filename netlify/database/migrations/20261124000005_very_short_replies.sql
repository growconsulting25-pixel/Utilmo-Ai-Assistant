-- Utilmo: very short replies (goal: book a meeting or collect contact details quickly).
UPDATE assistant_settings SET
  settings = jsonb_set(jsonb_set(settings, '{behavior,maxResponseWords}', '30'::jsonb), '{ai,maxOutputTokens}', '1500'::jsonb),
  version = version + 1, updated_at = now()
WHERE assistant_id = (SELECT id FROM assistants WHERE public_key = 'utilmo');
