-- Recipients: support@utilmo.com (not .ca).
UPDATE integrations SET config = jsonb_set(config, '{to}', to_jsonb(replace(config->>'to', 'support@utilmo.ca', 'support@utilmo.com'))), updated_at = now()
WHERE type = 'email' AND config->>'to' LIKE '%support@utilmo.ca%';
