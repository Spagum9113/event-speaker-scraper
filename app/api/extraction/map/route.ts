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
import { JobCounters } from "@/lib/types";
import { getSupabaseServerClient } from "@/lib/supabase/server";

type MapRequestBody = {
  eventId?: string;
  startUrl?: string;
};

const MAX_SESSION_PAGES = 20;
const SPEAKER_PATH_KEYWORDS = ["speaker", "speakers", "presenter", "presenters", "faculty"];
const SESSION_PATH_KEYWORDS = ["session", "sessions", "agenda", "schedule", "program"];
const SPEAKER_SIGNAL_TOKENS = ["speaker", "speakers", "presenter", "presenters", "faculty"];

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

      try {
        appendLogLine(
          `Mode selected for ${sessionUrl}: ${modeSelection.mode}${modeSelection.isAmbiguous ? " (ambiguous)" : ""}.`,
        );
        const firstPass = await scrapeStructuredSessionPage(sessionUrl, request.signal, {
          extractionMode: modeSelection.mode,
        });
        scrapeArtifacts.push(firstPass.debugArtifact);

        let chosenResult = firstPass;
        if (
          modeSelection.isAmbiguous &&
          modeSelection.mode === "session" &&
          firstPass.appearances.length === 0 &&
          hasSpeakerSignals(firstPass.debugArtifact)
        ) {
          appendLogLine(`Retrying ${sessionUrl} with speakerDirectory mode.`);
          const retryPass = await scrapeStructuredSessionPage(sessionUrl, request.signal, {
            extractionMode: "speakerDirectory",
          });
          scrapeArtifacts.push(retryPass.debugArtifact);
          if (retryPass.appearances.length > 0) {
            chosenResult = retryPass;
          }
        }

        processedUrls.push(sessionUrl);
        extractedSessions.push(...chosenResult.sessions);
        extractedAppearances.push(...chosenResult.appearances);
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
