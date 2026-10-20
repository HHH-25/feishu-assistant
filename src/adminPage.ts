export const adminHtml = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>飞书企业数据中心 · 管理入口</title>
<style>
  :root{font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif;color:#192338;background:#f5f7fb}
  *{box-sizing:border-box}body{margin:0}header{background:#13376b;color:white;padding:22px max(20px,calc((100vw - 1100px)/2))}
  h1{font-size:22px;margin:0 0 5px}header p{margin:0;opacity:.8;font-size:13px}main{max-width:1100px;margin:auto;padding:20px}
  section{background:white;border:1px solid #e5eaf2;border-radius:12px;padding:20px;margin-bottom:16px;box-shadow:0 3px 12px #1c36500a}
  h2{font-size:17px;margin:0 0 16px}form{display:flex;gap:10px;flex-wrap:wrap;align-items:end}
  label{display:grid;gap:5px;font-size:13px;color:#526074}input,select,button{font:inherit;border-radius:7px;padding:9px 11px}
  input,select{border:1px solid #cdd6e4;background:white;min-width:150px}input[type=file]{max-width:100%;border:0;padding-left:0}
  button{background:#2368d7;color:white;border:0;cursor:pointer}button:disabled{opacity:.5;cursor:wait}
  .muted{font-size:13px;color:#66758c}.message{min-height:22px;color:#244b82;white-space:pre-wrap}
  .summary-body{white-space:pre-wrap;line-height:1.65;overflow-wrap:anywhere;border-top:1px solid #e9edf3;padding-top:12px}
  .error{color:#b42318}.table-wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:13px;min-width:700px}
  th,td{text-align:left;padding:10px 8px;border-bottom:1px solid #e9edf3}th{color:#506078;background:#f8faff}
  a{color:#2064c4}#admin-content{display:none}
  @media(max-width:650px){main{padding:12px}section{padding:15px}form>label,form>button{width:100%}input,select{width:100%}}
</style></head><body>
<header><h1>企业数据中心</h1><p>文件归档 · 日报汇总 · 运行状态</p></header>
<main><section><div id="identity" class="message">正在验证飞书身份…</div></section>
<div id="admin-content">
<section><h2>查找归档文件</h2><form id="search-form">
<label>文件名<input name="file_name" placeholder="包含的文字"></label>
<label>部门<input name="department" placeholder="如：销售"></label>
<label>状态<select name="status"><option value="">全部</option><option value="success">成功</option><option value="pending">处理中</option><option value="failed">失败</option></select></label>
<button type="submit">查询</button></form><p id="list-message" class="muted"></p>
<div class="table-wrap"><table><thead><tr><th>文件</th><th>部门</th><th>提交人</th><th>状态</th><th>版本</th><th>时间</th><th>操作</th></tr></thead><tbody id="archive-rows"></tbody></table></div></section>
<section><h2>归档文件</h2><form id="upload-form">
<label>选择文件<input type="file" name="file" accept=".pdf,.docx,.xlsx,.txt" required></label>
<label>部门<input name="department" required></label>
<label>目标空间<select name="space_id" id="space-select" required><option value="">加载授权空间中…</option></select></label>
<label>密级<select name="confidentiality"><option value="dept">部门内部</option><option value="public">公司公开</option><option value="mgmt">管理层</option><option value="finance">财务保密</option></select></label>
<button type="submit">上传并归档</button></form><p id="upload-message" class="message"></p></section>
<section><h2>日报管理摘要</h2><form id="summary-form"><label>业务日期<input type="date" name="business_date" required></label>
<button type="submit">手动汇总</button><button type="button" id="status-button">查看运行状态</button></form>
<p id="summary-message" class="message"></p><div id="summary-details" hidden>
<p id="summary-sources" class="muted"></p><div id="summary-content" class="summary-body"></div>
</div></section></div></main>
<script src="/admin/feishu-h5-sdk.js"></script>
<script src="/admin/app.js"></script></body></html>`;

export function adminScript(appId: string): string {
  return `const APP_ID=${JSON.stringify(appId)};
let csrf='';
const $=id=>document.getElementById(id);
const show=(id,value,error=false)=>{const el=$(id);el.textContent=value;el.classList.toggle('error',error)};
async function api(path,options={}){
  const headers={...(options.headers||{})};
  if(options.method==='POST')headers['x-csrf-token']=csrf;
  const response=await fetch(path,{...options,headers,credentials:'same-origin'});
  const data=await response.json();
  if(!response.ok)throw new Error(data.error?.message||'请求失败');
  return data;
}
async function login(){
  if(!window.h5sdk){show('identity','请在飞书工作台中打开此应用',true);return}
  window.h5sdk.ready(()=>{
    if(!window.tt){show('identity','飞书客户端未提供登录能力',true);return}
    const success=async result=>{
      try{
        const response=await fetch('/admin/auth',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:result.code})});
        const data=await response.json();if(!response.ok)throw new Error(data.error?.message||'登录失败');
        await loadIdentity();
      }catch(error){show('identity',error.message,true)}
    };
    const fail=()=>show('identity','飞书身份验证失败，请重新打开应用',true);
    const fallback=()=>window.tt.requestAuthCode({appId:APP_ID,success,fail});
    if(window.tt.requestAccess)window.tt.requestAccess({appID:APP_ID,scopeList:[],success,fail:error=>error.errno===103?fallback():fail()});
    else fallback();
  });
}
async function loadIdentity(){
  const response=await fetch('/admin/api/me',{credentials:'same-origin'});
  if(response.status===401){await login();return}
  const data=await response.json();
  if(!response.ok){show('identity',data.error?.message||'无权访问',true);return}
  csrf=data.csrf;show('identity','已登录：'+data.operator);
  const select=$('space-select');select.replaceChildren();
  for(const space of data.spaces){const option=document.createElement('option');
    option.value=space;option.textContent=space;select.append(option)}
  $('admin-content').style.display='block';
  await loadArchives();
}
async function loadArchives(){
  try{
    const query=new URLSearchParams(new FormData($('search-form')));
    const data=await api('/admin/api/archives?'+query.toString());
    const tbody=$('archive-rows');tbody.replaceChildren();
    for(const row of data.archives){
      const tr=document.createElement('tr');
      for(const value of [row.file_name,row.department,row.uploader,row.status,String(row.version),row.uploaded_at]){
        const td=document.createElement('td');td.textContent=value||'';tr.append(td);
      }
      const action=document.createElement('td');
      try{const url=new URL(row.feishu_url);if(url.protocol==='https:'&&url.hostname.endsWith('.feishu.cn')){
        const a=document.createElement('a');a.href=url.href;a.target='_blank';a.rel='noopener noreferrer';a.textContent='在飞书打开';action.append(a);
      }}catch{}
      tr.append(action);tbody.append(tr);
    }
    show('list-message','当前身份可见 '+data.total+' 条记录');
  }catch(error){show('list-message',error.message,true)}
}
$('search-form').addEventListener('submit',event=>{event.preventDefault();loadArchives()});
$('upload-form').addEventListener('submit',async event=>{
  event.preventDefault();const form=event.currentTarget;const button=form.querySelector('button');button.disabled=true;
  try{const data=await api('/admin/api/archives',{method:'POST',body:new FormData(form)});
    show('upload-message',data.deduplicated?'文件已存在，返回原归档记录':'归档成功：'+data.archive_id);await loadArchives();
  }catch(error){show('upload-message',error.message,true)}finally{button.disabled=false}
});
$('summary-form').elements.business_date.value=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
$('summary-form').addEventListener('submit',async event=>{
  event.preventDefault();const form=event.currentTarget;const button=form.querySelector('button');button.disabled=true;
  try{const data=await api('/admin/api/daily-summary',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({business_date:form.elements.business_date.value})});
    show('summary-message','汇总完成；缺交：'+(data.missing.join('、')||'无')+'；'+(data.message_sent?'已推送':'未重复推送'));
    await loadSummaryStatus();
  }catch(error){show('summary-message',error.message,true)}finally{button.disabled=false}
});
async function loadSummaryStatus(){
  try{const date=$('summary-form').elements.business_date.value;
    const data=await api('/admin/api/daily-summary/'+encodeURIComponent(date));
    show('summary-message','任务状态：'+(data.job?.status||'尚未运行')+
      '；发送状态：'+(data.send?.state||'无')+
      (data.summary?'；缺交：'+(data.summary.missing_employees.join('、')||'无'):'')+
      (data.job?.message_id?'；消息已记录':''));
    $('summary-details').hidden=!data.summary;
    if(data.summary){show('summary-sources','来源日报：'+(data.summary.source_report_ids.join('、')||'无')+
      '；修订：'+data.summary.revision);show('summary-content',data.summary.content)}
  }catch(error){show('summary-message',error.message,true)}
}
$('status-button').addEventListener('click',loadSummaryStatus);
loadIdentity();`;
}
