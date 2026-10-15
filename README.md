# 飞书企业数据中心 MVP

测试环境双闭环骨架：**文件入口**（上传→鉴权→哈希去重→云盘/台账）+ **日报出口**（多维表→汇总→模型摘要→回写→推送）。  
当前飞书租户/权限未齐，**默认 `CLIENT_MODE=mock`**，不依赖真实凭证。Mock 数据和操作者均为演示输入，不能作为真实验收证据。

## 快速开始

```bash
# Node.js >= 18
npm install
npm start
```

一条命令启动后默认仅监听 `http://127.0.0.1:3000`。

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
| 默认 | `CLIENT_MODE=mock`（或不设），内存飞书/模型，可跑归档与日报逻辑 |
| 真实 | 复制 `.env.example` → `.env`，填入密钥后设 `CLIENT_MODE=real` |

`real` 模式下 `RealFeishuClient` / `RealModelClient` 目前为 **stub**，调用会明确报错。REST 入口要求 `API_ACTORS_JSON` 中配置的 Bearer 凭证，并根据可信身份限制目标空间和手动汇总权限；即使设置凭证，真实业务闭环仍需完成开放 API 接入和联调。

密钥只放环境变量，**不要提交 `.env`**。

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
| GET | `/api/v1/archives/:archiveId` | 查归档状态 |
| POST | `/api/v1/daily-summary/run` | 手动触发某日汇总 |
| GET | `/api/v1/daily-summary/schedule` | 定时状态 |
| POST | `/api/v1/mock/seed-daily` | 仅 mock：注入演示日报 |

## 文档

- [环境就绪检查表](docs/环境就绪检查表.md) — 启动前外部依赖与阻塞留证
- [第1日设计文档](docs/第1日设计文档.md) — 需求复述、架构、数据模型、接口、风险
- [部署说明（D3 草稿）](docs/部署说明.md) — 安装、配置、验证、定时
- [接口说明（D4 草稿）](docs/接口说明.md) — REST 字段与错误约定

## 当前阻塞

- 测试租户、飞书应用权限、目标目录/知识空间、多维表、机器人、模型密钥、分级测试账号、样例文件 — **尚未全部到位**。
- **正式 10 日计时未开始**。发现阻塞后须在 2 小时内留证（见检查表模板）。
- 未挂载真实 MCP Server；工具定义见 `src/mcp/tools.draft.ts`。

## 目录结构

```
docs/                 中文设计、部署、接口、环境检查表
samples/              mock 演示样例文件
src/
  clients/            FeishuClient / ModelClient（mock + real stub）
  services/           归档、日报汇总、轻量调度
  demo/               mock 种子数据
  mcp/                MCP 工具草案
  app.ts / index.ts   REST 入口
tests/                T1–T8 业务规则 + REST 单测
.env.example          配置样例（无真实密钥）
```
