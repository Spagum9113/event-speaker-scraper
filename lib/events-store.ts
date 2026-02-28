"use client";

import {
  appendJobToEventInDb,
  createEventInDb,
  deleteEventByIdFromDb,
  deleteEventsByIdsFromDb,
  getEventByIdFromDb,
  listEventsFromDb,
  updateEventBasicsInDb,
} from "@/lib/events-repository";
import { EventJob, EventRecord } from "@/lib/types";

function nowIso(): string {
  return new Date().toISOString();
}

export async function listEvents(): Promise<EventRecord[]> {
  return listEventsFromDb();
}

export async function getEventById(id: string): Promise<EventRecord | undefined> {
  return (await getEventByIdFromDb(id)) ?? undefined;
}

export async function createEvent(name: string, url: string): Promise<EventRecord> {
  return createEventInDb(name, url);
}

export async function updateEventBasics(
  id: string,
  updates: { name: string; url: string },
): Promise<EventRecord | undefined> {
  return (await updateEventBasicsInDb(id, updates)) ?? undefined;
}

export async function deleteEventById(id: string): Promise<void> {
  await deleteEventByIdFromDb(id);
}

export async function deleteEventsByIds(ids: string[]): Promise<void> {
  await deleteEventsByIdsFromDb(ids);
}

export async function appendEventJob(id: string, job: EventJob): Promise<void> {
  await appendJobToEventInDb(id, job);
}

export async function startExtraction(
  eventId: string,
  startUrl: string,
): Promise<void> {
  const response = await fetch("/api/extraction/map", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ eventId, startUrl }),
  });

  const payload = (await response.json()) as {
    error?: string;
  };
  if (!response.ok) {
    throw new Error(payload.error ?? "Could not start extraction.");
  }
}

export function buildMockExtractionResult(previousLogLines: string[]): EventJob {
  const timestamp = new Date().toLocaleTimeString();

  // The mock values match the future production counters shape.
  return {
    status: "complete",
    counters: {
      totalUrlsMapped: 42,
      urlsDiscovered: 42,
      pagesProcessed: 18,
      sessionsFound: 12,
      speakerAppearancesFound: 29,
      uniqueSpeakersFound: 21,
    },
    logLines: [
      ...previousLogLines.slice(-8),
      `[${timestamp}] Crawl started`,
      `[${timestamp}] Session pages filtered`,
      `[${timestamp}] Speaker extraction complete`,
      `[${timestamp}] Saved event results`,
    ].slice(-20),
    mappedUrls: [],
    filteredUrls: [],
    processedUrls: [],
    pageScrapes: [],
    updatedAt: nowIso(),
  };
}

