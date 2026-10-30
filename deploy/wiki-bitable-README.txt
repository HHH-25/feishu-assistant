知识库 + 多维表格合并更新包 v0.9.0 — 2026-10-28

适用：公司已部署的 /opt/feishu-mcp，feishu-mcp.service。
包含已部署的知识库 v2 功能，以及尚未部署的知识库文件更新。只安装本包即可。

一、本次多维表格能力
1. 通过飞书 base/wiki 链接接入本人有权访问的多维表格，无需服务器逐个配置。
   查询本人已接入列表；列出数据表、字段、视图；按字段筛选、排序和分页查询记录。
2. 创建多维表格；修改名称；创建、改名、删除数据表。
3. 记录单条/批量新增、修改、删除，每批最多100条；只传需要改动的字段。
   支持文本、数字、日期、复选框、单选、多选、人员、链接、附件、关联记录等已实现类型。
   人员须使用本应用核实的身份；关联记录先检查存在及可读；记录写入不会隐式创建选项。
4. 创建、修改、删除常用字段，管理选项；支持单向/双向关联字段。
   双向关联可能在关联表生成反向字段；字段类型/选项变化可能影响已有记录，需要确认。
5. 创建表格、看板、画册、甘特、表单视图；改名、设置接口支持的筛选和隐藏字段、删除视图。
   查询排序与持久视图配置不同；本包不提供日历视图创建或完整表单设计器。
6. 上传附件素材（非空且最多20MiB），再挂入指定记录的附件字段。
   上传成功不等于挂入成功；追加附件需要保留原附件列表。
7. 开关高级权限；创建/更新/删除自定义角色；向角色添加/移除已核实的同企业个人。
   角色支持数据表、记录筛选、字段、视图及部分复制/导出权限。
   更新角色按完整配置替换；未列字段默认无权限，不能省略要保留的数据表配置。
   field_perm: 1可阅读、2可添加、3可编辑。本人需拥有管理权限。
   字段操作权限需要高级权限v2；知识库内的多维表格不支持通过此元数据接口切换高级权限。
   未包含群/部门批量角色授权。多个角色和其他分享来源可能叠加，不承诺最终权限仅为只读。
8. 列出并复制已有仪表盘；列出并启用/停用已有自动化工作流。
   启用工作流可能触发消息或数据修改，必须先确认具体流程和影响。

明确未包含：公式表达式/查找引用字段的创建或修改、从零设计仪表盘图表、编排新自动化流程、
飞书界面的全部高级样式/表单配置/扩展插件。已有公式等计算字段可以读取，不能直接写入。
高级权限、自动化等仍受企业套餐、表格版本、应用授权和员工本人权限限制。

二、知识库合并功能
保留新建知识库、成员管理、页面可阅读/可编辑授权、选知识库/父页面创建与编辑文档等功能。
新增：
- 把本地PDF、DOCX、XLSX、TXT原文件上传到知识库根目录或父页面，最大20MiB。
  保留原始文件，不自动转换为在线文档；先暂存本人云空间，再迁入目标位置。
- 将已有飞书云空间文档移动到知识库指定位置。支持docx、docs/doc、sheets、base、
  mindnotes、file、slides直接链接；不支持移动现有wiki页面、整个文件夹或短链接。
  这是移动，不是复制；原位置和权限继承会改变，先展示预览再确认执行。
企业公开仍受企业管理员策略限制，本包不绕过管理员限制。

三、安装前开通并发布权限
飞书开放平台 → 蓝图飞书助手 → 权限管理，核对“用户身份”以下范围。
保留原有权限，并开通缺少的范围，发布应用版本让权限生效。
本包使用以下逐项权限；有旧bitable:app权限也不要遗漏新版角色的细分权限。

基础与表结构：
base:app:create base:app:read base:app:update
base:table:read base:table:create base:table:update base:table:delete
base:field:read base:field:create base:field:update base:field:delete
记录与视图：
base:record:retrieve base:record:read base:record:create base:record:update base:record:delete
base:view:read base:view:write_only
高级权限及角色成员：
base:role:read base:role:create base:role:update base:role:delete
base:collaborator:read base:collaborator:create base:collaborator:delete
仪表盘与工作流：
base:dashboard:read base:dashboard:copy base:workflow:read base:workflow:write
附件和知识库文件：
docs:document.media:upload drive:drive.metadata:readonly drive:file:upload
继续保留既有 wiki:wiki、docx:document、offline_access、群消息等权限。
如已有等效更广的drive权限，脚本会保留，不重复补充该组细分drive范围。
应用开通权限不等于给员工授予资源权限；员工没权限时操作应被拒绝。

四、上传与安装
上传 feishu-wiki-bitable-20261028.tar.gz 到服务器 /root，只执行这个新包：
(
  set -e
  cd /root
  tar -xzf feishu-wiki-bitable-20261028.tar.gz
  bash feishu-wiki-bitable-20261028/install-wiki-bitable.sh
)

脚本校验SHA256和公司配置；备份程序与.env.local；保留原OAuth范围并补充本次范围；
加载模块、重启服务并检查健康状态。失败则恢复旧文件与.env.local，并尝试重启旧服务。
备份位置 /root/feishu-wikibitable-backup-*。不替换数据库、密钥、应用身份和资源配置。
健康检查仅表示服务可启动；不会自动创建真实表格、移动文档、发送消息或修改实际权限。

部署后每位员工重新授权自己的助手，用本人飞书扫码；分别刷新插件工具列表并新开聊天。
例如 feishu助手 / 飞书助手00 都需更新连接。先查询飞书身份，确认操作人正确。

五、测试说明
本地构建、自动化接口模拟测试和安装失败回滚测试通过，详见TEST-RESULTS.txt。
模拟覆盖：正确API路由/请求体、员工凭证、字段格式、分页、批量读写复查、权限拒绝、
员工隔离、重复提交、过期/变更预览、部分完成、不确定状态、附件原始字节、OAuth和MCP工具注册。
未连接生产飞书执行真实写入；需要发布权限、安装和本人授权后进行真实验收。
删除、字段改动、权限调整、流程启停等先显示影响并确认。批量修改超过一条也先确认。
飞书记录接口不提供原子版本比较；执行前复查能发现已变化的数据，但不能阻止飞书客户端同时写入。
pending/uncertain 不等于成功，不能换操作编号或重新预览来盲目重做。使用原回执核查。
批量操作不承诺跨记录事务回滚；部分完成会保留回执供核实，不自动重复写入。

六、上线测试话术（使用专门测试表，不使用正式业务表）
1. “查询当前授权的飞书身份。”
2. “新建多维表格‘技术部接口验收’，在里面建‘测试数据’数据表，新增文本字段‘备注’和数字字段‘数量’，给我链接。”
3. “在测试数据里新增两条：备注A、数量1；备注B、数量2。写完重新读取核实。”
4. “查数量大于1的记录，按数量降序展示。”
5. “把备注A这条的数量改成3，保留其他字段，修改后复查。”
6. “给测试数据建一个看板视图。”（是否可用依实际字段与飞书接口要求）
7. 选择一个测试附件：“把这个附件追加到指定测试记录的附件字段，保留原附件并复查。”
8. 让只有阅读权限的另一员工接入链接并尝试修改测试记录：应被拒绝且内容保持不变。
9. 管理员明确需要时再测试角色授权；确认角色配置后检查本人及测试成员的实际访问效果。
10. 测试删除时先预览并核对具体记录，再确认；仪表盘/工作流使用已有专门测试对象。

七、官方接口参考
https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/bitable-v1/app/create
https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/bitable-v1/app-table-record/search
https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/bitable-v1/app-table-record/batch_get
https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/bitable-v1/advanced-permission/base-v2/app-role/create
https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/bitable-v1/app-dashboard/copy
https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/bitable-v1/app-workflow/update
