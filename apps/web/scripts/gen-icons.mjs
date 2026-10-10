/**
 * 生成 PWA 图标（PNG）。
 *
 * 为什么不直接在 public/ 里放 SVG：Chrome 的「安装到桌面」要求 192/512 的 PNG，
 * Safari 的 apple-touch-icon 也不认 SVG。项目里不引入任何图形库，
 * 所以这里用 Node 内置 zlib 手写最小 PNG 编码器，按像素画一个 ¥ 标记。
 *
 *   node scripts/gen-icons.mjs
 *
 * 产物已提交到 public/icons/，只有改图标时才需要重跑。
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'public', 'icons');

// ---------------------------------------------------------------------------
// 最小 PNG 编码器（8 位 RGBA，无隔行）
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'latin1');
  const body = Buffer.concat([typeBuf, data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

/** rgba: Uint8Array，长度 = width * height * 4 */
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0; // filter type: None
    for (let x = 0; x < width * 4; x += 1) {
      raw[rowStart + 1 + x] = rgba[y * width * 4 + x];
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// 绘制：深色圆角方块 + 浅蓝 ¥ 标记（带 1px 抗锯齿）
// ---------------------------------------------------------------------------

const BG = [15, 23, 42]; // #0f172a
const FG = [56, 189, 248]; // #38bdf8

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 圆角矩形的有符号距离（负数在内部）。 */
function roundedRectSdf(px, py, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(px - cx) - (halfW - radius);
  const dy = Math.abs(py - cy) - (halfH - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

/** 点到线段的距离，用于画带圆头的笔画。 */
function segmentDistance(px, py, x0, y0, x1, y1) {
  const vx = x1 - x0;
  const vy = y1 - y0;
  const wx = px - x0;
  const wy = py - y0;
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : clamp01((wx * vx + wy * vy) / len2);
  return Math.hypot(wx - vx * t, wy - vy * t);
}

/**
 * @param {number} size 边长
 * @param {number} scale 图形相对尺寸（maskable 需要留安全区，用 0.72）
 * @param {boolean} maskable 是否画满整块底（maskable 不要圆角外的透明）
 */
function drawIcon(size, scale, maskable) {
  const rgba = new Uint8Array(size * size * 4);
  const center = size / 2;
  const half = size / 2;
  const radius = maskable ? size / 2 : size * 0.22;
  const strokeWidth = Math.max(2, size * 0.075 * scale * 1.35);
  const glyph = size * scale;

  // ¥ 的几何：两条斜线交于中心偏上，再向下竖一笔，两条横杠
  const topY = center - glyph * 0.28;
  const midY = center - glyph * 0.02;
  const bottomY = center + glyph * 0.32;
  const armX = glyph * 0.26;
  const barX = glyph * 0.22;
  const bar1Y = center + glyph * 0.08;
  const bar2Y = center + glyph * 0.22;

  const strokes = [
    [center - armX, topY, center, midY],
    [center + armX, topY, center, midY],
    [center, midY, center, bottomY],
    [center - barX, bar1Y, center + barX, bar1Y],
    [center - barX, bar2Y, center + barX, bar2Y],
  ];

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;

      const bgAlpha = clamp01(0.5 - roundedRectSdf(px, py, center, center, half, half, radius));
      if (bgAlpha <= 0) continue;

      let fgAlpha = 0;
      for (const [x0, y0, x1, y1] of strokes) {
        const d = segmentDistance(px, py, x0, y0, x1, y1);
        fgAlpha = Math.max(fgAlpha, clamp01(strokeWidth / 2 + 0.5 - d));
      }

      const i = (y * size + x) * 4;
      const alpha = bgAlpha;
      for (let c = 0; c < 3; c += 1) {
        const bg = BG[c];
        const fg = FG[c];
        rgba[i + c] = Math.round(bg + (fg - bg) * fgAlpha);
      }
      rgba[i + 3] = Math.round(255 * alpha);
    }
  }

  return encodePng(size, size, rgba);
}

// ---------------------------------------------------------------------------

mkdirSync(OUT_DIR, { recursive: true });

const targets = [
  { file: 'icon-192.png', size: 192, scale: 0.85, maskable: false },
  { file: 'icon-512.png', size: 512, scale: 0.85, maskable: false },
  // maskable 会被系统裁成圆形/水滴形，图形缩到 0.68 保证在安全区内
  { file: 'maskable-512.png', size: 512, scale: 0.68, maskable: true },
  { file: 'apple-touch-icon-180.png', size: 180, scale: 0.85, maskable: true },
];

for (const { file, size, scale, maskable } of targets) {
  const png = drawIcon(size, scale, maskable);
  writeFileSync(join(OUT_DIR, file), png);
  console.log(`${file}  ${size}x${size}  ${png.length} bytes`);
}
