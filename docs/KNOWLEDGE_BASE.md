# Knowledge base — verified facts, assumptions and conflicts

Research date: 2026-11-23. Sources: the 28 public pages listed in `https://utilmo.com/page-sitemap.xml` (FR + EN) and
53 blog posts from `post-sitemap.xml`. robots.txt allows all crawling (`User-agent: * / Allow: /`).

## How knowledge enters the assistant

1. **Curated seed** (`knowledge/seed/utilmo/*.md`) — fact sheets written from the official pages, each with its source URLs.
   Imported automatically on first use (priority 3, *not yet marked verified*: an Utilmo admin should review and verify them).
2. **Website crawl** (`server/knowledge.ts`) — triggered automatically after the seed import and on demand from the admin:
   robots.txt → sitemaps → page fetch (polite delay) → main-content extraction → site-wide boilerplate removal →
   versioned documents (URL + fetch timestamp + content hash) → heading-aware chunks → full-text index (+ embeddings if configured).
   Blog posts are stored as priority 4 "general context"; legal pages are down-weighted.
3. **Admin content** — FAQs, official answers, corrections, pricing, PDFs/TXT/MD uploads (priority 1–2, can be marked verified).
   Manually edited documents are never overwritten by a re-crawl.

Source priority used in retrieval and in the prompt: **1 approved internal → 2 verified documentation → 3 official website → 4 general context**.

## Facts found on the official website (status: published, pending Utilmo verification)

| Topic | Published information | Page |
|---|---|---|
| Company | All-in-one real estate platform; "1000+ brokers in Quebec"; developed in Quebec; owned by Marketing Websites Inc. (Montreal, founded 2015) | /fr/a-propos/ |
| Contact | 514-360-2187 (business hours), support@utilmo.ca, 3737 Crémazie-Est #401, Montréal | /fr/contact/ |
| Login / app | app.utilmo.com/login; "Utilmo App" on App Store and Google Play | trial page, footer |
| CRM price | **$79.99/month**, no setup fees, website not included, "no contracts" | /crm-leads/ |
| CRM features | contacts, pipelines, tasks, reminders, SMS+e-mail notification on new lead, calls/SMS/e-mail from Utilmo, dialer & call recording, landing pages, automated e-mail/SMS campaigns, action plans, customizable fields/workflows, reports, mobile, weekly training | /crm-leads/ |
| Integrations | Centris or CREA (proprietary, all brokers in Canada); Google Calendar, Office 365, Mailchimp; Gmail/Google Calendar connection; ChatGPT via an MCP service using an Utilmo API token (privacy policy) | /crm-leads/, privacy policy |
| Websites | Essential **$1,000 + $129.99/month** (hosting + MLS integration, CRM included, max 10 pages); Pro **$2,000**; Elite **$3,500** (custom pages + logo); Centris/CREA on all sites | /real-estate-website-design/ |
| Add-ons | Auto-posting to Facebook, Google Ads, Facebook/Instagram ads, custom design, custom domains, Google Workspace, Microsoft 365, pro e-mails, SEO, PPC, social media management — **no prices published** | /addons/ |
| AI & automation | Qualify leads, schedule appointments, automated workflows, e-mail/SMS follow-ups — plan inclusion not specified | home |
| White label | Resellable branded CRM, desktop app, website, PMS — pricing on request | /white-label/ |
| Demo | Free 1-on-1 demo: https://calendly.com/utilmocrm/30-minute-meeting-clone | /schedule-demo/ |

## Conflicts detected (seeded as open conflicts — the assistant will not pick a value)

1. **Free-trial length** — CRM page and "30-day free trial" page say 30 days; "Schedule demo" and "Onboarding" pages show a "14-Day Free Trial" button.
2. **Essential website templates** — pricing page "Choice of 17 Templates" vs trial page "Choice of 12 Templates" (+ "Fixed site map"; Elite "3 fully custom pages").
3. **"Save $500 today only" promo page** — time-limited, validity unknown; must not be promised.

Resolve them in **Admin → Base de connaissances → Conflits**: add the official value as a priority-1 verified document, then mark the conflict resolved.

## Not found publicly (the assistant says it must be confirmed)

- Prices for advertising/SEO/social add-ons, white label, Pro/Elite monthly fees, budgets, lead volumes, guarantees or exclusivity.
- Step-by-step help documentation (adding contacts, pipelines, imports, SMS automations, connecting a website, subscription/account settings).
  The support collection explicitly tells the assistant not to invent procedures and to open a support request instead.
- A documented Utilmo CRM API (endpoints, auth) — required before a native "Utilmo CRM" sync adapter can be built.
- Customer reviews, SLAs, data-hosting region of the Utilmo CRM itself.

## Reference site (leadsimmobilier.ca)

The page is a client-rendered app; its markup could be fetched but the chat content is injected at runtime, so the
interaction pattern was implemented from the written brief (large inline chat in a hero section + floating bubble),
with Utilmo's own branding. No code or branding was copied. No screenshot was attached to the request.
