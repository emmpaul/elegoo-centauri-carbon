// The History section of the dashboard (web/history.ts): the row strings of
// each outcome (spec: History rows), read on UTC.
process.env.TZ = "UTC";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HistoryJob } from "../src/history-store.ts";
import "./support/web-modules.ts";

const { historyRowView } = await import("../web/history.ts");

/** The references' "now": 2026-11-13 21:20:00 UTC. */
const NOW = Date.UTC(2026, 10, 13, 21, 20, 0);

/** The completed job of the spec's scenario, with a variant's fields on top. */
function job(patch: Partial<HistoryJob> = {}): HistoryJob {
  return {
    id: "job-1",
    fileName: "test-print-1.gcode",
    startedAt: Date.UTC(2026, 10, 13, 20, 5, 58),
    endedAt: Date.UTC(2026, 10, 13, 21, 18, 13),
    durationSeconds: 4335,
    layers: { printed: 180, total: 180 },
    outcome: "completed",
    taskStatus: 1,
    errorCode: null,
    thumbnail: "/api/history/thumbnail?id=job-1",
    ...patch,
  };
}

describe("history rows", () => {
  it("shows a completed job of today", () => {
    assert.deepEqual(historyRowView(job(), NOW), {
      id: "job-1",
      thumbnail: "/api/history/thumbnail?id=job-1",
      name: "test-print-1.gcode",
      start: "20:05",
      end: "21:18",
      duration: "1h 12m",
      layers: "180 / 180",
      outcome: { label: "Completed", tone: "ok" },
    });
  });

  it("puts the day and month before a time on an earlier day", () => {
    const row = historyRowView(job(), Date.UTC(2026, 10, 14, 9, 0, 0));
    assert.equal(row.start, "13 Nov 20:05");
    assert.equal(row.end, "13 Nov 21:18");
  });

  it("names filament low for error 45 in the error tone", () => {
    const row = historyRowView(job({ outcome: "failed", taskStatus: 3, errorCode: 45 }), NOW);
    assert.deepEqual(row.outcome, { label: "Error 45 · filament low", tone: "bad" });
    assert.deepEqual(historyRowView(job({ outcome: "failed", errorCode: 12 }), NOW).outcome, { label: "Error 12", tone: "bad" });
  });

  it("reads Stopped for a stopped job", () => {
    const row = historyRowView(job({ outcome: "stopped", taskStatus: 3, layers: { printed: 16, total: 19 } }), NOW);
    assert.deepEqual(row.outcome, { label: "Stopped", tone: "warn" });
    assert.equal(row.layers, "16 / 19");
  });

  it("reads Printing with no end or duration while running", () => {
    const row = historyRowView(job({ outcome: "running", taskStatus: 4, endedAt: null, durationSeconds: null }), NOW);
    assert.deepEqual(row.outcome, { label: "Printing", tone: "info" });
    assert.equal(row.start, "20:05");
    assert.equal(row.end, null);
    assert.equal(row.duration, null);
  });

  it("shows a dash for an unknown layer total", () => {
    assert.equal(historyRowView(job({ layers: { printed: 12, total: 0 } }), NOW).layers, "12 / —");
  });

  it("names an unknown task status in the neutral tone", () => {
    assert.deepEqual(historyRowView(job({ outcome: "unknown", taskStatus: 7 }), NOW).outcome, { label: "Unknown (7)", tone: "neutral" });
  });

  it("leaves the thumbnail null for the placeholder", () => {
    assert.equal(historyRowView(job({ thumbnail: null }), NOW).thumbnail, null);
  });
});
