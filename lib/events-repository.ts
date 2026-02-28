import { EventJob, EventRecord, JobCounters, JobStatus, SpeakerRow } from "@/lib/types";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

type DbEvent = {
  id: string;
  name: string;
  start_url: string;
  created_at: string;
};

type DbJob = {
  id: string;
  event_id: string;
  status: JobStatus;
  urls_discovered: number;
  pages_processed: number;
  sessions_found: number;
  speaker_appearances_found: number;
  unique_speakers_found: number;
  log: unknown;
  error: string | null;
  created_at: string;
};

type DbSpeakerWithOrg = {
  id: string;
  canonical_name: string;
  title: string | null;
  profile_url: string | null;
  organizations: { name: string } | { name: string }[] | null;
};

const EMPTY_COUNTERS: JobCounters = {
  urlsDiscovered: 0,
  pagesProcessed: 0,
  sessionsFound: 0,
  speakerAppearancesFound: 0,
  uniqueSpeakersFound: 0,
};

function nowIso(): string {
  return new Date().toISOString();
}

export function defaultJob(status: JobStatus = "queued"): EventJob {
  return {
    status,
    counters: EMPTY_COUNTERS,
    logLines: ["Waiting for first extraction run."],
    updatedAt: nowIso(),
  };
}

function parseLogLines(rawLog: unknown): string[] {
  if (!Array.isArray(rawLog)) {
    return [];
  }

  return rawLog.map((entry) =>
    typeof entry === "string" ? entry : JSON.stringify(entry),
  );
}

function toEventJob(row: DbJob | null): EventJob {
  if (!row) {
    return defaultJob("queued");
  }

  return {
    status: row.status,
    counters: {
      urlsDiscovered: row.urls_discovered,
      pagesProcessed: row.pages_processed,
      sessionsFound: row.sessions_found,
      speakerAppearancesFound: row.speaker_appearances_found,
      uniqueSpeakersFound: row.unique_speakers_found,
    },
    logLines: parseLogLines(row.log),
    updatedAt: row.created_at,
  };
}

function toSpeakerRows(rows: DbSpeakerWithOrg[]): SpeakerRow[] {
  return rows.map((row) => {
    const orgName = Array.isArray(row.organizations)
      ? row.organizations[0]?.name
      : row.organizations?.name;

    return {
      id: row.id,
      name: row.canonical_name,
      organization: orgName ?? "-",
      title: row.title ?? undefined,
      profileUrl: row.profile_url ?? undefined,
    };
  });
}

function toEventRecord(
  event: DbEvent,
  latestJob: DbJob | null,
  speakers: SpeakerRow[] = [],
): EventRecord {
  return {
    id: event.id,
    name: event.name,
    url: event.start_url,
    createdAt: event.created_at,
    latestJob: toEventJob(latestJob),
    speakers,
  };
}

function getDomain(startUrl: string): string | null {
  try {
    return new URL(startUrl).hostname;
  } catch {
    return null;
  }
}

async function getLatestJobsByEventIds(eventIds: string[]): Promise<Map<string, DbJob>> {
  const byEventId = new Map<string, DbJob>();
  if (eventIds.length === 0) {
    return byEventId;
  }

  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase
    .from("jobs")
    .select(
      "id, event_id, status, urls_discovered, pages_processed, sessions_found, speaker_appearances_found, unique_speakers_found, log, error, created_at",
    )
    .in("event_id", eventIds)
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(error.message);
  }

  for (const row of (data ?? []) as DbJob[]) {
    if (!byEventId.has(row.event_id)) {
      byEventId.set(row.event_id, row);
    }
  }

  return byEventId;
}

export async function listEventsFromDb(): Promise<EventRecord[]> {
  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase
    .from("events")
    .select("id, name, start_url, created_at")
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(error.message);
  }

  const events = (data ?? []) as DbEvent[];
  const latestJobs = await getLatestJobsByEventIds(events.map((event) => event.id));

  return events.map((event) => toEventRecord(event, latestJobs.get(event.id) ?? null));
}

export async function getEventByIdFromDb(id: string): Promise<EventRecord | null> {
  const supabase = getSupabaseBrowserClient();
  const { data: eventData, error: eventError } = await supabase
    .from("events")
    .select("id, name, start_url, created_at")
    .eq("id", id)
    .maybeSingle();

  if (eventError) {
    throw new Error(eventError.message);
  }

  if (!eventData) {
    return null;
  }

  const { data: latestJobData, error: latestJobError } = await supabase
    .from("jobs")
    .select(
      "id, event_id, status, urls_discovered, pages_processed, sessions_found, speaker_appearances_found, unique_speakers_found, log, error, created_at",
    )
    .eq("event_id", id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (latestJobError) {
    throw new Error(latestJobError.message);
  }

  const { data: speakerRows, error: speakersError } = await supabase
    .from("speakers")
    .select("id, canonical_name, title, profile_url, organizations(name)")
    .eq("event_id", id)
    .order("canonical_name", { ascending: true });

  if (speakersError) {
    throw new Error(speakersError.message);
  }

  return toEventRecord(
    eventData as DbEvent,
    (latestJobData as DbJob | null) ?? null,
    toSpeakerRows((speakerRows ?? []) as DbSpeakerWithOrg[]),
  );
}

export async function createEventInDb(name: string, startUrl: string): Promise<EventRecord> {
  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase
    .from("events")
    .insert({
      name: name.trim(),
      start_url: startUrl.trim(),
      domain: getDomain(startUrl),
    })
    .select("id, name, start_url, created_at")
    .single();

  if (error) {
    throw new Error(error.message);
  }

  const createdEvent = data as DbEvent;
  await appendJobToEventInDb(createdEvent.id, defaultJob("queued"));
  const completeRecord = await getEventByIdFromDb(createdEvent.id);

  if (!completeRecord) {
    throw new Error("Failed to load created event.");
  }

  return completeRecord;
}

export async function updateEventBasicsInDb(
  id: string,
  updates: { name: string; url: string },
): Promise<EventRecord | null> {
  const supabase = getSupabaseBrowserClient();
  const { error } = await supabase
    .from("events")
    .update({
      name: updates.name.trim(),
      start_url: updates.url.trim(),
      domain: getDomain(updates.url),
    })
    .eq("id", id);

  if (error) {
    throw new Error(error.message);
  }

  return getEventByIdFromDb(id);
}

export async function deleteEventByIdFromDb(id: string): Promise<void> {
  const supabase = getSupabaseBrowserClient();
  const { error } = await supabase.from("events").delete().eq("id", id);
  if (error) {
    throw new Error(error.message);
  }
}

export async function appendJobToEventInDb(
  eventId: string,
  job: EventJob,
): Promise<void> {
  const supabase = getSupabaseBrowserClient();
  const { error } = await supabase.from("jobs").insert({
    event_id: eventId,
    status: job.status,
    urls_discovered: job.counters.urlsDiscovered,
    pages_processed: job.counters.pagesProcessed,
    sessions_found: job.counters.sessionsFound,
    speaker_appearances_found: job.counters.speakerAppearancesFound,
    unique_speakers_found: job.counters.uniqueSpeakersFound,
    log: job.logLines,
  });

  if (error) {
    throw new Error(error.message);
  }
}
