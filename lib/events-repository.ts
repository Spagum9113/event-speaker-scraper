import { SupabaseClient } from "@supabase/supabase-js";
import { EventJob, EventRecord, JobCounters, JobStatus, SessionRow, SpeakerRow } from "@/lib/types";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import type {
  SessionExtractedRow,
  SpeakerAppearanceExtractedRow,
} from "@/lib/firecrawl";

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
  total_urls_mapped: number;
  urls_discovered: number;
  pages_processed: number;
  sessions_found: number;
  speaker_appearances_found: number;
  unique_speakers_found: number;
  log: unknown;
  mapped_urls: unknown;
  filtered_urls: unknown;
  processed_urls: unknown;
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

type DbSession = {
  id: string;
  url: string;
  title: string;
};

type DbOrganization = {
  id: string;
  name: string;
  normalized_name: string;
};

type DbSpeaker = {
  id: string;
  normalized_name: string;
  profile_url: string | null;
  organization_id: string | null;
};

type DbSpeakerWithNormalizedOrg = DbSpeaker & {
  organizations:
    | { normalized_name: string }
    | { normalized_name: string }[]
    | null;
};

const EMPTY_COUNTERS: JobCounters = {
  totalUrlsMapped: 0,
  urlsDiscovered: 0,
  pagesProcessed: 0,
  sessionsFound: 0,
  speakerAppearancesFound: 0,
  uniqueSpeakersFound: 0,
};

export type JobUpdatePatch = {
  status?: JobStatus;
  counters?: Partial<JobCounters>;
  logLines?: string[];
  mappedUrls?: string[];
  filteredUrls?: string[];
  processedUrls?: string[];
  error?: string | null;
};

function nowIso(): string {
  return new Date().toISOString();
}

function getSupabaseClient(client?: SupabaseClient): SupabaseClient {
  return client ?? getSupabaseBrowserClient();
}

export function defaultJob(status: JobStatus = "queued"): EventJob {
  return {
    status,
    counters: EMPTY_COUNTERS,
    logLines: ["Waiting for first extraction run."],
    mappedUrls: [],
    filteredUrls: [],
    processedUrls: [],
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

function parseUrlList(rawList: unknown): string[] {
  if (!Array.isArray(rawList)) {
    return [];
  }

  return rawList.filter((entry): entry is string => typeof entry === "string");
}

function toEventJob(row: DbJob | null): EventJob {
  if (!row) {
    return defaultJob("queued");
  }

  return {
    status: row.status,
    counters: {
      totalUrlsMapped: row.total_urls_mapped,
      urlsDiscovered: row.urls_discovered,
      pagesProcessed: row.pages_processed,
      sessionsFound: row.sessions_found,
      speakerAppearancesFound: row.speaker_appearances_found,
      uniqueSpeakersFound: row.unique_speakers_found,
    },
    logLines: parseLogLines(row.log),
    mappedUrls: parseUrlList(row.mapped_urls),
    filteredUrls: parseUrlList(row.filtered_urls),
    processedUrls: parseUrlList(row.processed_urls),
    updatedAt: row.created_at,
  };
}

function toSpeakerRows(rows: DbSpeakerWithOrg[]): SpeakerRow[] {
  const dedupedByName = new Map<
    string,
    {
      score: number;
      speaker: SpeakerRow;
    }
  >();

  for (const row of rows) {
    const orgName = Array.isArray(row.organizations)
      ? row.organizations[0]?.name
      : row.organizations?.name;
    const speaker: SpeakerRow = {
      id: row.id,
      name: row.canonical_name,
      organization: orgName ?? "-",
      title: row.title ?? undefined,
      profileUrl: row.profile_url ?? undefined,
    };

    // Step 2: Collapse duplicate speaker names from multiple page/profile variants.
    const normalizedName = normalizeIdentityValue(speaker.name);
    const key = normalizedName || row.id;
    const score =
      (speaker.organization !== "-" ? 1 : 0) +
      (speaker.title ? 1 : 0) +
      (speaker.profileUrl ? 1 : 0);

    const existing = dedupedByName.get(key);
    if (!existing || score > existing.score) {
      dedupedByName.set(key, { score, speaker });
    }
  }

  return Array.from(dedupedByName.values()).map((entry) => entry.speaker);
}

function toEventRecord(
  event: DbEvent,
  latestJob: DbJob | null,
  sessions: SessionRow[] = [],
  speakers: SpeakerRow[] = [],
): EventRecord {
  return {
    id: event.id,
    name: event.name,
    url: event.start_url,
    createdAt: event.created_at,
    latestJob: toEventJob(latestJob),
    sessions,
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

function normalizeTextValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeIdentityValue(value: string | undefined): string {
  return (normalizeTextValue(value) ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeUrlValue(value: string | undefined): string | undefined {
  const trimmed = normalizeTextValue(value);
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = new URL(trimmed);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return undefined;
  }
}

async function getLatestJobsByEventIds(eventIds: string[]): Promise<Map<string, DbJob>> {
  const byEventId = new Map<string, DbJob>();
  if (eventIds.length === 0) {
    return byEventId;
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("jobs")
    .select(
      "id, event_id, status, total_urls_mapped, urls_discovered, pages_processed, sessions_found, speaker_appearances_found, unique_speakers_found, log, mapped_urls, filtered_urls, processed_urls, error, created_at",
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
  const supabase = getSupabaseClient();
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
  const supabase = getSupabaseClient();
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
      "id, event_id, status, total_urls_mapped, urls_discovered, pages_processed, sessions_found, speaker_appearances_found, unique_speakers_found, log, mapped_urls, filtered_urls, processed_urls, error, created_at",
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

  const { data: sessionRows, error: sessionsError } = await supabase
    .from("sessions")
    .select("id, title, url")
    .eq("event_id", id)
    .order("title", { ascending: true });

  if (sessionsError) {
    throw new Error(sessionsError.message);
  }

  const sessions: SessionRow[] = ((sessionRows ?? []) as DbSession[]).map((row) => ({
    id: row.id,
    title: row.title,
    url: row.url,
  }));

  return toEventRecord(
    eventData as DbEvent,
    (latestJobData as DbJob | null) ?? null,
    sessions,
    toSpeakerRows((speakerRows ?? []) as DbSpeakerWithOrg[]),
  );
}

export async function createEventInDb(name: string, startUrl: string): Promise<EventRecord> {
  const supabase = getSupabaseClient();
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
  const supabase = getSupabaseClient();
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
  const supabase = getSupabaseClient();
  const { error } = await supabase.from("events").delete().eq("id", id);
  if (error) {
    throw new Error(error.message);
  }
}

export async function deleteEventsByIdsFromDb(ids: string[]): Promise<void> {
  if (ids.length === 0) {
    return;
  }

  const supabase = getSupabaseClient();
  const { error } = await supabase.from("events").delete().in("id", ids);
  if (error) {
    throw new Error(error.message);
  }
}

export async function appendJobToEventInDb(
  eventId: string,
  job: EventJob,
  client?: SupabaseClient,
): Promise<void> {
  await createJobForEventInDb(eventId, job, client);
}

export async function createJobForEventInDb(
  eventId: string,
  job: EventJob,
  client?: SupabaseClient,
): Promise<string> {
  const supabase = getSupabaseClient(client);
  const { data, error } = await supabase
    .from("jobs")
    .insert({
    event_id: eventId,
    status: job.status,
    total_urls_mapped: job.counters.totalUrlsMapped,
    urls_discovered: job.counters.urlsDiscovered,
    pages_processed: job.counters.pagesProcessed,
    sessions_found: job.counters.sessionsFound,
    speaker_appearances_found: job.counters.speakerAppearancesFound,
    unique_speakers_found: job.counters.uniqueSpeakersFound,
    log: job.logLines,
    mapped_urls: job.mappedUrls,
    filtered_urls: job.filteredUrls,
    processed_urls: job.processedUrls,
    })
    .select("id")
    .single();

  if (error) {
    throw new Error(error.message);
  }

  return (data as { id: string }).id;
}

export async function updateJobByIdInDb(
  jobId: string,
  patch: JobUpdatePatch,
  client?: SupabaseClient,
): Promise<void> {
  const supabase = getSupabaseClient(client);
  const updatePayload: Record<string, unknown> = {};

  if (patch.status !== undefined) {
    updatePayload.status = patch.status;
  }
  if (patch.counters?.totalUrlsMapped !== undefined) {
    updatePayload.total_urls_mapped = patch.counters.totalUrlsMapped;
  }
  if (patch.counters?.urlsDiscovered !== undefined) {
    updatePayload.urls_discovered = patch.counters.urlsDiscovered;
  }
  if (patch.counters?.pagesProcessed !== undefined) {
    updatePayload.pages_processed = patch.counters.pagesProcessed;
  }
  if (patch.counters?.sessionsFound !== undefined) {
    updatePayload.sessions_found = patch.counters.sessionsFound;
  }
  if (patch.counters?.speakerAppearancesFound !== undefined) {
    updatePayload.speaker_appearances_found = patch.counters.speakerAppearancesFound;
  }
  if (patch.counters?.uniqueSpeakersFound !== undefined) {
    updatePayload.unique_speakers_found = patch.counters.uniqueSpeakersFound;
  }
  if (patch.logLines !== undefined) {
    updatePayload.log = patch.logLines.slice(-20);
  }
  if (patch.mappedUrls !== undefined) {
    updatePayload.mapped_urls = patch.mappedUrls;
  }
  if (patch.filteredUrls !== undefined) {
    updatePayload.filtered_urls = patch.filteredUrls;
  }
  if (patch.processedUrls !== undefined) {
    updatePayload.processed_urls = patch.processedUrls;
  }
  if (patch.error !== undefined) {
    updatePayload.error = patch.error;
  }

  if (Object.keys(updatePayload).length === 0) {
    return;
  }

  const { error } = await supabase.from("jobs").update(updatePayload).eq("id", jobId);
  if (error) {
    throw new Error(error.message);
  }
}

export async function persistExtractedConferenceDataInDb(
  eventId: string,
  sessions: SessionExtractedRow[],
  speakerAppearances: SpeakerAppearanceExtractedRow[],
  client?: SupabaseClient,
): Promise<{
  sessionsFound: number;
  speakerAppearancesFound: number;
  uniqueSpeakersFound: number;
}> {
  const supabase = getSupabaseClient(client);

  const normalizedSessionsMap = new Map<string, SessionExtractedRow>();
  for (const session of sessions) {
    const normalizedUrl = normalizeUrlValue(session.url);
    const normalizedTitle = normalizeTextValue(session.title);
    if (!normalizedUrl || !normalizedTitle) {
      continue;
    }
    if (!normalizedSessionsMap.has(normalizedUrl)) {
      normalizedSessionsMap.set(normalizedUrl, {
        url: normalizedUrl,
        title: normalizedTitle,
      });
    }
  }
  const normalizedSessions = Array.from(normalizedSessionsMap.values());

  let sessionRows: DbSession[] = [];
  if (normalizedSessions.length > 0) {
    const { data, error } = await supabase
      .from("sessions")
      .upsert(
        normalizedSessions.map((session) => ({
          event_id: eventId,
          title: session.title,
          url: session.url,
        })),
        { onConflict: "event_id,url" },
      )
      .select("id, url, title");

    if (error) {
      throw new Error(error.message);
    }
    sessionRows = (data ?? []) as DbSession[];
  }

  const sessionIdByUrl = new Map(sessionRows.map((row) => [row.url, row.id]));

  const normalizedOrgByName = new Map<string, string>();
  for (const appearance of speakerAppearances) {
    const normalizedOrg = normalizeIdentityValue(appearance.organization);
    const rawOrg = normalizeTextValue(appearance.organization);
    if (normalizedOrg && rawOrg && !normalizedOrgByName.has(normalizedOrg)) {
      normalizedOrgByName.set(normalizedOrg, rawOrg);
    }
  }

  const orgKeys = Array.from(normalizedOrgByName.keys());
  const organizationsByNormalized = new Map<string, DbOrganization>();
  if (orgKeys.length > 0) {
    const { data: existingOrgs, error: existingOrgsError } = await supabase
      .from("organizations")
      .select("id, name, normalized_name")
      .in("normalized_name", orgKeys);
    if (existingOrgsError) {
      throw new Error(existingOrgsError.message);
    }
    for (const org of (existingOrgs ?? []) as DbOrganization[]) {
      organizationsByNormalized.set(org.normalized_name, org);
    }

    const missingOrgRows = orgKeys
      .filter((key) => !organizationsByNormalized.has(key))
      .map((key) => ({
        name: normalizedOrgByName.get(key) ?? key,
        normalized_name: key,
      }));

    if (missingOrgRows.length > 0) {
      const { data: insertedOrgs, error: insertedOrgsError } = await supabase
        .from("organizations")
        .upsert(missingOrgRows, { onConflict: "normalized_name" })
        .select("id, name, normalized_name");
      if (insertedOrgsError) {
        throw new Error(insertedOrgsError.message);
      }
      for (const org of (insertedOrgs ?? []) as DbOrganization[]) {
        organizationsByNormalized.set(org.normalized_name, org);
      }
    }
  }

  const { data: existingSpeakers, error: existingSpeakersError } = await supabase
    .from("speakers")
    .select("id, normalized_name, profile_url, organization_id, organizations(normalized_name)")
    .eq("event_id", eventId);
  if (existingSpeakersError) {
    throw new Error(existingSpeakersError.message);
  }

  const byProfileUrl = new Map<string, DbSpeaker>();
  const byNameOrg = new Map<string, DbSpeaker>();
  for (const speaker of (existingSpeakers ?? []) as DbSpeakerWithNormalizedOrg[]) {
    if (speaker.profile_url) {
      byProfileUrl.set(speaker.profile_url, speaker);
    }
    const orgNormalized = Array.isArray(speaker.organizations)
      ? speaker.organizations[0]?.normalized_name
      : speaker.organizations?.normalized_name;
    const fallbackKey = `${speaker.normalized_name}::${orgNormalized ?? ""}`;
    byNameOrg.set(fallbackKey, speaker);
  }

  const speakerIdByIdentity = new Map<string, string>();
  const rowsForSessionLink: Array<{ sessionId: string; speakerId: string; role?: string }> = [];

  for (const appearance of speakerAppearances) {
    const normalizedSessionUrl = normalizeUrlValue(appearance.sessionUrl);
    if (!normalizedSessionUrl) {
      continue;
    }

    const sessionId = sessionIdByUrl.get(normalizedSessionUrl);
    if (!sessionId) {
      continue;
    }

    const canonicalName = normalizeTextValue(appearance.name);
    const normalizedName = normalizeIdentityValue(appearance.name);
    if (!canonicalName || !normalizedName) {
      continue;
    }

    const orgNormalized = normalizeIdentityValue(appearance.organization);
    const organizationId =
      orgNormalized && organizationsByNormalized.has(orgNormalized)
        ? organizationsByNormalized.get(orgNormalized)?.id ?? null
        : null;
    const normalizedProfileUrl = normalizeUrlValue(appearance.profileUrl);

    const lookupKey = normalizedProfileUrl
      ? `profile::${normalizedProfileUrl}`
      : `nameorg::${normalizedName}::${orgNormalized}`;

    let speakerId = speakerIdByIdentity.get(lookupKey);
    if (!speakerId) {
      const matchedExisting = normalizedProfileUrl
        ? byProfileUrl.get(normalizedProfileUrl)
        : byNameOrg.get(`${normalizedName}::${orgNormalized}`);

      if (matchedExisting) {
        speakerId = matchedExisting.id;
      } else {
        const { data: insertedSpeaker, error: insertedSpeakerError } = await supabase
          .from("speakers")
          .insert({
            event_id: eventId,
            canonical_name: canonicalName,
            normalized_name: normalizedName,
            organization_id: organizationId,
            title: normalizeTextValue(appearance.title) ?? null,
            profile_url: normalizedProfileUrl ?? null,
          })
          .select("id, normalized_name, profile_url, organization_id")
          .single();
        if (insertedSpeakerError) {
          throw new Error(insertedSpeakerError.message);
        }
        const speaker = insertedSpeaker as DbSpeaker;
        speakerId = speaker.id;
        if (speaker.profile_url) {
          byProfileUrl.set(speaker.profile_url, speaker);
        }
        byNameOrg.set(`${speaker.normalized_name}::${orgNormalized}`, speaker);
      }
      speakerIdByIdentity.set(lookupKey, speakerId);
    }

    rowsForSessionLink.push({
      sessionId,
      speakerId,
      role: normalizeTextValue(appearance.role),
    });
  }

  const uniqueLinks = new Map<string, { session_id: string; speaker_id: string; role: string | null }>();
  for (const row of rowsForSessionLink) {
    const key = `${row.sessionId}::${row.speakerId}`;
    if (!uniqueLinks.has(key)) {
      uniqueLinks.set(key, {
        session_id: row.sessionId,
        speaker_id: row.speakerId,
        role: row.role ?? null,
      });
    }
  }

  if (uniqueLinks.size > 0) {
    const { error: sessionSpeakersError } = await supabase
      .from("session_speakers")
      .upsert(Array.from(uniqueLinks.values()), { onConflict: "session_id,speaker_id" });
    if (sessionSpeakersError) {
      throw new Error(sessionSpeakersError.message);
    }
  }

  const { count: uniqueSpeakersCount, error: uniqueSpeakersError } = await supabase
    .from("speakers")
    .select("id", { count: "exact", head: true })
    .eq("event_id", eventId);
  if (uniqueSpeakersError) {
    throw new Error(uniqueSpeakersError.message);
  }

  return {
    sessionsFound: normalizedSessions.length,
    speakerAppearancesFound: rowsForSessionLink.length,
    uniqueSpeakersFound: uniqueSpeakersCount ?? 0,
  };
}
