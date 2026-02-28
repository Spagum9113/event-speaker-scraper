import { chromium } from "playwright";
import type {
  ScrapeDebugArtifact,
  SessionExtractedRow,
  SpeakerAppearanceExtractedRow,
} from "@/lib/firecrawl";

type SpeakerCandidate = {
  name: string;
  organization?: string;
  title?: string;
  profileUrl?: string;
  role?: string;
};

type JsonApiResponseCapture = {
  url: string;
  status: number;
  payload: unknown;
};

export type ApiStrategyResult = {
  sessions: SessionExtractedRow[];
  appearances: SpeakerAppearanceExtractedRow[];
  artifacts: ScrapeDebugArtifact[];
  stopReason: string;
  endpointUrl?: string;
};

type PaginationStyle = "none" | "page" | "offset";

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isSpeakerLikeObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const hasName = !!normalizeText(record.name ?? record.fullName ?? record.displayName);
  const hasSupportSignal =
    !!normalizeText(
      record.organization ??
        record.company ??
        record.title ??
        record.jobTitle ??
        record.profileUrl ??
        record.profileURL ??
        record.websiteUrl ??
        record.url,
    ) ||
    typeof record.id === "string" ||
    typeof record.id === "number";
  return hasName && hasSupportSignal;
}

function toSpeakerCandidate(value: Record<string, unknown>): SpeakerCandidate {
  const name =
    normalizeText(value.name) ??
    normalizeText(value.fullName) ??
    normalizeText(value.displayName) ??
    "Unknown";
  return {
    name,
    organization:
      normalizeText(value.organization) ??
      normalizeText(value.company) ??
      normalizeText(value.employer),
    title: normalizeText(value.title) ?? normalizeText(value.jobTitle),
    profileUrl:
      normalizeText(value.profileUrl) ??
      normalizeText(value.profileURL) ??
      normalizeText(value.websiteUrl) ??
      normalizeText(value.url) ??
      normalizeText(value.link),
    role: normalizeText(value.role),
  };
}

function collectSpeakerCandidates(payload: unknown): SpeakerCandidate[] {
  const out: SpeakerCandidate[] = [];
  const stack: unknown[] = [payload];
  let traversed = 0;

  while (stack.length > 0 && traversed < 5000) {
    traversed += 1;
    const current = stack.pop();
    if (Array.isArray(current)) {
      for (const item of current) {
        stack.push(item);
      }
      continue;
    }
    if (!current || typeof current !== "object") {
      continue;
    }
    if (isSpeakerLikeObject(current)) {
      out.push(toSpeakerCandidate(current));
    }
    for (const value of Object.values(current as Record<string, unknown>)) {
      if (value && typeof value === "object") {
        stack.push(value);
      }
    }
  }

  return out;
}

function appearanceKey(candidate: SpeakerCandidate): string {
  const profile = candidate.profileUrl?.trim().toLowerCase();
  if (profile) {
    return `profile::${profile}`;
  }
  const normalizedName = (candidate.name ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const normalizedOrg = (candidate.organization ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `nameorg::${normalizedName}::${normalizedOrg}`;
}

function detectPagination(urlValue: string): {
  style: PaginationStyle;
  pageParam?: string;
  offsetParam?: string;
  step?: number;
} {
  try {
    const parsed = new URL(urlValue);
    const params = parsed.searchParams;
    for (const key of ["page", "p"]) {
      if (params.has(key)) {
        return { style: "page", pageParam: key, step: 1 };
      }
    }
    for (const key of ["offset", "start", "from"]) {
      if (params.has(key)) {
        const limit =
          Number(params.get("limit")) ||
          Number(params.get("pageSize")) ||
          Number(params.get("per_page")) ||
          Number(params.get("size")) ||
          20;
        return { style: "offset", offsetParam: key, step: limit };
      }
    }
  } catch {
    // ignore invalid URLs
  }
  return { style: "none" };
}

function toArtifacts(
  captures: JsonApiResponseCapture[],
  pageUrl: string,
  passLabel: string,
): ScrapeDebugArtifact[] {
  return captures.slice(0, 30).map((capture) => ({
    url: pageUrl,
    success: true,
    rawPayload: capture.payload,
    extractedJson: capture.payload,
    extractionMode: "speakerDirectory",
    metadata: {
      strategy: "apiProbe",
      pass: passLabel,
      responseUrl: capture.url,
      status: capture.status,
    },
  }));
}

export async function runBrowserApiStrategy(
  pageUrl: string,
  signal: AbortSignal | undefined,
  appendLogLine: (message: string) => void,
): Promise<ApiStrategyResult | null> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const captures: JsonApiResponseCapture[] = [];
  const unique = new Map<string, SpeakerAppearanceExtractedRow>();

  page.on("response", async (response) => {
    try {
      const contentType = response.headers()["content-type"] ?? "";
      if (!contentType.toLowerCase().includes("json")) {
        return;
      }
      const payload = await response.json();
      const candidates = collectSpeakerCandidates(payload);
      if (candidates.length === 0) {
        return;
      }

      captures.push({ url: response.url(), status: response.status(), payload });
      for (const candidate of candidates) {
        const key = appearanceKey(candidate);
        if (!unique.has(key)) {
          unique.set(key, {
            name: candidate.name,
            organization: candidate.organization,
            title: candidate.title,
            profileUrl: candidate.profileUrl,
            role: candidate.role,
            sessionUrl: pageUrl,
          });
        }
      }
    } catch {
      // ignore non-json / parse errors
    }
  });

  try {
    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForTimeout(2500);

    for (let pass = 1; pass <= 6; pass += 1) {
      if (signal?.aborted) {
        break;
      }
      await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
        const selectors = [
          "button[aria-label*='load more' i]",
          "button[aria-label*='show more' i]",
          "button[class*='load-more' i]",
          "a[aria-label*='load more' i]",
        ];
        for (const selector of selectors) {
          const element = document.querySelector(selector) as HTMLElement | null;
          if (element) {
            element.click();
            break;
          }
        }
      });
      await page.waitForTimeout(1800);
    }

    const bestCapture = captures.reduce<JsonApiResponseCapture | null>((best, current) => {
      if (!best) {
        return current;
      }
      const currentCount = collectSpeakerCandidates(current.payload).length;
      const bestCount = collectSpeakerCandidates(best.payload).length;
      return currentCount > bestCount ? current : best;
    }, null);

    let stopReason = "network_probe_only";
    if (bestCapture) {
      const pagination = detectPagination(bestCapture.url);
      if (pagination.style !== "none") {
        let stagnantPasses = 0;
        let index = 1;
        while (index <= 50 && stagnantPasses < 2 && !signal?.aborted) {
          index += 1;
          try {
            const nextUrl = new URL(bestCapture.url);
            if (pagination.style === "page" && pagination.pageParam) {
              nextUrl.searchParams.set(pagination.pageParam, String(index));
            } else if (pagination.style === "offset" && pagination.offsetParam) {
              nextUrl.searchParams.set(
                pagination.offsetParam,
                String((index - 1) * (pagination.step ?? 20)),
              );
            }

            const response = await page.request.get(nextUrl.toString(), { timeout: 30000 });
            if (!response.ok()) {
              stagnantPasses += 1;
              continue;
            }
            const payload = await response.json();
            const candidates = collectSpeakerCandidates(payload);
            captures.push({ url: nextUrl.toString(), status: response.status(), payload });
            const before = unique.size;
            for (const candidate of candidates) {
              const key = appearanceKey(candidate);
              if (!unique.has(key)) {
                unique.set(key, {
                  name: candidate.name,
                  organization: candidate.organization,
                  title: candidate.title,
                  profileUrl: candidate.profileUrl,
                  role: candidate.role,
                  sessionUrl: pageUrl,
                });
              }
            }
            const added = unique.size - before;
            stagnantPasses = added === 0 ? stagnantPasses + 1 : 0;
          } catch {
            stagnantPasses += 1;
          }
        }
        stopReason = "api_pagination_exhausted";
      }
    }

    const appearances = Array.from(unique.values());
    if (appearances.length === 0) {
      return null;
    }

    appendLogLine(`API probe strategy captured ${appearances.length} unique speakers.`);
    return {
      sessions: [{ title: "Speaker Directory", url: pageUrl }],
      appearances,
      artifacts: toArtifacts(captures, pageUrl, "api_probe"),
      stopReason,
      endpointUrl: bestCapture?.url,
    };
  } finally {
    await context.close();
    await browser.close();
  }
}
