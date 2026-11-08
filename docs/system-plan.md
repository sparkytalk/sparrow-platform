# Sparrow system plan: one core, many doors (parked, Nov 4 2026)

Preet, Pros, Crew and Admin are windows onto ONE Supabase database, never separate systems.

## Three layers
1. Doors (where jobs come from): Preet on WhatsApp now; later booking links, website widget, Google "Book" button, contractor-branded WhatsApp assistant, lead inbox (HomeStars/Thumbtack/Google LSA), job sharing between pros, PM/realtor portals, partner API.
2. Core: customers, jobs, quotes, calendar, invoices, payments, contractors, crew. Every job exists once.
3. Workspaces: Admin (owner of Sparrow), Pros (contractor owner/office), Crew (workers; belong to a contractor, see only assigned jobs on the day).

## Every job carries
- source (which door)
- customer owner (Sparrow or contractor)
- money rule (10% Sparrow jobs, none on own jobs, subscription tiers later)
All doors go through one "create job" step with the same checks (area, duplicates, prices, free days).

## Security
- One login, roles: admin / contractor owner / office / crew. Crew never see prices, other customers or earnings.
- Customer ownership enforced by database rules.
- Lockbox codes shown only on the job day; phone numbers hidden from crew where not needed.
- Secrets only in database/Supabase settings; rotate when someone leaves.
- Activity log, daily backups, test data apart, remove crew access immediately on leaving.

## Open decisions
1. Fee per source (own link free? job sharing 10%?)
2. Who owns a Sparrow customer who rebooks the same contractor directly?
3. Crew as a view inside Pros with the same login (done: crew live inside Pros since Nov 2026).

## Order
1. Job day + payments. 2. Three labels on every job; own jobs become real jobs. 3. Crew roles. 4. Booking link.
