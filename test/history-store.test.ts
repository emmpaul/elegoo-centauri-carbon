import { strict as assert } from "node:assert";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import { HistoryStore, SCHEMA_VERSION } from "../src/history-store.ts";

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
