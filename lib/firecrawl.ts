type FirecrawlMapResponse = {
  success?: boolean;
  links?: unknown;
  data?: {
    links?: unknown;
  } | unknown;
};

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
}> {
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
