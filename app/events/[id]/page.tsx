"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { getEventById, startExtraction } from "@/lib/events-store";
import { EventRecord } from "@/lib/types";

type MappingPanelMode =
  | "totalMapped"
  | "afterFilter"
  | "processed"
  | "rawScrapes"
  | "conferenceSessions"
  | "uniqueSpeakers"
  | null;

const TERMINAL_STATUSES = new Set(["complete", "failed"]);

function formatDate(isoDate: string): string {
  return new Date(isoDate).toLocaleString();
}

function formatDuration(totalSeconds: number): string {
  const safeSeconds = Math.max(0, totalSeconds);
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(
      seconds,
    ).padStart(2, "0")}`;
  }

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export default function EventDetailPage() {
  const params = useParams<{ id: string }>();
  // Step 2: Keep handle to the background extraction call for error reporting only.
  const activeRunPromiseRef = useRef<Promise<void> | null>(null);
  const [event, setEvent] = useState<EventRecord | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [panelMode, setPanelMode] = useState<MappingPanelMode>(null);
  const [runStartedAtMs, setRunStartedAtMs] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [lastRunDurationSeconds, setLastRunDurationSeconds] = useState<number | null>(null);

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
      activeRunPromiseRef.current = null;
      isMounted = false;
    };
  }, [params.id]);

  useEffect(() => {
    if (!isRunning || runStartedAtMs === null) {
      return;
    }

    const interval = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - runStartedAtMs) / 1000));
    }, 1000);

    return () => window.clearInterval(interval);
  }, [isRunning, runStartedAtMs]);

  useEffect(() => {
    if (!isRunning || !event?.id) {
      return;
    }

    const eventId = event.id;
    let isMounted = true;
    async function pollLatestEvent() {
      try {
        const refreshed = await getEventById(eventId);
        if (!isMounted || !refreshed) {
          return;
        }

        setEvent(refreshed);
        if (TERMINAL_STATUSES.has(refreshed.latestJob.status)) {
          setIsRunning(false);
          if (runStartedAtMs) {
            setLastRunDurationSeconds(Math.floor((Date.now() - runStartedAtMs) / 1000));
          }
          setRunStartedAtMs(null);
        }
      } catch {
        // Step 2: Ignore transient polling errors so a single failure does not stop live updates.
      }
    }

    void pollLatestEvent();
    const interval = window.setInterval(() => {
      void pollLatestEvent();
    }, 2500);

    return () => {
      isMounted = false;
      window.clearInterval(interval);
    };
  }, [event?.id, isRunning, runStartedAtMs]);

  function cancelExtraction(): void {
    if (!isRunning) {
      return;
    }

    setIsRunning(false);
    setRunStartedAtMs(null);
    setError("Stopped local polling. Extraction may still be running on the server.");
  }

  async function runExtraction(): Promise<void> {
    if (!event || isRunning) {
      return;
    }

    const startedAtMs = Date.now();
    setRunStartedAtMs(startedAtMs);
    setElapsedSeconds(0);
    setIsRunning(true);
    setError("");
    const startedAt = new Date().toLocaleTimeString();

    // Step 2: Optimistically show queued state until polling picks up persisted job rows.
    const inProgress: EventRecord = {
      ...event,
      latestJob: {
        ...event.latestJob,
        status: "queued",
        updatedAt: new Date().toISOString(),
        logLines: [
          ...event.latestJob.logLines.slice(-19),
          `[${startedAt}] Extraction requested from UI.`,
        ],
      },
    };

    setEvent(inProgress);
    const runPromise = startExtraction(event.id, event.url);
    activeRunPromiseRef.current = runPromise;
    void runPromise.catch((runError) => {
      setError(
        runError instanceof Error ? runError.message : "Could not start extraction.",
      );
      setIsRunning(false);
      if (startedAtMs) {
        setLastRunDurationSeconds(Math.floor((Date.now() - startedAtMs) / 1000));
      }
      setRunStartedAtMs(null);
      activeRunPromiseRef.current = null;
    });
    setPanelMode("processed");
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
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
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
          <div className="min-w-[180px] rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-right">
            <p className="text-[11px] uppercase tracking-wide text-zinc-600">Processing Timer</p>
            <p className="mt-0.5 text-base font-semibold tabular-nums">
              {formatDuration(isRunning ? elapsedSeconds : (lastRunDurationSeconds ?? 0))}
            </p>
            <p className="mt-1 text-[11px] text-zinc-600">
              {isRunning ? "Current run" : "Latest run"}
            </p>
          </div>
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
            onClick={() => setPanelMode("conferenceSessions")}
          />
          <CounterCard
            label="Raw page scrapes"
            value={event.latestJob.pageScrapes.length}
            onClick={() => setPanelMode("rawScrapes")}
          />
          <CounterCard
            label="Unique speakers"
            value={event.latestJob.counters.uniqueSpeakersFound}
            onClick={() => setPanelMode("uniqueSpeakers")}
          />
        </div>
        {panelMode ? (
          <DebugPanel
            mode={panelMode}
            mappedUrls={event.latestJob.mappedUrls}
            filteredUrls={event.latestJob.filteredUrls}
            processedUrls={event.latestJob.processedUrls}
            pageScrapes={event.latestJob.pageScrapes}
            sessions={event.sessions}
            speakers={event.speakers}
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
                <th className="p-3 text-left font-medium">#</th>
                <th className="p-3 text-left font-medium">Name</th>
                <th className="p-3 text-left font-medium">Organization</th>
                <th className="p-3 text-left font-medium">Title</th>
                <th className="p-3 text-left font-medium">Profile Website URL</th>
              </tr>
            </thead>
            <tbody>
              {event.speakers.length === 0 ? (
                <tr>
                  <td className="p-3 text-zinc-600" colSpan={5}>
                    No speakers yet. Results will appear here after extraction.
                  </td>
                </tr>
              ) : (
                event.speakers.map((speaker, index) => (
                  <tr key={speaker.id} className="border-t border-zinc-200">
                    <td className="p-3">{index + 1}</td>
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
      className={`rounded-md border border-zinc-200 bg-zinc-50 p-3 ${onClick ? "cursor-pointer hover:bg-zinc-100" : ""
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

function DebugPanel({
  mode,
  mappedUrls,
  filteredUrls,
  processedUrls,
  pageScrapes,
  sessions,
  speakers,
}: {
  mode: NonNullable<MappingPanelMode>;
  mappedUrls: string[];
  filteredUrls: string[];
  processedUrls: string[];
  pageScrapes: EventRecord["latestJob"]["pageScrapes"];
  sessions: EventRecord["sessions"];
  speakers: EventRecord["speakers"];
}) {
  const [selectedPageScrapeId, setSelectedPageScrapeId] = useState<string>("");
  const panelTextRef = useRef<HTMLDivElement | null>(null);
  const [copyLabel, setCopyLabel] = useState("Copy");

  function stringifyForPanel(value: unknown): string {
    if (value === undefined || value === null) {
      return "";
    }
    if (typeof value === "string") {
      return value;
    }
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  if (mode === "rawScrapes") {
    const selected =
      pageScrapes.find((scrape) => scrape.id === selectedPageScrapeId) ?? pageScrapes[0];
    const selectedText = selected
      ? [
          `URL: ${selected.url}`,
          `Success: ${selected.success}`,
          selected.error ? `Error: ${selected.error}` : "",
          "",
          "extractedJson",
          stringifyForPanel(selected.extractedJson),
          "",
          "metadata",
          stringifyForPanel(selected.metadata),
          "",
          "markdown",
          selected.markdown ?? "",
          "",
          "html",
          selected.html ?? "",
          "",
          "rawPayload",
          stringifyForPanel(selected.rawPayload),
        ]
          .filter(Boolean)
          .join("\n")
      : "";

    return (
      <div className="mt-4 rounded-md border border-zinc-200 bg-white p-3">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Raw page scrapes</h3>
          <button
            type="button"
            onClick={() => {
              if (!selectedText.trim()) {
                return;
              }
              void navigator.clipboard.writeText(selectedText);
            }}
            className="text-xs text-zinc-600 hover:underline"
            disabled={!selected}
          >
            Copy selected
          </button>
        </div>
        <p className="mb-2 text-xs text-zinc-600">Total: {pageScrapes.length}</p>
        {pageScrapes.length === 0 ? (
          <div className="rounded-md border bg-zinc-50 p-2">
            <p className="text-sm text-zinc-600">No raw page scrape artifacts yet.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
            <div className="max-h-112 overflow-auto rounded-md border bg-zinc-50 p-2 lg:col-span-1">
              <ul className="space-y-1 text-xs">
                {pageScrapes.map((scrape, index) => (
                  <li key={scrape.id}>
                    <button
                      type="button"
                      className={`w-full rounded border px-2 py-1 text-left ${
                        selected?.id === scrape.id
                          ? "border-zinc-800 bg-zinc-100"
                          : "border-zinc-200 bg-white hover:bg-zinc-100"
                      }`}
                      onClick={() => setSelectedPageScrapeId(scrape.id)}
                    >
                      <p className="font-medium">Page {index + 1}</p>
                      <p className="truncate text-zinc-600">{scrape.url}</p>
                      <p className={scrape.success ? "text-emerald-700" : "text-red-700"}>
                        {scrape.success ? "Success" : "Failed"}
                      </p>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
            <div className="max-h-112 overflow-auto rounded-md border bg-zinc-50 p-2 lg:col-span-2">
              {!selected ? (
                <p className="text-sm text-zinc-600">Select a page to inspect raw scrape data.</p>
              ) : (
                <div className="space-y-3 text-xs text-zinc-700">
                  <section>
                    <h4 className="font-semibold">URL</h4>
                    <p className="break-all">{selected.url}</p>
                  </section>
                  <section>
                    <h4 className="font-semibold">Status</h4>
                    <p>{selected.success ? "Success" : "Failed"}</p>
                  </section>
                  {selected.error ? (
                    <section>
                      <h4 className="font-semibold">Error</h4>
                      <pre className="whitespace-pre-wrap wrap-break-word rounded border bg-white p-2">
                        {selected.error}
                      </pre>
                    </section>
                  ) : null}
                  <section>
                    <h4 className="font-semibold">Extracted JSON</h4>
                    <pre className="whitespace-pre-wrap wrap-break-word rounded border bg-white p-2">
                      {stringifyForPanel(selected.extractedJson) || "-"}
                    </pre>
                  </section>
                  <section>
                    <h4 className="font-semibold">Metadata</h4>
                    <pre className="whitespace-pre-wrap wrap-break-word rounded border bg-white p-2">
                      {stringifyForPanel(selected.metadata) || "-"}
                    </pre>
                  </section>
                  <section>
                    <h4 className="font-semibold">Markdown</h4>
                    <pre className="whitespace-pre-wrap wrap-break-word rounded border bg-white p-2">
                      {selected.markdown || "-"}
                    </pre>
                  </section>
                  <section>
                    <h4 className="font-semibold">HTML (raw text)</h4>
                    <pre className="whitespace-pre-wrap wrap-break-word rounded border bg-white p-2">
                      {selected.html || "-"}
                    </pre>
                  </section>
                  <section>
                    <h4 className="font-semibold">Raw payload</h4>
                    <pre className="whitespace-pre-wrap wrap-break-word rounded border bg-white p-2">
                      {stringifyForPanel(selected.rawPayload) || "-"}
                    </pre>
                  </section>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

  const config: {
    title: string;
    emptyText: string;
    type: "urlList" | "json";
    urls?: string[];
    data?: unknown;
  } =
    mode === "totalMapped"
      ? {
          title: "Total URLs mapped",
          type: "urlList",
          urls: mappedUrls,
          emptyText: "No mapped URLs yet.",
        }
      : mode === "afterFilter"
        ? {
            title: "URLs after filter",
            type: "urlList",
            urls: filteredUrls,
            emptyText: "No filtered URLs yet.",
          }
        : mode === "processed"
          ? {
              title: "Pages processed",
              type: "urlList",
              urls: processedUrls,
              emptyText: "No processed pages yet.",
            }
          : mode === "conferenceSessions"
            ? {
                title: "Conference sessions raw data",
                type: "json",
                data: sessions,
                emptyText: "No conference sessions yet.",
              }
            : {
                title: "Unique speakers raw data",
                type: "json",
                data: speakers,
                emptyText: "No unique speakers yet.",
              };

  const urls = config.urls ?? [];
  const data = config.data;
  const jsonText = data ? JSON.stringify(data, null, 2) : "";

  const textToCopy =
    config.type === "urlList"
      ? `${config.title}\nTotal: ${urls.length}\n\n${urls.join("\n")}`
      : `${config.title}\nTotal: ${Array.isArray(data) ? data.length : 0}\n\n${jsonText}`;

  const total =
    config.type === "urlList" ? urls.length : Array.isArray(data) ? data.length : 0;

  const hasRows = total > 0;

  async function handleCopy(): Promise<void> {
    const fallbackText = panelTextRef.current?.innerText?.trim();
    const value = textToCopy.trim() || fallbackText;
    if (!value) {
      return;
    }

    try {
      await navigator.clipboard.writeText(value);
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
      <p className="mb-2 text-xs text-zinc-600">Total: {total}</p>
      <div className="max-h-52 overflow-auto rounded-md border bg-zinc-50 p-2">
        {!hasRows ? (
          <p className="text-sm text-zinc-600">{config.emptyText}</p>
        ) : config.type === "urlList" ? (
          <ul className="space-y-1 text-sm text-zinc-700">
            {urls.map((url) => (
              <li key={url} className="break-all">
                {url}
              </li>
            ))}
          </ul>
        ) : (
          <pre className="text-xs text-zinc-700 whitespace-pre-wrap wrap-break-word">{jsonText}</pre>
        )}
      </div>
    </div>
  );
}

