-- Conference Speaker Extractor (Phase 1) schema

create extension if not exists pgcrypto;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'job_status') then
    create type job_status as enum (
      'queued',
      'crawling',
      'extracting',
      'saving',
      'complete',
      'failed'
    );
  end if;
end
$$;

create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  start_url text not null,
  domain text,
  created_at timestamptz not null default now()
);

create table if not exists jobs (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  status job_status not null default 'queued',
  total_urls_mapped integer not null default 0,
  urls_discovered integer not null default 0,
  pages_processed integer not null default 0,
  sessions_found integer not null default 0,
  speaker_appearances_found integer not null default 0,
  unique_speakers_found integer not null default 0,
  log jsonb not null default '[]'::jsonb,
  mapped_urls jsonb not null default '[]'::jsonb,
  filtered_urls jsonb not null default '[]'::jsonb,
  processed_urls jsonb not null default '[]'::jsonb,
  error text,
  created_at timestamptz not null default now()
);

alter table jobs add column if not exists total_urls_mapped integer not null default 0;
alter table jobs add column if not exists mapped_urls jsonb not null default '[]'::jsonb;
alter table jobs add column if not exists filtered_urls jsonb not null default '[]'::jsonb;
alter table jobs add column if not exists processed_urls jsonb not null default '[]'::jsonb;

create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  title text not null,
  url text not null,
  created_at timestamptz not null default now(),
  unique (event_id, url)
);

create table if not exists organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  normalized_name text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists speakers (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  canonical_name text not null,
  normalized_name text not null,
  organization_id uuid references organizations(id) on delete set null,
  title text,
  profile_url text,
  created_at timestamptz not null default now(),
  unique (event_id, profile_url)
);

create table if not exists session_speakers (
  session_id uuid not null references sessions(id) on delete cascade,
  speaker_id uuid not null references speakers(id) on delete cascade,
  role text,
  created_at timestamptz not null default now(),
  primary key (session_id, speaker_id)
);

create table if not exists job_page_scrapes (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references jobs(id) on delete cascade,
  event_id uuid not null references events(id) on delete cascade,
  url text not null,
  success boolean not null default false,
  raw_payload jsonb,
  extracted_json jsonb,
  metadata jsonb,
  markdown text,
  html text,
  error text,
  created_at timestamptz not null default now()
);

create index if not exists events_created_at_desc_idx on events (created_at desc);
create index if not exists jobs_event_created_idx on jobs (event_id, created_at desc);
create index if not exists sessions_event_id_idx on sessions (event_id);
create index if not exists speakers_event_id_idx on speakers (event_id);
create index if not exists speakers_organization_id_idx on speakers (organization_id);
create index if not exists organizations_normalized_name_idx on organizations (normalized_name);
create index if not exists job_page_scrapes_job_id_idx on job_page_scrapes (job_id);
create index if not exists job_page_scrapes_event_created_idx on job_page_scrapes (event_id, created_at desc);
