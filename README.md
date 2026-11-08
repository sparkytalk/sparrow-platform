# Sparrow Platform

Sparrow Labs Inc. (BC) — office-as-a-service for solo trades and service businesses.
One Supabase database (project `cskcmpayxaqyqlqhepup`, "Sparrow Platform") with several "doors" and "workspaces" on top. See [docs/system-plan.md](docs/system-plan.md).

## What lives where

| Part | Live at | Source |
|---|---|---|
| Pros app (business owners **and** their crew, one login) | https://pros.sparrowlabs.ca | `web/pros/index.html` |
| Admin dashboard (Sparrow staff) | https://admin.sparrowlabs.ca | `web/admin/index.html` |
| Customer quote approval | https://sparrowlabs.ca/quote/ | `web/quote/index.html` |
| Customer date picker | https://sparrowlabs.ca/dates/ | `web/dates/index.html` |
| Customer invoice page | https://sparrowlabs.ca/invoice/ | `web/invoice/index.html` |
| Old crew address (forwards to Pros) | https://crew.sparrowlabs.ca | `web/crew-redirect/.htaccess` |
| Server code (Supabase Edge Functions) | Supabase → Edge Functions | `supabase/functions/` |
| Database (tables, rules, functions) | Supabase → Database | `supabase/schema/` (from the backup job) and `supabase/sql/` |
| Preet (WhatsApp booking agent) | ElevenLabs | prompt and tools live in ElevenLabs |
| Crew Assistant (chat in the Pros app) | ElevenLabs agent `agent_3701m6e5k2vafw6a0jce9sfwhs0n` | tools call `crew-assistant-tools` |

Each web page is a single self-contained HTML file (no build step). Hosting is Hostinger (`public_html/pros/`, `public_html/admin/`, `public_html/quote/` …).

## Edge functions

| Function | What it does |
|---|---|
| `preet-api` | Tools Preet calls during WhatsApp chats (prices, availability, create requests) |
| `elevenlabs-webhook` | Receives ElevenLabs post-call events |
| `sync-chats` | Every 5 min, copies finished Preet chats into `conversations` / `messages` |
| `send-outbox` | Sends queued WhatsApp messages |
| `contractor-auth` | Contractor and crew invite links: check, set password, or link a Google sign-in |
| `pros-mail` | Emails from no-reply@sparrowlabs.ca: sign-in links, crew invites, contractor invites |
| `crew-assistant` | Starts a Crew Assistant chat (session pass, memory, signed ElevenLabs link) |
| `crew-assistant-tools` | Actions the Crew Assistant can take (clock in/out, reports, problems, stock, time off) |
| `ops-setup` | Internal deploy helper |

## Secrets (never in this repo)

Kept in Supabase → Edge Functions → Secrets, or in the `settings` / `ops_kv` tables:
`ELEVENLABS_API_KEY`, `SMTP_PASSWORD`, WhatsApp/Meta tokens, Square token, deploy credentials.
The key inside the web pages (`sb_publishable_…`) is the public key; access is enforced by database rules (RLS + security-definer functions).

## Backups

`.github/workflows/supabase-backup.yml` runs every night and commits the current edge functions and database schema into `supabase/`. It needs two repository secrets (Settings → Secrets and variables → Actions):
- `SUPABASE_ACCESS_TOKEN` — from https://supabase.com/dashboard/account/tokens
- `SUPABASE_DB_PASSWORD` — the database password (Supabase → Project Settings → Database)

## Changing things

Edit the file here, then deploy it to the same path on Hostinger (or ask Claude to). Keep this repo and the live site in step.
