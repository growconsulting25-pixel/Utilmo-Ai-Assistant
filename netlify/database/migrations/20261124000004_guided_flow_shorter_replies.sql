-- Utilmo: shorter welcome (the guided flow appends "Êtes-vous courtier immobilier ?") and shorter replies.
UPDATE assistant_settings SET
  settings = jsonb_set(jsonb_set(jsonb_set(settings,
    '{behavior,welcome}', '{"fr":"Bonjour 👋 Bienvenue chez Utilmo ! Je peux répondre à vos questions et vous aider à trouver la bonne solution pour votre entreprise.","en":"Hi 👋 Welcome to Utilmo! I can answer your questions and help you find the right solution for your business."}'::jsonb),
    '{behavior,maxResponseWords}', '60'::jsonb),
    '{ai,maxOutputTokens}', '800'::jsonb),
  version = version + 1, updated_at = now()
WHERE assistant_id = (SELECT id FROM assistants WHERE public_key = 'utilmo');
