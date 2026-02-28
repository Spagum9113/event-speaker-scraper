import { NextResponse } from "next/server";
import {
  defaultJob,
  createJobForEventInDb,
  createJobPageScrapesInDb,
  persistExtractedConferenceDataInDb,
  updateJobByIdInDb,
} from "@/lib/events-repository";
import {
  FirecrawlExtractionMode,
  filterLikelySessionUrls,
  mapEventUrlsWithFirecrawl,
  ScrapeDebugArtifact,
  scrapeStructuredSessionPage,
  SessionExtractedRow,
  SpeakerAppearanceExtractedRow,
} from "@/lib/firecrawl";
import { runBrowserApiStrategy } from "@/lib/speaker-api-strategy";
import { JobCounters } from "@/lib/types";
import { getSupabaseServerClient } from "@/lib/supabase/server";

type MapRequestBody = {
  eventId?: string;
  startUrl?: string;
};

const MAX_SESSION_PAGES = 20;
const MAX_SPEAKER_PASSES = 8;
const MAX_SPEAKER_PASS_FAILURES = 2;
const SPEAKER_NO_GROWTH_STOP_PASSES = 2;
const MIN_PASSES_BEFORE_PLATEAU_STOP = 4;
const SPEAKER_PATH_KEYWORDS = ["speaker", "speakers", "presenter", "presenters", "faculty"];
const SESSION_PATH_KEYWORDS = ["session", "sessions", "agenda", "schedule", "program"];
const SPEAKER_SIGNAL_TOKENS = ["speaker", "speakers", "presenter", "presenters", "faculty"];

type StrategyRunOutput = {
  sessions: SessionExtractedRow[];
  appearances: SpeakerAppearanceExtractedRow[];
  artifacts: ScrapeDebugArtifact[];
  stopReason: string;
};

type ExtractionStrategy = {
  name: "apiProbe" | "firecrawlFallback";
  canHandle: (mode: FirecrawlExtractionMode, isAmbiguous: boolean) => number;
  run: (
    url: string,
    signal: AbortSignal | undefined,
    appendLogLine: (message: string) => void,
    modeSelection: { mode: FirecrawlExtractionMode; isAmbiguous: boolean },
  ) => Promise<StrategyRunOutput | null>;
};

function pickExtractionMode(url: string): {
  mode: FirecrawlExtractionMode;
  isAmbiguous: boolean;
} {
  try {
    const parsed = new URL(url);
    const candidate = `${parsed.pathname}${parsed.search}`.toLowerCase();
    const hasSpeakerKeyword = SPEAKER_PATH_KEYWORDS.some((keyword) =>
      candidate.includes(keyword),
    );
    const hasSessionKeyword = SESSION_PATH_KEYWORDS.some((keyword) =>
      candidate.includes(keyword),
    );

    if (hasSpeakerKeyword && !hasSessionKeyword) {
      return { mode: "speakerDirectory", isAmbiguous: false };
    }
    if (hasSessionKeyword && !hasSpeakerKeyword) {
      return { mode: "session", isAmbiguous: false };
    }
  } catch {
    // Step 3: Fall back to default mode when URL parsing fails.
  }

  return { mode: "session", isAmbiguous: true };
}

function hasSpeakerSignals(artifact: ScrapeDebugArtifact): boolean {
  const markdown = artifact.markdown?.toLowerCase() ?? "";
  const html = artifact.html?.toLowerCase() ?? "";
  const extractedJsonText =
    artifact.extractedJson !== undefined ? JSON.stringify(artifact.extractedJson).toLowerCase() : "";
  return SPEAKER_SIGNAL_TOKENS.some(
    (token) =>
      markdown.includes(token) || html.includes(token) || extractedJsonText.includes(token),
  );
}

function normalizeIdentityToken(value: string | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function speakerAppearanceKey(row: SpeakerAppearanceExtractedRow): string {
  const profile = row.profileUrl?.trim().toLowerCase();
  if (profile) {
    return `profile::${profile}`;
  }
  const name = normalizeIdentityToken(row.name);
  const org = normalizeIdentityToken(row.organization);
  return `nameorg::${name}::${org}`;
}

async function runFirecrawlFallbackStrategy(
  sessionUrl: string,
  signal: AbortSignal | undefined,
  appendLogLine: (message: string) => void,
  modeSelection: { mode: FirecrawlExtractionMode; isAmbiguous: boolean },
): Promise<StrategyRunOutput | null> {
  const shouldRunSpeakerPassLoop =
    modeSelection.mode === "speakerDirectory" ||
    (modeSelection.isAmbiguous && modeSelection.mode === "session");

  if (!shouldRunSpeakerPassLoop) {
    const singlePass = await scrapeStructuredSessionPage(sessionUrl, signal, {
      extractionMode: "session",
    });
    return {
      sessions: singlePass.sessions,
      appearances: singlePass.appearances,
      artifacts: [singlePass.debugArtifact],
      stopReason: "single_session_pass",
    };
  }

  const speakerLoopMode: FirecrawlExtractionMode =
    modeSelection.mode === "speakerDirectory" ? "speakerDirectory" : "session";
  const uniqueAppearanceMap = new Map<string, SpeakerAppearanceExtractedRow>();
  const sessionRowsByUrl = new Map<string, SessionExtractedRow>();
  const artifacts: ScrapeDebugArtifact[] = [];
  let consecutiveNoGrowthPasses = 0;
  let failedPasses = 0;
  let stopReason = "max_passes_reached";
  let shouldEnterSpeakerMode = speakerLoopMode === "speakerDirectory";

  for (let passIndex = 1; passIndex <= MAX_SPEAKER_PASSES; passIndex += 1) {
    if (signal?.aborted) {
      throw new Error("Extraction cancelled.");
    }

    const passMode: FirecrawlExtractionMode =
      shouldEnterSpeakerMode || passIndex > 1 ? "speakerDirectory" : "session";
    appendLogLine(`Pass ${passIndex} (${passMode}) started for ${sessionUrl}.`);

    try {
      const passResult = await scrapeStructuredSessionPage(sessionUrl, signal, {
        extractionMode: passMode,
        speakerPassIndex: passIndex,
        maxLoadMoreClicks: Math.min(1 + passIndex, 4),
      });
      const debugArtifact: ScrapeDebugArtifact = {
        ...passResult.debugArtifact,
        metadata: {
          ...(passResult.debugArtifact.metadata ?? {}),
          passIndex,
          extractionMode: passMode,
        },
      };
      artifacts.push(debugArtifact);

      if (!shouldEnterSpeakerMode) {
        if (
          passMode === "session" &&
          passResult.appearances.length === 0 &&
          hasSpeakerSignals(passResult.debugArtifact)
        ) {
          appendLogLine(
            `Pass ${passIndex}: speaker signals detected; switching to speakerDirectory mode.`,
          );
          shouldEnterSpeakerMode = true;
          continue;
        }
        shouldEnterSpeakerMode = passMode === "speakerDirectory";
      }

      for (const sessionRow of passResult.sessions) {
        if (!sessionRowsByUrl.has(sessionRow.url)) {
          sessionRowsByUrl.set(sessionRow.url, sessionRow);
        }
      }

      const beforeUniqueCount = uniqueAppearanceMap.size;
      for (const appearance of passResult.appearances) {
        const key = speakerAppearanceKey(appearance);
        if (!uniqueAppearanceMap.has(key)) {
          uniqueAppearanceMap.set(key, appearance);
        }
      }
      const newSpeakersThisPass = uniqueAppearanceMap.size - beforeUniqueCount;
      appendLogLine(
        `Pass ${passIndex}: extracted=${passResult.appearances.length}, new=${newSpeakersThisPass}, cumulative=${uniqueAppearanceMap.size}.`,
      );

      if (newSpeakersThisPass === 0) {
        consecutiveNoGrowthPasses += 1;
      } else {
        consecutiveNoGrowthPasses = 0;
      }

      const reachedPlateauThreshold =
        passIndex >= MIN_PASSES_BEFORE_PLATEAU_STOP &&
        uniqueAppearanceMap.size > 0 &&
        consecutiveNoGrowthPasses >= SPEAKER_NO_GROWTH_STOP_PASSES;

      if (reachedPlateauThreshold) {
        stopReason = "plateau_no_growth";
        break;
      }
    } catch (passError) {
      failedPasses += 1;
      const message =
        passError instanceof Error ? passError.message : "Unknown scrape pass error.";
      artifacts.push({
        url: sessionUrl,
        success: false,
        rawPayload: null,
        extractedJson: null,
        extractionMode: passMode,
        metadata: {
          extractionMode: passMode,
          ambiguousModeSelection: modeSelection.isAmbiguous,
          passIndex,
        },
        error: message,
      });
      appendLogLine(`Pass ${passIndex} failed for ${sessionUrl}: ${message}`);
      if (failedPasses >= MAX_SPEAKER_PASS_FAILURES) {
        stopReason = "max_pass_failures";
        break;
      }
    }
  }

  return {
    sessions: Array.from(sessionRowsByUrl.values()),
    appearances: Array.from(uniqueAppearanceMap.values()),
    artifacts,
    stopReason,
  };
}

export async function POST(request: Request) {
  let jobId: string | null = null;
  const logLines: string[] = [];

  function appendLogLine(message: string): void {
    const timestamp = new Date().toLocaleTimeString();
    logLines.push(`[${timestamp}] ${message}`);
  }

  function buildCounters(patch?: Partial<JobCounters>): JobCounters {
    return {
      totalUrlsMapped: patch?.totalUrlsMapped ?? 0,
      urlsDiscovered: patch?.urlsDiscovered ?? 0,
      pagesProcessed: patch?.pagesProcessed ?? 0,
      sessionsFound: patch?.sessionsFound ?? 0,
      speakerAppearancesFound: patch?.speakerAppearancesFound ?? 0,
      uniqueSpeakersFound: patch?.uniqueSpeakersFound ?? 0,
    };
  }

  try {
    const body = (await request.json()) as MapRequestBody;
    const eventId = body.eventId?.trim();
    const startUrl = body.startUrl?.trim();

    if (!eventId || !startUrl) {
      return NextResponse.json(
        { error: "eventId and startUrl are required." },
        { status: 400 },
      );
    }

    const supabase = getSupabaseServerClient();
    appendLogLine("Extraction queued.");
    const queuedJob = defaultJob("queued");
    queuedJob.logLines = logLines.slice(-20);
    jobId = await createJobForEventInDb(eventId, queuedJob, supabase);

    appendLogLine("Crawling started.");
    await updateJobByIdInDb(
      jobId,
      {
        status: "crawling",
        logLines,
        counters: buildCounters(),
      },
      supabase,
    );

    const mapped = await mapEventUrlsWithFirecrawl(startUrl);
    const likelySessionUrls = filterLikelySessionUrls(
      mapped.filteredUrls,
      MAX_SESSION_PAGES,
    );
    // Fall back to first filtered pages when keyword targeting finds nothing.
    const targetedSessionUrls =
      likelySessionUrls.length > 0
        ? likelySessionUrls
        : mapped.filteredUrls.slice(0, MAX_SESSION_PAGES);
    appendLogLine(
      `Mapping complete. ${mapped.totalMappedUrls} total URLs, ${mapped.filteredUrls.length} after filter, ${targetedSessionUrls.length} targeted.`,
    );
    await updateJobByIdInDb(
      jobId,
      {
        status: "extracting",
        counters: buildCounters({
          totalUrlsMapped: mapped.totalMappedUrls,
          urlsDiscovered: mapped.filteredUrls.length,
        }),
        mappedUrls: mapped.mappedUrls,
        filteredUrls: mapped.filteredUrls,
        processedUrls: [],
        logLines,
        error: null,
      },
      supabase,
    );

    const extractedSessions: SessionExtractedRow[] = [];
    const extractedAppearances: SpeakerAppearanceExtractedRow[] = [];
    const scrapeArtifacts: ScrapeDebugArtifact[] = [];
    const processedUrls: string[] = [];
    const scrapeErrors: string[] = [];

    for (const sessionUrl of targetedSessionUrls) {
      if (request.signal.aborted) {
        throw new Error("Extraction cancelled.");
      }
      const modeSelection = pickExtractionMode(sessionUrl);
      const strategies: ExtractionStrategy[] = [
        {
          name: "apiProbe",
          canHandle: (mode) => (mode === "speakerDirectory" ? 100 : 40),
          run: async (url, signal, appendLine) => {
            try {
              const apiResult = await runBrowserApiStrategy(url, signal, appendLine);
              if (!apiResult) {
                return null;
              }
              if (apiResult.endpointUrl) {
                appendLine(`API endpoint discovered for ${url}: ${apiResult.endpointUrl}`);
              }
              return {
                sessions: apiResult.sessions,
                appearances: apiResult.appearances,
                artifacts: apiResult.artifacts,
                stopReason: apiResult.stopReason,
              };
            } catch (strategyError) {
              appendLine(
                `apiProbe strategy failed for ${url}: ${
                  strategyError instanceof Error ? strategyError.message : "Unknown strategy error."
                }`,
              );
              return null;
            }
          },
        },
        {
          name: "firecrawlFallback",
          canHandle: () => 10,
          run: async (url, signal, appendLine, selection) =>
            runFirecrawlFallbackStrategy(url, signal, appendLine, selection),
        },
      ];
      const orderedStrategies = strategies
        .map((strategy) => ({
          strategy,
          score: strategy.canHandle(modeSelection.mode, modeSelection.isAmbiguous),
        }))
        .sort((left, right) => right.score - left.score);

      try {
        appendLogLine(
          `Mode selected for ${sessionUrl}: ${modeSelection.mode}${modeSelection.isAmbiguous ? " (ambiguous)" : ""}.`,
        );
        let selectedStrategyName: ExtractionStrategy["name"] | null = null;
        let strategyResult: StrategyRunOutput | null = null;
        for (const entry of orderedStrategies) {
          if (entry.score <= 0) {
            continue;
          }
          appendLogLine(
            `Running strategy ${entry.strategy.name} for ${sessionUrl} (score=${entry.score}).`,
          );
          const result = await entry.strategy.run(
            sessionUrl,
            request.signal,
            appendLogLine,
            modeSelection,
          );
          if (result && (result.appearances.length > 0 || result.sessions.length > 0)) {
            strategyResult = result;
            selectedStrategyName = entry.strategy.name;
            break;
          }
        }

        if (!strategyResult) {
          throw new Error("All extraction strategies returned empty results.");
        }

        processedUrls.push(sessionUrl);
        extractedSessions.push(...strategyResult.sessions);
        extractedAppearances.push(...strategyResult.appearances);
        scrapeArtifacts.push(...strategyResult.artifacts);
        appendLogLine(
          `Strategy ${selectedStrategyName ?? "unknown"} completed for ${sessionUrl} (stopReason=${strategyResult.stopReason}, appearances=${strategyResult.appearances.length}).`,
        );
        appendLogLine(`Processed page ${processedUrls.length}/${targetedSessionUrls.length}: ${sessionUrl}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown scrape error.";
        scrapeErrors.push(`${sessionUrl}: ${message}`);
        scrapeArtifacts.push({
          url: sessionUrl,
          success: false,
          rawPayload: null,
          extractedJson: null,
          extractionMode: modeSelection.mode,
          metadata: {
            extractionMode: modeSelection.mode,
            ambiguousModeSelection: modeSelection.isAmbiguous,
          },
          error: message,
        });
        appendLogLine(`Scrape failed for ${sessionUrl}.`);
      }

      await updateJobByIdInDb(
        jobId,
        {
          status: "extracting",
          counters: buildCounters({
            totalUrlsMapped: mapped.totalMappedUrls,
            urlsDiscovered: mapped.filteredUrls.length,
            pagesProcessed: processedUrls.length,
            sessionsFound: new Set(extractedSessions.map((session) => session.url)).size,
            speakerAppearancesFound: extractedAppearances.length,
          }),
          processedUrls,
          logLines,
        },
        supabase,
      );
    }

    appendLogLine("Saving extracted sessions and speakers.");
    await updateJobByIdInDb(
      jobId,
      {
        status: "saving",
        counters: buildCounters({
          totalUrlsMapped: mapped.totalMappedUrls,
          urlsDiscovered: mapped.filteredUrls.length,
          pagesProcessed: processedUrls.length,
          sessionsFound: new Set(extractedSessions.map((session) => session.url)).size,
          speakerAppearancesFound: extractedAppearances.length,
        }),
        processedUrls,
        logLines,
      },
      supabase,
    );

    try {
      await createJobPageScrapesInDb(jobId, eventId, scrapeArtifacts, supabase);
      appendLogLine(`Saved ${scrapeArtifacts.length} page scrape artifacts.`);
    } catch (artifactError) {
      const artifactMessage =
        artifactError instanceof Error ? artifactError.message : "Unknown page artifact save error.";
      appendLogLine(`Page artifact persistence failed: ${artifactMessage}`);
    }

    const persisted = await persistExtractedConferenceDataInDb(
      eventId,
      extractedSessions,
      extractedAppearances,
      supabase,
    );
    appendLogLine(
      `Saved ${persisted.sessionsFound} sessions, ${persisted.speakerAppearancesFound} appearances, ${persisted.uniqueSpeakersFound} unique speakers.`,
    );
    appendLogLine(
      scrapeErrors.length > 0
        ? `${scrapeErrors.length} pages failed during scrape.`
        : "No scrape errors reported.",
    );

    await updateJobByIdInDb(
      jobId,
      {
        status: "complete",
        counters: buildCounters({
          totalUrlsMapped: mapped.totalMappedUrls,
          urlsDiscovered: mapped.filteredUrls.length,
          pagesProcessed: processedUrls.length,
          sessionsFound: persisted.sessionsFound,
          speakerAppearancesFound: persisted.speakerAppearancesFound,
          uniqueSpeakersFound: persisted.uniqueSpeakersFound,
        }),
        processedUrls,
        logLines,
        error: null,
      },
      supabase,
    );

    return NextResponse.json({
      eventId,
      jobId,
      totalMappedUrls: mapped.totalMappedUrls,
      filteredUrlsCount: mapped.filteredUrls.length,
      targetedSessionUrlsCount: targetedSessionUrls.length,
      processedUrlsCount: processedUrls.length,
      scrapeErrorsCount: scrapeErrors.length,
      sessionsFound: persisted.sessionsFound,
      speakerAppearancesFound: persisted.speakerAppearancesFound,
      uniqueSpeakersFound: persisted.uniqueSpeakersFound,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown mapping error.";
    if (jobId) {
      try {
        appendLogLine(`Extraction failed: ${message}`);
        await updateJobByIdInDb(
          jobId,
          {
            status: "failed",
            logLines,
            error: message,
          },
          getSupabaseServerClient(),
        );
      } catch {
        // Step 1: Keep original API failure if failed-state persistence also errors.
      }
    }

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
