// The dashboard's History section (design D8): pure view functions that turn a
// job of the history API (docs/api.md) into the strings of its row. Besides
// types it imports only the view rules of ./view.js, so `node --test` tests it
// and the browser loads it as /history.js.
import type { HistoryJob } from "../src/history-store.ts";
import { clock, duration, type Tone } from "./view.js";

const NONE = "—";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The strings of one history row. */
export interface HistoryRowView {
  id: string;
  /** API path of the thumbnail; null shows the neutral placeholder. */
  thumbnail: string | null;
  name: string;
  /** "HH:MM" today, "D Mon HH:MM" on another day. */
  start: string;
  /** Like `start`; null while the job runs. */
  end: string | null;
  /** "1h 12m"; null while the job runs. */
  duration: string | null;
  /** "<printed> / <total>", with "—" for an unknown total. */
  layers: string;
  outcome: { label: string; tone: Tone };
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Local time as "HH:MM", with the day and month before it when it is not on `now`'s day. */
export function historyTime(ms: number | null, now: number): string {
  if (ms === null) return NONE;
  const d = new Date(ms);
  return sameDay(d, new Date(now)) ? clock(ms) : `${d.getDate()} ${MONTHS[d.getMonth()]} ${clock(ms)}`;
}

/** The outcome in words and its tone (spec: History rows). */
export function historyOutcome(job: Pick<HistoryJob, "outcome" | "errorCode" | "taskStatus">): HistoryRowView["outcome"] {
  switch (job.outcome) {
    case "completed":
      return { label: "Completed", tone: "ok" };
    case "stopped":
      return { label: "Stopped", tone: "warn" };
    case "running":
      return { label: "Printing", tone: "info" };
    case "failed": {
      const code = job.errorCode;
      return { label: `Error ${code ?? NONE}${code === 45 ? " · filament low" : ""}`, tone: "bad" };
    }
    default:
      return { label: `Unknown (${job.taskStatus})`, tone: "neutral" };
  }
}

/** One row of the History section. */
export function historyRowView(job: HistoryJob, now: number): HistoryRowView {
  const running = job.outcome === "running";
  return {
    id: job.id,
    thumbnail: job.thumbnail,
    name: job.fileName || NONE,
    start: historyTime(job.startedAt, now),
    end: running ? null : historyTime(job.endedAt, now),
    duration: running ? null : duration(job.durationSeconds),
    layers: `${job.layers.printed} / ${job.layers.total > 0 ? job.layers.total : NONE}`,
    outcome: historyOutcome(job),
  };
}

// ---- Loader (design D8) ----

/** Jobs per page the section asks for (the API's default). */
export const HISTORY_PAGE_SIZE = 20;

/**
 * Where the list stands: `loading` the first page, `more` (a next page
 * exists), `done` (the last page is in), `empty` (no jobs at all), or `error`
 * (the last request failed; Retry repeats it).
 */
export type HistoryStatus = "closed" | "loading" | "more" | "done" | "empty" | "error";

export interface HistoryState {
  jobs: HistoryJob[];
  status: HistoryStatus;
}

/** The status line under the list: its text, and whether it shows Retry; null hides it. */
export function historyStatusView(status: HistoryStatus): { message: string; retry: boolean } | null {
  switch (status) {
    case "loading":
      return { message: "Loading…", retry: false };
    case "empty":
      return { message: "No prints yet", retry: false };
    case "error":
      return { message: "History unavailable", retry: true };
    default:
      return null;
  }
}

/** What the loader needs from the page. */
export interface HistoryHost {
  /** Fetch with the access token. */
  fetch(path: string): Promise<Response>;
  /** Calls `visible` whenever the end of the list scrolls into view. */
  observe(visible: () => void): void;
  /** The state changed: render the list again. */
  render(state: HistoryState): void;
  /** The service answered 401: check the token again. */
  unauthorized(): void;
}

/**
 * Loads the history page by page while the section is open: the first page
 * once on open, the next one when the end of the list comes into view (one
 * request at a time, until `next` is null), and the first page again on
 * `reload()`. It touches no DOM, so `node --test` drives it with a stub fetch.
 */
export class HistoryList {
  state: HistoryState = { jobs: [], status: "closed" };
  #host: HistoryHost;
  #next: string | null = null;
  #open = false;
  /** Whether the list shows the archive's current first page; false after a change while closed. */
  #loaded = false;
  #inFlight = false;
  /** Counts first-page loads, so an answer for a replaced list is dropped. */
  #generation = 0;

  constructor(host: HistoryHost) {
    this.#host = host;
    host.observe(() => void this.more());
  }

  /** The section opened: loads the first page unless the list is current. */
  open(): Promise<void> {
    this.#open = true;
    return this.#loaded ? Promise.resolve() : this.reload();
  }

  /** The section closed: nothing loads until it opens again. */
  close(): void {
    this.#open = false;
  }

  /** The archive changed: reloads the first page while open, else on the next open. */
  changed(): Promise<void> {
    this.#loaded = false;
    return this.#open ? this.reload() : Promise.resolve();
  }

  /** Replaces the list with the archive's first page. */
  reload(): Promise<void> {
    this.#loaded = true;
    this.#next = null;
    const generation = ++this.#generation;
    this.#inFlight = false;
    if (this.state.jobs.length === 0) this.#set({ jobs: [], status: "loading" });
    return this.#load(null, generation);
  }

  /** The end of the list is in view: loads the next page, if there is one and none is loading. */
  more(): Promise<void> {
    if (!this.#open || this.#inFlight || this.state.status !== "more" || this.#next === null) return Promise.resolve();
    return this.#load(this.#next, this.#generation);
  }

  /** Repeats the request that failed: the first page when nothing is shown, else the next one. */
  retry(): Promise<void> {
    if (this.state.jobs.length === 0 || this.#next === null) return this.reload();
    this.#set({ jobs: this.state.jobs, status: "more" });
    return this.more();
  }

  async #load(before: string | null, generation: number): Promise<void> {
    this.#inFlight = true;
    const query = new URLSearchParams({ limit: String(HISTORY_PAGE_SIZE) });
    if (before !== null) query.set("before", before);
    let page: { jobs: HistoryJob[]; next: string | null } | null = null;
    let unauthorized = false;
    try {
      const response = await this.#host.fetch(`/api/history?${query}`);
      if (response.status === 401) unauthorized = true;
      else if (response.ok) {
        const body = (await response.json()) as { jobs?: unknown; next?: unknown };
        if (Array.isArray(body.jobs) && (typeof body.next === "string" || body.next === null)) {
          page = { jobs: body.jobs as HistoryJob[], next: body.next };
        }
      }
    } catch {
      page = null;
    }
    if (generation !== this.#generation) return; // reloaded meanwhile
    this.#inFlight = false;
    if (unauthorized) this.#host.unauthorized();
    if (page === null) {
      this.#set({ jobs: before === null ? [] : this.state.jobs, status: "error" });
      return;
    }
    const jobs = before === null ? page.jobs : [...this.state.jobs, ...page.jobs];
    this.#next = page.next;
    this.#set({ jobs, status: jobs.length === 0 ? "empty" : page.next === null ? "done" : "more" });
  }

  #set(state: HistoryState): void {
    this.state = state;
    this.#host.render(state);
  }
}
