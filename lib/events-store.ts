"use client";

import { EventRecord, EventJob, JobCounters, JobStatus } from "@/lib/types";

const STORAGE_KEY = "conference-speaker-extractor-events-v1";

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

function defaultJob(status: JobStatus = "queued"): EventJob {
  return {
    status,
    counters: EMPTY_COUNTERS,
    logLines: ["Waiting for first extraction run."],
    updatedAt: nowIso(),
  };
}

function withWindowGuard<T>(callback: () => T, fallback: T): T {
  // This keeps calls safe if a function runs before hydration.
  if (typeof window === "undefined") {
    return fallback;
  }

  return callback();
}

export function listEvents(): EventRecord[] {
  return withWindowGuard(() => {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }

    try {
      const parsed = JSON.parse(raw) as EventRecord[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      // If local data is malformed we recover gracefully with an empty list.
      return [];
    }
  }, []);
}

export function saveEvents(events: EventRecord[]): void {
  withWindowGuard(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(events));
  }, undefined);
}

export function getEventById(id: string): EventRecord | undefined {
  return listEvents().find((event) => event.id === id);
}

export function createEvent(name: string, url: string): EventRecord {
  const trimmedName = name.trim();
  const trimmedUrl = url.trim();
  const event: EventRecord = {
    id: crypto.randomUUID(),
    name: trimmedName,
    url: trimmedUrl,
    createdAt: nowIso(),
    latestJob: defaultJob("queued"),
    speakers: [],
  };

  const next = [event, ...listEvents()];
  saveEvents(next);
  return event;
}

export function upsertEvent(updatedEvent: EventRecord): void {
  const current = listEvents();
  const index = current.findIndex((event) => event.id === updatedEvent.id);

  if (index === -1) {
    saveEvents([updatedEvent, ...current]);
    return;
  }

  const next = [...current];
  next[index] = updatedEvent;
  saveEvents(next);
}

export function updateEventBasics(
  id: string,
  updates: { name: string; url: string },
): EventRecord | undefined {
  const current = listEvents();
  const index = current.findIndex((event) => event.id === id);

  if (index === -1) {
    return undefined;
  }

  const next = [...current];
  const original = next[index];
  const updated: EventRecord = {
    ...original,
    name: updates.name.trim(),
    url: updates.url.trim(),
  };

  next[index] = updated;
  saveEvents(next);
  return updated;
}

export function deleteEventById(id: string): void {
  const next = listEvents().filter((event) => event.id !== id);
  saveEvents(next);
}

export function buildMockExtractionResult(previousLogLines: string[]): EventJob {
  const timestamp = new Date().toLocaleTimeString();

  // The mock values match the future production counters shape.
  return {
    status: "complete",
    counters: {
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
    updatedAt: nowIso(),
  };
}

