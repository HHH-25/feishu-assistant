知识库文件更新包 v0.8.0 — 2026-10-28

适用：已部署公司资源发现/同事消息/知识库管理版本的 /opt/feishu-mcp。
本包包含此前 v2 的知识库创建、成员管理、页面权限、文档创建功能，不需要再安装旧包。

新增能力
1. 上传本地 PDF、DOCX、XLSX、TXT（每份非空且不超过20MiB）到选定知识库根目录或父页面。
   保留原始文件，作为知识库文件节点；不会转换成可直接编辑正文的飞书在线文档。
   新发现的知识库不需要服务器逐个配置：使用当前员工云空间根目录暂存，再迁入知识库。
   已有静态暂存目录仍兼容。暂存或迁入受当前员工权限与云空间配额限制。
2. 将已有飞书云空间文档迁入指定知识库根目录或父页面。
   支持文档直接链接：docx、docs/doc、sheets、base、mindnotes、file、slides。
   先展示文档名称、目标位置及权限变化，再由员工确认执行。
   这是移动原文档，不是复制；原云空间位置会变化，默认继承目标父页面权限。
   不支持移动已有知识库页面（wiki链接）、整个文件夹、短链接或批量迁入。
3. 异步迁入通过原操作回执查询；复查原文件标识、类型、知识库和父页面后才报告成功。
   失败或结果不确定时禁止换操作编号重试。文件已上传但迁入失败会保留暂存文件，供核对。

安装前：飞书开放平台 → 蓝图飞书助手 → 权限管理
确认“用户身份”权限中有以下范围，并创建/发布应用版本，使权限生效：
  drive:drive.metadata:readonly （本次新增，用于源文档元数据和员工云空间目录）
  drive:file:upload （既有文件上传权限）
  wiki:wiki （既有知识库权限）
如已获等效的更广范围 drive:drive，不需要重复添加前两项。
应用范围和员工自身文档权限是两层要求；开通应用权限不赋予员工访问他人文档的权限。
已有文档迁入由飞书检查源文档管理权限、原文件夹编辑权限和目标位置权限。
不支持绕过企业管理员对“企业公开”的限制。

上传 feishu-wiki-files-20261028.tar.gz 至服务器 /root 后执行：
(
  set -e
  cd /root
  tar -xzf feishu-wiki-files-20261028.tar.gz
  bash feishu-wiki-files-20261028/install-wiki-files.sh
)

脚本会校验包和公司配置，备份4个程序文件及.env.local，保留既有OAuth范围并补充文件范围，
重启 feishu-mcp.service 并检查健康状态；失败时恢复备份。备份在 /root/feishu-wikifiles-backup-*。
数据库、密钥、应用身份和资源配置不替换。不执行真实文档移动或权限修改。
健康检查通过仅说明服务启动，不代表已完成员工真实业务测试。

部署后每位员工：
1. 重新授权自己的助手连接，用本人飞书扫码，使新增范围进入用户授权。
2. 分别刷新对应插件的工具列表（feishu助手 / 飞书助手00 都需更新），新开聊天测试。
3. 先让助手查询当前飞书身份，确认是自己。

测试话术
本地文件：在聊天中选中测试附件后说
“把这个文件上传到技术部知识库的根目录，保留原文件格式，完成后核实位置。”
已有飞书文档：
“把这篇文档 [文档直接链接] 迁入技术部知识库的 [父页面名称/根目录]，先展示迁入预览。”
核对预览后说“确认迁入”。迁入会改变源文档位置及权限继承，请用测试文档验证。

测试前提：操作员工需要拥有相应权限；例如尚未获技术部知识库创建权限的员工会被拒绝。
本地自动化测试覆盖权限拒绝、员工隔离、原始字节、目标选择、重复提交、异步状态和配置保留。
尚未进行服务器上的真实附件/文档迁入测试。

官方接口依据
https://open.feishu.cn/document/ukTMukTMukTM/uUDN04SN0QjL1QDN/wiki-v2/space-node/move_docs_to_wiki
https://open.feishu.cn/document/server-docs/docs/wiki-v2/task/get
https://open.feishu.cn/document/server-docs/docs/drive-v1/file/batch_query
https://open.feishu.cn/document/server-docs/docs/drive-v1/folder/get-root-folder-meta
https://open.feishu.cn/document/server-docs/docs/drive-v1/upload/upload_all
