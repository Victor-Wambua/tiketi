/**
 * `node:sqlite`'s `DatabaseSync`, on top of sql.js (the SQLite C library compiled to WebAssembly).
 * It is the same SQL engine, so the schema, `BEGIN IMMEDIATE`, the primary key on `seat_claims` and
 * every query in `src/server` run unchanged. The database lives in memory; `close()` parks its
 * bytes under the path so the seeding step can hand the finished database to the running app.
 */
import initSqlJs, { type Database, type SqlValue } from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm-browser.wasm?url';

const SQL = await initSqlJs({ locateFile: () => wasmUrl });

const files = new Map<string, Uint8Array>();

type Param = number | bigint | string | null | Uint8Array;
const norm = (params: Param[]): SqlValue[] =>
  params.map((p) => (typeof p === 'bigint' ? Number(p) : (p as SqlValue)));

export class StatementSync {
  constructor(
    private readonly db: Database,
    private readonly sql: string,
  ) {}

  get(...params: Param[]): Record<string, unknown> | undefined {
    const st = this.db.prepare(this.sql);
    try {
      st.bind(norm(params));
      return st.step() ? st.getAsObject() : undefined;
    } finally {
      st.free();
    }
  }

  all(...params: Param[]): Record<string, unknown>[] {
    const st = this.db.prepare(this.sql);
    try {
      st.bind(norm(params));
      const rows: Record<string, unknown>[] = [];
      while (st.step()) rows.push(st.getAsObject());
      return rows;
    } finally {
      st.free();
    }
  }

  run(...params: Param[]): { changes: number; lastInsertRowid: number } {
    const st = this.db.prepare(this.sql);
    try {
      st.bind(norm(params));
      st.step();
    } finally {
      st.free();
    }
    const changes = this.db.getRowsModified();
    const last = this.db.exec('SELECT last_insert_rowid()')[0]?.values[0]?.[0];
    return { changes, lastInsertRowid: Number(last ?? 0) };
  }
}

export class DatabaseSync {
  private readonly db: Database;

  constructor(private readonly path: string) {
    this.db = new SQL.Database(files.get(path));
  }

  exec(sql: string): void {
    this.db.run(sql);
  }

  prepare(sql: string): StatementSync {
    return new StatementSync(this.db, sql);
  }

  close(): void {
    files.set(this.path, this.db.export());
    this.db.close();
  }
}
