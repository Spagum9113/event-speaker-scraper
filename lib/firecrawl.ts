type FirecrawlMapResponse = {
  success?: boolean;
  links?: unknown;
  data?: {
    links?: unknown;
  } | unknown;
};

type FirecrawlScrapeResponse = {
  success?: boolean;
  data?: {
    json?: unknown;
    markdown?: unknown;
    html?: unknown;
    metadata?: unknown;
  } | null;
};

export type SessionExtractedRow = {
  title: string;
  url: string;
};

export type SpeakerAppearanceExtractedRow = {
  name: string;
  organization?: string;
  title?: string;
  profileUrl?: string;
  role?: string;
  sessionUrl: string;
};

export type ScrapeDebugArtifact = {
  url: string;
  success: boolean;
  rawPayload: unknown;
  extractedJson: unknown;
  extractionMode?: FirecrawlExtractionMode;
  markdown?: string;
  html?: string;
  metadata?: Record<string, unknown>;
  error?: string;
};

export type FirecrawlExtractionMode = "session" | "speakerDirectory";

type ScrapedSessionModel = {
  title?: unknown;
  url?: unknown;
  speakers?: unknown;
};

type ScrapedSpeakerModel = {
  name?: unknown;
  organization?: unknown;
  title?: unknown;
  profileUrl?: unknown;
  profileWebsiteUrl?: unknown;
  websiteUrl?: unknown;
  role?: unknown;
};

type FirecrawlAction =
  | { type: "wait"; milliseconds: number }
  | { type: "scroll"; direction: "down" | "up" }
  | { type: "executeJavascript"; script: string };

const SESSION_URL_KEYWORDS = [
  "agenda",
  "schedule",
  "session",
  "sessions",
  "program",
  "speaker",
  "speakers",
];

const DEFAULT_SCRAPE_TIMEOUT_MS = 30000;
const SPEAKER_DIRECTORY_SCRAPE_TIMEOUT_MS = 120000;

// Step 1: Treat these extensions as non-page assets and filter them out.
const ASSET_EXTENSIONS = new Set([
  ".css",
  ".js",
  ".mjs",
  ".map",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".webp",
  ".ico",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".mp4",
  ".webm",
  ".mp3",
  ".wav",
  ".xml",
  ".json",
  ".txt",
]);

function getFirecrawlApiKey(): string {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) {
    throw new Error("Missing FIRECRAWL_API_KEY.");
  }
  return apiKey;
}

function normalizeTextValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseMappedUrls(payload: FirecrawlMapResponse): string[] {
  // Step 1: Firecrawl responses can vary, so check common locations in order.
  const candidates = [
    payload.links,
    payload.data && typeof payload.data === "object"
      ? (payload.data as { links?: unknown }).links
      : undefined,
    payload.data,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.filter((value): value is string => typeof value === "string");
    }
  }

  return [];
}

function isHttpProtocol(url: URL): boolean {
  return url.protocol === "http:" || url.protocol === "https:";
}

function isHtmlLikePath(pathname: string): boolean {
  // Step 1: Paths without file extension are assumed to be HTML pages.
  const lastDot = pathname.lastIndexOf(".");
  if (lastDot <= pathname.lastIndexOf("/")) {
    return true;
  }

  const extension = pathname.slice(lastDot).toLowerCase();
  return !ASSET_EXTENSIONS.has(extension);
}

function normalizeUrl(input: string): string | null {
  try {
    const parsed = new URL(input);
    // Step 1: Ignore fragment-only differences during de-duplication.
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

export function filterMappedUrls(startUrl: string, mappedUrls: string[]): string[] {
  // Step 1: Keep results on the exact same hostname as the event URL.
  const originHost = new URL(startUrl).hostname.toLowerCase();
  const deduped = new Set<string>();

  for (const rawUrl of mappedUrls) {
    const normalized = normalizeUrl(rawUrl);
    if (!normalized) {
      continue;
    }

    const parsed = new URL(normalized);
    if (!isHttpProtocol(parsed)) {
      continue;
    }
    // Step 1: Skip cross-domain links discovered by the mapper.
    if (parsed.hostname.toLowerCase() !== originHost) {
      continue;
    }
    // Step 1: Skip static files/docs and keep page-like URLs.
    if (!isHtmlLikePath(parsed.pathname)) {
      continue;
    }

    deduped.add(parsed.toString());
  }

  return Array.from(deduped);
}

export async function mapEventUrlsWithFirecrawl(startUrl: string): Promise<{
  totalMappedUrls: number;
  mappedUrls: string[];
  filteredUrls: string[];
}> 
{
  const apiKey = getFirecrawlApiKey();

  // Step 1: Server-side map call so API key never reaches the browser.
  const response = await fetch("https://api.firecrawl.dev/v1/map", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url: startUrl }),
    cache: "no-store",
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Firecrawl map request failed (${response.status}): ${errorText}`);
  }

  const payload = (await response.json()) as FirecrawlMapResponse;
  const mappedUrls = parseMappedUrls(payload);
  const filteredUrls = filterMappedUrls(startUrl, mappedUrls);

  return {
    totalMappedUrls: mappedUrls.length,
    mappedUrls,
    filteredUrls,
  };
}

export function filterLikelySessionUrls(urls: string[], maxPages: number): string[] {
  const selected: string[] = [];

  for (const value of urls) {
    try {
      const parsed = new URL(value);
      const candidate = `${parsed.pathname}${parsed.search}`.toLowerCase();
      const isLikelySessionUrl = SESSION_URL_KEYWORDS.some((keyword) =>
        candidate.includes(keyword),
      );

      if (isLikelySessionUrl) {
        selected.push(parsed.toString());
      }
    } catch {
      continue;
    }

    if (selected.length >= maxPages) {
      break;
    }
  }

  return selected;
}

function buildSpeakerDirectoryActions(
  speakerPassIndex: number,
  maxLoadMoreClicks: number,
): FirecrawlAction[] {
  const safePassIndex = Math.max(1, speakerPassIndex);
  const safeMaxClicks = Math.max(1, maxLoadMoreClicks);
  const scrollCount = Math.min(1 + safePassIndex, 4);
  const preActionWaitMs = safePassIndex === 1 ? 2200 : 1400;
  const actions: FirecrawlAction[] = [{ type: "wait", milliseconds: preActionWaitMs }];

  for (let index = 0; index < scrollCount; index += 1) {
    actions.push({ type: "scroll", direction: "down" });
    actions.push({ type: "wait", milliseconds: 800 });
  }

  actions.push({
    type: "executeJavascript",
    script: `
      const selectors = [
        "button[aria-label*='load more' i]",
        "button[aria-label*='show more' i]",
        "button[class*='load-more' i]",
        "a[aria-label*='load more' i]"
      ];
      let clicks = 0;
      while (clicks < ${safeMaxClicks}) {
        let clicked = false;
        for (const selector of selectors) {
          const el = document.querySelector(selector);
          if (el) {
            el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            clicked = true;
            clicks += 1;
            break;
          }
        }
        if (!clicked) {
          break;
        }
      }
    `,
  });

  actions.push({ type: "wait", milliseconds: 1200 });
  return actions;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  const rounded = Math.floor(value ?? fallback);
  return rounded > 0 ? rounded : fallback;
}

function buildSpeakerDirectoryScrapeOptions(options: ScrapeStructuredPageOptions): {
  speakerPassIndex: number;
  maxLoadMoreClicks: number;
} {
  return {
    speakerPassIndex: normalizePositiveInteger(options.speakerPassIndex, 1),
    maxLoadMoreClicks: normalizePositiveInteger(options.maxLoadMoreClicks, 1),
  };
}

function buildSpeakerDirectoryActionPlan(options: ScrapeStructuredPageOptions): FirecrawlAction[] {
  const passOptions = buildSpeakerDirectoryScrapeOptions(options);
  return buildSpeakerDirectoryActions(
    passOptions.speakerPassIndex,
    passOptions.maxLoadMoreClicks,
  );
}

type ScrapeStructuredPageOptions = {
  extractionMode?: FirecrawlExtractionMode;
  speakerPassIndex?: number;
  maxLoadMoreClicks?: number;
};

function buildSpeakerDirectoryMetadata(
  metadata: Record<string, unknown> | undefined,
  options: ScrapeStructuredPageOptions,
): Record<string, unknown> {
  const passOptions = buildSpeakerDirectoryScrapeOptions(options);
  return {
    ...(metadata ?? {}),
    extractionMode: "speakerDirectory",
    speakerPassIndex: passOptions.speakerPassIndex,
    maxLoadMoreClicks: passOptions.maxLoadMoreClicks,
  };
}

function buildSessionMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  return {
    ...(metadata ?? {}),
    extractionMode: "session",
  };
}

// The request options are passed from route orchestration to progressively
// increase interaction intensity for speaker-directory pages.
function getScrapeActions(
  extractionMode: FirecrawlExtractionMode,
  options: ScrapeStructuredPageOptions,
): FirecrawlAction[] | undefined {
  if (extractionMode !== "speakerDirectory") {
    return undefined;
  }
  return buildSpeakerDirectoryActionPlan(options);
}

// Keep this type declaration near exports for easy imports.
type ScrapeRequestOptions = ScrapeStructuredPageOptions;

function getScrapeTimeoutMs(extractionMode: FirecrawlExtractionMode): number {
  return extractionMode === "speakerDirectory"
    ? SPEAKER_DIRECTORY_SCRAPE_TIMEOUT_MS
    : DEFAULT_SCRAPE_TIMEOUT_MS;
}

function buildDebugMetadata(
  extractionMode: FirecrawlExtractionMode,
  options: ScrapeRequestOptions,
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return extractionMode === "speakerDirectory"
    ? buildSpeakerDirectoryMetadata(metadata, options)
    : buildSessionMetadata(metadata);
}

function buildActions(
  extractionMode: FirecrawlExtractionMode,
  options: ScrapeRequestOptions,
): FirecrawlAction[] | undefined {
  return getScrapeActions(extractionMode, options);
}

function normalizeScrapeOptions(
  options?: ScrapeStructuredPageOptions,
): ScrapeRequestOptions {
  return {
    extractionMode: options?.extractionMode,
    speakerPassIndex: options?.speakerPassIndex,
    maxLoadMoreClicks: options?.maxLoadMoreClicks,
  };
}

function getExtractionMode(options: ScrapeRequestOptions): FirecrawlExtractionMode {
  return options.extractionMode ?? "session";
}

function getOnlyMainContent(extractionMode: FirecrawlExtractionMode): boolean {
  return extractionMode !== "speakerDirectory";
}

function normalizeResponseMetadata(
  metadata: unknown,
): Record<string, unknown> | undefined {
  return metadata && typeof metadata === "object"
    ? (metadata as Record<string, unknown>)
    : undefined;
}

function normalizeStructuredOutput(
  extractionMode: FirecrawlExtractionMode,
  extractedJson: unknown,
  pageUrl: string,
): {
  sessions: SessionExtractedRow[];
  appearances: SpeakerAppearanceExtractedRow[];
} {
  return extractionMode === "speakerDirectory"
    ? toSpeakerDirectoryRows(parseStructuredSpeakers(extractedJson), pageUrl)
    : toSessionAndAppearances(parseStructuredSessions(extractedJson, pageUrl), pageUrl);
}

function getPromptByMode(extractionMode: FirecrawlExtractionMode): string {
  return extractionMode === "speakerDirectory"
    ? "Extract all speakers visible on this page. Return an object with `speakers` array. Each speaker should include `name`, optional `organization`, optional `title`, optional `profileWebsiteUrl`, optional `profileUrl`, optional `websiteUrl`, optional `role`."
    : "Extract conference sessions and the speakers listed for each session on this page. Return an object with `sessions` array. Each session must contain `title`, optional `url`, and `speakers` array. Each speaker item should include `name`, optional `organization`, optional `title`, optional `profileWebsiteUrl` (speaker website/profile page URL), optional `profileUrl`, optional `websiteUrl`, optional `role`.";
}

function getSchemaByMode(extractionMode: FirecrawlExtractionMode): Record<string, unknown> {
  if (extractionMode === "speakerDirectory") {
    return {
      type: "object",
      properties: {
        speakers: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              organization: { type: "string" },
              title: { type: "string" },
              profileWebsiteUrl: { type: "string" },
              profileUrl: { type: "string" },
              websiteUrl: { type: "string" },
              role: { type: "string" },
            },
            required: ["name"],
          },
        },
      },
      required: ["speakers"],
    };
  }

  return {
    type: "object",
    properties: {
      sessions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            url: { type: "string" },
            speakers: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  organization: { type: "string" },
                  title: { type: "string" },
                  profileWebsiteUrl: { type: "string" },
                  profileUrl: { type: "string" },
                  websiteUrl: { type: "string" },
                  role: { type: "string" },
                },
                required: ["name"],
              },
            },
          },
          required: ["title"],
        },
      },
    },
    required: ["sessions"],
  };
}

function parseStructuredSessions(payload: unknown, pageUrl: string): ScrapedSessionModel[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const record = payload as {
    sessions?: unknown;
    items?: unknown;
    data?: unknown;
    title?: unknown;
    speakers?: unknown;
  };

  if (Array.isArray(record.sessions)) {
    return record.sessions as ScrapedSessionModel[];
  }
  if (Array.isArray(record.items)) {
    return record.items as ScrapedSessionModel[];
  }
  if (Array.isArray(record.data)) {
    return record.data as ScrapedSessionModel[];
  }

  const singleTitle = normalizeTextValue(record.title);
  if (!singleTitle) {
    return [];
  }

  return [{ title: singleTitle, url: pageUrl, speakers: record.speakers }];
}

function parseStructuredSpeakers(payload: unknown): ScrapedSpeakerModel[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const record = payload as {
    speakers?: unknown;
    items?: unknown;
    data?: unknown;
    name?: unknown;
  };

  if (Array.isArray(record.speakers)) {
    return record.speakers as ScrapedSpeakerModel[];
  }
  if (Array.isArray(record.items)) {
    return record.items as ScrapedSpeakerModel[];
  }
  if (Array.isArray(record.data)) {
    return record.data as ScrapedSpeakerModel[];
  }

  const singleName = normalizeTextValue(record.name);
  if (!singleName) {
    return [];
  }

  return [record as ScrapedSpeakerModel];
}

function toSessionAndAppearances(
  sessions: ScrapedSessionModel[],
  pageUrl: string,
): {
  sessions: SessionExtractedRow[];
  appearances: SpeakerAppearanceExtractedRow[];
} {
  const normalizedSessions: SessionExtractedRow[] = [];
  const normalizedAppearances: SpeakerAppearanceExtractedRow[] = [];

  for (const session of sessions) {
    const sessionTitle = normalizeTextValue(session.title);
    if (!sessionTitle) {
      continue;
    }

    const sessionUrl = normalizeTextValue(session.url) ?? pageUrl;
    normalizedSessions.push({
      title: sessionTitle,
      url: sessionUrl,
    });

    const speakers = Array.isArray(session.speakers) ? session.speakers : [];
    for (const speaker of speakers) {
      if (!speaker || typeof speaker !== "object") {
        continue;
      }
      const speakerRecord = speaker as {
        name?: unknown;
        organization?: unknown;
        title?: unknown;
        profileUrl?: unknown;
        profileWebsiteUrl?: unknown;
        websiteUrl?: unknown;
        role?: unknown;
      };
      const speakerName = normalizeTextValue(speakerRecord.name);
      if (!speakerName) {
        continue;
      }

      normalizedAppearances.push({
        name: speakerName,
        organization: normalizeTextValue(speakerRecord.organization),
        title: normalizeTextValue(speakerRecord.title),
        // Accept common variants so future runs keep speaker website URLs.
        profileUrl:
          normalizeTextValue(speakerRecord.profileWebsiteUrl) ??
          normalizeTextValue(speakerRecord.websiteUrl) ??
          normalizeTextValue(speakerRecord.profileUrl),
        role: normalizeTextValue(speakerRecord.role),
        sessionUrl,
      });
    }
  }

  return {
    sessions: normalizedSessions,
    appearances: normalizedAppearances,
  };
}

function toSpeakerDirectoryRows(
  speakers: ScrapedSpeakerModel[],
  pageUrl: string,
): {
  sessions: SessionExtractedRow[];
  appearances: SpeakerAppearanceExtractedRow[];
} {
  const appearances: SpeakerAppearanceExtractedRow[] = [];

  for (const speaker of speakers) {
    const speakerName = normalizeTextValue(speaker.name);
    if (!speakerName) {
      continue;
    }

    appearances.push({
      name: speakerName,
      organization: normalizeTextValue(speaker.organization),
      title: normalizeTextValue(speaker.title),
      profileUrl:
        normalizeTextValue(speaker.profileWebsiteUrl) ??
        normalizeTextValue(speaker.websiteUrl) ??
        normalizeTextValue(speaker.profileUrl),
      role: normalizeTextValue(speaker.role),
      sessionUrl: pageUrl,
    });
  }

  const sessions =
    appearances.length === 0
      ? []
      : [
          {
            title: "Speaker Directory",
            url: pageUrl,
          },
        ];

  return { sessions, appearances };
}

export async function scrapeStructuredSessionPage(
  pageUrl: string,
  signal?: AbortSignal,
  options?: ScrapeStructuredPageOptions,
): Promise<{
  sessions: SessionExtractedRow[];
  appearances: SpeakerAppearanceExtractedRow[];
  debugArtifact: ScrapeDebugArtifact;
}> {
  const apiKey = getFirecrawlApiKey();
  const requestOptions = normalizeScrapeOptions(options);
  const extractionMode = getExtractionMode(requestOptions);
  const scrapeTimeoutMs = getScrapeTimeoutMs(extractionMode);

  const response = await fetch("https://api.firecrawl.dev/v1/scrape", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url: pageUrl,
      onlyMainContent: getOnlyMainContent(extractionMode),
      formats: ["json", "markdown", "html"],
      actions: buildActions(extractionMode, requestOptions),
      jsonOptions: {
        prompt: getPromptByMode(extractionMode),
        schema: getSchemaByMode(extractionMode),
      },
      timeout: scrapeTimeoutMs,
    }),
    cache: "no-store",
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Firecrawl scrape failed (${response.status}) for ${pageUrl}: ${errorText}`);
  }

  const payload = (await response.json()) as FirecrawlScrapeResponse;
  const extractedJson = payload.data?.json;
  const markdown = normalizeTextValue(payload.data?.markdown);
  const html = normalizeTextValue(payload.data?.html);
  const metadata = normalizeResponseMetadata(payload.data?.metadata);
  const normalized = normalizeStructuredOutput(extractionMode, extractedJson, pageUrl);

  return {
    ...normalized,
    debugArtifact: {
      url: pageUrl,
      success: true,
      rawPayload: payload,
      extractedJson,
      extractionMode,
      markdown,
      html,
      metadata: buildDebugMetadata(extractionMode, requestOptions, metadata),
    },
  };
}
