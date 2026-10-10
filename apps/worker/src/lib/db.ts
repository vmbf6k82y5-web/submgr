/**
 * D1 访问的薄封装。
 *
 * 只做三件事：
 *   1) 统一把 undefined 归一化成 null、把 boolean 归一化成 0/1
 *      （D1 的绑定参数不接受 undefined / boolean，直接传会抛错）；
 *   2) 统一取出 results；
 *   3) 提供 `aliveClause` 之类的软删除口径常量，避免每个 route 各写一遍。
 *
 * 不做 ORM、不做查询构造器：SQL 直接写在 route / cron 里，读起来最清楚。
 */

/** 绑定参数归一化。 */
export function bindParams(params: readonly unknown[]): unknown[] {
  return params.map((v) => {
    if (v === undefined) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    return v;
  });
}

function statement(db: D1Database, sql: string, params: readonly unknown[]): D1PreparedStatement {
  return db.prepare(sql).bind(...bindParams(params));
}

/** 查询多行。 */
export async function allRows<T>(
  db: D1Database,
  sql: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const res = await statement(db, sql, params).all<T>();
  return (res.results ?? []) as T[];
}

/** 查询单行；没有结果返回 null。 */
export async function firstRow<T>(
  db: D1Database,
  sql: string,
  params: readonly unknown[] = [],
): Promise<T | null> {
  const res = await statement(db, sql, params).all<T>();
  const rows = (res.results ?? []) as T[];
  return rows.length > 0 ? (rows[0] as T) : null;
}

/** 执行一条写语句。 */
export async function runStmt(
  db: D1Database,
  sql: string,
  params: readonly unknown[] = [],
): Promise<D1Result> {
  return statement(db, sql, params).run();
}

/** 是否存在至少一行。 */
export async function exists(
  db: D1Database,
  sql: string,
  params: readonly unknown[] = [],
): Promise<boolean> {
  const row = await firstRow<{ one: number }>(db, sql, params);
  return row !== null;
}

/**
 * 判断一个异常是不是「唯一索引冲突」。
 *
 * D1 / SQLite 对 UNIQUE 约束抛出的信息里一定有 'UNIQUE constraint failed'。
 * 各个 route 用它把「数据库兜底拦截」翻译成 409，而不是 500。
 */
export function isUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('UNIQUE constraint failed') || msg.includes('SQLITE_CONSTRAINT_UNIQUE');
}

/**
 * 判断一个异常是不是「CHECK / 触发器 RAISE(ABORT) 拦截」。
 *
 * 触发器用 RAISE(ABORT, '...') 抛出的信息会包含给用户的中文说明，
 * 直接透传给前端比返回 500 更有用。
 */
export function isConstraintViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('constraint failed') ||
    msg.includes('CHECK constraint') ||
    msg.includes('FOREIGN KEY constraint') ||
    msg.includes('is frozen') ||
    msg.includes('已生效')
  );
}
