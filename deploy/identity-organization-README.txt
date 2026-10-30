飞书助手：企业身份信息补丁 0.9.1（2026-10-28）

用途
who_am_i 增加当前授权企业名称。姓名来自服务端已授权员工会话；企业名称由飞书企业信息接口实时获取，且必须与员工的 tenant_key 一致。
不写死企业名称，不代表用户加入的全部企业，也不查询部门架构。
企业接口失败时保留员工身份，并返回 organization.status=unavailable 及原因；不能将它报告成企业查询成功。

一、飞书权限
进入“蓝图飞书助手”开放平台后台 → 权限管理，查找：
获取企业信息：tenant:tenant:readonly
权限类型选择“应用身份”，开通后创建并发布新版本，完成所需审批。
如果该应用身份权限已开通且已发布，跳过这一步。
这个接口使用 tenant_access_token；无需将权限加进员工 OAuth scopes，也无需仅为此权限重新连接员工。
官方接口文档：https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/tenant-v2/tenant/query
官方 SDK 请求定义（仅支持 tenant token）：https://github.com/larksuite/oapi-sdk-python/blob/v2_main/lark_oapi/api/tenant/v2/model/query_tenant_request.py

二、服务器安装
前提：已安装并验收此前的知识库与多维表格 0.9.0 版本，服务名 feishu-mcp.service。
将 feishu-identity-organization-0.9.1-20261028.tar.gz 上传到服务器 /root，执行：

cd /root
tar -xzf feishu-identity-organization-0.9.1-20261028.tar.gz
bash feishu-identity-organization-0.9.1-20261028/install.sh

安装脚本会核对公司配置、校验包文件、备份三个程序文件、重启并检查健康状态。失败自动恢复程序文件。
只更新 dist/src/bridge/{feishu,service,tools}.js，不修改 .env.local、授权数据、数据库、密钥或员工资源。
成功时显示备份路径。健康检查只说明程序已运行，不能代替企业查询验收。

三、ChatGPT 验收
在 feishu助手 管理页点击“刷新工具”，完成后发起身份查询：
“查询我的飞书身份和当前授权企业名称；如果企业查询失败，请展示具体原因。”
预期：姓名为何云浩（以实际授权员工为准），企业名称以飞书返回并核验的结果为准，organization.status=verified。
工具数量仍然是 32；这次更新的是 who_am_i，不新增工具。
若显示 tenant:tenant:readonly 权限提示，核对应用身份权限及新版本是否已发布。
若返回 TENANT_MISMATCH，不显示企业名称；核查应用所属企业与当前员工授权，不能手工填名称掩盖不一致。

手动回滚（用安装时实际输出的备份路径替换 /root/feishu-identity-backup-XXXXXXXX）
backup_dir=/root/feishu-identity-backup-XXXXXXXX
for file in feishu service tools; do cp -a "$backup_dir/dist/src/bridge/$file.js" "/opt/feishu-mcp/dist/src/bridge/$file.js"; done
systemctl restart feishu-mcp.service

验证范围
本地编译与模拟 API 测试、安装成功/失败回滚测试；未代替服务器安装、飞书权限发布及真实企业接口验收。
