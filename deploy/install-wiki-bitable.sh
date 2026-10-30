#!/usr/bin/env bash
set -euo pipefail
patch_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
test "$(id -u)" = 0
cd /opt/feishu-mcp
systemctl is-active --quiet feishu-mcp.service
files=(dist/src/bridge/service.js dist/src/bridge/tools.js dist/src/bridge/operations.js dist/src/clients/wiki.js dist/src/bridge/bitable.js dist/src/bridge/bitableSchema.js)
for file in dist/src/bridge/service.js dist/src/bridge/tools.js dist/src/bridge/operations.js dist/src/clients/wiki.js; do test -f "$file"; done
test -f .env.local
(cd "$patch_dir" && sha256sum -c SHA256SUMS)
node --input-type=module <<'NODE'
import {readSettings,missingSettings} from './dist/src/bridge/settings.js';
const s=readSettings();
if(s.appId!=='cli_aa6acb79effa9d2f'||s.tenant!=='1b617f6cfbcd974f'||s.publicUrl!=='https://mcp.zhiyinhui.top'||s.accessMode!=='tenant'||s.resourceMode!=='user'||missingSettings(s).length)
  throw Error('公司应用或资源查询配置不匹配，未更新');
NODE
backup_dir="$(mktemp -d /root/feishu-wikibitable-backup-XXXXXXXX)"
for file in "${files[@]}" .env.local; do
  mkdir -p "$backup_dir/$(dirname "$file")"
  if [ -f "$file" ]; then cp -a "$file" "$backup_dir/$file"; fi
done
rollback() {
  rc=$?
  trap - EXIT
  if [ "$rc" -ne 0 ]; then
    echo "更新失败，正在恢复。备份：$backup_dir"
    for file in "${files[@]}" .env.local; do
      if [ -f "$backup_dir/$file" ]; then cp -a "$backup_dir/$file" "$file"; else rm -f -- "$file"; fi
    done
    systemctl restart feishu-mcp.service || echo "恢复后重启失败，请检查服务状态"
  fi
  exit "$rc"
}
trap rollback EXIT
for file in "${files[@]}"; do cp "$patch_dir/$file" "$file"; done
node --input-type=module - "$patch_dir/bitable-scopes.mjs" <<'NODE'
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {readSettings} from './dist/src/bridge/settings.js';
import {BridgeService} from './dist/src/bridge/service.js';
import {Operations} from './dist/src/bridge/operations.js';
import {BitableService} from './dist/src/bridge/bitable.js';
import {changeSchema} from './dist/src/bridge/bitableSchema.js';
import {FeishuWikiClient} from './dist/src/clients/wiki.js';
import './dist/src/bridge/tools.js';
for(const name of ['uploadWiki','prepareWikiMove','moveExistingWiki','status','createWiki','createWikiSpace','wikiSpaceInfo','changeWikiMember','updateWikiSettings','readWikiPersonPermission','setWikiPersonPermission'])
  if(typeof BridgeService.prototype[name]!=='function')throw Error('功能未安装：'+name);
if(typeof FeishuWikiClient.prototype.move!=='function'||typeof Operations.prototype.completeVerifiedUpload!=='function')throw Error('迁入回执功能未安装');
for(const name of ['connect','catalog','list','search','prepare','apply','create','upload','status'])
  if(typeof BitableService.prototype[name]!=='function')throw Error('多维表格功能未安装：'+name);
if(!changeSchema.safeParse({action:'rename_base',name:'检查'}).success||typeof Operations.prototype.completeVerifiedBitable!=='function')throw Error('多维表格回执功能未安装');
const {withBitableScopes}=await import(pathToFileURL(process.argv[2]).href);
const old=fs.readFileSync('.env.local','utf8');
fs.writeFileSync('.env.local',withBitableScopes(old,readSettings().scopes));
console.log('知识库、多维表格、权限及操作回执：程序加载通过');
NODE
systemctl restart feishu-mcp.service
healthy=false
for attempt in 1 2 3 4 5; do
  sleep 1
  if curl --noproxy '*' --fail --silent --max-time 3 http://127.0.0.1:3010/health |
    node --input-type=module -e 'let s="";for await(const c of process.stdin)s+=c;try{const h=JSON.parse(s);if(h.service!=="feishu-mcp"||h.ready!==true)process.exit(1)}catch{process.exit(1)}'; then
    healthy=true
    break
  fi
done
test "$healthy" = true
systemctl is-active --quiet feishu-mcp.service
trap - EXIT
echo "知识库与多维表格已更新，服务健康检查通过（尚未执行真实业务验收）。"
echo "备份位置：$backup_dir"
echo "已补充 OAuth 多维表格与文件权限范围；请按 README 确认飞书用户权限已开通并发布。"
echo "下一步：每位员工重新授权对应助手，并刷新插件工具列表，在新聊天中测试。"
