-- Live human takeover: team members can reply inside a visitor conversation.
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_role_check;
ALTER TABLE messages ADD CONSTRAINT messages_role_check CHECK (role IN ('user','assistant','event','agent'));
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS human_active boolean NOT NULL DEFAULT false;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS human_agent_name text;

-- Email notifications (new leads, support tickets, "talk to someone"): disabled until a sender is configured in the admin.
INSERT INTO integrations (organization_id, assistant_id, type, name, enabled, config)
SELECT a.organization_id, a.id, 'email', 'Notifications courriel', false,
  '{"provider":"smtp","to":"support@marketingwebsites.ca, jean@marketingwebsites.ca, support@utilmo.ca","events":["lead.captured","support.ticket_created","human.requested"],"smtp_port":465}'::jsonb
FROM assistants a WHERE a.public_key = 'utilmo'
  AND NOT EXISTS (SELECT 1 FROM integrations i WHERE i.assistant_id = a.id AND i.type = 'email');
