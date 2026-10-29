import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

// D1 enforces foreign keys and ignores PRAGMA foreign_keys = OFF. The
// supported way to rebuild a parent table is PRAGMA defer_foreign_keys.
describe("D1 migrations", () => {
  it("applies every migration with foreign keys left on", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    const dir = join(process.cwd(), "migrations");
    const files = readdirSync(dir)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const sql = readFileSync(join(dir, file), "utf8");
      expect(sql, file).not.toMatch(/^\s*PRAGMA\s+foreign_keys\s*=\s*OFF/im);
      db.exec("BEGIN");
      db.exec(sql);
      db.exec("COMMIT");
    }
    const on = db.prepare("PRAGMA foreign_keys").get() as {
      foreign_keys: number;
    };
    expect(on.foreign_keys).toBe(1);
    expect(() =>
      db.exec(
        "INSERT INTO segments (id, item_id, position, text) VALUES ('orphan', 'missing-item', 0, 'no')",
      ),
    ).toThrow(/FOREIGN KEY/i);
    const parked = db
      .prepare(
        "SELECT COUNT(*) AS n FROM items WHERE approved_x_user_id IS NOT NULL",
      )
      .get() as { n: number };
    expect(parked.n).toBe(0);
  });

  it("keeps items, segments, media, audit, and attempts across every rebuild", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    const dir = join(process.cwd(), "migrations");
    const files = readdirSync(dir)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    const one = (sql: string) =>
      db.prepare(sql).get() as Record<string, unknown>;
    for (const file of files) {
      if (file.startsWith("0004")) seedBefore0004(db);
      if (file.startsWith("0006")) seedBefore0006(db);
      if (file.startsWith("0007")) seedBefore0007(db);
      db.exec("BEGIN");
      db.exec(readFileSync(join(dir, file), "utf8"));
      db.exec("COMMIT");
      if (file.startsWith("0004")) expectSurvived0004(one);
      if (file.startsWith("0006")) expectSurvived0006(one);
      if (file.startsWith("0007")) expectSurvived0007(one);
    }
    expect(
      (db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number })
        .foreign_keys,
    ).toBe(1);
    expect(() =>
      db.exec(
        "INSERT INTO segments (id, item_id, position, text) VALUES ('orphan', 'missing-item', 0, 'no')",
      ),
    ).toThrow(/FOREIGN KEY/i);
    expect(() =>
      db.exec(
        "INSERT INTO post_attempts (id, segment_id, item_id, lease_id, started_at) VALUES ('bad-attempt', 'seg-6', 'missing-item', 'lease', 1)",
      ),
    ).toThrow(/FOREIGN KEY/i);
  });
});

function seedBefore0004(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO items (
      id, kind, status, source, content_hash, created_at, updated_at, review_stage, missed
    ) VALUES ('item-4', 'post', 'needs_review', 'you', 'hash-4', 10, 11, 'awaiting_paul', 0)`,
  ).run();
  db.prepare(
    `INSERT INTO segments (id, item_id, position, text)
     VALUES ('seg-4', 'item-4', 0, 'segment four')`,
  ).run();
  db.prepare(
    `INSERT INTO media (id, item_id, segment_id, r2_key, mime, bytes, alt_text)
     VALUES ('med-4', 'item-4', 'seg-4', 'r2/four', 'image/png', 4, 'alt four')`,
  ).run();
  db.prepare(
    `INSERT INTO audit_log (id, item_id, actor, action, from_status, to_status, content_hash, at)
     VALUES ('aud-4', 'item-4', 'you', 'create', NULL, 'needs_review', 'hash-4', 12)`,
  ).run();
}

function seedBefore0006(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO items (
      id, kind, status, source, content_hash, created_at, updated_at, review_stage, missed
    ) VALUES ('item-6', 'thread', 'scheduled', 'paul', 'hash-6', 20, 21, 'awaiting_paul', 0)`,
  ).run();
  db.prepare(
    `INSERT INTO segments (id, item_id, position, text, x_post_id)
     VALUES ('seg-6', 'item-6', 0, 'segment six', 'post-6')`,
  ).run();
  db.prepare(
    `INSERT INTO media (
      id, item_id, segment_id, position, r2_key, mime, bytes, alt_text
    ) VALUES ('med-6', 'item-6', 'seg-6', 0, 'r2/six', 'image/png', 6, 'alt six')`,
  ).run();
  db.prepare(
    `INSERT INTO audit_log (id, item_id, actor, action, content_hash, at)
     VALUES ('aud-6', 'item-6', 'you', 'approve', 'hash-6', 22)`,
  ).run();
  db.prepare(
    `INSERT INTO post_attempts (id, segment_id, item_id, lease_id, started_at, outcome)
     VALUES ('att-6', 'seg-6', 'item-6', 'lease-6', 23, 'posted')`,
  ).run();
}

function seedBefore0007(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO items (
      id, kind, status, source, content_hash, approved_hash, created_at, updated_at,
      review_stage, missed
    ) VALUES (
      'item-7', 'post', 'scheduled', 'you', 'hash-7', 'hash-7', 30, 31, 'draft', 0
    )`,
  ).run();
  db.prepare(
    `INSERT INTO segments (id, item_id, position, text)
     VALUES ('seg-7', 'item-7', 0, 'segment seven')`,
  ).run();
  db.prepare(
    `INSERT INTO media (
      id, item_id, segment_id, position, r2_key, mime, bytes, alt_text
    ) VALUES ('med-7', 'item-7', 'seg-7', 0, 'r2/seven', 'image/png', 7, 'alt seven')`,
  ).run();
  db.prepare(
    `INSERT INTO audit_log (id, item_id, actor, action, content_hash, at)
     VALUES ('aud-7', 'item-7', 'you', 'schedule', 'hash-7', 32)`,
  ).run();
  db.prepare(
    `INSERT INTO post_attempts (id, segment_id, item_id, lease_id, started_at)
     VALUES ('att-7', 'seg-7', 'item-7', 'lease-7', 33)`,
  ).run();
}

function expectSurvived0004(
  one: (sql: string) => Record<string, unknown>,
): void {
  expect(
    one(
      "SELECT status, needs_reason, review_stage FROM items WHERE id = 'item-4'",
    ),
  ).toEqual({
    status: "needs_you",
    needs_reason: "unknown",
    review_stage: "awaiting_paul",
  });
  expect(one("SELECT item_id, text FROM segments WHERE id = 'seg-4'")).toEqual({
    item_id: "item-4",
    text: "segment four",
  });
  expect(
    one(
      "SELECT item_id, segment_id, alt_text, position FROM media WHERE id = 'med-4'",
    ),
  ).toEqual({
    item_id: "item-4",
    segment_id: "seg-4",
    alt_text: "alt four",
    position: 0,
  });
  expect(
    one("SELECT item_id, action FROM audit_log WHERE id = 'aud-4'"),
  ).toEqual({
    item_id: "item-4",
    action: "create",
  });
}

function expectSurvived0006(
  one: (sql: string) => Record<string, unknown>,
): void {
  expect(
    one("SELECT status, source, review_stage FROM items WHERE id = 'item-6'"),
  ).toEqual({
    status: "scheduled",
    source: "you",
    review_stage: "needs_approval",
  });
  expect(
    one("SELECT item_id, text, x_post_id FROM segments WHERE id = 'seg-6'"),
  ).toEqual({
    item_id: "item-6",
    text: "segment six",
    x_post_id: "post-6",
  });
  expect(
    one("SELECT item_id, segment_id, alt_text FROM media WHERE id = 'med-6'"),
  ).toEqual({
    item_id: "item-6",
    segment_id: "seg-6",
    alt_text: "alt six",
  });
  expect(
    one("SELECT item_id, action FROM audit_log WHERE id = 'aud-6'"),
  ).toEqual({
    item_id: "item-6",
    action: "approve",
  });
  expect(
    one(
      "SELECT segment_id, item_id, outcome FROM post_attempts WHERE id = 'att-6'",
    ),
  ).toEqual({
    segment_id: "seg-6",
    item_id: "item-6",
    outcome: "posted",
  });
  expect(one("SELECT text FROM segments WHERE id = 'seg-4'").text).toBe(
    "segment four",
  );
  expect(one("SELECT alt_text FROM media WHERE id = 'med-4'").alt_text).toBe(
    "alt four",
  );
  expect(one("SELECT action FROM audit_log WHERE id = 'aud-4'").action).toBe(
    "create",
  );
}

function expectSurvived0007(
  one: (sql: string) => Record<string, unknown>,
): void {
  const item = one(
    "SELECT status, approved_hash, approved_x_user_id FROM items WHERE id = 'item-7'",
  );
  expect(item.status).toBe("needs_you");
  expect(item.approved_hash).toBeNull();
  expect(item.approved_x_user_id).toBeNull();
  expect(one("SELECT item_id, text FROM segments WHERE id = 'seg-7'")).toEqual({
    item_id: "item-7",
    text: "segment seven",
  });
  expect(one("SELECT item_id, alt_text FROM media WHERE id = 'med-7'")).toEqual(
    {
      item_id: "item-7",
      alt_text: "alt seven",
    },
  );
  expect(one("SELECT item_id FROM audit_log WHERE id = 'aud-7'").item_id).toBe(
    "item-7",
  );
  expect(
    one("SELECT item_id, outcome FROM post_attempts WHERE id = 'att-7'"),
  ).toEqual({
    item_id: "item-7",
    outcome: null,
  });
  expect(one("SELECT id FROM items WHERE id = 'item-4'").id).toBe("item-4");
  expect(one("SELECT id FROM items WHERE id = 'item-6'").id).toBe("item-6");
  expect(one("SELECT text FROM segments WHERE id = 'seg-6'").text).toBe(
    "segment six",
  );
  expect(
    one("SELECT outcome FROM post_attempts WHERE id = 'att-6'").outcome,
  ).toBe("posted");
}
