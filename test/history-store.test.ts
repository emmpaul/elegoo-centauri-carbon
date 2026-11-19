import { strict as assert } from "node:assert";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import {
  HistoryStore,
  SCHEMA_VERSION,
  encodeHistoryCursor,
  jobFromDetail,
  parseHistoryCursor,
} from "../src/history-store.ts";
import type { JobRecord } from "../src/history-store.ts";
import { loadFixture } from "./support/fake-printer.ts";

/** The 26 `HistoryDetailList` entries of `print-complete.json#28`. */
function fixtureEntries(): Record<string, unknown>[] {
  const frame = loadFixture("print-complete.json").frames.find((f) => f.seq === 28);
  const payload = frame?.payload as { Data: { Data: { HistoryDetailList: Record<string, unknown>[] } } };
  return payload.Data.Data.HistoryDetailList;
}

function records(entries: unknown[]): JobRecord[] {
  return entries.map(jobFromDetail).filter((job) => job !== null);
}

function syntheticEntry(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    Thumbnail: "http://192.0.2.10/board-resource/history_image/synthetic-1.png",
    TaskName: "/local/test-print-90.gcode",
    BeginTime: 1794600000,
    EndTime: 1794603600,
    TaskStatus: 1,
    SliceInformation: { total_layer_numbers: 50 },
    AlreadyPrintLayer: 50,
    TaskId: "synthetic-1",
    ErrorStatusReason: 0,
    ...overrides,
  };
}

const dir = mkdtempSync(join(tmpdir(), "ecc-history-"));
after(() => {
  chmodSync(dir, 0o700);
  rmSync(dir, { recursive: true, force: true });
});

let fileCount = 0;
function tempFile(): string {
  return join(dir, `history-${++fileCount}.sqlite`);
}

function versionOf(path: string): number {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  } finally {
    db.close();
  }
}

describe("HistoryStore.open", () => {
  it("knows schema version 1", () => {
    assert.equal(SCHEMA_VERSION, 1);
  });

  it("reports version 1 for a :memory: archive", () => {
    const store = HistoryStore.open(":memory:");
    assert.equal(store.schemaVersion(), 1);
    store.close();
  });

  it("creates a new file at version 1", () => {
    const path = tempFile();
    const store = HistoryStore.open(path);
    assert.equal(store.schemaVersion(), 1);
    store.close();
    assert.equal(versionOf(path), 1);
  });

  it("reopens a version 1 file unchanged", () => {
    const path = tempFile();
    HistoryStore.open(path).close();
    const before = new DatabaseSync(path, { readOnly: true });
    const schema = before.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY name").all();
    before.close();

    HistoryStore.open(path).close();
    assert.equal(versionOf(path), 1);
    const again = new DatabaseSync(path, { readOnly: true });
    assert.deepEqual(again.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY name").all(), schema);
    again.close();
  });

  it("refuses a file with a newer version and leaves it at that version", () => {
    const path = tempFile();
    const db = new DatabaseSync(path);
    db.exec("PRAGMA user_version = 2");
    db.close();

    assert.throws(
      () => HistoryStore.open(path),
      (error: Error) => {
        assert.match(error.message, /version 2/);
        assert.match(error.message, /version 1/);
        assert.ok(error.message.includes(path), error.message);
        return true;
      },
    );
    assert.equal(versionOf(path), 2);
  });

  it(
    "fails on a read-only directory naming the path and DATA_DIR",
    { skip: process.getuid?.() === 0 ? "root can write a read-only directory" : false },
    () => {
      const roDir = mkdtempSync(join(dir, "ro-"));
      chmodSync(roDir, 0o555);
      try {
        const path = join(roDir, "history.sqlite");
        assert.throws(
          () => HistoryStore.open(path),
          (error: Error) => {
            assert.ok(error.message.includes(path), error.message);
            assert.ok(error.message.includes("DATA_DIR"), error.message);
            return true;
          },
        );
      } finally {
        chmodSync(roDir, 0o700);
      }
    },
  );
});

describe("HistoryStore.upsert", () => {
  it("stores the 26 fixture entries as 26 jobs", () => {
    const store = HistoryStore.open(":memory:");
    const entries = fixtureEntries();
    assert.equal(entries.length, 26);
    assert.equal(store.upsert(records(entries)), 26);

    const jobs = entries.map((entry) => store.job(entry.TaskId as string));
    assert.ok(jobs.every((job) => job !== null));
    const stopped = jobs.filter((job) => job?.fileName === "test-print-15.gcode");
    assert.deepEqual(
      stopped.map((job) => [job?.outcome, job?.layers.printed, job?.layers.total]),
      [["stopped", 16, 19], ["stopped", 11, 19]],
    );
    store.close();
  });

  it("reads the completed fixture job in the API shape", () => {
    const store = HistoryStore.open(":memory:");
    store.upsert(records(fixtureEntries()));
    assert.deepEqual(store.job("27febebe-8552-40e8-9e82-086c014a5502"), {
      id: "27febebe-8552-40e8-9e82-086c014a5502",
      fileName: "test-print-1.gcode",
      startedAt: 1794600358000,
      endedAt: 1794604693000,
      durationSeconds: 4335,
      layers: { printed: 180, total: 180 },
      outcome: "completed",
      taskStatus: 1,
      errorCode: null,
      thumbnail: null,
    });
    store.close();
  });

  it("reads a non-zero ErrorStatusReason as failed", () => {
    const store = HistoryStore.open(":memory:");
    store.upsert(records([syntheticEntry({ ErrorStatusReason: 45 })]));
    const job = store.job("synthetic-1");
    assert.equal(job?.outcome, "failed");
    assert.equal(job?.errorCode, 45);
    assert.equal(job?.taskStatus, 1);
    store.close();
  });

  it("reads TaskStatus 4 as running with no end or duration", () => {
    const store = HistoryStore.open(":memory:");
    store.upsert(records([syntheticEntry({ TaskStatus: 4, AlreadyPrintLayer: 10 })]));
    const job = store.job("synthetic-1");
    assert.equal(job?.outcome, "running");
    assert.equal(job?.startedAt, 1794600000000);
    assert.equal(job?.endedAt, null);
    assert.equal(job?.durationSeconds, null);
    store.close();
  });

  it("counts no change when the same entries are stored again", () => {
    const store = HistoryStore.open(":memory:");
    store.upsert(records(fixtureEntries()));
    assert.equal(store.upsert(records(fixtureEntries())), 0);
    store.close();
  });

  it("counts a job whose details changed", () => {
    const store = HistoryStore.open(":memory:");
    store.upsert(records([syntheticEntry({ TaskStatus: 4 })]));
    assert.equal(store.upsert(records([syntheticEntry({ TaskStatus: 1 })])), 1);
    assert.equal(store.job("synthetic-1")?.outcome, "completed");
    store.close();
  });

  it("skips an entry without a TaskId and stores the rest", () => {
    const store = HistoryStore.open(":memory:");
    const entries: unknown[] = [
      syntheticEntry({ TaskId: undefined }),
      syntheticEntry({ TaskId: "" }),
      null,
      syntheticEntry({ TaskId: "synthetic-2" }),
      syntheticEntry({ TaskId: "synthetic-3" }),
    ];
    assert.equal(jobFromDetail(entries[0]), null);
    assert.equal(store.upsert(records(entries)), 2);
    assert.notEqual(store.job("synthetic-2"), null);
    assert.notEqual(store.job("synthetic-3"), null);
    store.close();
  });

  it("defaults missing numbers to 0 and takes the last path segment as the file name", () => {
    const job = jobFromDetail({ TaskId: "synthetic-4", TaskName: "/local/sub/test-print-91.gcode", BeginTime: "x" });
    assert.equal(job?.fileName, "test-print-91.gcode");
    assert.equal(job?.beginTime, 0);
    assert.equal(job?.layersTotal, 0);
    assert.equal(job?.thumbnailUrl, null);
  });
});

describe("HistoryStore.list", () => {
  it("pages 26 jobs as 20 then 6, newest first", () => {
    const store = HistoryStore.open(":memory:");
    const entries = fixtureEntries();
    store.upsert(records(entries));

    const first = store.list(null, 20);
    assert.equal(first.jobs.length, 20);
    assert.notEqual(first.next, null);
    const second = store.list(first.next, 20);
    assert.equal(second.jobs.length, 6);
    assert.equal(second.next, null);

    const expected = [...entries]
      .sort((a, b) => (b.BeginTime as number) - (a.BeginTime as number))
      .map((entry) => entry.TaskId);
    assert.deepEqual([...first.jobs, ...second.jobs].map((job) => job.id), expected);
    assert.equal(first.jobs[0]?.fileName, "test-print-2.gcode");
    store.close();
  });

  it("answers next null when the jobs fit exactly in one page", () => {
    const store = HistoryStore.open(":memory:");
    store.upsert(records(fixtureEntries()));
    assert.equal(store.list(null, 26).next, null);
    assert.equal(store.list(null, 25).jobs.length, 25);
    assert.notEqual(store.list(null, 25).next, null);
    store.close();
  });

  it("keeps a stable order without duplicates or gaps for equal start times", () => {
    const store = HistoryStore.open(":memory:");
    const ids = ["a-1", "b-2", "c-3", "d-4", "e-5", "f-6", "g-7"];
    store.upsert(records(ids.map((id, i) => syntheticEntry({ TaskId: id, BeginTime: i < 5 ? 1794600000 : 1794500000 }))));

    const seen: string[] = [];
    let before: string | null = null;
    for (let pages = 0; pages < 10; pages++) {
      const page = store.list(before, 2);
      seen.push(...page.jobs.map((job) => job.id));
      before = page.next;
      if (before === null) break;
    }
    assert.deepEqual(seen, ["e-5", "d-4", "c-3", "b-2", "a-1", "g-7", "f-6"]);
    store.close();
  });

  it("encodes and parses a cursor", () => {
    const cursor = { beginTime: 1794600358, taskId: "27febebe-8552-40e8-9e82-086c014a5502" };
    assert.equal(encodeHistoryCursor(cursor), "1794600358_27febebe-8552-40e8-9e82-086c014a5502");
    assert.deepEqual(parseHistoryCursor(encodeHistoryCursor(cursor)), cursor);
  });

  it("rejects malformed cursors", () => {
    const store = HistoryStore.open(":memory:");
    const bad = ["", "abc", "_id", "123_", "123", "-1_id", "1.5_id", "1234567890123_id", "123_id with space",
      "123_id;DROP", `123_${"a".repeat(65)}`, "123_id\n"];
    for (const cursor of bad) {
      assert.equal(parseHistoryCursor(cursor), null, cursor);
      assert.throws(() => store.list(cursor, 20), RangeError, cursor);
    }
    store.close();
  });

  it("rejects a limit that is not a positive integer", () => {
    const store = HistoryStore.open(":memory:");
    for (const limit of [0, -1, 1.5, Number.NaN]) assert.throws(() => store.list(null, limit), RangeError);
    store.close();
  });

  it("lists nothing from an empty archive", () => {
    const store = HistoryStore.open(":memory:");
    assert.deepEqual(store.list(null, 20), { jobs: [], next: null });
    store.close();
  });
});
