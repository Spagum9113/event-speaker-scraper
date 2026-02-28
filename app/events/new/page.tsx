"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import { createEvent } from "@/lib/events-store";
import { normalizeWebsiteUrl } from "@/lib/url";

export default function NewEventPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    // Small validation keeps user feedback fast before backend validation exists.
    if (!name.trim() || !url.trim()) {
      setError("Event name and URL are required.");
      return;
    }

    const normalizedUrl = normalizeWebsiteUrl(url);
    if (!normalizedUrl) {
      setError("Please enter a valid website URL.");
      return;
    }

    try {
      setIsSubmitting(true);
      const created = await createEvent(name, normalizedUrl);
      router.push(`/events/${created.id}`);
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "Could not create event. Please try again.",
      );
      setIsSubmitting(false);
    }
  }

  return (
    <main className="mx-auto max-w-3xl p-6">
      <div className="mb-6">
        <Link href="/events" className="text-sm text-zinc-600 hover:underline">
          ← Back to Events
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">New Event</h1>
      </div>

      <form onSubmit={onSubmit} className="space-y-4 rounded-lg border p-4">
        <div>
          <label htmlFor="event-name" className="mb-1 block text-sm font-medium">
            Event Name
          </label>
          <input
            id="event-name"
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="w-full rounded-md border border-zinc-300 px-3 py-2"
            placeholder="RSA Conference 2026"
          />
        </div>

        <div>
          <label htmlFor="event-url" className="mb-1 block text-sm font-medium">
            Event Website URL
          </label>
          <input
            id="event-url"
            // Use text so users can enter values like "www.site.com" and we normalize.
            type="text"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            className="w-full rounded-md border border-zinc-300 px-3 py-2"
            placeholder="https://example-conference.com"
          />
        </div>

        {error ? <p className="text-sm text-red-600">{error}</p> : null}

        <button
          type="submit"
          disabled={isSubmitting}
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:bg-zinc-400"
        >
          {isSubmitting ? "Creating..." : "Run Extraction"}
        </button>
      </form>
    </main>
  );
}

