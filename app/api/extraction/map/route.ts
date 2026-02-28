import { NextResponse } from "next/server";
import { mapEventUrlsWithFirecrawl } from "@/lib/firecrawl";

type MapRequestBody = {
  eventId?: string;
  startUrl?: string;
};

export async function POST(request: Request) {
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

    const mapped = await mapEventUrlsWithFirecrawl(startUrl);

    return NextResponse.json({
      eventId,
      totalMappedUrls: mapped.totalMappedUrls,
      mappedUrls: mapped.mappedUrls,
      filteredUrls: mapped.filteredUrls,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown mapping error.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
