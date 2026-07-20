import { beforeEach, describe, expect, it, vi } from "vitest";

const databaseHarness = vi.hoisted(() => ({
  operations: [] as string[],
  schemaVersion: 1,
}));

vi.mock("node:fs", () => ({ mkdirSync: vi.fn() }));
vi.mock("node:sqlite", () => ({
  DatabaseSync: class FakeDatabaseSync {
    exec(sql: string): void {
      databaseHarness.operations.push(sql);
      if (sql === "BEGIN IMMEDIATE") {
        databaseHarness.schemaVersion = 2;
      }
      if (sql.includes("ALTER TABLE repositories")) {
        throw new Error("duplicate column name: mirror_size_bytes");
      }
    }

    prepare(sql: string): { get: () => { user_version: number } } {
      databaseHarness.operations.push(`PREPARE ${sql}`);
      return {
        get: () => ({ user_version: databaseHarness.schemaVersion }),
      };
    }

    close(): void {}
  },
}));

import { openStore } from "../lib/store";

beforeEach(() => {
  databaseHarness.operations.length = 0;
  databaseHarness.schemaVersion = 1;
});

describe("store initialization", () => {
  it("rechecks the schema after acquiring the migration lock", () => {
    const store = openStore("/tmp/mirrormirror-schema-race-test");
    store.close();

    const beginIndex = databaseHarness.operations.indexOf("BEGIN IMMEDIATE");
    const versionReadIndex = databaseHarness.operations.indexOf(
      "PREPARE PRAGMA user_version",
    );
    expect(beginIndex).toBeGreaterThanOrEqual(0);
    expect(versionReadIndex).toBeGreaterThan(beginIndex);
    expect(
      databaseHarness.operations.some((operation) =>
        operation.includes("ALTER TABLE repositories"),
      ),
    ).toBe(false);
  });
});
