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
