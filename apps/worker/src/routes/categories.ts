/**
 * /api/categories —— 订阅分类。
 *
 * 删除是软删除：订阅上残留的 category_id 不会让接口报错，
 * 趋势图会把指向已删分类的扣款归到「未分类」（core 的 trendGroupOf 已处理）。
 */

import { Hono } from 'hono';
import { nowIso, type CategoryRow } from '@submgr/core';
import type { Env } from '../env.js';
import { allRows, firstRow, isUniqueViolation, runStmt } from '../lib/db.js';
import { conflict, invalid, notFound } from '../lib/errors.js';
import {
  has,
  optionalInt,
  readJson,
  requiredString,
  type JsonObject,
} from '../lib/validate.js';

export const categoryRoutes = new Hono<{ Bindings: Env }>();

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function readColor(body: JsonObject, fallback: string | null): string {
  const raw = body['color'];
  if (raw === undefined) {
    if (fallback !== null) return fallback;
    return '#64748b';
  }
  if (typeof raw !== 'string' || !COLOR_RE.test(raw)) {
    throw invalid('字段 color 必须是 #RRGGBB 形式的颜色');
  }
  return raw.toLowerCase();
}

async function loadCategory(db: D1Database, id: string): Promise<CategoryRow> {
  const row = await firstRow<CategoryRow>(
    db,
    `SELECT * FROM categories WHERE id = ? AND deleted_at IS NULL`,
    [id],
  );
  if (!row) throw notFound(`分类不存在或已删除：${id}`);
  return row;
}

categoryRoutes.get('/', async (c) => {
  const items = await allRows<CategoryRow & { subscription_count: number }>(
    c.env.DB,
    `SELECT c.*, (SELECT COUNT(*) FROM subscriptions s
                   WHERE s.category_id = c.id AND s.deleted_at IS NULL) AS subscription_count
       FROM categories c
      WHERE c.deleted_at IS NULL
      ORDER BY c.sort ASC, c.name ASC`,
  );
  return c.json({ items });
});

categoryRoutes.post('/', async (c) => {
  const body = await readJson(c.req.raw);
  const name = requiredString(body, 'name', { max: 100 });
  const color = readColor(body, null);
  const sort = optionalInt(body, 'sort', { min: -100000, max: 100000 }) ?? 0;
  const id = crypto.randomUUID();
  const now = nowIso();

  try {
    await runStmt(
      c.env.DB,
      `INSERT INTO categories (id, name, color, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, name, color, sort, now, now],
    );
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('duplicate_name', `分类名已存在：${name}`);
    throw err;
  }

  return c.json({ item: await loadCategory(c.env.DB, id) }, 201);
});

categoryRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const current = await loadCategory(c.env.DB, id);
  const body = await readJson(c.req.raw);

  const sets: string[] = [];
  const params: unknown[] = [];
  if (has(body, 'name')) {
    sets.push('name = ?');
    params.push(requiredString(body, 'name', { max: 100 }));
  }
  if (has(body, 'color')) {
    sets.push('color = ?');
    params.push(readColor(body, current.color));
  }
  if (has(body, 'sort')) {
    sets.push('sort = ?');
    params.push(optionalInt(body, 'sort', { min: -100000, max: 100000 }) ?? 0);
  }
  if (sets.length === 0) throw invalid('请求体里没有任何可更新的字段');

  sets.push('updated_at = ?');
  params.push(nowIso());
  params.push(id);

  try {
    await runStmt(c.env.DB, `UPDATE categories SET ${sets.join(', ')} WHERE id = ?`, params);
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('duplicate_name', '分类名已存在');
    throw err;
  }

  return c.json({ item: await loadCategory(c.env.DB, id) });
});

categoryRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  await loadCategory(c.env.DB, id);
  await runStmt(
    c.env.DB,
    `UPDATE categories SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
    [nowIso(), nowIso(), id],
  );
  return c.json({ deleted: true, id });
});
