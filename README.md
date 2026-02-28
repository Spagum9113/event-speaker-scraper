# Conference Speaker Extractor

Next.js app for creating events, tracking extraction job progress, and viewing extracted speakers.

This project uses Supabase as the source of truth for:
- `events`
- `jobs` (latest status/log/counters)
- `speakers` and `organizations`

## Prerequisites

- Node.js 20+
- A Supabase project

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create local environment file:

```bash
cp .env.example .env.local
```

3. Fill in `.env.local`:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY` (reserved for server-side operations)
   - `FIRECRAWL_API_KEY` (reserved for extraction pipeline work)

4. Apply database schema in Supabase SQL Editor:
   - `supabase/schema.sql`

## Run Locally

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Current Scope

- No auth/RLS in this pass (single-user mode).
- Event CRUD reads/writes Supabase.
- Mock extraction flow writes job snapshots to the `jobs` table.
- Event detail reads latest job and speaker rows from Supabase.
