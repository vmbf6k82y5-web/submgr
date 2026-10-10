# 订阅管家 · 进度报告（阶段一 ~ 阶段三）

> * 阶段一（§1~§8 的原始内容，完成于 2026-10-10）：数据模型定稿 + `packages/core` + 单元测试。
> * 阶段二：`apps/worker` —— `/api/*` 接口、`/ics/:token.ics`、三个 Cron 作业、`wrangler.toml`。
> * 阶段三（见 §9）：`apps/web` —— Vite + React + TS + Tailwind + ECharts 的 PWA，六个页面 + 示例数据兜底。
>
> 工作目录：`~/submgr`。**尚未部署到 Cloudflare，也没有推送 GitHub**（收尾另行指示）。

---

## 1. 目录树（当前实际状态）

```
submgr/
├── package.json                     # pnpm workspace 根；test / typecheck / build
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
├── tsconfig.base.json
├── .gitignore
├── PROGRESS.md                      # 本文件
│
├── apps/
│   ├── web/
│   │   └── package.json             # 占位（阶段一不碰前端）
│   └── worker/
│       ├── package.json             # test = schema 校验；Worker 源码后续阶段
│       ├── migrations/              # D1 表结构（6 个文件，按序号执行）
│       │   ├── 0001_settings_categories.sql
│       │   ├── 0002_subscriptions.sql
│       │   ├── 0003_charges_fx.sql
│       │   ├── 0004_notification_channels.sql
│       │   ├── 0005_reminder_rules.sql
│       │   └── 0006_triggers.sql
│       ├── seed/
│       │   └── seed.sql             # 5 条示例订阅，覆盖月付/年付/试用/终身/外币
│       └── scripts/
│           └── validate-schema.mjs  # 用真实 SQLite 跑 migration + 断言约束（50 项）
│
└── packages/core/                   # 纯函数领域逻辑，前后端共用
    ├── package.json
    ├── tsconfig.json / tsconfig.build.json / vitest.config.ts
    ├── src/
    │   ├── index.ts                 # 统一出口
    │   ├── types.ts                 # 领域类型（与 D1 列一一对应）+ 枚举
    │   ├── time.ts                  # date-only / UTC 时间点 / 用户时区
    │   ├── money.ts                 # ISO 4217 小数位、整数金额、BigInt 精确换算
    │   ├── cycles.ts                # 周期与到期日（锚点日、闰年、固定天数、终身）
    │   ├── amounts.ts               # 月均 / 年均折算
    │   ├── status.ts                # active / ended / anomaly 判定 + 付费周期锚点（B1）
    │   ├── fx.ts                    # 汇率快照健康度（stale、缺币种）
    │   ├── summary.ts               # 总览汇总
    │   └── trend.ts                 # 按月堆叠趋势（/api/trends）+ 中文字段标签
    └── tests/                       # 7 个测试文件 + fixtures.ts
```

安装依赖：`pnpm install`（pnpm 10.34.6 / Node 22.23.3，环境里已有，未使用 sudo）。

---

## 2. 数据模型定稿

### 2.1 全局约定

| 约定 | 落地方式 |
|---|---|
| 金额一律整数最小单位 | 所有金额列 `INTEGER`，SQLite 无浮点金额列；核心层 `convert` 用 BigInt 有理数运算 |
| 主键 UUID (TEXT) | 9 张表里 8 张 `id TEXT PRIMARY KEY`，并 `CHECK (length(id) = 36)`；**`fx_rates` 例外**，见 3.1 |
| 每表 `created_at` / `updated_at` / `deleted_at` | 全部 9 张表都有；`created_at`/`updated_at` 有 `DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))`；`deleted_at IS NULL` 表示未删除 |
| 时间统一 UTC ISO 字符串 | 时间点列全部 `CHECK (... GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z')`，非 `Z` 结尾直接写不进去 |
| 日期用 `YYYY-MM-DD` | 到期日/扣款日/生效日等都有 GLOB 格式校验 |
| `updated_at` 自动维护 | 每表一个 `AFTER UPDATE` 触发器；调用方显式写入时不会被覆盖 |

### 2.2 表清单

| 表 | 关键列 | 业务约束（数据库层强制） |
|---|---|---|
| `settings` | `base_currency`(CNY) `timezone`(Asia/Shanghai) `ics_token` `amortize_lifetime_months`(36) | `ux_settings_singleton ON ((1))` 保证**只有一行**；`ics_token` 唯一索引；`amortize_lifetime_months >= 0` |
| `categories` | `name` `color` `sort` | 未删除的名字唯一；`color` 必须是 `#RRGGBB` |
| `subscriptions` | `sub_type` `charge_channel` `renew_mode` `start_date` `end_date` `cancelled_at` | 三个枚举用 `CHECK IN (...)`；`end_date >= start_date`；渠道只是纯文字，**库内不存在任何续费/取消跳转字段** |
| `subscription_versions` | `effective_from` `amount_minor` `currency` `cycle_type` `cycle_days` `is_trial` `trial_end_date` `after_trial_*` | `cycle_days` 只在 `days` 周期出现且 > 0；`is_trial` 与 `trial_end_date` 必须成对；`trial_end_date > effective_from`；**同订阅同日唯一**（`ux_versions_subscription_effective`）；**生效后冻结触发器** |
| `charges` | `charge_date` `amount_minor` `currency` `fx_rate_to_base` `base_currency` `base_amount_minor` `source` `status` | `ux_charges_auto_daily` 保证 Cron **每天每订阅最多一条自动扣款**（幂等）；`base_amount_minor` 必须能追溯到汇率与币种 |
| `fx_rates` | `date` `base`(固定 USD) `currency` `rate`(字符串) `fetched_at` | **主键 `(date, currency)`**；`CHECK (base = 'USD')`；`rate` 必须是正数 |
| `notification_channels` | `type` `name` `config_json` `secret_ref` `secrets_encrypted` | **密钥不许明文进 D1**：`config_json` 被 CHECK 禁止出现 `webhook` / `bot_token` / `sign_secret` / `secret_key` / `password`；必须至少给出 `secret_ref` 或 `secrets_encrypted` |
| `reminder_rules` | `rule_type` `days_before` `at_time` `schedule_type` `interval_days` `weekdays` `channel_id` `enabled` | `due` 规则必须有 `days_before`+`at_time`；`schedule` 规则必须有 `schedule_type`+`at_time` 且 `subscription_id` 必须为空；`weekdays` 必须是 JSON 数组 |
| `reminder_log` | `rule_id` `subscription_id` `due_date` `sent_at` `result` | `ux_reminder_log_dedupe (rule_id, due_date) WHERE result='sent'` → **同一条规则对同一个到期日只成功发一次**；失败可重试留多条 |

### 2.3 「价格版本冻结」的三层保障

1. **接口层**：`/api/subscriptions/:id/versions` 只允许新增（阶段二实现）。
2. **数据库触发器**：`trg_subscription_versions_freeze` —— 对 `effective_from <= date('now')` 的版本，只要改动 `amount_minor` / `currency` / `cycle_type` / `cycle_days` / `effective_from` / `subscription_id` 就 `RAISE(ABORT)`（用 `IS NOT` 比较，NULL 变化也能识别）。改 `plan_name` 仍然允许。
3. **唯一索引**：同订阅同日只能有一个版本，保证「当前版本」定义唯一。

### 2.4 种子数据（`apps/worker/seed/seed.sql`）

| # | 订阅 | 覆盖点 |
|---|---|---|
| 1 | 爱奇艺黄金会员 | **月付** CNY 微信；含一次 ¥25→¥30 涨价（**构建了 2 个价格版本**，前 4 期走旧版、后 2 期走新版） |
| 2 | iCloud+ 2TB | **年付** CNY 81600 分，Apple |
| 3 | Netflix 高级会员 | **外币** USD 2299 分/月，4 笔扣款各自冻结了不同汇率（7.1420 / 7.0980 / 7.2150 / 7.1690） |
| 4 | Notion Plus | **试用** 14 天，4 天后转正 ¥99.00/月，`after_trial_*` 已填 |
| 5 | JetBrains 全家桶 | **终身** CNY 214800 分，手动续费，按 36 个月摊销 |

附带：5 个分类、2 个提醒渠道（密钥只存 `secret_ref` 名字）、5 条提醒规则（含 weekly 与 every_n_days 两种周期汇总）、12 条汇率快照（今天+昨天 × 6 币种）。
所有日期用 `date('now', ...)` 相对生成，**任何一天播种都看起来是新鲜的**。

---

## 3. 定稿与未定事项

> 阶段四会把这些整理进 README 的「假设」一节。

### 3.1 已定稿（2026-10-10 确认）

| # | 事项 | 定稿结论 | 落地位置 |
|---|---|---|---|
| 1 | schema 校验器 | **保留**。`pnpm test` 仍然 = core 单测 + schema 校验（50 项断言），不变 | `apps/worker/scripts/validate-schema.mjs`；`apps/worker/package.json` 的 `test` 脚本 |
| 2 | **B1 试用转正后的周期锚点** | **改为「转正后重新起算」**：锚点 = 第一个转正版本的 `effective_from`（转正日）。`nextDueDate` 签名不动，只在 `getStatus` / `summarize` 的调用处改 | 新增 `trialConversionDate()` / `dueAnchorFor()`（`packages/core/src/status.ts`）；调用点：`status.ts` 的 `getStatus`、`summary.ts` 的 `summarize`。测试：`status.test.ts` ›「B1: 试用转正后的锚点」（12 条）、`summary.test.ts` ›「B1: summarize 的到期窗口按转正日起算」（3 条） |
| 3 | A2 `charges.base_currency` | **保留** | `migrations/0003_charges_fx.sql` |
| 4 | A3 `fx_rates.fetched_at` | **保留** | `migrations/0003_charges_fx.sql` |
| 5 | `/api/trends` 的按月分桶 | **放 `packages/core`（纯函数）** | 新增 `packages/core/src/trend.ts`：`monthlyTrend()` + 月份键工具 + 中文字段标签表。测试：`trend.test.ts`（38 条） |
| — | A1 `fx_rates` 复合主键 | **保留**（上一轮验收已把「fx_rates 主键是 (date, currency)」列为验收项并 PASS） | `migrations/0003_charges_fx.sql` |

**B1 的两个附带结论**（同一次改动的必然结果，一并说明）：

- **锚点对「转正版本及其之后的所有版本」都生效。** 转正后即使再发生调价（新版本 `effective_from` = 调价日），周期仍锚在转正日，不会跟着版本漂移。例：1/14 转正、4/20 调价的月订阅，5/1 时下一次到期日是 **5/14**，而不是 5/20。
- **试用进行中时，「下次到期日」= 转正日。** 因为转正版本尚未落库时是用投影（`projectAfterTrialVersions`）参与锚点计算的，所以试用期内这个字段就已经有意义（1/1–1/14 的试用，1/5 时显示的下次到期日是 1/14），不会出现「理由写试用 1/14 结束、到期日却写 2/1」这种自相矛盾。

**趋势分桶的口径**（`monthlyTrend`，写进 README 时照抄）：

- `group` 支持 `category | cycle | channel | type` 四个维度。
- **只统计实际发生的钱**：`paid` 记正数，`refunded` 记负数（钱退回来了），`failed` 完全排除。
- 币种优先用扣款当天**冻结**的 `base_amount_minor`；冻结时的基准币种与当前 `settings.base_currency` 不一致时，退回用原币种按最新汇率换算。
- **缺汇率的格子是 `null` 而不是 `0`**，同时把币种列进 `missingCurrencies`，与 `summarize` 口径一致。
- from..to 之间每个月份都会出现（无支出的月份为 0），前端不用自己补空月份。
- 分组按区间总额从大到小排序，金额相同时按 key 升序，保证结果稳定可复现。
- 单次请求最多 `MAX_TREND_MONTHS = 600` 个月，防止 `from`/`to` 写错时把内存跑满。

### 3.2 已按现状实现（原 A4–A7，若你无异议就保持）

| # | 事项 | 处理方式 | 为什么 |
|---|---|---|---|
| A4 | `reminder_rules` 里既有到期提醒字段，又有「另外单独一种周期汇总提醒」 | **增加了 `rule_type IN ('due','schedule')` 判别列** | 两类规则的必填字段完全不同，没有判别列无法在库层写 CHECK |
| A5 | 「密钥只能从 secret 读，或者加密后存」，但只给了 `config_json` 一列 | 拆成 **`config_json`（非敏感）+ `secret_ref`（secret 绑定名）+ `secrets_encrypted`（AES-GCM 密文）**，并强制二者至少有一个 | 一列表达不了「非敏感配置」与「密钥来源」的区分。Telegram 的 `chat_id` 不算密钥，放在 `config_json` |
| A6 | `reminder_log` 去重 | 唯一索引**只覆盖 `result='sent'`** | 如果用全表唯一索引，一次发送失败就永远发不出去了。失败要允许重试并留历史 |
| A7 | `getStatus(subscription, versions, today)` 签名 | **加了可选第 4 个参数 `charges = []`** | 「最近一次扣款失败」这个异常没有扣款记录根本判不了。不传就跳过该项检查，原有 3 参调用不受影响 |

### 3.3 其余业务口径（仍可调整）

| # | 事项 | 当前实现 | 影响 |
|---|---|---|---|
| B2 | 月均/年均里试用版本怎么算 | 用 `after_trial_*` 的**转正价**折算（`useAfterTrial: true`） | 好处是转正前后月均数字稳定、不跳变；坏处是试用期（实付 0）也把转正价算进月均。若你想「试用期月均就是 0」，改成 `false` 即可 |
| B3 | 月均/年均/未来 30 天统计哪些订阅 | `active` + `anomaly`，**排除 `ended`** | 已结束的不该计入「我每月花多少」。异常（如扣款失败）仍在付费，故计入 |
| B4 | 「未来 30 天将扣的金额」是否区分续费方式 | **不区分**，自动续费和手动续费都预估 | 手动续费严格说「不一定会扣」。若你只想看自动续费，加一个 `renew_mode === 'auto'` 过滤即可 |
| B5 | 未来窗口的边界 | **左开右闭 `(today, today+30]`**，今天这一期不计入 | 避免与趋势图里「今天已经发生的扣款」重复计数 |
| B6 | 手动续费异常是否要求「先有历史扣款」 | **不要求**，按需求字面：过了到期日 + 没有续费记录 → 标红 | 副作用：新建一个 `start_date` 在过去的订阅且不补扣款记录，第二期起会显示异常。初始版本会覆盖第一期，所以刚建好当天不会红 |
| B7 | 未知币种怎么处理 | 语法合法（3 位字母）但非 ISO 的代码按 **2 位小数**处理，不抛错；语法非法才抛错 | 例如 `RMB` 不会让整条链路崩。若你要「未知币种必须报错」，改 `currencyExponent` |
| B8 | 舍入规则 | **半值远离零**（四舍五入），全程 BigInt 精确运算，不经过浮点 | 例如 `10000 分 / 3 = 3333.33 → 3333`；`2.5 → 3`、`-2.5 → -3` |
| B9 | 终身订阅 `amortize_lifetime_months = 0` | 月均与年均都是 **0**（= 不参与均值） | 需求原文只说「0 表示不摊销」，没说结果记什么。若你想记 `null` 或原值，告诉我 |
| B10 | 年均是否等于「月均 × 12」 | **不等于**，年额直接由周期算出，只舍入一次 | `季付 10000` → 月均 3333、年均 40000；`3333 × 12 = 39996 ≠ 40000`。避免二次舍入误差累积 |
| ~~B11~~ | ~~`sub_type` / `charge_channel` 的中文标签~~ | **已做**（随 trend 一起落地） | `packages/core/src/trend.ts` 导出 `SUB_TYPE_LABELS` / `CHARGE_CHANNEL_LABELS` / `CYCLE_TYPE_LABELS` 及 `subTypeLabel()` / `chargeChannelLabel()` / `cycleTypeLabel()`，前端图例与 Worker 提醒文案共用同一套说法 |

### 3.4 其他说明

- **`seed.sql` 开头会 `DELETE` 全部数据**，只为本地/演示用，文件里已加显著警告；不要在生产库执行。
- **种子里的 `fx_rates` 只播今天和昨天**。两天后就会 `stale = true`，这是预期的（真实运行时由 Cron 每天刷新）。
- **额外交付物 `apps/worker/scripts/validate-schema.mjs`**（已定稿保留）：阶段一没有 Cloudflare 账号，但 migration 里的 CHECK / 触发器 / 部分唯一索引必须被真正执行过才算「确认通过」。所以用 Node 内置的 `node:sqlite`（D1 底层也是 SQLite）把 6 个 migration + seed 跑一遍，并对 50 条约束做断言。要求 **Node ≥ 22.5**（`--experimental-sqlite`）。
- **`packages/core` 零运行时依赖**（只有 `date-fns` / `date-fns-tz`），不 import 任何 Cloudflare API，可在 Worker、浏览器、Node 里直接跑。
- **日期运算全部走 date-fns**（`addMonths` / `startOfMonth` / `getDaysInMonth` / `setDate` / `addDays` / `differenceInCalendarDays`），没有任何手写的月份加减或闰年判断。为保证「锚点日」不丢失：先 `startOfMonth` 再到 1 号上做 `addMonths`（从 1 号出发永远不会被截断），最后用 `getDaysInMonth` 把锚点日放回去。趋势的月份键同理：补成 `YYYY-MM-01` 再走 `addMonthsKeepingAnchorDay`。

---

## 4. 测试结果

```
$ pnpm test

apps/worker test:  ✅ schema 校验：50 通过，0 失败
packages/core test: Test Files  7 passed (7)
packages/core test:      Tests  254 passed (254)

退出码 0
```

core 单测分布（7 个文件 / 254 条）：

| 文件 | 条数 | 覆盖 |
|---|---|---|
| `time.test.ts` | 18 | date-only 校验、加减、用户时区边界、DST、进程时区无关性 |
| `money.test.ts` | 37 | ISO 4217 小数位、主/最小单位互转、舍入、BigInt 换算、冻结汇率 |
| `cycles.test.ts` | 40 | 月末锚点、闰年、跨年、固定天数、终身、到期日窗口 |
| `amounts.test.ts` | 27 | 月均/年均折算、终身摊销、JPY/KWD、试用转正价 |
| `status.test.ts` | 55 | 正常/异常/结束判定、版本选取、批量计数、**B1 锚点（12 条）** |
| `summary.test.ts` | 39 | 汇总合计、价格切换、试用转正、缺汇率、stale、**B1 窗口（3 条）** |
| `trend.test.ts` | 38 | 月份键工具、四维度分组、冻结汇率、缺汇率、状态取舍、兜底 |

`pnpm typecheck`（`tsc --noEmit`，`strict` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`）**零错误**。
`pnpm --filter @submgr/core build`（`tsc` 输出 d.ts + js）**通过**。

### 4.1 需求点名的测试用例 → 覆盖情况

| 需求要求的用例 | 覆盖位置 |
|---|---|
| 月末锚点 | `cycles.test.ts` › 月末锚点（1/31 → 2/29 → **3/31**，含 30 日锚点、3/31 起点、季度/半年锚点） |
| 闰年 | `cycles.test.ts` › 闰年（2/29 年订阅平年落 2/28、**2028 年回到 2/29**；1/29 月订阅跨平年 2 月） |
| 跨年 | `cycles.test.ts` › 跨年（11/30 月订阅跨到次年 2 月、12/31 季度与年订阅、7/15 半年订阅） |
| 试用转正 | `status.test.ts` › anomaly-试用（试用中 / 最后一天 / 过期未转正 / 已转正 / 转正当天取新版）+ **B1: 试用转正后的锚点**；`summary.test.ts` › 试用转正 + **B1: summarize 的到期窗口按转正日起算** |
| 价格版本切换前后 | `status.test.ts` › 版本选取；`summary.test.ts` › 价格版本切换前后（切换前一天 / 当天 / 之后） |
| 日元、科威特第纳尔等不同小数位 | `money.test.ts` › ISO 4217 小数位 + `convert`（JPY→CNY、KWD→CNY、JPY→KWD、JPY→USD）；`amounts.test.ts` › 小数位不同的币种 |
| 缺汇率 | `money.test.ts` › 缺任一币种汇率 → `null`；`summary.test.ts` › 缺汇率（**断言合计为 null 且不退化成「只算有汇率的那个」**）；`trend.test.ts` › 缺汇率时格子是 null（**断言不出现 0**） |
| 时区边界（Asia/Shanghai 午夜前后） | `time.test.ts` › 用户时区（UTC 15:59 vs 16:00 分属上海两天、跨月跨年、西半球、DST 切换、`atTimeInTimeZoneToUtc`） |
| （额外）结果与进程时区无关 | `time.test.ts` › 在 UTC / 上海 / 纽约 / 加尔各答 / 奥克兰下 date-only 运算结果完全一致 |

### 4.2 B1 定稿的验收点（5 条，对应测试名）

| 验收点 | 测试名 | 文件 |
|---|---|---|
| 1/14 转正 → 下次到期日是 **2/14** 而不是 2/1 | 「转正后到期日从转正日起算：1/14 转正 -> 2/14，而不是 2/1」 | `status.test.ts` |
| 转正后再调价，锚点不跟着版本漂移 | 「转正后遇到调价版本，锚点依然是转正日，不会跟着版本漂移」 | `status.test.ts` |
| 试用进行中，下次到期日 = 转正日 | 「试用进行中：下次到期日 = 转正日（不是试用版本自己那个无意义的周期日）」 | `status.test.ts` |
| 转正版本还没落库时靠投影得到同样结果 | 「转正版本还没落库时，用投影也能得到同一个窗口结果」 | `summary.test.ts` |
| 普通订阅行为完全不变 | 「dueAnchorFor：普通订阅仍用 start_date（行为不变）」 | `status.test.ts` |

### 4.3 其他值得一提的断言

- **金额精确性**：`convert` 在 `.5` 临界值上远离零（`4.5 → 5`、`-0.5 → -1`）；`ratioMinor` 用 BigInt，`9007199254740991 / 3` 不失真。
- **冻结汇率**：`convertWithFrozenRate(2299,'USD','CNY','7.1420') === 16419`，与种子数据里的 `base_amount_minor` 完全一致；`trend.test.ts` 另外验证了「冻结值优先于用最新汇率重算」（16419 vs 重算的 16415），以及基准币种被改过时会退回用原币种重算。
- **月份键不会漂移**：连续 12 次 `+1 月` 必定回到同一个月；`monthsBetween('2024-11','2025-02')` 正确跨年。
- **不给脏数据留口子**：非法日期（`2024-02-30`）、非整数金额、超精度主单位字符串、缺 `cycle_days`、非法月份键全部抛错，而不是静默算成别的数。
- **数据库层约束真的会拦人**：settings 只能一行、已生效版本改金额/币种/周期被触发器拒绝、同订阅同日两个版本被拒、Cron 重复扣款被拒、`config_json` 里出现 `webhook_url` 被拒、无密钥渠道被拒、同一规则的同一到期日只能成功发一次、schedule 规则挂订阅被拒、非法 `weekdays` 被拒、外键约束生效。

---

## 5. 阶段一未做（留给后续阶段）

- `apps/worker` 的 Hono 路由、Bearer 鉴权、`/ics/:token.ics`、Cron（汇率适配器、提醒发送、试用转正、扣款生成）。
- `/api/trends` 路由本身（**分桶逻辑已在 `packages/core` 完成**，Worker 里只需把参数透传给 `monthlyTrend()`）。
- `wrangler.toml`（D1 绑定、Cron、Static Assets）。
- `apps/web` 的 Vite + React + PWA + ECharts + Tailwind 全部页面。
- README（本地开发 / 创建 D1 / migration / secret / 部署命令）。

**下一步等阶段二指令。**

---
---

# 订阅管家 · 阶段二进度报告

> 范围：**只做 `apps/worker`（Hono + D1 + Cron + ICS）+ `wrangler.toml` + README**。
> `migrations/` 与 `packages/core` **一行未改**（表结构冻结）；前端仍为占位。
> 完成时间：2026-10-10 · 工作目录：`~/submgr`

## 6. 阶段二做了什么

### 6.1 目录（新增部分）

```
apps/worker/
├── src/
│   ├── index.ts                 # Hono 入口：路由挂载 + notFound + onError + scheduled(waitUntil)
│   ├── env.ts                   # Env 绑定（DB / ADMIN_TOKEN / NOTIFY_SECRET_KEY / FX_API_BASE / ASSETS）
│   ├── auth.ts                  # Bearer 鉴权：常数时间比较，未配置 ADMIN_TOKEN 时 fail closed（500）
│   ├── ics.ts                   # GET /ics/:token.ics（VCALENDAR / 全天事件 / VALARM / 折行）
│   ├── lib/
│   │   ├── db.ts                # D1 小工具：绑定参数归一化、all/first/run、唯一约束判定
│   │   ├── errors.ts            # ApiError + invalid/notFound/conflict/unauthorized
│   │   ├── validate.ts          # 请求体/查询参数读取器（枚举、日期、时间、时区、币种…）
│   │   ├── settings.ts          # settings 单行自愈、ICS 令牌生成、常数时间比较
│   │   ├── fx.ts                # 汇率快照读取 + 冻结（asOf 语义）
│   │   ├── world.ts             # 一次性把订阅/版本/扣款/分类/汇率读进内存
│   │   └── upcoming.ts          # 「未来到期清单」唯一实现（ICS + 提醒 + 汇总共用）
│   ├── routes/                  # subscriptions charges categories summary trends reminders channels settings
│   ├── notify/
│   │   ├── secrets.ts           # secret_ref(env JSON) / secrets_encrypted(AES-256-GCM) 解析
│   │   ├── send.ts              # 飞书（带签名）+ Telegram，deps 可注入
│   │   └── messages.ts          # 提醒文案（单笔 / 清单 / 周期汇总）
│   └── cron/
│       ├── deps.ts              # CronDeps(fetch/now/sleep/fxSource/log) + 结构化 JSON 日志
│       ├── adapters.ts          # FxRateSource 适配器（默认 open.er-api.com）
│       ├── retry.ts             # withRetry（指数退避）
│       ├── fx.ts                # Cron ① 拉汇率（upsert、分批 batch、失败兜底）
│       ├── reminders.ts         # Cron ② 提醒扫描（去重、到点判定、失败重试）
│       ├── charges.ts           # Cron ③ 试用转正 + 当日扣款（冻结汇率）
│       └── index.ts             # 表达式常量 + jobForCron + dispatchCron（永不抛异常）
├── tests/                       # 9 个测试文件 + helpers（D1 替身 / 场景 fixture / Cron deps）
├── wrangler.toml                # D1 绑定 + 3 个 cron + Static Assets + vars
├── tsconfig.json / tsconfig.test.json / vitest.config.ts
└── .dev.vars.example
```

另外新增了根目录 `README.md`（含**假设**清单）与 `apps/web/dist/index.html` 占位页
（`[assets]` 指向它，否则 `wrangler deploy --dry-run` 会因为目录不存在而报错）。

### 6.2 三个 Cron

| 常量 | 表达式（UTC） | 上海时间 | 行为 |
|---|---|---|---|
| `CRON_REMINDERS` | `*/15 * * * *` | 每 15 分钟 | 到期提醒 + 周期汇总；`reminder_log` 去重；失败写 `failed` 行下轮重试 |
| `CRON_FX` | `20 16 * * *` | 00:20 | 抓 USD 汇率 → 按 `(date, currency)` upsert；失败重试 3 次（500ms 指数退避） |
| `CRON_DAILY` | `30 16 * * *` | 00:30 | ① 试用转正（`effective_from = trial_end_date`，支持补跑）② 生成当日扣款并冻结汇率 |

先拉汇率、后生成扣款，保证当天扣款能用上当天的快照。三个作业都**不抛异常**，
失败写结构化 JSON 日志（`cron.fx.failed` / `cron.reminder.failed` / `cron.charges.*` /
`cron.unknown` / `cron.crashed`），因为 migration 里没有作业日志表。

### 6.3 实现里踩出来的一个真问题（重要）

`reminder_log` 的去重索引是 `ux_reminder_log_dedupe (rule_id, due_date) WHERE result = 'sent'`（已冻结）。
最初的实现是「一条到期规则命中 N 个订阅就发 N 条消息」——**同一天有多个订阅到期时，第二条会被
去重逻辑挡掉**（实测：Spotify 与 Notion 同时在 10-10 到期，第二条落成 `skipped`，用户永远收不到）。

修正：**同一（规则 + 到期日）合并成一条「清单」消息**（`buildDueListReminderText`，每行带各自的
扣费渠道），单笔时仍用原来的单笔文案。这样一条日志对应一条消息，去重语义与 schema 完全一致。
测试 `cron-reminders.test.ts` 里专门锁住了这个行为。

---

## 7. 验证结果

```
$ cd ~/submgr && pnpm test
packages/core test:  Test Files  7 passed (7)     Tests  254 passed (254)
apps/worker test:    ① schema 校验：50 通过，0 失败
                     ② Test Files  9 passed (9)   Tests  163 passed (163)

$ pnpm typecheck
apps/web typecheck: Done（占位）
packages/core typecheck: Done
apps/worker typecheck: Done（src + tests 两个 tsconfig）

$ cd apps/worker && npx wrangler deploy --dry-run --outdir=dist
Total Upload: 290.68 KiB / gzip: 63.46 KiB
- D1 Databases: DB: submgr (00000000-0000-4000-8000-000000000000)
- Vars: FX_API_BASE: "https://open.er-api.com/v6/latest/USD"
--dry-run: exiting now.
```

**没有部署**（没有 Cloudflare API Token），也没有跑 `wrangler d1 migrations apply --remote`。

### 7.1 测试分布（worker，163 条）

| 文件 | 条数 | 覆盖 |
|---|---|---|
| `subscriptions.test.ts` | 27 | 鉴权（401/500 fail-closed/200）、列表状态与中文标签、月均、过滤、新建/改/软删级联、版本只增不改、已生效冻结、形状校验 |
| `charges.test.ts` | 13 | 过滤、手动记账冻结汇率（按扣款日）、基准币种 1:1、缺汇率告警、改金额/日期重新冻结、软删、source 强制 manual |
| `meta.test.ts` | 28 | 分类（计数/重名/软删）、settings（自愈/校验/令牌轮换）、渠道（不回显密文/敏感键拒绝/secret_ref 格式）、提醒规则（due/schedule 形状、weekdays 归一、log 路由） |
| `summary-trends.test.ts` | 11 | 汇总数字（月均 49536 / 年均 594427 / 未来 30 天 105469）、窗口参数、stale、四维度趋势、冻结汇率、退款记负、失败排除、缺汇率 null |
| `ics.test.ts` | 17 | 无 Bearer、令牌 404、63 个事件、全天 + VALARM、UID 稳定性、窗口两端、折行 ≤75 八位组、单笔文案带渠道 |
| `cron-fx.test.ts` | 15 | 适配器解析、脏数据忽略、upsert 不长行、退避 500/1000、全部失败写日志且不动库、0 条有效汇率算失败、withRetry |
| `cron-reminders.test.ts` | 20 | 到点判定、去重（第二轮跳过）、合并清单、文案带渠道、飞书签名与 Telegram 载荷、下游失败重试、空窗口照发、scheduleFires/sumInBase 单测 |
| `cron-charges.test.ts` | 13 | 转正（`effective_from = trial_end_date`）、转正后第一笔扣款、幂等、补跑、已存在版本跳过、试用不续费、终身/手动/取消/过期不扣、缺汇率留空、昨日汇率回退、多笔共用快照 |
| `dispatch.test.ts` | 19 | jobForCron、三个作业分发、未知表达式、DB 挂掉不抛异常、404/500/CORS、scheduled 接线、settings 自愈、基准币种切换、空汇率 |

### 7.2 测试口径（为什么可信）

- **不 mock D1**：`tests/helpers/d1.ts` 用 Node 22 内置 `node:sqlite` 实现 D1 的
  `prepare/bind/all/first/run/batch/exec` 子集（`batch` 用 `BEGIN/COMMIT/ROLLBACK` 保证原子），
  启动时**真跑 6 个 migration**，所以 CHECK、部分唯一索引、冻结触发器都是真的在拦人。
- **时间可控**：系统时间固定在「真实今天 02:00 UTC」（= 上海当天 10:00），接口算出的 `today`、
  SQLite 的 `date('now')`、真实 UTC 日期三者一致；fixture 日期全部用 `D(n)`/`M(n)` 相对今天生成。
- **无网络**：`fetch` / `now` / `sleep` 全部通过 `CronDeps` / `NotifyDeps` 注入。
- 一处小坑：Vite 5 的内置模块表里还没有 `node:sqlite`，静态 `import 'node:sqlite'` 会被当成 npm 包解析，
  所以 D1 替身用 `createRequire` 加载并自己声明最小类型；worker 也补了 `@types/node` 供测试 tsconfig 使用。

---

## 8. 阶段二未做 / 留给阶段三

- ~~`apps/web` 的 Vite + React + PWA + ECharts + Tailwind 全部页面（当前只有占位 `dist/index.html`）。~~
  → **阶段三已完成，见 §9**。
- 真实部署：`wrangler d1 create` 拿 `database_id`、`wrangler secret put`、`migrations apply --remote`。
  → 仍未执行（没有账号级 API Token），步骤已写进 `README.md` §3.4。
- 所有「需求没写死、由实现决定」的点都在 `README.md` §7「假设」里逐条列出（阶段一/二 38 条 + 阶段三 14 条），
  改动其中任何一条都要同步改测试。

**下一步等收尾指令。**

---

# 9. 阶段三：前端骨架 + 交付收尾

> 范围：**只写 `apps/web`**，另外补了 `README.md` 与根 `package.json` 的脚本。
> `apps/worker`、`packages/core`、`migrations/`、`wrangler.toml` **一行没改**（只读它们对齐接口形状）。
> 完成时间：2026-10-10 · 未部署、未推送 GitHub。

## 9.1 技术选型（全部是稳定组合，无重型依赖）

| 关注点 | 选择 | 说明 |
|---|---|---|
| 构建 | Vite 5.4 + TS 5.6 | 与 worker 的 vitest 2 / vite 5 同代，锁文件里不会出现两套 Vite |
| UI | React 18.3 + react-router-dom 6.28 + Tailwind 3.4 | **不引入任何 UI 组件库**（Antd/MUI/shadcn 都没有） |
| 图表 | ECharts 5.5（`echarts/core` 按需注册 BarChart） | 不引入 echarts-for-react 之类的封装 |
| PWA | 手写 `manifest.webmanifest` + `public/sw.js` | 不引入 Workbox / vite-plugin-pwa |
| 图标 | `scripts/gen-icons.mjs`（Node 内置 zlib 手写 PNG） | 不引入 sharp/canvas 等图形库；产物已提交 |
| 取数 | 自写 `useApi`（60 行） | 不引入 react-query/SWR/Axios，`fetch` 直接用 |
| 测试 | vitest 2.1 + jsdom 25 + @testing-library/react 14 | 纯函数 + 示例数据 + jsdom 页面冒烟 |

## 9.2 六个页面

| 路由 | 页面 | 数据来源 | 要点 |
|---|---|---|---|
| `/` | 总览 | `GET /api/summary` | 三种状态**分开统计**（正常/异常/已结束各一张卡片 + 各自名单）；月均、年均、未来 30 天三张数字卡；异常项标红 + core 给的中文原因；`stale`/`missingCurrencies` 翻译成提示横幅（缺币种=红、过期=橙） |
| `/subscriptions` | 订阅列表 | `GET /api/subscriptions` + `/api/categories` | 名称搜索（300ms 防抖）、状态筛选、分类筛选；异常行红色左边框 + 红色原因；卡片显示分类色点、类型/渠道/续费方式、月均、下次到期（含"3 天后"） |
| `/subscriptions/new` | 新增订阅 | `POST /api/subscriptions`（带首个 `version`） | 基本信息 + 首个价格版本一次提交；支持试用（试用结束日 + 转正价/周期） |
| `/subscriptions/:id/edit` | 编辑订阅 | `PATCH` + `POST /:id/versions` | **改价格 = 新建版本**：基本信息与价格分成两个卡片、两个提交按钮；已生效版本只读并标注「金额/币种/周期不可改」；改动金额/币种/周期时提示"将新增价格版本、历史不受影响"；同订阅同日已有版本 → 前端禁用提交 |
| `/subscriptions/:id` | 订阅详情 | `GET /api/subscriptions/:id` | 版本历史（生效日/价格/周期/套餐名，冻结 vs 未生效徽标，试用与转正价）+ 扣款记录（原币金额、冻结基准金额与汇率、自动/手动、已支付/失败/退款）+ 「记一笔」手动记账（`POST /api/charges`）+ 软删除 |
| `/trends` | 趋势 | `GET /api/trends?group=` | 月度堆叠柱状图，四个维度切换（分类/付费周期/扣费渠道/订阅类型）、区间 6/12/24 个月；缺汇率的格子**留空**（不是 0）；区间合计、分组数、排除笔数说明（失败/退款/孤儿） |
| `/settings` | 设置 | `GET/PUT /api/settings`、`/api/channels`、`POST /settings/reset-ics-token` | 基准币种、时区（`Intl.supportedValuesOf('timeZone')`）、终身摊销月数；ICS 完整地址 + 复制 + 重置令牌（二次确认 + 旧地址立即失效说明）；提醒渠道列表/新增/删除（`secret_ref` 与 `secrets_encrypted` 至少一个，前端永不回显密文）；「本地连接」= API 地址 + ADMIN_TOKEN + 数据模式 + 示例场景 |

底部导航四档（总览/订阅/趋势/设置），手机优先，`max-w-app` 居中，底部避开 iPhone Home 指示条。

## 9.3 数据层：三种模式 + 示例数据兜底

- `lib/conn.ts`：`apiBase / token / mode(auto|live|mock) / mockScenario`，存 localStorage（**令牌不编译进产物**）。
- `lib/api.ts`：唯一网络出口。`auto` 模式下未配置令牌、或**读请求**连不上/报错 → 用示例数据渲染并在
  顶部标注「示例数据」+ 原因；**已配置令牌时的写请求绝不静默落进示例数据**，而是报错，避免"假保存成功"。
- `lib/mock/`：示例数据不是写死的 JSON，而是**用 core 的 `summarize / monthlyTrend / getStatus / convert`
  现算**（和 Worker 同一套口径），日期相对「今天」（按 `settings.timezone`）生成。覆盖：月付涨价历史、
  年付、终身摊销、试用过期未转正（异常）、已取消（已结束）、USD 与 JPY 外币扣款。
  三个场景 `healthy / stale / missing` 只改汇率快照；`missing` 缺 **JPY**（USD 是汇率基准，它本来就没有快照行）。
  示例数据**可写**：新建订阅、新增版本、记账、改设置、增删渠道都真的改内存状态，页面能来回点通。
- `lib/format.ts`：金额（整数最小单位 ⇄ 主单位，精度超限直接报错）、日期、距今天数、中文标签，
  以及 `fxNotices()` —— 把 `stale / missingCurrencies` 翻成"明确提示"的纯函数（有单测）。
- `lib/versioning.ts`：改价规则（`changedFrozenFields / newVersionHint / hasVersionOn`）+ 表单草稿校验，纯函数、有单测。

## 9.4 PWA

- `manifest.webmanifest`：`standalone`、中文名、主题色 `#0f172a`、192/512/maskable/180 四个图标。
- `sw.js`：`/api`、`/ics` **永不缓存**；导航 network-first（离线回落缓存的 `index.html`）；
  同源静态资源 cache-first + 后台刷新；`VERSION` 变更时 activate 清旧缓存。
- 只在 `import.meta.env.PROD` 注册 SW（开发时注册会缓存 Vite 模块，改代码看不到效果）。
- 图标：`node scripts/gen-icons.mjs` 手写 PNG 编码器画深色圆角底 + 浅蓝 ¥ 标记，maskable 缩到安全区。

## 9.5 测试（84 条，`pnpm test` 全过）

| 文件 | 条数 | 覆盖 |
|---|---|---|
| `src/lib/format.test.ts` | 17 | 金额格式化/精度校验/往返、日期与相对天数、中文标签、汇率健康度提示（含同时缺币种+过期） |
| `src/lib/versioning.test.ts` | 18 | 冻结判定、改动字段、**改价必须新建版本**的三种分支、同日重复、草稿校验（试用/固定天数/终身/精度） |
| `src/lib/mock/mock.test.ts` | 17 | 数据集完整性、三种状态、涨价历史按版本记账、三类场景（healthy/stale/missing）、趋势四维度、写入（建订阅/建版本/同日 409/记账冻结/设置/渠道/404） |
| `src/lib/api.test.ts` | 16 | buildUrl、auto 回落（无令牌/网络错误/500）、**写请求不回落**、live 报错与请求头、空响应体、mock 模式、场景开关 |
| `src/lib/trendOption.test.ts` | 6 | series 顺序与长度、**缺汇率保持 null**、主单位换算、分类配色、跨年轴标签、空分组 |
| `src/App.test.tsx` | 10 | **jsdom 页面冒烟**：总览（三状态+汇率提示）、列表筛选、详情版本历史、**编辑页改价提示**、新增页提交后跳详情、趋势切维度、设置页 ICS/渠道、404 回落 |

## 9.6 动手前对齐的接口形状（只读 Worker 得到）

- `GET /api/subscriptions` → `{items, counts{total,active,ended,anomaly}, today, base_currency}`；条目含
  `status/reason_code/reason/next_due_date/current_version/monthly_amount_minor` 与 label 字段。
- `GET /api/subscriptions/:id` → `{item, versions, charges}`；`POST /api/subscriptions` 可带 `version`；
  `POST /:id/versions` **只许新增**（同订阅同日冲突 409）；`PATCH /:id/versions/:vid` 已生效版本只许改 `plan_name`。
- `GET /api/summary` → `{item: SummaryResult & {window_days, generated_at}}`。
- `GET /api/trends?group=category|cycle|channel|type&from=YYYY-MM&to=YYYY-MM` → `{item: TrendResult, today}`。
- `GET/PUT /api/settings`、`POST /api/settings/reset-ics-token`（响应带 `ics_path`）。
- `GET/POST/DELETE /api/channels`（响应只有 `has_secrets_encrypted`，永无密文）。
- `POST /api/charges` → `{item, fx_warning}`；`DELETE /api/subscriptions/:id` 软删除。

## 9.7 交付收尾

- **README**：§1 进度表、§2 目录树、§3 本地开发（3.2 前端 + 示例数据说明）、§3.4 部署
  （创建 D1 → 换 `database_id` → `migrations apply --remote` → `wrangler secret put` → `pnpm run deploy`，
  并注明需要用户自己的 Cloudflare API Token/凭据、`[assets]` 必须先 build 前端）、
  §5 ICS 的复制/重置、§7.7 前端假设（39~52 条）、§8 已知限制。
- **根 `package.json`** 新增脚本：`deploy`（先 build 前端 → `wrangler deploy`）、`dev`（前端）、
  `dev:worker`、`test:web`、`db:migrate:local/remote`、`db:seed:local`。
  > **坑（已实测）**：pnpm 10 自带 `deploy` 子命令且优先级高于同名脚本，所以 `pnpm deploy` 与
  > `pnpm --filter @submgr/worker deploy` 都**跑不到**我们的脚本 —— 必须用 `pnpm run deploy` /
  > `pnpm --filter @submgr/worker run deploy`。脚本内部也已统一改成 `run` 形式，
  > `apps/worker` 里的 `"deploy": "wrangler deploy"` 保持不变。
- 版本/进度口径：`pnpm test` = core 254 + worker 163（+ 50 条 schema 校验）+ web 84；`pnpm typecheck` 三个包全绿；
  `pnpm build` 能出 `apps/web/dist`（约 758 KB / gzip 252 KB，主要是 ECharts + React）。

## 9.8 本阶段未做（明确留给收尾或后续）

- **没有部署、没有推送 GitHub**（等收尾指令）；`wrangler.toml` 的 `database_id` 仍是占位值。
- 没有在真机/真浏览器验证：只做了构建 + jsdom 冒烟，PWA 安装、离线、iOS Safari 均未实测。
- 未做提醒规则页面、分类管理页面、未来生效版本的编辑/删除入口（README §7.7 第 45、46 条）。
- 没有加深色模式、没有做多用户/登录（单用户自用，令牌即身份）。

## 9.9 终验（对照总提示词逐项核对）与修复

按总提示词逐项核对了一遍（技术栈 9 项 / 硬性规则 7 条 / 数据模型 9 张表 / core 5 个函数 + 8 类测试场景 /
Worker 接口与 Cron / 前端六页面 / 交付物 5 项），结论：**47 项 PASS、3 项 FAIL、9 项 UNCLEAR**（明细见当轮报告）。
需求方拍板后**只改文档，代码一行未动**：

| 项 | 处理 |
|---|---|
| F1 未使用 Drizzle ORM（spec 明确要求） | 承认偏离，写进 **README §7.8 第 53 条**（含替代方案与原因），并在 §1、§8 加了指引 |
| F2 README 未提 Cloudflare Access | 在 **§4 接口一览的鉴权段**补一段：把 `/api/*` 放到 Access 后面、零代码改动；并说明 ICS 不能走 Access、`wrangler dev` 不走 Access、`workers.dev` 一般挂不了 Access |
| F3 `pnpm deploy` 被 pnpm 内置命令抢占 | 保持 `pnpm run deploy`（已实测），不改名 |
| U1~U9（schedule 规则单表承载、`charges.base_currency` 额外列、已生效版本禁删、前端多做的「记一笔 / 摊销月数 / 本地连接 / 示例数据兜底」、ICS 左开右闭窗口、`settings.id`、stale 基于 `fetched_at`） | **全部接受现状**，原有假设条目保留不动 |
| U3 退款符号约定 | 补进 **README §7.8 第 54 条**（正数金额 + `status='refunded'`，趋势里当负数） |
| U4 月均/年均不含已结束订阅 | 补进 **README §7.8 第 55 条** |

修复后重跑：`pnpm test` 全过（core 254 + worker 163 + schema 校验 50 + web 84）、`pnpm typecheck` 三包全绿。
**停下等 GitHub 收尾指令，未推送、未部署。**
