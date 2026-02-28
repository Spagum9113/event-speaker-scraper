# Project Context: Conference Speaker Extractor (Phase 1)

## Goal
Build a simple web app where I can enter:
- **Event name** (so I can find it later in history)
- **Event website URL** (conference site like RSA)

The app should crawl the conference website and extract a structured, **deduplicated list of publicly listed speakers across all sessions**, store it in **Supabase**, let me **search/filter** the results, and let me **export to CSV**.

Phase 1 focuses on **speakers** (and moderators/panelists if listed). Not general attendees.

---

## Tech Stack
- **Frontend/Backend:** Next.js (TypeScript)
- **Hosting:** Vercel
- **Database/Auth/Storage:** Supabase (Postgres; Storage optional for CSV exports)
- **Crawling/Scraping:** Firecrawl
- **Language:** TypeScript (end-to-end)

---

## User Flow
1. I go to the app and click **New Event**
2. I enter:
   - Event Name
   - Website URL
3. I click **Run Extraction**
4. I see progress (job status + basic counts)
5. When complete, I can:
   - view speakers in a table
   - search + filter
   - export CSV
6. Later, I can return to the app and browse **past events** by name and open any event to see its saved results.

---

## Pages / Screens
### 1) Events List (History)
- Shows all previously created events
- Each row shows:
  - event name
  - event URL
  - created date
  - latest job status (complete/failed/in progress)
  - counts (optional: # speakers, # sessions)
- Clicking an event opens the Event Detail page

### 2) New Event
- Inputs:
  - event name (required)
  - event URL (required)
- Button: **Run Extraction**

### 3) Event Detail
Shows:
- event name + URL
- latest job status (queued/crawling/extracting/saving/complete/failed)
- progress counts:
  - URLs discovered
  - pages processed
  - sessions found
  - speaker appearances found
  - unique speakers created
- small log output (last ~20 messages)

Sections/tabs:
- **Speakers table** (default)
- **Sessions table** (optional but helpful)

Actions:
- **Download CSV**

---

## Data Model (Supabase)
Minimum tables:

### `events`
- `id` (uuid)
- `name` (text, required)
- `start_url` (text, required)
- `domain` (text)
- `created_at` (timestamp)

### `jobs`
Represents one extraction run for an event.
- `id` (uuid)
- `event_id` (fk to events)
- `status` (queued/crawling/extracting/saving/complete/failed)
- counts:
  - `urls_discovered`
  - `pages_processed`
  - `sessions_found`
  - `speaker_appearances_found`
  - `unique_speakers_found`
- `log` (text or json array)
- `error` (text nullable)
- `created_at` (timestamp)

### `sessions`
- `id` (uuid)
- `event_id` (fk)
- `title` (text)
- `url` (text)
- `created_at`

### `organizations`
- `id` (uuid)
- `name` (text)
- `normalized_name` (text)

### `speakers`
- `id` (uuid)
- `event_id` (fk)
- `canonical_name` (text)
- `normalized_name` (text)
- `organization_id` (fk nullable)
- `title` (text nullable)
- `profile_url` (text nullable)
- `created_at`

### `session_speakers`
Join table so one speaker can appear in many sessions.
- `session_id` (fk)
- `speaker_id` (fk)
- `role` (text nullable)
- unique constraint: `(session_id, speaker_id)`

Notes:
- Dedupe speakers within an event:
  - if `profile_url` exists: unique by `(event_id, profile_url)`
  - else unique by `(event_id, normalized_name + normalized_org)`

---

## Extraction (Phase 1)

### Crawl Strategy (Firecrawl)
Use Firecrawl to handle crawling and fetching pages.

Preferred approach:
1. **Firecrawl Map** the domain to list URLs
2. Filter to likely session pages (agenda/schedule/session paths/keywords)
3. **Firecrawl Scrape** those session pages
4. Extract:
   - session title + url
   - speaker name
   - speaker organization (if visible)
   - speaker profile url (if present)

Traceability:
- Each extracted speaker appearance should always be linked back to `session_url` (source page).

### Guardrails
- Stay within the same domain
- Skip assets (images, css/js, pdf)
- Max pages per run (config)
- Per-page timeout

---

## Search + Filter (Phase 1)
Speakers table supports:
- Search: case-insensitive partial match on speaker name + organization (ILIKE)
- Filter: organization dropdown
- Clicking a speaker shows the sessions they appear in

---

## CSV Export (Phase 1)
Export unique speakers for an event with columns:
- name
- organization
- title (optional)
- profile_url
- event_name

The CSV should match what I see in the UI.

---

## Non-Goals (Phase 1)
- Full attendee extraction (non-speaker attendees)
- Automated LinkedIn scraping
- Automated email finding
- ICP scoring automation
- Multi-user/team features

---

## Implementation Notes
- Next.js (TypeScript) app deployed on Vercel
- Firecrawl is called from server-side routes/actions (keep API key server-side)
- Supabase is the source of truth; UI reads from Supabase
- Use `jobs` table for progress tracking; UI polls job status while extraction runs
- Prefer idempotent upserts to avoid duplicates on re-runs