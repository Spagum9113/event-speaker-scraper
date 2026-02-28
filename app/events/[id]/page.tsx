"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import {
  appendEventJob,
  buildMockExtractionResult,
  getEventById,
} from "@/lib/events-store";
import { EventRecord } from "@/lib/types";

function formatDate(isoDate: string): string {
  return new Date(isoDate).toLocaleString();
}

export default function EventDetailPage() {
  const params = useParams<{ id: string }>();
  const [event, setEvent] = useState<EventRecord | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let isMounted = true;

    async function loadEvent() {
      if (!params.id) {
        if (isMounted) {
          setEvent(null);
          setIsLoading(false);
        }
        return;
      }

      try {
        const loadedEvent = await getEventById(params.id);
        if (isMounted) {
          setEvent(loadedEvent ?? null);
          setError("");
        }
      } catch (loadError) {
        if (isMounted) {
          setError(loadError instanceof Error ? loadError.message : "Failed to load event.");
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    void loadEvent();

    return () => {
      isMounted = false;
    };
  }, [params.id]);

  async function runExtraction(): Promise<void> {
    if (!event || isRunning) {
      return;
    }

    setIsRunning(true);
    setError("");
    const startedAt = new Date().toLocaleTimeString();

    // First update simulates the in-progress status the backend job will later drive.
    const inProgress: EventRecord = {
      ...event,
      latestJob: {
        ...event.latestJob,
        status: "crawling",
        updatedAt: new Date().toISOString(),
        logLines: [
          ...event.latestJob.logLines.slice(-19),
          `[${startedAt}] Extraction requested from UI.`,
        ],
      },
    };

    try {
      await appendEventJob(event.id, inProgress.latestJob);
      setEvent(inProgress);
    } catch (runError) {
      setError(
        runError instanceof Error ? runError.message : "Could not start extraction.",
      );
      setIsRunning(false);
      return;
    }

    window.setTimeout(async () => {
      const completed: EventRecord = {
        ...inProgress,
        latestJob: buildMockExtractionResult(inProgress.latestJob.logLines),
      };

      try {
        await appendEventJob(event.id, completed.latestJob);
        const refreshed = await getEventById(event.id);
        setEvent(refreshed ?? completed);
      } catch (runError) {
        setError(
          runError instanceof Error ? runError.message : "Could not finalize extraction.",
        );
      }

      setIsRunning(false);
    }, 1200);
  }

  if (isLoading) {
    return (
      <main className="mx-auto max-w-4xl p-6">
        <Link href="/events" className="text-sm text-zinc-600 hover:underline">
          ← Back to Events
        </Link>
        <p className="mt-4 text-zinc-700">Loading event...</p>
      </main>
    );
  }

  if (!event) {
    return (
      <main className="mx-auto max-w-4xl p-6">
        <Link href="/events" className="text-sm text-zinc-600 hover:underline">
          ← Back to Events
        </Link>
        <p className="mt-4 text-zinc-700">Event not found.</p>
        {error ? <p className="mt-2 text-sm text-red-600">{error}</p> : null}
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-6xl p-6">
      <div className="mb-6">
        <Link href="/events" className="text-sm text-zinc-600 hover:underline">
          ← Back to Events
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">{event.name}</h1>
        <p className="text-sm text-zinc-600">{event.url}</p>
      </div>

      <section className="mb-6 rounded-lg border p-4">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <button
            onClick={() => void runExtraction()}
            disabled={isRunning}
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-zinc-400"
          >
            {isRunning ? "Running..." : "Run Extraction"}
          </button>
          <span className="text-sm">
            Latest status:{" "}
            <span className="font-medium capitalize">{event.latestJob.status}</span>
          </span>
          <span className="text-sm text-zinc-600">
            Last updated: {formatDate(event.latestJob.updatedAt)}
          </span>
        </div>
        {error ? <p className="mb-3 text-sm text-red-600">{error}</p> : null}

        <div className="grid grid-cols-1 gap-3 text-sm md:grid-cols-2 lg:grid-cols-4">
          <CounterCard
            label="URLs discovered"
            value={event.latestJob.counters.urlsDiscovered}
          />
          <CounterCard
            label="Pages processed"
            value={event.latestJob.counters.pagesProcessed}
          />
          <CounterCard
            label="Conference sessions"
            value={event.latestJob.counters.sessionsFound}
          />
          <CounterCard
            label="Unique speakers"
            value={event.latestJob.counters.uniqueSpeakersFound}
          />
        </div>

        <div className="mt-4">
          <h2 className="mb-2 text-sm font-semibold">Latest log lines</h2>
          <div className="max-h-48 overflow-auto rounded-md border bg-zinc-50 p-3">
            {event.latestJob.logLines.length === 0 ? (
              <p className="text-sm text-zinc-600">No logs yet.</p>
            ) : (
              <ul className="space-y-1 text-sm text-zinc-700">
                {event.latestJob.logLines.slice(-20).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>

      <section className="rounded-lg border p-4">
        <h2 className="mb-3 text-lg font-semibold">Speakers</h2>
        <div className="overflow-hidden rounded-md border border-zinc-200">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-zinc-50">
              <tr>
                <th className="p-3 text-left font-medium">Name</th>
                <th className="p-3 text-left font-medium">Organization</th>
                <th className="p-3 text-left font-medium">Title</th>
                <th className="p-3 text-left font-medium">Profile URL</th>
              </tr>
            </thead>
            <tbody>
              {event.speakers.length === 0 ? (
                <tr>
                  <td className="p-3 text-zinc-600" colSpan={4}>
                    No speakers yet. Results will appear here after extraction.
                  </td>
                </tr>
              ) : (
                event.speakers.map((speaker) => (
                  <tr key={speaker.id} className="border-t border-zinc-200">
                    <td className="p-3">{speaker.name}</td>
                    <td className="p-3">{speaker.organization}</td>
                    <td className="p-3">{speaker.title ?? "-"}</td>
                    <td className="p-3">{speaker.profileUrl ?? "-"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

function CounterCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3">
      <p className="text-xs uppercase tracking-wide text-zinc-600">{label}</p>
      <p className="mt-1 text-lg font-semibold">{value}</p>
    </div>
  );
}

