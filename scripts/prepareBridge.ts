// Read-only Feishu discovery. --save writes local ignored configuration only.
import { readSettings } from '../src/bridge/settings.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import dotenv from 'dotenv';
const s=readSettings();
if(s.appId!=='cli_aa5a0c7cd0f5dc14')throw new Error('此辅助脚本仅用于已核实的独立测试应用');
const response=await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',{
  method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(15000),
  body:JSON.stringify({app_id:s.appId,app_secret:s.appSecret})});
const auth=await response.json() as Record<string,any>;
if(auth.code!==0||!auth.tenant_access_token)throw new Error(`应用鉴权失败 code=${Number(auth.code)}`);
async function read(path:string){
  const response=await fetch('https://open.feishu.cn/open-apis'+path,{headers:{authorization:`Bearer ${auth.tenant_access_token}`},signal:AbortSignal.timeout(15000)});
  const result=await response.json() as Record<string,any>;
  return {ok:response.ok&&result.code===0,code:result.code,data:result.data};
}
const tenant=await read('/tenant/v2/tenant/query');
const old=dotenv.parse(readFileSync('.env','utf8'));
const admins=JSON.parse(old.ADMIN_WEB_ACTORS_JSON||'[]') as {open_id:string}[];
const chat=old.FEISHU_MANAGER_CHAT_ID?await read(`/im/v1/chats/${encodeURIComponent(old.FEISHU_MANAGER_CHAT_ID)}?user_id_type=open_id`):undefined;
const values:Record<string,string>={};
if(tenant.ok&&tenant.data?.tenant?.tenant_key)values.MCP_FEISHU_TENANT_KEY=tenant.data.tenant.tenant_key;
if(admins.length) values.MCP_ALLOWED_USERS_JSON=JSON.stringify(admins.map(a=>a.open_id));
if(chat?.ok)values.MCP_CHATS_JSON=JSON.stringify([{id:'test_group',name:chat.data.name||'测试群',chat_id:old.FEISHU_MANAGER_CHAT_ID}]);
if(process.argv.includes('--save')) {
  let local=existsSync('.env.local')?readFileSync('.env.local','utf8'):'';
  for(const [name,value]of Object.entries(values))if(!dotenv.parse(local)[name])local+=`\n${name}=${value}\n`;
  writeFileSync('.env.local',local);
}
mkdirSync('tmp',{recursive:true});
writeFileSync('tmp/bridge-discovery.json',JSON.stringify({tenant,chat},null,2));
console.log(JSON.stringify({appAuthentication:true,tenant:{ok:tenant.ok,code:tenant.code,name:tenant.data?.tenant?.name},
  chat:{ok:chat?.ok,code:chat?.code,name:chat?.data?.name},
  knownAdminCount:admins.length,localKeys:process.argv.includes('--save')?Object.keys(values):[],details:'tmp/bridge-discovery.json'}));
