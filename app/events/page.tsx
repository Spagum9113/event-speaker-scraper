"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import {
  deleteEventById,
  listEvents,
  updateEventBasics,
} from "@/lib/events-store";
import { EventRecord } from "@/lib/types";
import { normalizeWebsiteUrl } from "@/lib/url";

function formatDate(isoDate: string): string {
  return new Date(isoDate).toLocaleString();
}

export default function EventsPage() {
  const router = useRouter();
  // Use a lazy initializer so we read storage once for the initial render.
  const [events, setEvents] = useState<EventRecord[]>(() => listEvents());
  const [openMenuEventId, setOpenMenuEventId] = useState<string | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | null>(
    null,
  );
  const [editTargetId, setEditTargetId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editUrl, setEditUrl] = useState("");
  const [editError, setEditError] = useState("");

  function handleEdit(eventRecord: EventRecord): void {
    // Use an inline modal instead of prompt() so editing is reliable and visible.
    setEditTargetId(eventRecord.id);
    setEditName(eventRecord.name);
    setEditUrl(eventRecord.url);
    setEditError("");
    setOpenMenuEventId(null);
    setMenuPosition(null);
  }

  function handleDelete(eventRecord: EventRecord): void {
    const shouldDelete = window.confirm(
      `Delete "${eventRecord.name}"? This cannot be undone.`,
    );
    if (!shouldDelete) {
      return;
    }

    deleteEventById(eventRecord.id);
    setEvents((current) => current.filter((item) => item.id !== eventRecord.id));
    setOpenMenuEventId(null);
    setMenuPosition(null);
  }

  function handleSaveEdit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();

    if (!editTargetId) {
      return;
    }

    if (!editName.trim() || !editUrl.trim()) {
      setEditError("Name and URL cannot be empty.");
      return;
    }

    const normalizedUrl = normalizeWebsiteUrl(editUrl);
    if (!normalizedUrl) {
      setEditError("Please enter a valid website URL.");
      return;
    }

    const updated = updateEventBasics(editTargetId, {
      name: editName,
      url: normalizedUrl,
    });

    if (!updated) {
      setEditError("Could not update this event. Please try again.");
      return;
    }

    setEvents((current) =>
      current.map((item) => (item.id === updated.id ? updated : item)),
    );
    setEditTargetId(null);
    setEditError("");
  }

  return (
    <main className="mx-auto max-w-5xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Events</h1>
          <p className="text-sm text-zinc-600">
            History of created events and their latest extraction status.
          </p>
        </div>
        <Link
          href="/events/new"
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700"
        >
          New Event
        </Link>
      </div>

      <div className="rounded-lg border border-zinc-200">
        <div className="overflow-x-auto overflow-y-visible">
          <table className="w-full border-collapse text-sm">
          <thead className="bg-zinc-50">
            <tr>
              <th className="p-3 text-left font-medium">Name</th>
              <th className="p-3 text-left font-medium">URL</th>
              <th className="p-3 text-left font-medium">Latest Status</th>
              <th className="p-3 text-left font-medium">Created</th>
              <th className="p-3 text-right font-medium">Actions</th>
            </tr>
          </thead>
            <tbody>
            {events.length === 0 ? (
              <tr>
                <td className="p-3 text-zinc-600" colSpan={5}>
                  No events yet. Create your first one.
                </td>
              </tr>
            ) : (
              events.map((eventRecord) => (
                <tr
                  key={eventRecord.id}
                  onDoubleClick={() => router.push(`/events/${eventRecord.id}`)}
                  className="cursor-pointer border-t border-zinc-200"
                >
                  <td className="p-3">
                    <Link
                      href={`/events/${eventRecord.id}`}
                      className="font-medium text-zinc-900 hover:underline"
                    >
                      {eventRecord.name}
                    </Link>
                  </td>
                  <td className="p-3 text-zinc-700">{eventRecord.url}</td>
                  <td className="p-3 capitalize">{eventRecord.latestJob.status}</td>
                  <td className="p-3 text-zinc-600">
                    {formatDate(eventRecord.createdAt)}
                  </td>
                  <td
                    className="p-3 text-right"
                    onDoubleClick={(event) => event.stopPropagation()}
                  >
                    <div className="relative inline-block text-left">
                      <button
                        type="button"
                        aria-label={`Open actions for ${eventRecord.name}`}
                        onClick={(clickEvent) => {
                          clickEvent.stopPropagation();
                          const buttonRect =
                            clickEvent.currentTarget.getBoundingClientRect();

                          // Render as a fixed overlay so table overflow cannot clip it.
                          setOpenMenuEventId((current) => {
                            const isClosing = current === eventRecord.id;
                            if (isClosing) {
                              setMenuPosition(null);
                              return null;
                            }

                            setMenuPosition({
                              top: buttonRect.top - 8,
                              left: buttonRect.right,
                            });
                            return eventRecord.id;
                          });
                        }}
                        className="rounded-md border border-zinc-300 px-2 py-1 text-zinc-700 hover:bg-zinc-100"
                      >
                        ⋮
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
            </tbody>
          </table>
        </div>
      </div>

      {openMenuEventId && menuPosition ? (
        <div
          className="fixed inset-0 z-40"
          onClick={() => {
            setOpenMenuEventId(null);
            setMenuPosition(null);
          }}
        >
          <div
            className="fixed z-50 w-28 -translate-x-full -translate-y-full rounded-md border border-zinc-200 bg-white p-1 text-left shadow-md"
            style={{ top: menuPosition.top, left: menuPosition.left }}
            onClick={(clickEvent) => clickEvent.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => {
                const target = events.find((item) => item.id === openMenuEventId);
                if (!target) {
                  return;
                }
                handleEdit(target);
              }}
              className="block w-full rounded px-2 py-1 text-left text-sm text-zinc-700 hover:bg-zinc-100"
            >
              Edit
            </button>
            <button
              type="button"
              onClick={() => {
                const target = events.find((item) => item.id === openMenuEventId);
                if (!target) {
                  return;
                }
                handleDelete(target);
              }}
              className="block w-full rounded px-2 py-1 text-left text-sm text-red-600 hover:bg-red-50"
            >
              Delete
            </button>
          </div>
        </div>
      ) : null}

      {editTargetId ? (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4"
          onClick={() => setEditTargetId(null)}
        >
          <form
            onSubmit={handleSaveEdit}
            onClick={(clickEvent) => clickEvent.stopPropagation()}
            className="w-full max-w-md space-y-4 rounded-lg bg-white p-4 shadow-xl"
          >
            <h2 className="text-lg font-semibold">Edit Event</h2>

            <div>
              <label htmlFor="edit-event-name" className="mb-1 block text-sm font-medium">
                Event Name
              </label>
              <input
                id="edit-event-name"
                type="text"
                value={editName}
                onChange={(event) => setEditName(event.target.value)}
                className="w-full rounded-md border border-zinc-300 px-3 py-2"
              />
            </div>

            <div>
              <label htmlFor="edit-event-url" className="mb-1 block text-sm font-medium">
                Event URL
              </label>
              <input
                id="edit-event-url"
                type="text"
                value={editUrl}
                onChange={(event) => setEditUrl(event.target.value)}
                className="w-full rounded-md border border-zinc-300 px-3 py-2"
              />
            </div>

            {editError ? <p className="text-sm text-red-600">{editError}</p> : null}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditTargetId(null)}
                className="rounded-md border border-zinc-300 px-3 py-2 text-sm"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-700"
              >
                Save
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </main>
  );
}

