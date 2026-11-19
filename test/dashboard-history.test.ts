// The History section of the dashboard (web/history.ts): the row strings of
// each outcome (spec: History rows), read on UTC, and the loader that pages
// through /api/history, driven by a stub fetch and a fake observer.
process.env.TZ = "UTC";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HistoryJob } from "../src/history-store.ts";
import "./support/web-modules.ts";

const { HistoryList, historyRowView, historyStatusView } = await import("../web/history.ts");

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

/** 27 jobs, newest first, as the fake service lists them. */
const JOBS: HistoryJob[] = Array.from({ length: 27 }, (_, i) => job({ id: `job-${i + 1}`, fileName: `test-print-${i + 1}.gcode` }));

/** A stub /api/history over `jobs` that records each request; `fail` answers that status instead. */
function stubApi(jobs: HistoryJob[] = JOBS) {
  const requests: string[] = [];
  const api = {
    requests,
    jobs,
    fail: null as number | null,
    fetch(path: string): Promise<Response> {
      requests.push(path);
      if (api.fail !== null) return Promise.resolve(Response.json({ error: { code: "internal" } }, { status: api.fail }));
      const url = new URL(path, "http://x");
      const limit = Number(url.searchParams.get("limit"));
      const before = url.searchParams.get("before");
      const start = before === null ? 0 : api.jobs.findIndex((j) => j.id === before) + 1;
      const page = api.jobs.slice(start, start + limit);
      const next = start + limit < api.jobs.length ? page.at(-1)!.id : null;
      return Promise.resolve(Response.json({ jobs: page, next }));
    },
  };
  return api;
}

/** A loader over `api` with a fake observer: `scroll()` brings the end of the list into view. */
function setUpList(api = stubApi()) {
  let visible: (() => void) | null = null;
  const renders: string[] = [];
  let unauthorized = 0;
  const list = new HistoryList({
    fetch: (path) => api.fetch(path),
    observe: (callback) => {
      visible = callback;
    },
    render: (state) => renders.push(state.status),
    unauthorized: () => unauthorized++,
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return {
    list,
    api,
    renders,
    unauthorized: () => unauthorized,
    async scroll() {
      visible?.();
      await settle();
    },
  };
}

describe("history loader", () => {
  it("makes no request before the section opens", () => {
    const { api, list } = setUpList();
    assert.deepEqual(api.requests, []);
    assert.equal(list.state.status, "closed");
  });

  it("requests one page on open, and not again on a second open", async () => {
    const { api, list } = setUpList();
    await list.open();
    assert.deepEqual(api.requests, ["/api/history?limit=20"]);
    assert.equal(list.state.jobs.length, 20);
    assert.equal(list.state.status, "more");
    list.close();
    await list.open();
    assert.equal(api.requests.length, 1);
  });

  it("loads the page before the cursor at the end of the list and stops after next is null", async () => {
    const { api, list, scroll } = setUpList();
    await list.open();
    await scroll();
    assert.deepEqual(api.requests, ["/api/history?limit=20", "/api/history?limit=20&before=job-20"]);
    assert.deepEqual(list.state.jobs.map((j) => j.id), JOBS.map((j) => j.id));
    assert.equal(list.state.status, "done");
    await scroll();
    assert.equal(api.requests.length, 2);
  });

  it("sends one request at a time while the end stays in view", async () => {
    const { api, list, scroll } = setUpList();
    await list.open();
    const pending = list.more();
    await scroll();
    await pending;
    assert.equal(api.requests.length, 2);
  });

  it("shows History unavailable with Retry on an error, and Retry reloads", async () => {
    const { api, list } = setUpList();
    api.fail = 500;
    await list.open();
    assert.equal(list.state.status, "error");
    assert.deepEqual(historyStatusView(list.state.status), { message: "History unavailable", retry: true });
    api.fail = null;
    await list.retry();
    assert.deepEqual(api.requests, ["/api/history?limit=20", "/api/history?limit=20"]);
    assert.equal(list.state.jobs.length, 20);
    assert.equal(historyStatusView(list.state.status), null);
  });

  it("keeps the rows and retries the next page when it fails", async () => {
    const { api, list, scroll } = setUpList();
    await list.open();
    api.fail = 500;
    await scroll();
    assert.equal(list.state.status, "error");
    assert.equal(list.state.jobs.length, 20);
    api.fail = null;
    await list.retry();
    assert.equal(api.requests.at(-1), "/api/history?limit=20&before=job-20");
    assert.equal(list.state.jobs.length, 27);
  });

  it("shows No prints yet for an empty archive", async () => {
    const { list } = setUpList(stubApi([]));
    await list.open();
    assert.equal(list.state.status, "empty");
    assert.deepEqual(historyStatusView(list.state.status), { message: "No prints yet", retry: false });
  });

  it("reload() replaces the rows from the first page", async () => {
    const { api, list, scroll } = setUpList();
    await list.open();
    await scroll();
    api.jobs = [job({ id: "job-new", fileName: "test-print-28.gcode" }), ...JOBS];
    await list.reload();
    assert.equal(api.requests.at(-1), "/api/history?limit=20");
    assert.equal(list.state.jobs.length, 20);
    assert.equal(list.state.jobs[0]!.id, "job-new");
    assert.equal(list.state.status, "more");
  });

  it("reloads on a change while open, and on the next open after a change while closed", async () => {
    const { api, list } = setUpList();
    await list.open();
    await list.changed();
    assert.equal(api.requests.length, 2);
    list.close();
    await list.changed();
    assert.equal(api.requests.length, 2);
    await list.open();
    assert.equal(api.requests.length, 3);
  });

  it("drops an answer for a list replaced meanwhile", async () => {
    const { api, list, scroll } = setUpList();
    await list.open();
    // Hold the next-page answer (of the old 27-job list) until the reload has finished.
    const answer = api.fetch.bind(api);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    api.fetch = (path) => {
      api.fetch = answer;
      const response = answer(path);
      return held.then(() => response);
    };
    const more = list.more();
    api.jobs = JOBS.slice(0, 3);
    await list.reload();
    assert.deepEqual(list.state.jobs.map((j) => j.id), ["job-1", "job-2", "job-3"]);
    release();
    await more;
    await scroll();
    assert.deepEqual(list.state.jobs.map((j) => j.id), ["job-1", "job-2", "job-3"]);
    assert.equal(list.state.status, "done");
  });

  it("hands a 401 to the token check", async () => {
    const { api, list, unauthorized } = setUpList();
    api.fail = 401;
    await list.open();
    assert.equal(unauthorized(), 1);
  });
});
