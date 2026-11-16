import { DatabaseSync } from "node:sqlite";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PreparedStatement } from "./types";

type Row = Record<string, unknown>;
type SQLiteValue = null | number | bigint | string | NodeJS.ArrayBufferView;

export interface SQLiteResult {
  meta: { changes: number; last_row_id: number };
}

export class SQLiteDatabase {
  readonly raw: DatabaseSync;

  constructor(path: string) {
    this.raw = new DatabaseSync(path);
    this.raw.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  }

  prepare(sql: string) {
    return new SQLiteStatement(this.raw, sql);
  }

  async batch(statements: PreparedStatement[]) {
    this.raw.exec("BEGIN");
    try {
      const results = statements.map((statement) =>
        (statement as SQLiteStatement).execute(),
      );
      this.raw.exec("COMMIT");
      return results;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    this.raw.close();
  }
}

export class SQLiteStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly values: unknown[] = [],
  ) {}

  bind(...values: unknown[]) {
    return new SQLiteStatement(this.db, this.sql, values);
  }

  execute(): SQLiteResult {
    const values = this.values.map((value) => value ?? null) as SQLiteValue[];
    const result = this.db.prepare(this.sql).run(...values);
    return {
      meta: {
        changes: Number(result.changes),
        last_row_id: Number(result.lastInsertRowid),
      },
    };
  }

  async run() {
    return this.execute();
  }

  async first<T>() {
    const values = this.values.map((value) => value ?? null) as SQLiteValue[];
    return (this.db.prepare(this.sql).get(...values) as T | undefined) || null;
  }

  async all<T>() {
    const values = this.values.map((value) => value ?? null) as SQLiteValue[];
    return {
      results: this.db.prepare(this.sql).all(...values) as T[],
    };
  }
}

export async function applyMigrations(db: SQLiteDatabase, directory: string) {
  db.raw.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const applied = new Set(
    (db.raw.prepare("SELECT name FROM schema_migrations").all() as Row[]).map(
      (row) => String(row.name),
    ),
  );
  const files = (await readdir(directory))
    .filter((file) => /^\d+_.+\.sql$/.test(file))
    .sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(directory, file), "utf8");
    db.raw.exec("BEGIN");
    try {
      for (const statement of sql
        .split(";")
        .map((value) => value.trim())
        .filter(Boolean))
        db.raw.exec(statement);
      db.raw
        .prepare("INSERT INTO schema_migrations VALUES (?,?)")
        .run(file, new Date().toISOString());
      db.raw.exec("COMMIT");
    } catch (error) {
      db.raw.exec("ROLLBACK");
      throw error;
    }
  }
}
