-- Pre-fill the notification sender: support@utilmo.com over Google Workspace SMTP (password entered in the admin).
UPDATE integrations SET config = config || '{"provider":"smtp","smtp_host":"smtp.gmail.com","smtp_port":465,"smtp_user":"support@utilmo.com","from":"Utilmo <support@utilmo.com>"}'::jsonb, updated_at = now()
WHERE type = 'email' AND secret_encrypted IS NULL
  AND assistant_id = (SELECT id FROM assistants WHERE public_key = 'utilmo');
