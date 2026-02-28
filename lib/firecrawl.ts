type FirecrawlMapResponse = {
  success?: boolean;
  links?: unknown;
  data?: {
    links?: unknown;
  } | unknown;
};

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
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

export function filterMappedUrls(startUrl: string, mappedUrls: string[]): string[] {
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
    if (parsed.hostname.toLowerCase() !== originHost) {
      continue;
    }
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
