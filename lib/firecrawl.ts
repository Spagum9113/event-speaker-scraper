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
  markdown?: string;
  html?: string;
  metadata?: Record<string, unknown>;
  error?: string;
};

type ScrapedSessionModel = {
  title?: unknown;
  url?: unknown;
  speakers?: unknown;
};

const SESSION_URL_KEYWORDS = [
  "agenda",
  "schedule",
  "session",
  "sessions",
  "program",
  "speaker",
  "speakers",
];

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

export async function scrapeStructuredSessionPage(
  pageUrl: string,
  signal?: AbortSignal,
): Promise<{
  sessions: SessionExtractedRow[];
  appearances: SpeakerAppearanceExtractedRow[];
  debugArtifact: ScrapeDebugArtifact;
}> {
  const apiKey = getFirecrawlApiKey();

  const response = await fetch("https://api.firecrawl.dev/v1/scrape", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url: pageUrl,
      onlyMainContent: true,
      formats: ["json", "markdown", "html"],
      jsonOptions: {
        prompt:
          "Extract conference sessions and the speakers listed for each session on this page. Return an object with `sessions` array. Each session must contain `title`, optional `url`, and `speakers` array. Each speaker item should include `name`, optional `organization`, optional `title`, optional `profileWebsiteUrl` (speaker website/profile page URL), optional `profileUrl`, optional `websiteUrl`, optional `role`.",
        schema: {
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
        },
      },
      timeout: 30000,
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
  const metadata =
    payload.data?.metadata && typeof payload.data.metadata === "object"
      ? (payload.data.metadata as Record<string, unknown>)
      : undefined;
  const sessions = parseStructuredSessions(extractedJson, pageUrl);
  const normalized = toSessionAndAppearances(sessions, pageUrl);

  return {
    ...normalized,
    debugArtifact: {
      url: pageUrl,
      success: true,
      rawPayload: payload,
      extractedJson,
      markdown,
      html,
      metadata,
    },
  };
}
