# WorkBuddy 员工入口（单人测试）

此入口供员工在 WorkBuddy 中把**自己明确指定的原文件**归档到飞书，并提交或查询本人日报。当前飞书工作台 `/admin` 页面仍供管理员使用。WorkBuddy 登录只建立 WorkBuddy 账号会话；业务服务另凭员工专用 key 判断员工、部门、空间和密级。

## 当前验收范围

- hyh 的独立财务测试凭证已放在本机忽略文件中；不要在聊天、截图、Git 或连接器包里公开。服务端绑定 `finance:hyh`、财务部门、财务测试空间和财务密级，且无手动汇总权限。
- 本地 MCP 协议调用到真实测试飞书已完成一份虚构财务 TXT 文件和一份虚构日报，读回文件、台账、日报记录 ID 与审计。重复提交日报更新原记录。
- WorkBuddy 客户端已登录；连接器安装和可视化操作仍待验证。协议测试不等于客户端验收。6666ZK 原生公共／财务目录访问、hyh 原生财务写入和 T9 群界面截图也仍待补。

## 本机准备

1. 用 hyh 对应账号登录已安装的 WorkBuddy；密码和验证码由本人输入，不发给协作者。
2. 在服务主机运行 `npm ci`、`npm run build`、`npm run prepare:workbuddy`。准备脚本生成忽略目录 `tmp/workbuddy-connector`，其中的 `mcp.json` 指向编译后的本地 MCP 服务。连接器包内没有真实凭证。
3. 在忽略目录 `tmp/workbuddy-upload` 单独放入要上传的虚构 PDF、DOCX、XLSX 或 TXT；**不要把凭证、SQLite 或真实业务文件放在此目录**。单文件上限 20 MiB。连接器用绝对路径读取该目录内的文件并直接以 multipart 发送到业务服务；对话中不粘贴 Base64 文件内容。
4. WorkBuddy 5.8.3 的“专家·技能·连接器 → 连接器 → 自定义连接器 → 添加 MCP”提供本机 `mcp.json` 编辑器。把生成的 `tmp/workbuddy-connector/mcp.local.json` 内容粘贴进去，再保存。该配置只包含连接器脚本路径、本机服务地址、授权上传目录和**凭证文件路径**，没有凭证正文。员工凭证保存在单独的忽略文件 `tmp/workbuddy-hyh-credential.txt`；请勿把它放进上传目录。`http` 仅限本机 `localhost`／`127.0.0.1`，远程地址须为 HTTPS。
5. 可移植的连接器包仍使用 `connector-meta.json`、`mcp.json`、`token-schema.json`、图标和 Skill。包内 `mcp.json` 是字段模板，**本机自定义 MCP 页面应使用 `mcp.local.json`**。切换员工时，分别使用员工自己的凭证文件和本机 MCP 配置，不共享 hyh 身份。客户端工具调用通过后，才把客户端验收标为通过。

## 演示话术

在 WorkBuddy 中用 hyh 账号，选中 `tmp/workbuddy-upload` 里一份虚构文件，明确说“把这个文件归档到财务测试空间”，再说“查刚才归档 ID 的状态”。应读回 `success`、文件 token 和飞书链接；在飞书财务目录与台账核对同一文件。

然后说“提交今天的虚构日报：完成事项为核对虚构财务样例，明日计划为继续联调”，再说“查看我今天的日报”。应读回 `employee=hyh`、财务密级和飞书 `record_id`。再次提交修订时同一业务日应保留同一个 `record_id`；首次 20:00 后提交为 `late`。财务日报不进入公共模型摘要。

员工连接器只暴露 `archive_local_file`、`get_archive_status`、`submit_daily_report`、`get_my_daily_report` 四个工具。它不提供管理员手动汇总、故障核对或全员查询。飞书原生目录访问还需由 hyh 本人在飞书账号里单独验证。

## 故障与运维

WorkBuddy 显示连接失败时，先检查服务 `/health`、本机地址、员工 key 与授权上传目录。服务返回 401 代表凭证无效；403 代表身份或空间权限不符；归档返回待核对状态时不重复上传，由管理员按部署说明核对飞书文件与台账。当前演示依赖本机服务，电脑休眠或进程退出后会中断；长期使用需稳定 HTTPS 地址、持续运行主机、逐人凭证和密钥轮换。

连接器字段以 [WorkBuddy 官方连接器文档](https://open.workbuddy.cn/docs/connector) 为准。
