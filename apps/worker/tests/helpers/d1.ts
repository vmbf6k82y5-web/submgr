/**
 * 测试用的 D1 替身：直接用 Node 内置的 node:sqlite 跑真实的 migration。
 *
 * 为什么不用手写 mock：本项目最容易出错的地方恰恰是「SQL + 数据库约束」
 * （CHECK、部分唯一索引、触发器冻结价格版本）。只有让真实的 SQLite 执行
 * 真正的 migration 文件，测试才有意义。
 *
 * 只实现被 src/ 用到的 D1 API 子集：
 *   prepare(sql).bind(...).all() / .run() / .first()
 *   batch([...])   （原子：BEGIN/COMMIT/ROLLBACK）
 *   exec(sql)
 */

import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * node:sqlite 是 Node 22 新增的内置模块：
 *   * Vite 5 的内置模块表里没有它，静态 `import 'node:sqlite'` 会被当成 npm 包解析而失败；
 *   * @types/node 22.20 也还没有它的类型声明。
 * 所以这里用 createRequire 绕过打包器的静态分析，并自己声明用到的最小接口。
 */
interface SqliteStatement {
  all(...params: never[]): unknown[];
  get(...params: never[]): unknown;
  run(...params: never[]): { changes?: number | bigint; lastInsertRowid?: number | bigint };
}

interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (path: string) => SqliteDatabase;
}

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as SqliteModule;

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, '../../migrations');
const seedFile = resolve(here, '../../seed/seed.sql');

/** D1 绑定参数不接受 undefined / boolean，与 src/lib/db.ts 的口径保持一致。 */
function normalizeParam(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

export class FakeD1Statement {
  constructor(
    private readonly database: SqliteDatabase,
    readonly sql: string,
    readonly params: readonly unknown[] = [],
  ) {}

  bind(...values: unknown[]): FakeD1Statement {
    return new FakeD1Statement(this.database, this.sql, values.map(normalizeParam));
  }

  /** node:sqlite 的位置参数必须是基本类型数组。 */
  private exec(): { statement: SqliteStatement } {
    const statement = this.database.prepare(this.sql);
    return { statement };
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: true; meta: object }> {
    const rows = this.exec().statement.all(...(this.params as never[])) as T[];
    return { results: rows, success: true, meta: {} };
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const row = this.exec().statement.get(...(this.params as never[])) as
      | Record<string, unknown>
      | undefined;
    if (row === undefined) return null;
    if (column !== undefined) return row[column] as T;
    return row as T;
  }

  async run(): Promise<{
    results: never[];
    success: true;
    meta: { changes: number; last_row_id: number };
  }> {
    const info = this.exec().statement.run(...(this.params as never[]));
    return {
      results: [],
      success: true,
      meta: {
        changes: Number(info.changes ?? 0),
        last_row_id: Number(info.lastInsertRowid ?? 0),
      },
    };
  }
}

export class FakeD1 {
  readonly raw: SqliteDatabase;

  constructor(opts: { migrate?: boolean; seed?: boolean } = {}) {
    this.raw = new DatabaseSync(':memory:');
    this.raw.exec('PRAGMA foreign_keys = ON;');
    if (opts.migrate !== false) this.applyMigrations();
    if (opts.seed) this.raw.exec(readFileSync(seedFile, 'utf8'));
  }

  private applyMigrations(): void {
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const file of files) {
      this.raw.exec(readFileSync(join(migrationsDir, file), 'utf8'));
    }
  }

  prepare(sql: string): FakeD1Statement {
    return new FakeD1Statement(this.raw, sql);
  }

  /** 与 D1 的 batch 一样是原子的。 */
  async batch(statements: readonly FakeD1Statement[]): Promise<unknown[]> {
    this.raw.exec('BEGIN');
    try {
      const out: unknown[] = [];
      for (const statement of statements) out.push(await statement.run());
      this.raw.exec('COMMIT');
      return out;
    } catch (error) {
      this.raw.exec('ROLLBACK');
      throw error;
    }
  }

  async exec(sql: string): Promise<{ count: number; duration: number }> {
    this.raw.exec(sql);
    return { count: 0, duration: 0 };
  }

  close(): void {
    this.raw.close();
  }
}

/** 直接跑一段 SQL（测试里造数据用）。 */
export function execSql(db: FakeD1, sql: string): void {
  db.raw.exec(sql);
}

/** 查询多行（测试断言用）。 */
export function queryAll<T = Record<string, unknown>>(db: FakeD1, sql: string, ...params: unknown[]): T[] {
  return db.raw.prepare(sql).all(...(params as never[])) as T[];
}

/** 查询一行（测试断言用）。 */
export function queryOne<T = Record<string, unknown>>(
  db: FakeD1,
  sql: string,
  ...params: unknown[]
): T | undefined {
  return db.raw.prepare(sql).get(...(params as never[])) as T | undefined;
}
