export type JobStatus =
  | "queued"
  | "crawling"
  | "extracting"
  | "saving"
  | "complete"
  | "failed";

export type JobCounters = {
  totalUrlsMapped: number;
  urlsDiscovered: number;
  pagesProcessed: number;
  sessionsFound: number;
  speakerAppearancesFound: number;
  uniqueSpeakersFound: number;
};

export type SpeakerRow = {
  id: string;
  name: string;
  organization: string;
  title?: string;
  profileUrl?: string;
};

export type SessionRow = {
  id: string;
  title: string;
  url: string;
};

export type EventJob = {
  status: JobStatus;
  counters: JobCounters;
  logLines: string[];
  mappedUrls: string[];
  filteredUrls: string[];
  processedUrls: string[];
  updatedAt: string;
};

export type EventRecord = {
  id: string;
  name: string;
  url: string;
  createdAt: string;
  latestJob: EventJob;
  sessions: SessionRow[];
  speakers: SpeakerRow[];
};

