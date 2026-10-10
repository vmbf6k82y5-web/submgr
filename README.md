# 订阅管家（submgr）

个人自用的订阅追踪工具：记下每笔订阅的价格版本、自动算出「每月/每年要花多少钱」、在到期前提醒、把到期日喂进手机日历。

**运行时形态**：Cloudflare Workers（Hono）+ D1（SQLite）+ Cron Triggers + Static Assets，前端是 React PWA（Vite 构建后由 Worker 的 Static Assets 托管）。

---

## 1. 当前进度

| 阶段 | 内容 | 状态 |
|---|---|---|
| 一 | `packages/core`：纯领域逻辑（时间/金额/周期/状态/汇率/汇总/趋势）+ D1 migration + schema 校验器 | ✅ 完成（254 条单测） |
| 二 | `apps/worker`：`/api/*` 接口、`/ics/:token.ics`、三个 Cron 作业、`wrangler.toml` | ✅ 完成（163 条集成测试 + 50 条 schema 校验） |
| 三 | `apps/web`：Vite + React + TS + Tailwind + ECharts，PWA，六个页面 | ✅ 完成（84 条前端测试，含 jsdom 页面冒烟） |

**尚未部署到 Cloudflare**（没有账号级 API Token），`wrangler.toml` 里的 `database_id` 是占位值，
前端也只做过本地构建与 jsdom 冒烟，没有在真机/真浏览器上跑过，见 §7.7、§8。
另有 **1 处已知技术栈偏离**（未使用 Drizzle ORM，已确认接受），见 §7.8 第 53 条。

---

## 2. 目录结构

```
submgr/
├── packages/core/            # 纯函数领域层，不依赖任何运行时（Workers/Node 都能跑）
│   ├── src/{time,money,cycles,amounts,status,fx,summary,trend,types}.ts
│   └── tests/                # 254 条单测
├── apps/worker/              # Cloudflare Worker
│   ├── migrations/           # 0001..0006（**已冻结，不许改表结构**）
│   ├── seed/seed.sql         # 本地开发用种子数据
│   ├── scripts/validate-schema.mjs   # 50 条 schema 约束校验
│   ├── src/
│   │   ├── index.ts          # Hono 入口：路由挂载 / notFound / onError / scheduled
│   │   ├── auth.ts env.ts ics.ts
│   │   ├── lib/              # db / validate / settings / fx / world / upcoming / errors
│   │   ├── routes/           # subscriptions charges categories summary trends reminders channels settings
│   │   ├── notify/           # secrets（密钥解析）/ send（飞书+Telegram）/ messages（文案）
│   │   └── cron/             # deps / adapters（汇率源）/ retry / fx / reminders / charges / index
│   ├── tests/                # 163 条集成测试（真跑 migration）
│   └── wrangler.toml
└── apps/web/                 # 前端（Vite + React + TS + Tailwind + ECharts，PWA）
    ├── index.html            # SPA 入口（manifest / theme-color / apple-touch-icon）
    ├── vite.config.ts        # /api、/ics 代理到 wrangler dev；vitest 配置
    ├── tailwind.config.js postcss.config.js
    ├── scripts/gen-icons.mjs # 手写 PNG 编码器生成 PWA 图标（不引入图形库）
    ├── public/
    │   ├── manifest.webmanifest  # PWA 清单
    │   ├── sw.js                 # 手写 Service Worker（/api 永不缓存）
    │   └── icons/                # 192 / 512 / maskable / apple-touch-icon
    └── src/
        ├── main.tsx App.tsx      # 入口 + 路由（六个页面）
        ├── components/           # Layout / ui / VersionFields / EChart
        ├── hooks/useApi.ts       # 取数与提交（一个 useEffect，不引入 react-query）
        ├── lib/
        │   ├── api.ts conn.ts source.ts  # 接口出口 / 连接配置 / 数据来源提示
        │   ├── format.ts versioning.ts   # 展示格式化 / 改价与版本规则（纯函数）
        │   ├── trendOption.ts            # 趋势结果 -> ECharts 配置（纯函数）
        │   └── mock/                     # 内置示例数据（data / dto / handler）
        ├── pages/                # Overview Subscriptions SubscriptionForm
        │                         # SubscriptionDetail Trends Settings
        └── **/*.test.ts(x)       # 84 条前端测试（含 jsdom 页面冒烟）
```

---

## 3. 本地开发

需要 Node ≥ 22.5（测试用到内置 `node:sqlite`）与 pnpm 10。

```bash
pnpm install
pnpm test          # core 254 条 + worker 163 条 + 50 条 schema 校验 + web 84 条
pnpm typecheck     # 三个包全部 tsc --noEmit
pnpm build         # core 产出 d.ts；worker 干跑 wrangler；web 出 dist/
```

### 3.1 跑 Worker（本地）

```bash
cd apps/worker
cp .dev.vars.example .dev.vars     # 填 ADMIN_TOKEN
pnpm db:migrate:local              # 建本地 D1 表结构
pnpm db:seed:local                 # 可选：灌种子数据
pnpm dev                           # http://localhost:8787
```

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:8787/api/subscriptions
```

### 3.2 跑前端（Vite）

```bash
pnpm dev                 # = pnpm --filter @submgr/web dev → http://localhost:5173
```

- `vite.config.ts` 把 `/api`、`/ics` 代理到 `http://127.0.0.1:8787`，所以**前台起 Vite、后台起 Worker**
  就是完整的本地环境（同源，不需要 CORS）。
- **Worker 没起来也能看页面**：`auto` 模式（默认）在「没配置 ADMIN_TOKEN」或「接口连不上」时
  自动使用 `src/lib/mock/` 里的内置示例数据，顶部会显示醒目的「示例数据」横幅。
- 在「设置 → 本地连接」里填 **API 地址**（留空 = 同源）与 **ADMIN_TOKEN**，即可切到真实接口；
  数据模式可设为 `自动 / 只用真实接口 / 只用示例数据`，示例数据还能切「汇率过期 / 缺 JPY 汇率」
  两个场景来看异常提示。
- 令牌只存在浏览器 `localStorage`（不编译进 JS 产物）；`VITE_*` 里没有放任何密钥。

### 3.3 生成 secrets

密钥**不进数据库**，只从环境变量 / secret 读。两种落地方式：

```bash
cd apps/worker     # wrangler 是本仓库的 devDependency，用 pnpm exec 调，不需要全局装

# ① secret_ref：渠道只存「环境变量名」，值本身放 Worker secret
pnpm exec wrangler secret put ADMIN_TOKEN
pnpm exec wrangler secret put FEISHU_MAIN      # {"webhook_url":"...","sign_secret":"..."}
pnpm exec wrangler secret put TELEGRAM_MAIN    # {"bot_token":"...","chat_id":"..."}

# ② secrets_encrypted：把密钥 JSON 用 AES-256-GCM 加密后存库
#    密文格式 base64( iv(12 字节) || 密文与 tag )，主密钥 NOTIFY_SECRET_KEY = base64(32 字节)
pnpm exec wrangler secret put NOTIFY_SECRET_KEY
```

### 3.4 部署（需要你自己的 Cloudflare API Token）

> 本仓库**不含**任何 Cloudflare 凭据，下面的命令都在你自己的账号下执行。

```bash
# 所有 wrangler 命令都在 apps/worker 里跑：wrangler 是本仓库的 devDependency，
# 用 pnpm exec 就能调用，不需要全局安装。
cd apps/worker

# 0) 登录（交互式，会开浏览器）。CI / 非交互部署才用 Token：
#    export CLOUDFLARE_API_TOKEN=...     # 权限：Workers Scripts:Edit + D1:Edit
#    export CLOUDFLARE_ACCOUNT_ID=...
pnpm exec wrangler login

# 1) 建 D1，把输出的 database_id 填进 wrangler.toml（现在文件里是占位 UUID）
pnpm exec wrangler d1 create submgr

# 2) 建表：本地库随时可建，远端库要在部署前建
pnpm db:migrate:local            # = wrangler d1 migrations apply submgr --local
pnpm db:migrate:remote           # = wrangler d1 migrations apply submgr --remote
pnpm db:seed:local               # 可选：本地灌种子数据

# 3) 写密钥：值只在你本机输入，绝不写进 wrangler.toml，也绝不进 D1
pnpm exec wrangler secret put ADMIN_TOKEN          # 必填：/api 的 Bearer 令牌
pnpm exec wrangler secret put NOTIFY_SECRET_KEY    # 可选：加密渠道密钥的主密钥（base64 32 字节）
pnpm exec wrangler secret put FEISHU_MAIN          # 可选：渠道 secret_ref 指向的环境变量名
pnpm exec wrangler secret put TELEGRAM_MAIN        # 可选

# 4) 部署：先构建前端，再 wrangler deploy（回到仓库根执行）
cd ../..
pnpm run deploy
#   = pnpm --filter @submgr/web build && pnpm --filter @submgr/worker run deploy
#   ⚠️ 必须写 pnpm run deploy：pnpm 自带一个 deploy 子命令（workspace 部署），
#      会盖住同名脚本，写成 pnpm deploy 跑的是 pnpm 自己的东西。
#   只想干跑：pnpm --filter @submgr/worker build   （= wrangler deploy --dry-run --outdir=dist）
#   只想单独部署 Worker：pnpm --filter @submgr/worker run deploy

# 5) 打开 https://submgr.<你的子域>.workers.dev，
#    在「设置 → 本地连接」里填入 ADMIN_TOKEN（令牌只存这台设备的 localStorage）
```

部署前必须注意的三件事：

- `apps/worker/wrangler.toml` 里的 `database_id` 必须先换成真实值，否则会部署到占位库上。
- **要敲 `pnpm run deploy`**（根 `package.json` 里的自定义脚本）：先 build 前端，再调用 Worker 的
  `pnpm --filter @submgr/worker run deploy`（= `wrangler deploy`）。注意 **`pnpm deploy` 不会跑这个脚本** ——
  pnpm 10 自带同名子命令（workspace deploy）且优先级更高，`pnpm --filter @submgr/worker deploy` 同理，
  所以脚本调用一律用 `run` 形式。
- `[assets]` 指向 `apps/web/dist`，所以**必须先构建前端**。`dist/` 在 `.gitignore` 里（不入库），
  它只在本地 `pnpm --filter @submgr/web build` 或 `pnpm run deploy` 时生成。

Cloudflare API Token / `ADMIN_TOKEN` 都是你自己的凭据：本项目不需要、也不会保存它们；
只有要在 CI 里做非交互部署时才临时 `export`（别写进 `wrangler.toml`，也别提交进仓库）。

---

## 4. 接口一览

`/api/*` 全部要求 `Authorization: Bearer $ADMIN_TOKEN`（用 SHA-256 摘要做常数时间比较；
`ADMIN_TOKEN` 没配置时**一律 500**，不会退化成「不校验」）。

> **也可以改用 Cloudflare Access（零代码改动）**：绑定自有域名后，在 Cloudflare 控制台给
> `你的域名/api/*` 建一条 Access 应用（策略可以是「只允许我自己的邮箱」，或 Service Token +
> `CF-Access-Client-Id` / `CF-Access-Client-Secret` 走机器访问），由 Access 在 Worker **之前**
> 挡掉所有 `/api` 请求，Worker 侧不用改一行代码。
>
> 两者可以叠加，建议叠加：
> * `/ics/:token.ics` **不能**走 Access（日历客户端带不了 Access 的 cookie/请求头），
>   它必须继续靠路径令牌，所以 `ADMIN_TOKEN` 保留着更稳（Access 挂了也不至于全裸）；
> * 本地 `wrangler dev` 不经过 Access，仍然只有 Bearer 这一道门；
> * Access 应用需要一个你能控制的 zone，`*.workers.dev` 子域上一般挂不了 Access，
>   具体以控制台实际可用性为准。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/api/subscriptions` | 列表（状态、当前版本、月均、分类名）/ 新建（可顺带带首个价格版本） |
| GET/PATCH/DELETE | `/api/subscriptions/:id` | 详情（含版本与扣款）/ 修改 / 软删除（级联软删版本与提醒规则） |
| GET/POST | `/api/subscriptions/:id/versions` | 价格版本：只许新增 |
| PATCH/DELETE | `/api/subscriptions/:id/versions/:vid` | 已生效版本只允许改 `plan_name`，且不许删除（409 `version_frozen`） |
| GET/POST | `/api/charges` | 扣款流水（可按订阅/区间/状态/来源过滤）/ 手动记账（自动冻结汇率） |
| PATCH/DELETE | `/api/charges/:id` | 改金额/日期会**重新冻结**当天的汇率 / 软删除 |
| GET/POST | `/api/categories` | 分类 + 每类订阅数 / 新建 |
| GET/POST | `/api/reminders` | 提醒规则（due / schedule）/ 新建 |
| GET | `/api/reminders/log` | 提醒发送记录（去重依据） |
| PATCH/DELETE | `/api/reminders/:id` | 改 / 软删除规则 |
| GET/POST | `/api/channels` | 通知渠道（**永不回显密文**）/ 新建 |
| GET/PUT | `/api/settings` | 单行配置（基准币种、时区、ICS 令牌、终身摊销月数） |
| POST | `/api/settings/reset-ics-token` | 轮换日历令牌（旧地址立刻 404） |
| GET | `/api/summary` | 汇总：状态计数、月均/年均、未来 30 天、汇率健康度、异常清单 |
| GET | `/api/trends` | 月度堆叠趋势（`group=category\|cycle\|channel\|type`） |
| GET | `/ics/:token.ics` | 日历订阅（**不走 Bearer**，令牌即凭证） |

错误体统一为 `{"error":{"code","message","details?"}}`；`400` 参数非法、`401` 鉴权失败、
`404` 不存在、`409` 冲突（重名 / 版本冻结 / 同日版本重复）、`500` 服务端错误。

---

## 5. 日历订阅（ICS）

```
https://<worker 域名>/ics/<ics_token>.ics
```

- 令牌在 `settings.ics_token`（`GET /api/settings` 会返回完整的 `ics_path`），可用
  `PUT /api/settings`（`ics_token` 或 `reset_ics_token: true`）或 `POST /api/settings/reset-ics-token` 轮换。
- 窗口：**（今天 − 1 天, 今天 + 12 个月]**，所以「今天到期」也在日历里。
- 事件：全天事件（`DTSTART;VALUE=DATE` / `DTEND` = 次日）+ `VALARM`（`TRIGGER:-P1D`、`ACTION:DISPLAY`）。
- UID：`${subscription_id}-${due_date}`，重新生成完全一致，客户端不会重复建事件。
- 已结束（取消 / 过 `end_date`）与终身订阅不产生事件。
- 响应头 `Content-Type: text/calendar; charset=utf-8`、`Cache-Control: private, max-age=300`。
- 前端「设置」页直接展示完整地址，提供**复制**（`navigator.clipboard`，失败时提示手动长按复制）
  与**重置令牌**（`POST /api/settings/reset-ics-token`，会二次确认并说明旧地址立刻失效）。

---

## 6. Cron（三个作业，表达式是 **UTC**）

| 常量 | 表达式 | 上海时间 | 干什么 |
|---|---|---|---|
| `CRON_REMINDERS` | `*/15 * * * *` | 每 15 分钟 | 扫描到期提醒 + 周期汇总，`reminder_log` 去重 |
| `CRON_FX` | `20 16 * * *` | 00:20 | 拉 `FX_API_BASE`（默认 `https://open.er-api.com/v6/latest/USD`）写 `fx_rates`，失败重试 3 次（500ms 指数退避） |
| `CRON_DAILY` | `30 16 * * *` | 00:30 | ① 试用转正 ② 生成当日扣款并冻结汇率 |

顺序有意义：先拉汇率，后生成扣款，当天扣款才用得上当天的快照（来不及也不会出错，只是当天
`base_amount_minor` 留空待补）。

失败**不落库**（migration 已冻结，没有作业日志表），改为结构化 JSON 日志，可在
`wrangler tail` / Dashboard 里按 `event` 过滤：
`cron.fx.ok` / `cron.fx.attempt_failed` / `cron.fx.failed` / `cron.reminder.sent` /
`cron.reminder.failed` / `cron.reminders.done` / `cron.trial.converted` / `cron.charges.done` /
`cron.charges.missing_fx` / `cron.unknown` / `cron.crashed` / `http.unhandled`。

---

## 7. 假设

需求里没有写死、由实现自行决定的地方，全部列在这里。**改动其中任何一条都要同步改测试。**
§7.8 是收尾终验时补的：其中**第 53 条是对原 spec 的明确偏离**（已确认接受），54、55 条是 spec 未写死的口径。

### 7.1 接口与数据

1. **新建订阅可以顺带带一个 `version`**（`POST /api/subscriptions` 的可选字段）。否则「新建订阅」和
   「加价格版本」必须两次请求，第一条订阅会有一瞬间没有价格。
2. **已生效版本冻结到字段级**：`effective_from <= 今天` 的版本只允许改 `plan_name`，改金额/币种/周期/
   生效日返回 `409 version_frozen`；**删除同样禁止**（需求只说「只增不改」，我把「不改」落到了删除上）。
   未来版本可以随意改和删。
3. **手动记账强制 `source = 'manual'`**：`POST /api/charges` 忽略客户端传的 `source`，
   `source='auto'` 只能由 Cron 产生，否则自动扣款的幂等索引可以被伪造。
4. **汇率冻结日 = 用户时区下的今天**（`settings.timezone`），与 `charge_date` 同一口径；
   查汇率只用「`date <= charge_date` 的最新一天」，**绝不使用未来汇率**。
5. **缺汇率不静默**：`fx_rate_to_base` / `base_currency` / `base_amount_minor` 全部留 `NULL`，
   接口多返回一个 `fx_warning`；绝不写 0、也不假设 1:1。
6. **改扣款（PATCH）会按新的金额/日期重新冻结汇率**，因为「历史金额必须冻结」。
7. **软删除**：订阅、版本、扣款、分类、渠道、规则都是 `deleted_at`；删订阅会级联软删它的版本与规则。
8. **`config_json` 禁止敏感键名**（`webhook` / `bot_token` / `sign_secret` / `secret_key` / `password`，
   与 migration 的 CHECK 同一口径）；`secret_ref` 必须是环境变量名风格 `^[A-Z][A-Z0-9_]*$`，
   防止有人把 webhook URL 直接塞进数据库。
9. **`settings` 单行会自愈**：任何需要它的接口都会「没有就插一行」，所以空库第一次访问不会 500。
    若库里出现多行未删除的 settings（singleton 索引之外的脏数据），口径是「取最早创建的一行」，
    并写 `settings.multiple_alive_rows` warn 日志，不静默。
10. **`base_currency` 被改过以后**，历史扣款仍保留冻结时记录的 `base_currency`；趋势遇到
    「冻结基准 ≠ 当前基准」会退回用原币种 + 当前汇率重算（这是 core 的行为）。
11. **`/api/summary` 的 `missingCurrencies` 只列非基准币种**（core 的口径：基准币种是同币种直通，
    不登记）。汇率表整个为空时表现为 `monthlyAverageMinor = null` + `fxAsOf = null` + `stale = true`，
    而不是一笔一笔列缺失。

### 7.2 试用转正与扣款生成（Cron ③）

12. **转正版本 `effective_from = trial_end_date`**（需求原文），并**支持补跑**：
    `trial_end_date <= 今天` 都会处理，不只当天，否则漏跑一天用户就永远停在试用版本上。
13. 转正版本**沿用试用版本的 `plan_name`**，价格/周期/币种取 `after_trial_*`。
14. 「试用后不续费」的表示法 = `after_trial_*` 全为空 → **不生成转正版本，也不生成扣款**。
15. **自动扣款只对 `renew_mode = 'auto'`**；试用版本不生成（试用期没有实际扣款）、终身版本不生成
    （一次性付费不是周期扣款）、已取消 / 过了 `end_date` 的不生成。
16. 同一天多笔扣款**共用同一份汇率快照**（一次读库），保证同日口径一致。
17. 幂等靠 `UX_charges_auto_daily (subscription_id, charge_date) WHERE source='auto'`：
    先查后插，撞唯一索引也算「已存在」，重复跑不会多记一笔。
17a. **试用转正的两个防御口径**（第二双眼睛审查后补）：
    ① 一个订阅出现多个试用版本（补录/历史数据）时，只对 `effective_from` 最新的那个转正，
    更早的试用版不再生成转正版本；② 该订阅已存在「`effective_from >= trial_end_date`」的
    正式版本时跳过转正——两者都是为了避免把更早生效的版本插进版本序列中间、扰乱到期锚点。
17b. **扣款挂版本必须已生效**：`POST/PATCH /api/charges` 的 `version_id` 除「属于同一订阅」外，
    还要求 `effective_from <= charge_date`（PATCH 同改扣款日时以改完后的日期为准），
    否则 400——防止把扣款挂到未生效的未来版本上导致趋势口径错乱。

### 7.3 提醒（Cron ②）

18. **`at_time` 用字符串比较**（`HH:mm`，补零），当前用户时区时间 ≥ `at_time` 才发；
    早于 `at_time` 直接跳过、不写任何日志，所以 09:00 那次抖动漏跑，09:15 会补发。
    `at_time` 非空由 migration 0005 的 CHECK 与接口校验双重保证；cron 里仍留了一个
    防御分支：万一读到 `at_time` 为空的规则（正常数据不可达），跳过并按规则各记一条
    `cron.reminder.no_at_time` warn，不静默。
19. **同一天有多笔到期时合并成一条「清单」消息**（`buildDueListReminderText`）。这是被 schema 逼出来的
    设计：`reminder_log` 的去重键是 `(rule_id, due_date)`（`ux_reminder_log_dedupe` 部分唯一索引，已冻结），
    一条**全局**到期规则如果为同一天的每个订阅各发一条，第二条必然被去重挡掉。所以一个
    「规则 + 到期日」只对应一条消息，多笔时列成清单（每行都带各自的扣费渠道）。
20. **`every_n_days` 汇总的锚点 = 规则 `created_at` 在用户时区下的日期**（列里没有「下次发送日」这种字段，
    只能拿创建日当锚点），差值为 `interval` 的整数倍那天发。**修改规则（含 interval）不会重置锚点**
    （`created_at` 不变），所以「每 3 天」改成「每 2 天」后发送日仍相对原创建日对齐，
    而不是从修改当天重新起算；要换锚点就删了重建。
21. **周期汇总即使当天没有到期也照发**，文案写成「未来 30 天没有任何到期扣款。」，
    否则用户会分不清「没有要扣的钱」和「提醒挂了」。
22. **「未来 30 天」= （今天, 今天 + 30 天]**，与 core 的 `summarize.next30Days` **完全一致**
    （当天到期的由 `days_before = 0` 的到期规则负责，不重复计入）。`/api/summary` 的
    `next30DaysMinor` 与汇总提醒里的合计永远相等。
23. 去重命中「已经发过」时**不写 `skipped` 行**，只在返回值里体现；失败写 `result='failed'`
    的行（可以有多次，下一轮自动重试）。因为每 15 分钟跑一次，写 skipped 会把表撑大。
24. 渠道拿不到密钥 / 下游报错**只影响这一条规则**，不中断其它规则；日志里绝不出现 webhook / token 明文。
25. 飞书签名用官方算法：`string_to_sign = "${timestamp}\n${secret}"` 作 HMAC-SHA256 的 key、空串作消息，
    base64 后放进 `sign`；`code != 0` 也算失败。

### 7.4 日历（ICS）

26. **窗口是（今天 − 1 天, 今天 + 12 个月]**：左端减一天是为了把「今天到期」也放进日历，
    右端是 12 个月含当天。
27. **UID 就是 `${subscription_id}-${due_date}`**，不加域名后缀；重新生成完全一致。
28. `DTSTAMP` 用当前时刻（UTC），`DTSTART`/`DTEND` 是纯日期（全天事件），`X-WR-TIMEZONE` 只作为客户端提示；
    换行 CRLF，按 75 个八位组折行（不切断多字节字符）。
29. **不做 Bearer 鉴权**（日历客户端带不了自定义请求头），令牌即凭证，所以用 24 字节随机十六进制 +
    常数时间比较，并且 `Cache-Control: private`。

### 7.5 安全与运维

30. **不做 CORS**：`/api` 与前端同源（都由 Worker 的 Static Assets 提供），预检请求会被鉴权拦下。
    本地开发由 `vite.config.ts` 把 `/api`、`/ics` 代理到 `127.0.0.1:8787`，因此不需要在 Worker 侧开口子。
31. **Cron 表达式是 UTC**，换算到 `Asia/Shanghai` 是 00:20 / 00:30；`wrangler.toml` 与
    `src/cron/index.ts` 里的常量必须一起改。
32. **不认识的 cron 表达式不静默**：写 `cron.unknown` warn 日志并返回 `ok=false`，
    避免「改了 wrangler.toml 却忘了同步常量」被埋起来。
33. **作业不抛异常**：`dispatchCron` 统一兜底，一次网络抖动不会让整个 cron 事件标红；
    返回 `{cron, job, ok, error, result}` 供日志使用。
34. `wrangler.toml` 的 `database_id` 是**占位 UUID**，未部署；`FX_API_BASE` 放在 `[vars]`，
    密钥一律用 `wrangler secret put`。
35. **本阶段没有真的部署**，也没跑 `wrangler d1 migrations apply --remote`。

### 7.6 测试口径

36. 测试**不 mock D1**：用 Node 22 内置 `node:sqlite` 跑真实的 6 个 migration（含 CHECK、部分唯一索引、
    触发器），所以「数据库会不会拦人」也是被测对象。
37. 时间固定为「真实今天 02:00 UTC」（= 上海当天 10:00），这样接口算出的 `today`、SQLite 的
    `date('now')`（冻结触发器用）、真实 UTC 日期三者一致；所有 fixture 日期都用 `D(n)` / `M(n)` 相对今天生成。
38. 外部副作用（`fetch` / 时钟 / `sleep`）全部通过 `CronDeps` / `NotifyDeps` 注入，测试不发真实网络请求。

### 7.7 前端（阶段三）

39. **不引入 UI 组件库**：全部样式用 Tailwind 原子类，通用组件只有 `Card / Badge / Button / Field / StatCard`
    这些十几行的封装；图表用 ECharts（按需引入 BarChart + Grid/Tooltip/Legend + CanvasRenderer）。
40. **`ADMIN_TOKEN` 存 localStorage，不编译进产物**：同源部署时前端产物是公开的，令牌只存在用户设备上；
    「设置 → 本地连接」里可改 API 地址、令牌、数据模式。默认 `auto`。
41. **`auto` 模式的回落规则**：未配置令牌、或**读请求**连不上/报错 → 用内置示例数据渲染，
    顶部显示醒目的「示例数据」横幅并说明原因；**已配置令牌时的写请求绝不静默写进示例数据**，
    而是抛出错误（否则用户会以为保存成功）。`live` 模式下一律报错，不做任何回落。
42. **示例数据不是写死的 JSON**：`src/lib/mock/` 用 `@submgr/core` 的
    `summarize / monthlyTrend / getStatus / convert` 现算，日期相对「今天」（按 settings.timezone）生成，
    所以任何一天打开都是新鲜的；数据里刻意覆盖了月付/年付/终身、涨价历史、试用过期未转正、
    已取消、外币（USD/JPY）等情况。`healthy / stale / missing` 三个场景只改汇率快照 ——
    `missing` 缺的是 **JPY**，因为 USD 是汇率基准、它自己本来就没有快照行。
43. **缺汇率不显示 0**：`/api/summary` 的合计为 `null` 时界面显示「—」；趋势图里缺汇率的格子留空（`null`），
    绝不画成 0。`stale` 与 `missingCurrencies` 会被翻译成中文提示（缺币种是红色，汇率过期是橙色）。
44. **改价必须新建版本**：编辑页把「基本信息」（`PATCH /api/subscriptions/:id`）与
    「价格」（`POST /api/subscriptions/:id/versions`）分成两块、两个提交按钮；
    已生效版本只读展示并标注「金额/币种/周期不可改」；一旦金额/币种/周期与现状不同，
    提示会变成「改动会新建一个价格版本」并解释历史账目不受影响；
    同订阅同日已有版本时前端先禁用提交（后端 409 是兜底）。未来生效的版本本阶段不提供编辑入口。
45. **扣款记录的手动记账放在详情页**（`POST /api/charges`，`source` 由后端强制为 `manual`）；
    `reminder_rules`（`/api/reminders`）本阶段没有做页面 —— 需求只点了「提醒渠道」，
    接口保持可用但前端未消费（示例数据模式对未实现的接口明确返回 404，不假装成功）。
46. **提醒渠道只做「列表 + 新增 + 删除」**：`secret_ref` 与 `secrets_encrypted` 至少填一个，
    前端永不回显密文（只显示有没有）；密钥值本身仍然只能通过 `wrangler secret put` 写入。
47. **「终身摊销月数」放在设置页**：它直接决定月均/年均口径（`settings.amortize_lifetime_months`），
    属于同一行配置而不是新功能。
48. **路由与缓存**：前端用 `BrowserRouter`（不是 HashRouter），依赖 `wrangler.toml` 里
    `not_found_handling = "single-page-application"` 的 SPA 回落；开发期靠 Vite 的 history 回落。
49. **PWA 是手写的**（不引入 Workbox / vite-plugin-pwa）：`public/manifest.webmanifest` +
    `public/sw.js`。三条策略：`/api`、`/ics` 永不缓存；导航请求 network-first（离线回落缓存的
    `index.html`）；同源静态资源 cache-first + 后台刷新。**Service Worker 只在生产构建注册**
    （开发时注册会把 Vite 的模块请求也缓存住，改代码看不到效果）。
50. **图标由脚本生成**（`node scripts/gen-icons.mjs` 可随时重跑，产物已随项目保存）：用 Node 内置 zlib 手写 PNG
    （192 / 512 / maskable-512 / apple-touch-icon-180），不引入任何图形库；
    maskable 版本把图形缩到安全区内，避免被系统裁掉。
51. **前端测试口径**：纯函数（金额/日期/提示/改价规则/图表配置）+ 示例数据（读写、三个场景）
    + 接口回落策略（stub `fetch`）+ **jsdom 页面冒烟**（六个页面各渲染一遍，含筛选、改价提示、提交新建、404 回落）。
    ECharts 在 jsdom 里用桩替换（没有 canvas），图表配置由纯函数单测覆盖；
    **没有做真实浏览器/真机的视觉回归**，也没测 iOS/Android 的安装到桌面体验。
52. **根 `package.json` 的 `deploy` / `dev` 脚本是便利入口**：`pnpm run deploy` = 先 build 前端再
    `wrangler deploy`，`pnpm dev` = 起前端 Vite，Worker 开发仍是 `pnpm dev:worker` 或进 `apps/worker`。
    **必须写 `pnpm run deploy`**：pnpm 10 自带一个 `deploy` 子命令（把 workspace 包部署到指定目录），
    它的优先级高于同名脚本，所以 `pnpm deploy` / `pnpm --filter @submgr/worker deploy` 都跑不到我们的脚本
    —— 这一点已实测确认，脚本里对 Worker 的调用也统一写成 `run deploy`。

### 7.8 与原 spec 的偏离与补充口径（收尾终验新增）

53. **【对 spec 的偏离】没有使用 Drizzle ORM。** 原 spec 的「技术栈（不要更换）」里要求
    「Cloudflare D1，**用 Drizzle ORM**，用 wrangler 的 migrations 管理表结构」。
    实际实现是**手写 SQL + 自研薄封装**：`apps/worker/src/lib/db.ts` 只提供
    `firstRow` / `allRows` / `runStmt`（外加 `isUniqueViolation` / `isConstraintViolation` 这类错误判别），
    另有一份 **50 条 schema 约束校验**（`apps/worker/scripts/validate-schema.mjs`，随 `pnpm test` 一起跑）。
    **表结构这一半是满足的**：全部由 **wrangler migrations** 管理
    （`apps/worker/migrations/0001~0006` + `wrangler d1 migrations apply --local/--remote`）。
    偏离原因：本项目的数据库访问只有十来条固定查询，而 D1/SQLite 的 CHECK、部分唯一索引、触发器
    本身就是「约束的载体」（`ux_charges_auto_daily`、`ux_reminder_log_dedupe`、`ux_versions_subscription_effective` 等
    直接参与业务正确性），引入 ORM 会让 schema 与 migration 变成两套需要保持同步的定义，
    对个人自用工具来说收益小于维护成本。**这是一处明确的技术栈偏离，已与需求方确认接受**；
    若要改回 Drizzle，改动面是 db 层 + migrations 生成方式 + 每个 route 的查询。
54. **退款用「正数金额 + `status = 'refunded'`」表示**（spec 只给了 `paid/failed/refunded` 枚举，
    没有定义金额符号）：`charges.amount_minor >= 0` 由 DB CHECK 保证；趋势图把 `refunded` 当
    **负数**计入（`paid` 正数、`failed` 排除），所以退款在图上表现为一笔减项，而不是第二笔收入。
55. **月均 / 年均 / 未来 30 天不含「已结束（ended）」的订阅**（spec 未说明）：`summarize()` 只把
    `active` 与 `anomaly` 计入金额统计（见 `packages/core/src/summary.ts` 的 `included`），
    因为已取消或已过 `end_date` 的订阅不该再算进「我每月要花多少钱」；
    它们的数量**仍然照常**出现在三种状态的计数里，不会凭空消失。

---

## 8. 已知限制

- **前端没有部署过**：只做过本地 `pnpm dev`、生产构建与 jsdom 冒烟，没有真机/真浏览器验证；
  PWA 的安装、离线与 iOS Safari 的行为都还没实测。
- **技术栈偏离**：没有使用 Drizzle ORM（手写 SQL + 自研 db 薄封装 + 50 条 schema 校验替代），
  原因与影响见 §7.8 第 53 条。
- 未做「提醒规则」页面：`/api/reminders` 可用，但前端只展示提醒**渠道**（见 §7.7 第 45 条）。
- 未提供未来生效版本的编辑/删除入口（接口支持，前端没做），也没有分类管理页面
  （新增订阅时可以从已有分类里选）。
- 趋势图与总览的合计口径不同：费用合计用「当前版本月均」，趋势用**实际发生的扣款**
  （`paid` 正数、`refunded` 负数、`failed` 排除），不含「未来预测」。
- 没有作业日志表：Cron 的历史执行情况只能翻 Worker 日志（`wrangler tail`）。
- 币种只支持 ISO 4217 三字母法币白名单（没有加密货币），金额一律整数最小单位。
- 汇率只有 Cron 每天拉一次的那份快照；过期或缺失时界面只做提示，不会伪造数字。
