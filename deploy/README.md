# 固定服务器部署准备

状态：部署模板已准备，尚未安装到服务器。适用于一台使用 systemd 的 Linux 主机、一个固定 HTTPS 域名、一个飞书组织。当前 SQLite 和授权状态使用单实例；不要直接部署多副本。

## 需要确认的信息

- 企业已有服务器或云主机：系统、地区、管理连接方式；不要把密码或私钥发到聊天。
- 自有域名的一个子域名，例如 `mcp.example.com`，以及 DNS 管理权限。
- 飞书目标企业的管理员、应用、两位测试员工和专用测试资源。
- 服务器能访问飞书开放平台，公网客户端能访问服务的 HTTPS 入口。

域名和主机尚未确定，不应购买或修改 DNS。若选择 Windows、容器托管或已有反向代理，需适配对应部署方式。

## 安装布局

1. 安装项目兼容的 Node.js（package.json 要求 >=22.16，需包含 node:sqlite）、npm 和 Caddy；确认实际 Node 路径。模板使用 `/usr/bin/node`。
2. 创建独立系统用户 `feishu-mcp`，工作目录 `/opt/feishu-mcp`。代码由部署管理员管理，服务用户仅有读取权限。
3. 上传项目源代码、package.json、package-lock.json、tsconfig.json、scripts、tests 和 deploy。**排除 `.env*` 的真实配置、data、tmp、node_modules、日志、个人文件和密钥备份**。单独上传 `.env.mcp.example` 模板。新企业不要复制旧企业授权数据库。
4. 在服务器工作目录执行 `npm ci`、`npm run build`，确认生成 `dist/src/index.js`；然后执行 `npm prune --omit=dev`。由部署用户执行安装，不要以 root 运行依赖安装脚本。
5. 管理员建立 `/opt/feishu-mcp/data`，所有者为 `feishu-mcp:feishu-mcp`、权限 0700。
6. 从 `.env.mcp.example` 创建 `.env.local`，设置所有者 `root:feishu-mcp`、权限 0640。由应用自身 dotenv 读取，**不要把含 JSON 的 dotenv 文件当作 shell 脚本 source**。
7. 设置 `MCP_PORT=3010`、`MCP_STATE_DB_PATH=./data/bridge.db`、`MCP_PUBLIC_URL=https://实际域名`。填写新企业应用凭证、租户、测试员工和测试资源。不要混用不同企业或应用的 open_id。默认密钥位于 `data/bridge.key`，必须持久保存。
8. 将 service 文件安装到 `/etc/systemd/system/feishu-mcp.service`，核对路径后执行 `systemctl daemon-reload`、`systemctl enable --now feishu-mcp`。查看状态：`systemctl status feishu-mcp`；查看日志：`journalctl -u feishu-mcp --since today`。日志不要公开粘贴。

## HTTPS 与连接

1. 将子域名 DNS 指向主机；只添加实际可用的 IPv4/IPv6 记录。对公网开放 80/443，SSH 仅允许管理来源；3010 保持仅回环监听。
2. 把 Caddyfile.example 的占位域名换为真实域名。若已有站点，合并配置，不能覆盖其他站点。
3. 用 `caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile` 验证后加载 Caddy。Caddy 管理 HTTPS，保留其证书数据目录。
4. 飞书应用增加固定回调 `https://实际域名/feishu/callback`，发布并确认应用可用范围。不要提前删除仍在使用的旧回调。
5. 执行 `node deploy/check-public.mjs https://实际域名`。这个检查只证明服务配置与认证入口正常，不证明飞书业务操作成功。
6. 客户端连接 `https://实际域名/mcp`，两名员工分别重新授权。地址改变后不承诺旧连接继续有效。
7. 核对身份、授权资源、读取和单条虚构写入、权限拒绝、回读、消息回执；再做进程重启和主机重启验收。确认稳定后才能停用旧测试入口。

## 运维与备份

- systemd 模板提供失败自动重启，不等同于监控告警。需要另配外部 HTTPS 检查，检查 `/health` 的 `ready` 内容，而不只是 HTTP 200；飞书授权可用性仍需单独检查。
- 备份必须包含 **SQLite 数据库、加密密钥和对应企业配置**，限制访问并加密存放。密钥丢失会导致已有授权无法解密。
- 简单可靠的首期方案是在维护窗口停止 `feishu-mcp`，确认停止后备份整个 `data` 和 `.env.local`，再启动服务。不要只在运行中复制 `bridge.db` 而遗漏 WAL；自动备份、异地副本和恢复演练仍待落实。
- 恢复应先在隔离环境验证。禁止同时运行两份使用同一套授权状态的旧新服务来处理生产操作。
- 更新前保留可恢复版本和停机一致备份；部署故障时恢复对应代码/状态，不能让不同版本同时写同一个 SQLite 文件。
- 定期检查依赖安全更新、磁盘容量、证书续期、权限撤销和员工离职后的授权状态。

## 私信验收前提

配置 `MCP_RECIPIENTS_JSON` 中的收件人与 allowed_senders，需要用户明确确认测试收件人及内容。该操作以应用机器人发送，并附操作人信息；配置允许发送不代表飞书一定允许机器人触达，实际接口回执与收件端核实都需要完成。不确定回执不换操作编号重发。

参考：[Caddy 反向代理](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)、[systemd 服务重启规则](https://www.freedesktop.org/software/systemd/man/256/systemd.service.html)。
