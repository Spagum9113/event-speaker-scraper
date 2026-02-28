"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { appendEventJob, getEventById } from "@/lib/events-store";
import { EventRecord } from "@/lib/types";

type MappingPanelMode = "totalMapped" | "afterFilter" | "processed" | null;

type MapApiResponse = {
  totalMappedUrls: number;
  mappedUrls: string[];
  filteredUrls: string[];
  error?: string;
};

function formatDate(isoDate: string): string {
  return new Date(isoDate).toLocaleString();
}

export default function EventDetailPage() {
  const params = useParams<{ id: string }>();
  // Step 1: Keep a handle to cancel the in-flight map request from UI.
  const mappingAbortControllerRef = useRef<AbortController | null>(null);
  const [event, setEvent] = useState<EventRecord | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [panelMode, setPanelMode] = useState<MappingPanelMode>(null);

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
      mappingAbortControllerRef.current?.abort();
      isMounted = false;
    };
  }, [params.id]);

  function cancelExtraction(): void {
    if (!isRunning) {
      return;
    }

    mappingAbortControllerRef.current?.abort();
  }

  async function runExtraction(): Promise<void> {
    if (!event || isRunning) {
      return;
    }

    setIsRunning(true);
    setError("");
    const startedAt = new Date().toLocaleTimeString();

    // Step 1: Write an immediate "crawling" job snapshot so UI updates instantly.
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

    try {
      // Step 1: Each run gets its own cancel token.
      const controller = new AbortController();
      mappingAbortControllerRef.current = controller;
      const response = await fetch("/api/extraction/map", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eventId: event.id,
          startUrl: event.url,
        }),
        signal: controller.signal,
      });

      const payload = (await response.json()) as MapApiResponse;
      if (!response.ok) {
        throw new Error(payload.error ?? "Could not map event URLs.");
      }

      const completedAt = new Date().toLocaleTimeString();
      // Step 1: Only mapping counters are populated; processing stays zero.
      const completed: EventRecord = {
        ...inProgress,
        latestJob: {
          status: "complete",
          counters: {
            totalUrlsMapped: payload.totalMappedUrls,
            urlsDiscovered: payload.filteredUrls.length,
            pagesProcessed: 0,
            sessionsFound: 0,
            speakerAppearancesFound: 0,
            uniqueSpeakersFound: 0,
          },
          logLines: [
            ...inProgress.latestJob.logLines.slice(-14),
            `[${completedAt}] Firecrawl map completed (${payload.totalMappedUrls} total URLs).`,
            `[${completedAt}] URLs after filter: ${payload.filteredUrls.length}.`,
            `[${completedAt}] Pages processed remains 0 for Step 1.`,
          ].slice(-20),
          mappedUrls: payload.mappedUrls,
          filteredUrls: payload.filteredUrls,
          processedUrls: [],
          updatedAt: new Date().toISOString(),
        },
      };

      await appendEventJob(event.id, completed.latestJob);
      const refreshed = await getEventById(event.id);
      setEvent(refreshed ?? completed);
      setPanelMode("afterFilter");
    } catch (runError) {
      const failedAt = new Date().toLocaleTimeString();
      const isCanceled =
        runError instanceof DOMException && runError.name === "AbortError";
      const failedMessage = isCanceled
        ? "Extraction was cancelled."
        : runError instanceof Error
          ? runError.message
          : "Could not finalize extraction.";
      const failed: EventRecord = {
        ...inProgress,
        latestJob: {
          ...inProgress.latestJob,
          status: "failed",
          logLines: [
            ...inProgress.latestJob.logLines.slice(-18),
            `[${failedAt}] ${isCanceled ? "Mapping cancelled" : "Mapping failed"}: ${failedMessage}`,
          ].slice(-20),
          updatedAt: new Date().toISOString(),
        },
      };

      try {
        await appendEventJob(event.id, failed.latestJob);
      } catch {
        // Step 1: Avoid breaking the page when failed-status persistence also fails.
      }

      setEvent(failed);
      setError(failedMessage);
    } finally {
      mappingAbortControllerRef.current = null;
      setIsRunning(false);
    }
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
          {isRunning ? (
            <button
              type="button"
              onClick={cancelExtraction}
              className="rounded-md border border-red-300 bg-red-50 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-100"
            >
              Cancel Run
            </button>
          ) : null}
          <span className="text-sm">
            Latest status:{" "}
            <span className="font-medium capitalize">{event.latestJob.status}</span>
          </span>
          <span className="text-sm text-zinc-600">
            Last updated: {formatDate(event.latestJob.updatedAt)}
          </span>
        </div>
        {error ? <p className="mb-3 text-sm text-red-600">{error}</p> : null}

        <div className="grid grid-cols-1 gap-3 text-sm md:grid-cols-2 lg:grid-cols-5">
          <CounterCard
            label="Total URLs mapped"
            value={event.latestJob.counters.totalUrlsMapped}
            onClick={() => setPanelMode("totalMapped")}
          />
          <CounterCard
            label="URLs after filter"
            value={event.latestJob.counters.urlsDiscovered}
            onClick={() => setPanelMode("afterFilter")}
          />
          <CounterCard
            label="Pages processed"
            value={event.latestJob.counters.pagesProcessed}
            onClick={() => setPanelMode("processed")}
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
        {panelMode ? (
          <UrlPanel
            mode={panelMode}
            mappedUrls={event.latestJob.mappedUrls}
            filteredUrls={event.latestJob.filteredUrls}
            processedUrls={event.latestJob.processedUrls}
          />
        ) : null}

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

function CounterCard({
  label,
  value,
  onClick,
}: {
  label: string;
  value: number;
  onClick?: () => void;
}) {
  return (
    <div
      className={`rounded-md border border-zinc-200 bg-zinc-50 p-3 ${
        onClick ? "cursor-pointer hover:bg-zinc-100" : ""
      }`}
      onClick={onClick}
      onKeyDown={(event) => {
        if (!onClick) {
          return;
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick();
        }
      }}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
    >
      <p className="text-xs uppercase tracking-wide text-zinc-600">{label}</p>
      <p className="mt-1 text-lg font-semibold">{value}</p>
    </div>
  );
}

function UrlPanel({
  mode,
  mappedUrls,
  filteredUrls,
  processedUrls,
}: {
  mode: NonNullable<MappingPanelMode>;
  mappedUrls: string[];
  filteredUrls: string[];
  processedUrls: string[];
}) {
  const config =
    mode === "totalMapped"
      ? {
          title: "Total URLs mapped",
          urls: mappedUrls,
          emptyText: "No mapped URLs yet.",
        }
      : mode === "afterFilter"
        ? {
            title: "URLs after filter",
            urls: filteredUrls,
            emptyText: "No filtered URLs yet.",
          }
        : {
            title: "Pages processed",
            urls: processedUrls,
            emptyText: "No processed pages yet.",
          };
  const panelTextRef = useRef<HTMLDivElement | null>(null);
  const [copyLabel, setCopyLabel] = useState("Copy");

  async function handleCopy(): Promise<void> {
    const textToCopy = panelTextRef.current?.innerText?.trim();
    if (!textToCopy) {
      return;
    }

    try {
      await navigator.clipboard.writeText(textToCopy);
      setCopyLabel("Copied");
      setTimeout(() => setCopyLabel("Copy"), 1500);
    } catch {
      setCopyLabel("Copy failed");
      setTimeout(() => setCopyLabel("Copy"), 1500);
    }
  }

  return (
    <div ref={panelTextRef} className="mt-4 rounded-md border border-zinc-200 bg-white p-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold">{config.title}</h3>
        <button
          type="button"
          onClick={() => void handleCopy()}
          className="text-xs text-zinc-600 hover:underline"
        >
          {copyLabel}
        </button>
      </div>
      <p className="mb-2 text-xs text-zinc-600">Total: {config.urls.length}</p>
      <div className="max-h-52 overflow-auto rounded-md border bg-zinc-50 p-2">
        {config.urls.length === 0 ? (
          <p className="text-sm text-zinc-600">{config.emptyText}</p>
        ) : (
          <ul className="space-y-1 text-sm text-zinc-700">
            {config.urls.map((url) => (
              <li key={url} className="break-all">
                {url}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

