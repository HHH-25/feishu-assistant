# 飞书企业数据中心 MVP

测试环境双闭环骨架：**文件入口**（上传→鉴权→哈希去重→云盘/台账）+ **日报出口**（多维表→汇总→模型摘要→回写→推送）。  
**默认 `CLIENT_MODE=mock`、`MODEL_MODE=mock`**，不依赖真实凭证。独立飞书测试租户已接入文件、表格和机器人；Mock 数据和操作者不能作为真实验收证据。

## 快速开始

```bash
# Node.js >= 22.16
npm install
npm start
```

一条命令启动后默认仅监听 `http://127.0.0.1:3000`。

## 现在怎么用

当前交付物是运行在电脑或服务器上的集成服务。管理员网页 `/admin` 的代码已加入，默认关闭；需部署到 HTTPS、配置飞书网页应用入口和登录身份白名单后才能从飞书工作台打开，**目前还没有完成飞书内实际联调**。登录飞书后能查看归档文件、多维表台账和机器人摘要；登录本身不会自动抓取或汇总数据。

1. 在项目目录运行 `npm start`。访问本机 `http://127.0.0.1:3000/health` 确认服务模式；服务未运行时，手机飞书仍能查看已写入的历史测试数据，但不能触发新的归档或汇总。
2. 通过 REST `POST /api/v1/archives` 上传 PDF、DOCX、XLSX、TXT，或由 MCP 客户端调用 `archive_file`。服务校验可信身份与空间权限，写入指定飞书测试目录和文件台账；可用 `GET /api/v1/archives` 按文件名、部门、状态查当前身份有权查看的台账。真实模式请求需要已配置的 Bearer 凭证，不能仅靠飞书网页登录。
3. 通过 REST `POST /api/v1/daily-summary/run` 或 MCP `trigger_daily_summary` 手动汇总；启用 `DAILY_CRON_ENABLED=true` 且主机持续运行时，服务在 Asia/Shanghai 20:00 检查并执行同一流程。若主机错过 20:00，当天恢复后会补跑；跨日不自动回填。结果写入摘要与任务表，并发到专用测试群。
4. 在飞书中查看结果：公共与财务测试目录在云文档的云盘中；六张台账位于专用多维表；摘要消息位于“MVP虚构数据联调-仅测试”群。财务目录只给管理员、测试应用和财务测试账号 hyh 授权。

管理员网页启用条件和登录配置见 [部署与联调说明](docs/部署说明.md)，当前电脑的测试步骤见[飞书工作台演示](docs/飞书工作台演示.md)。页面通过飞书登录码在服务端核验身份，不把应用密钥或 API Bearer Key 放到浏览器；归档、查询和手动汇总仍调用同一业务服务。

真实飞书＋真实 DeepSeek 的手动汇总，以及真实飞书＋模拟模型的 20:00 定时已分别通过。普通账号原生拒绝验证、部分故障对账和飞书工作台真实登录与部署演练仍待完成，详见[测试与问题记录](docs/测试与问题记录.md)。

```bash
# 业务规则 + REST mock 单测
npm test

# 类型检查
npm run typecheck
```

开发热重载：`npm run dev`

## Mock / Real 切换

| 方式 | 说明 |
| --- | --- |
| 默认 | `CLIENT_MODE=mock`、`MODEL_MODE=mock`，内存飞书/模型 |
| 飞书联调 | `CLIENT_MODE=real`、`MODEL_MODE=mock`，真实文件/表格/消息与模拟摘要 |
| 全链路 | `CLIENT_MODE=real`、`MODEL_MODE=real`，另需模型密钥；`MODEL_PROVIDER` 可选 `openai` 或 `deepseek` |

`real` 模式已实现飞书令牌、云盘上传、多维表读写、机器人消息及模型摘要，入口要求 `API_ACTORS_JSON` 中配置的 Bearer 凭证。真实验收状态见 [测试与问题记录](docs/测试与问题记录.md)，配置和六张表的字段见 [部署与联调说明](docs/部署说明.md)。

密钥只放环境变量，**不要提交 `.env`**。

虚构测试文件见 [`samples/synthetic/`](samples/synthetic/)。隔离租户的六张表就绪后，可用 `FEISHU_TEST_SEED_ALLOWED=true npm run seed:test -- YYYY-MM-DD` 重复写入虚构日报和应交名单；执行前须设 `CLIENT_MODE=real` 并核对目标租户，详情见部署说明。

当前验证进度和未完成项见 [测试与问题记录](docs/测试与问题记录.md)。

## Mock 闭环演示

### 闭环 A：文件归档

```bash
# 1) 上传并写台账
curl -X POST http://localhost:3000/api/v1/archives ^
  -F "file=@./samples/demo.txt" ^
  -F "department=销售" ^
  -F "confidentiality=dept" ^
  -F "space_id=space_sales" ^
  -F "operator=user:alice"

# 2) 查台账（把 ARCHIVE_ID 换成上一步返回值）
curl http://localhost:3000/api/v1/archives/ARCHIVE_ID

# 3) 同内容再传一次 → deduplicated=true
curl -X POST http://localhost:3000/api/v1/archives ^
  -F "file=@./samples/demo.txt" ^
  -F "department=销售" ^
  -F "confidentiality=dept" ^
  -F "space_id=space_sales" ^
  -F "operator=user:bob"

# 4) 版本变更（不同内容同名）
curl -X POST http://localhost:3000/api/v1/archives ^
  -F "file=@./samples/demo-v2.txt" ^
  -F "department=销售" ^
  -F "confidentiality=dept" ^
  -F "space_id=space_sales" ^
  -F "operator=user:alice"

# 5) 普通用户写财务空间 → 403
curl -X POST http://localhost:3000/api/v1/archives ^
  -F "file=@./samples/demo.txt" ^
  -F "department=财务" ^
  -F "confidentiality=finance" ^
  -F "space_id=space_finance_test" ^
  -F "operator=user:alice"
```

财务空间需 elevated 操作者（如 `finance:cfo`），普通用户会 403 并记审计。

### 闭环 B：日报汇总

```bash
# 1) 注入演示种子：A/B 已交、C 缺交（仅 mock）
curl -X POST http://localhost:3000/api/v1/mock/seed-daily ^
  -H "Content-Type: application/json" ^
  -d "{\"business_date\":\"2026-10-14\"}"

# 2) 手动触发汇总（与 20:00 共用逻辑）
curl -X POST http://localhost:3000/api/v1/daily-summary/run ^
  -H "Content-Type: application/json" ^
  -d "{\"business_date\":\"2026-10-14\",\"operator\":\"admin\"}"

# 3) 同日再跑一次 → idempotent_skip_send=true，不重复推送
curl -X POST http://localhost:3000/api/v1/daily-summary/run ^
  -H "Content-Type: application/json" ^
  -d "{\"business_date\":\"2026-10-14\",\"operator\":\"admin\"}"

# 4) 查看定时状态（真实 cron 可后置；也可设 DAILY_CRON_ENABLED=true）
curl http://localhost:3000/api/v1/daily-summary/schedule
```

单测标签对齐验收风格：**T1–T4**（归档校验/权限/去重/版本）、**T5–T8**（缺交/摘要结构/触发共用/幂等）。

## REST 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查与当前 mode |
| POST | `/api/v1/archives` | multipart 归档 |
| GET | `/api/v1/archives` | 按权限列出和筛选归档台账 |
| GET | `/api/v1/archives/:archiveId` | 查归档状态 |
| POST | `/api/v1/daily-summary/run` | 手动触发某日汇总 |
| GET | `/api/v1/daily-summary/schedule` | 定时状态 |
| GET | `/api/v1/daily-summary/:businessDate/status` | 任务及发送回执状态 |
| POST | `/api/v1/recovery/message` | 管理员核对不确定的消息发送 |
| POST | `/api/v1/recovery/upload` | 管理员核对不确定的文件上传 |
| POST | `/api/v1/mock/seed-daily` | 仅 mock：注入演示日报 |

MCP stdio 可用 `npm run mcp` 启动，提供 `archive_file`、`get_archive_status`、`trigger_daily_summary` 三个工具；真实模式由 `MCP_API_KEY` 映射可信身份。工具与 REST 共用业务服务、权限和审计。

## 文档

- [环境就绪检查表](docs/环境就绪检查表.md) — 启动前外部依赖与阻塞留证
- [第1日设计文档](docs/第1日设计文档.md) — 需求复述、架构、数据模型、接口、风险
- [部署与联调说明](docs/部署说明.md) — 安装、字段契约、故障核对、真实验收
- [接口说明（D4 草稿）](docs/接口说明.md) — REST 字段与错误约定

## 当前待完成

- 模型密钥尚未提供；真实模型摘要未验收。
- 财务账号 hyh 已确认可见虚构财务文件；普通账号 6666ZK 的原生拒绝验证需由账号持有人配合。20:00 定时需在保持唤醒的主机上重测。
- 发送/上传结果不确定时的真实人工核对、真实飞书部署演练和 Office 在线文档导入尚待完成；干净副本的 Mock 启动检查已通过。
- **正式 10 日计时未开始**。发现阻塞后须在 2 小时内留证（见检查表模板）。

## 目录结构

```
docs/                 中文设计、部署、接口、环境检查表
samples/              mock 演示样例文件
src/
  clients/            FeishuClient / ModelClient（mock + real）
  services/           归档、日报汇总、轻量调度
  demo/               mock 种子数据
  mcp/                MCP stdio Server
  app.ts / index.ts   REST 入口
tests/                业务规则、REST、MCP、HTTP 契约、跨进程回执测试
.env.example          配置样例（无真实密钥）
```
