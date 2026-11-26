# Self-hosting Utilmo AI on your own server (instead of Netlify)

The same code runs as one Node.js process: demo page, admin, widget (`/widget.js`) and API on a single port,
with PostgreSQL as the database. `docker compose` adds automatic HTTPS (Caddy).

## What changes compared with Netlify

| Netlify | Your server |
|---|---|
| Netlify Database (automatic) | PostgreSQL 15+ (the `pgvector/pgvector:pg16` image is included) |
| AI Gateway (no key) | **Anthropic API key required** (`AI_API_KEY`) — billed directly by Anthropic, usually cheaper than gateway credits |
| Functions, background crawl, cron | Built in: one process, crawl in background, maintenance every 10 minutes |
| Migrations applied at deploy | Applied automatically at startup (`RUN_MIGRATIONS=false` to disable) |
| HTTPS / CDN | Caddy (Let's Encrypt) in `docker-compose.yml`, or your own Nginx/Apache |

## Requirements
- A Linux server (2 vCPU / 2 GB RAM is plenty to start) with Docker + Docker Compose.
- A sub-domain pointing to it, e.g. `ai.utilmo.com` (DNS **A** record → server IP).
- An Anthropic API key: https://console.anthropic.com → API Keys.

## Installation (about 15 minutes)
```bash
git clone https://github.com/growconsulting25-pixel/Utilmo-Ai-Assistant.git
cd Utilmo-Ai-Assistant
cp .env.selfhost.example .env
# edit .env: APP_DOMAIN, POSTGRES_PASSWORD, AI_API_KEY, the 3 secrets (openssl rand -base64 36), ADMIN_SETUP_TOKEN
docker compose up -d --build
docker compose logs -f app        # "[migrate] applied …" then "Utilmo AI listening on :8080"
```
Open `https://ai.utilmo.com/admin/` → create the owner account with `ADMIN_SETUP_TOKEN`.
The knowledge base (curated sheets + crawl of utilmo.com) is imported automatically at the first chat message.

### Without Docker (Node 22 + existing PostgreSQL)
```bash
npm ci && npm run build && npm run build:server
DATABASE_URL=postgres://user:pass@host:5432/utilmo AI_API_KEY=… SESSION_SECRET=… ADMIN_AUTH_SECRET=… ENCRYPTION_KEY=… PORT=8080 node dist-server/server.mjs
```
Put Nginx/Apache in front for HTTPS (`proxy_pass http://127.0.0.1:8080;` and **`proxy_buffering off;`** so answers stream),
and run it with systemd or pm2 (`pm2 start dist-server/server.mjs --name utilmo-ai`).

## Moving your existing data from Netlify (optional)
1. Get the Netlify Database connection string: `npx netlify-cli database status --show-credentials` (logged in, inside the linked project).
2. Dump and restore:
   ```bash
   pg_dump --no-owner --no-acl "NETLIFY_CONNECTION_STRING" > utilmo.sql
   docker compose up -d db
   docker compose exec -T db psql -U utilmo utilmo < utilmo.sql
   docker compose run --rm app node dist-server/migrate.mjs --baseline   # marks migrations as already applied
   docker compose up -d
   ```
3. Set the **same** `SESSION_SECRET`, `ADMIN_AUTH_SECRET`, `ENCRYPTION_KEY` as before if they were set on Netlify. If Netlify was using
   server-generated secrets, they are in the dumped `app_secrets` table and are picked up automatically.
4. Re-enter nothing else: leads, conversations, users, notifications and knowledge come with the dump.

## After the switch
- Change the widget URL on your websites to `https://ai.utilmo.com/widget.js` (see `docs/WORDPRESS.md`).
- Notifications e-mail links use the server's own address automatically.
- Updates: `git pull && docker compose up -d --build` (new migrations are applied at startup).
- Backups: `docker compose exec db pg_dump -U utilmo utilmo | gzip > backup-$(date +%F).sql.gz` (cron daily).
- You can then delete the Netlify project (Netlify → Project configuration → Delete project) to stop all Netlify charges.

## Variables
| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes (set by compose) | PostgreSQL. Add `?sslmode=require` for managed DBs (Supabase, Neon…) |
| `AI_API_KEY` | yes | Anthropic key (`AI_PROVIDER=openai` + OpenAI key also supported) |
| `SESSION_SECRET`, `ADMIN_AUTH_SECRET`, `ENCRYPTION_KEY` | recommended | 16+ random chars (auto-generated in DB if absent) |
| `ADMIN_SETUP_TOKEN` | first install | creates the first owner on an empty database |
| `ADMIN_RECOVERY_TOKEN` | optional | one-time account recovery |
| `APP_BASE_URL` | optional | public URL (auto-detected) |
| `TRUST_PROXY` | default `true` | read client IP from `X-Forwarded-For` (keep behind a proxy) |
| `USD_TO_CAD` | optional | dashboard cost conversion (default 1.38) |
| `EMBEDDING_PROVIDER`/`EMBEDDING_API_KEY` | optional | semantic search (pgvector) |
