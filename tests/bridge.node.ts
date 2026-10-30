import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { BridgeStore } from '../src/bridge/store.js';
import { Operations } from '../src/bridge/operations.js';
import { publicAddress, downloadAttachment } from '../src/bridge/download.js';
import { FeishuAuth } from '../src/bridge/feishu.js';
import { BridgeService } from '../src/bridge/service.js';
import { createBridgeApp } from '../src/bridge/app.js';
import { allowedRedirect } from '../src/bridge/oauth.js';
import { missingSettings, type BridgeSettings } from '../src/bridge/settings.js';
import { resolveChatRange } from '../src/bridge/time.js';

const settings:BridgeSettings={port:3010,host:'127.0.0.1',publicUrl:'https://mcp.example.com',dbPath:':memory:',keyPath:'',
  appId:'cli_test',appSecret:'test-only',tenant:'tenant_test',users:['ou_a','ou_b'],scopes:'offline_access',
  wiki:[{id:'wiki',name:'Test',space_id:'space',parent_node_token:'home',url_origin:'https://test.feishu.cn'}],
  chats:[{id:'group',name:'Test group',chat_id:'oc_group'}],tables:[{id:'table',name:'Test table',app_token:'app',table_id:'tbl'}],recipients:[]};
function seed(store:BridgeStore,id='a') {
  const person={sub:id,openId:`ou_${id}`,tenant:'tenant_test',name:id};
  store.put('feishu',id,{person,access:`token_${id}`,expires:Date.now()+3600000,refresh:'refresh'});return person;
}
const json=(data:unknown)=>new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});

test('identity reads live enterprise metadata with a tenant token and filters private fields',async()=>{
  const store=new BridgeStore(':memory:');seed(store);
  let name='测试企业',tokenRequests=0,queries=0;
  const auth=new FeishuAuth(settings,store,async(input,init)=>{
    if(String(input).endsWith('/auth/v3/tenant_access_token/internal')){
      tokenRequests++;assert.equal(init?.method,'POST');
      return json({code:0,tenant_access_token:'app-secret-token',expire:7200});
    }
    assert.equal(String(input),'https://open.feishu.cn/open-apis/tenant/v2/tenant/query');
    assert.equal(init?.method,'GET');assert.equal(init?.body,undefined);
    assert.equal((init?.headers as Record<string,string>).authorization,'Bearer app-secret-token');
    queries++;return json({code:0,data:{tenant:{name,tenant_key:'tenant_test',avatar:'private',extra:'private'}}});
  });
  const service=new BridgeService(settings,auth,store,'a');
  assert.deepEqual(await service.identity(),{name:'a',identity:'feishu_user',identity_source:'authorized_session',
    organization_scope:'current_authorized_tenant',organization:{status:'verified',name:'测试企业',source:'feishu_tenant_api'}});
  name='企业新名称';const updated=await service.identity();
  assert.equal(updated.organization.status,'verified');
  if(updated.organization.status==='verified')assert.equal(updated.organization.name,'企业新名称');
  assert.equal(tokenRequests,1);assert.equal(queries,2);
  store.close();
});

test('identity preserves employee result on enterprise lookup failure without leaking upstream secrets',async()=>{
  for(const mode of ['mismatch','missing-key','missing-name','denied','network','token-failed']){
    const store=new BridgeStore(':memory:');seed(store);
    const auth=new FeishuAuth(settings,store,async(input)=>{
      if(String(input).endsWith('/internal'))return mode==='token-failed'?
        json({code:1,msg:'secret'}):json({code:0,tenant_access_token:'secret',expire:7200});
      if(mode==='network')throw new Error('secret');
      if(mode==='denied')return new Response(JSON.stringify({code:99991672,msg:'secret'}),{status:403});
      return json({code:0,data:{tenant:{name:mode==='missing-name'?' ':'Wrong company',
        tenant_key:mode==='mismatch'?'other':mode==='missing-key'?undefined:'tenant_test'}}});
    });
    const result=await auth.identity('a');
    assert.equal(result.name,'a');assert.equal(result.organization.status,'unavailable');
    assert.doesNotMatch(JSON.stringify(result),/secret|Wrong company/);
    assert.equal(auth.person('a').name,'a');
    if(result.organization.status==='unavailable'&&mode==='denied'){
      assert.match(result.organization.error.message,/99991672/);
      assert.match(result.organization.error.message,/tenant:tenant:readonly/);
    }
    store.close();
  }
});

test('identity refuses invalid tenants and disconnects during enterprise lookup',async()=>{
  const store=new BridgeStore(':memory:');seed(store);
  let requests=0;
  const auth=new FeishuAuth({...settings,tenant:'other'},store,async()=>{requests++;return json({});});
  await assert.rejects(auth.identity('a'),/重新连接/);assert.equal(requests,0);
  const current=new FeishuAuth(settings,store,async(input)=>{
    if(String(input).endsWith('/internal'))return json({code:0,tenant_access_token:'secret',expire:7200});
    current.disconnect('a');return json({code:0,data:{tenant:{name:'测试企业',tenant_key:'tenant_test'}}});
  });
  await assert.rejects(current.identity('a'),/重新连接/);
  store.close();
});

test('page permissions use wiki node IDs, explicit scopes, PUT for updates and verified employee grants',async()=>{
  const store=new BridgeStore(':memory:');seed(store);seed(store,'b');
  const live={...settings,resourceMode:'user' as const};let mode='ok';
  let members:any[]=[];const writes:{method:string;body:any;path:string}[]=[];
  const auth=new FeishuAuth(live,store,async(input,init)=>{
    const url=new URL(String(input));
    if(url.pathname.endsWith('/is_in_chat'))return json({code:0,data:{is_in_chat:mode!=='left'}});
    if(url.pathname.startsWith('/open-apis/im/'))return json({code:0,data:{items:[{member_id_type:'open_id',member_id:'ou_liu',name:'刘明天',tenant_key:'tenant_test'}],has_more:false}});
    if(url.pathname.endsWith('/get_node'))return json({code:0,data:{node:{node_token:mode==='wrong-node'?'other':'page',obj_token:'underlying-doc',obj_type:'docx',space_id:mode==='wrong-space'?'elsewhere':'space',node_type:mode==='shortcut'?'shortcut':'origin',title:'Test page'}}});
    assert.equal((init?.headers as Record<string,string>).authorization,'Bearer token_a');
    assert.equal(url.searchParams.get('type'),'wiki');
    assert.ok(url.pathname.startsWith('/open-apis/drive/v1/permissions/page/members'));
    if(init?.method==='GET'){
      assert.ok(['single_page','container'].includes(url.searchParams.get('perm_type')!));
      if(mode==='bad-list')return json({code:0,data:{}});
      if(mode==='list-denied')return new Response(JSON.stringify({code:1770032}),{status:403});
      return json({code:0,data:{items:members}});
    }
    assert.equal(url.searchParams.get('need_notification'),'false');
    const body=JSON.parse(String(init?.body));writes.push({method:init!.method!,body,path:url.pathname});
    if(mode==='write-denied')return new Response(JSON.stringify({code:1770032}),{status:403});
    const member={...body,member_id:'ou_liu'};
    if(mode!=='stale-readback')members=[...members.filter(m=>m.perm_type!==body.perm_type),member];
    return json({code:0,data:{member:mode==='wrong-ack'?{...member,member_id:'ou_other'}:mode==='wrong-scope'?{...member,perm_type:'wrong'}:mode==='wrong-perm'?{...member,perm:'full_access'}:member}});
  });
  const a=new BridgeService(live,auth,store,'a'),b=new BridgeService(live,auth,store,'b');
  const recipient=(await a.findPeople({chat:'group',name:'刘明天'})).candidates[0].recipient;
  const input={target:'wiki',node_token:'page',recipient,permission:'edit' as const,scope:'single_page' as const,operation_key:'single'};
  const first=await a.setWikiPersonPermission(input);assert.equal(first.status,'success');
  assert.deepEqual(writes[0],{method:'POST',path:'/open-apis/drive/v1/permissions/page/members',body:{member_type:'openid',perm:'edit',perm_type:'single_page',type:'user',member_id:'ou_liu'}});
  const read=await a.readWikiPersonPermission(input);assert.equal(read.direct_permission,'edit');assert.equal(read.effective_permission,'not_verified');
  const noOp=await a.setWikiPersonPermission({...input,operation_key:'same'});assert.equal((noOp.result as any).changed,false);assert.equal(writes.length,1);
  const downgraded=await a.setWikiPersonPermission({...input,permission:'view',operation_key:'downgrade'});assert.equal(downgraded.status,'success');
  assert.equal((downgraded.result as any).effective_permission,'not_verified');
  assert.deepEqual(writes[1],{method:'PUT',path:'/open-apis/drive/v1/permissions/page/members/ou_liu',body:{member_type:'openid',perm:'view',perm_type:'single_page',type:'user'}});
  assert.equal((await a.setWikiPersonPermission({...input,scope:'container',operation_key:'descendants'})).status,'success');
  assert.equal(writes[2].method,'POST');assert.equal(writes[2].body.perm_type,'container');assert.equal(members.length,2);
  await assert.rejects(a.setWikiPersonPermission({...input,scope:'container'}),/操作编号/);
  await assert.rejects(a.setWikiPersonPermission({...input,permission:'view'}),/操作编号/);
  await assert.rejects(b.setWikiPersonPermission({...input,operation_key:'foreign'}),/重新查找/);
  for(mode of ['wrong-node','wrong-space','shortcut','left'])await assert.rejects(a.setWikiPersonPermission({...input,operation_key:mode}));
  assert.equal(writes.length,3);
  for(mode of ['bad-list','list-denied','missing-scope','duplicate']){
    members=mode==='missing-scope'?[{member_type:'openid',member_id:'ou_liu',perm:'view'}]:mode==='duplicate'?[1,2].map(()=>({member_type:'openid',member_id:'ou_liu',perm:'view',perm_type:'single_page'})):[];
    assert.equal((await a.setWikiPersonPermission({...input,operation_key:mode})).status,'uncertain');
  }
  assert.equal(writes.length,3);
  for(mode of ['write-denied','wrong-ack','wrong-scope','wrong-perm','stale-readback']){
    members=[];const attempt={...input,operation_key:mode};
    const result=await a.setWikiPersonPermission(attempt);assert.equal(result.status,'uncertain');
    if(mode!=='write-denied')assert.equal((result.result as any).verification,'pending');
    const before:number=writes.length;await a.setWikiPersonPermission(attempt);assert.equal(writes.length,before);
  }
  mode='ok';store.delete('recipient',recipient);assert.deepEqual(await a.setWikiPersonPermission(input),first);
  await assert.rejects(a.setWikiPersonPermission({...input,operation_key:'expired'}),/重新查找/);
  store.close();
});

test('new wiki spaces use employee identity, close web sharing and return a reusable target with durable receipts',async()=>{
  const store=new BridgeStore(':memory:');seed(store);seed(store,'b');
  const live={...settings,resourceMode:'user' as const,wiki:[]};let writes=0,mode='ok';
  const auth=new FeishuAuth(live,store,async(input,init)=>{
    assert.equal((init?.headers as Record<string,string>).authorization,'Bearer token_a');
    const url=new URL(String(input));
    if(init?.method==='GET')return json({code:0,data:{space:{space_id:'newspace',name:'Technical'}}});
    writes++;
    assert.equal(url.pathname,'/open-apis/wiki/v2/spaces');
    assert.deepEqual(JSON.parse(String(init?.body)),{name:'Technical',description:'Test',open_sharing:'closed'});
    if(mode==='missing')return json({code:0,data:{space:{name:'Technical'}}});
    if(mode==='denied')return new Response(JSON.stringify({code:131006}),{status:403});
    return json({code:0,data:{space:{space_id:'newspace',name:'Technical',visibility:'private',open_sharing:mode==='mismatch'?'open':'closed'}}});
  });
  const service=new BridgeService(live,auth,store,'a');
  const input={name:'Technical',description:'Test',operation_key:'new-space'};
  const first=await service.createWikiSpace(input);assert.equal(first.status,'success');
  assert.equal((first.result as {target:string}).target,'wiki_newspace');
  assert.equal((await service.wikiSpaceInfo('wiki_newspace')).name,'Technical');
  assert.deepEqual(await service.createWikiSpace(input),first);assert.equal(writes,1);
  await assert.rejects(service.createWikiSpace({...input,name:'Other'}),/操作编号/);
  assert.throws(()=>new Operations(store).status('b',first.operation_id),/本人/);
  for(mode of ['missing','denied','mismatch']){
    const attempt={...input,operation_key:mode};
    const failed=await service.createWikiSpace(attempt);assert.equal(failed.status,'uncertain');
    if(mode==='mismatch')assert.equal((failed.result as {target:string}).target,'wiki_newspace');
    const before:number=writes;await service.createWikiSpace(attempt);assert.equal(writes,before);
  }
  await assert.rejects(new BridgeService(settings,auth,store,'a').createWikiSpace({...input,operation_key:'configured'}),/启用/);
  auth.disconnect('a');await assert.rejects(service.createWikiSpace(input),/重新连接/);store.close();
});

test('wiki member changes verify coworker ownership and membership, exact roles and upstream acknowledgements',async()=>{
  const store=new BridgeStore(':memory:');seed(store);seed(store,'b');
  const live={...settings,resourceMode:'user' as const};let mode='ok';
  const writes:{method:string;path:string;body:Record<string,unknown>}[]=[];
  const auth=new FeishuAuth(live,store,async(input,init)=>{
    assert.match((init?.headers as Record<string,string>).authorization,/^Bearer token_[ab]$/);
    const url=new URL(String(input));
    if(url.pathname.endsWith('/is_in_chat'))return json({code:0,data:{is_in_chat:true}});
    if(url.pathname.startsWith('/open-apis/im/'))return json({code:0,data:{items:mode==='left'?[]:[
      {member_id_type:'open_id',member_id:'ou_liu',name:'刘明天',tenant_key:mode==='foreign'?'other':'tenant_test'}],has_more:false}});
    if(init?.method==='GET')return json({code:0,data:{space:{space_id:'space',name:'Test',space_type:mode==='personal'?'person':'team',visibility:mode==='public'?'public':'private'}}});
    const body=JSON.parse(String(init?.body));writes.push({method:init!.method!,path:url.pathname,body});
    if(init?.method==='POST')assert.equal(url.searchParams.get('need_notification'),'false');
    if(mode==='denied')return new Response(JSON.stringify({code:131006}),{status:403});
    if(mode==='missing')return json({code:0,data:{}});
    return json({code:0,data:{member:{member_id:mode==='wrong-person'?'ou_other':'ou_liu',member_type:'openid',member_role:mode==='wrong-role'?'invalid':body.member_role}}});
  });
  const a=new BridgeService(live,auth,store,'a'),b=new BridgeService(live,auth,store,'b');
  const recipient=(await a.findPeople({chat:'group',name:'刘明天'})).candidates[0].recipient;
  const input={target:'wiki',recipient,role:'member' as const,operation_key:'add-member'};
  const add=await a.changeWikiMember(input,'add');assert.equal(add.status,'success');
  assert.deepEqual(writes[0],{method:'POST',path:'/open-apis/wiki/v2/spaces/space/members',body:{member_type:'openid',member_role:'member',member_id:'ou_liu'}});
  const remove=await a.changeWikiMember({...input,role:'admin',operation_key:'remove-admin'},'remove');
  assert.equal(remove.status,'success');
  assert.deepEqual(writes[1],{method:'DELETE',path:'/open-apis/wiki/v2/spaces/space/members/ou_liu',body:{member_type:'openid',member_role:'admin'}});
  await assert.rejects(b.changeWikiMember({...input,operation_key:'foreign-handle'},'add'),/重新查找/);
  for(mode of ['left','foreign','public','personal'])await assert.rejects(a.changeWikiMember({...input,role:mode==='personal'?'admin':'member',operation_key:mode},'add'));
  assert.equal(writes.length,2);
  for(mode of ['denied','missing','wrong-person','wrong-role']){
    const attempt={...input,operation_key:mode};
    assert.equal((await a.changeWikiMember(attempt,'add')).status,'uncertain');
    const before:number=writes.length;await a.changeWikiMember(attempt,'add');assert.equal(writes.length,before);
  }
  store.delete('recipient',recipient);assert.deepEqual(await a.changeWikiMember(input,'add'),add);
  await assert.rejects(a.changeWikiMember({...input,operation_key:'expired'},'add'),/重新查找/);
  await assert.rejects(a.changeWikiMember({...input,role:'admin'},'add'),/操作编号/);
  store.close();
});

test('wiki settings only send requested changes and reject missing or mismatched acknowledgements',async()=>{
  const store=new BridgeStore(':memory:');seed(store);let mode='ok';const bodies:unknown[]=[];
  const auth=new FeishuAuth(settings,store,async(input,init)=>{
    assert.equal((init?.headers as Record<string,string>).authorization,'Bearer token_a');
    if(init?.method==='GET')return json({code:0,data:{space:{space_id:'space',name:'Test'}}});
    assert.equal(init?.method,'PUT');assert.equal(new URL(String(input)).pathname,'/open-apis/wiki/v2/spaces/space/setting');
    const body=JSON.parse(String(init?.body));bodies.push(body);
    if(mode==='denied')return new Response(JSON.stringify({code:131006}),{status:403});
    return json({code:0,data:{setting:mode==='missing'?undefined:mode==='mismatch'?{comment_setting:'allow'}:body}});
  });
  const service=new BridgeService(settings,auth,store,'a');
  await assert.rejects(service.updateWikiSettings({target:'wiki',operation_key:'empty'}),/至少/);assert.equal(bodies.length,0);
  const input={target:'wiki',comment_setting:'not_allow' as const,operation_key:'comment-only'};
  const first=await service.updateWikiSettings(input);assert.equal(first.status,'success');
  assert.deepEqual(bodies[0],{comment_setting:'not_allow'});
  assert.deepEqual(await service.updateWikiSettings(input),first);assert.equal(bodies.length,1);
  await assert.rejects(service.updateWikiSettings({...input,comment_setting:'allow'}),/操作编号/);
  assert.equal((await service.updateWikiSettings({target:'wiki',create_setting:'admin_and_member',security_setting:'not_allow',operation_key:'two-settings'})).status,'success');
  assert.deepEqual(bodies[1],{create_setting:'admin_and_member',security_setting:'not_allow'});
  for(mode of ['denied','missing','mismatch']){
    const attempt={...input,operation_key:mode};
    assert.equal((await service.updateWikiSettings(attempt)).status,'uncertain');
    const before:number=bodies.length;await service.updateWikiSettings(attempt);assert.equal(bodies.length,before);
  }
  store.close();
});

test('wiki creation selects discovered parent or root with employee credentials and preserves legacy defaults',async()=>{
  const store=new BridgeStore(':memory:');seed(store);
  const live={...settings,resourceMode:'user' as const};
  const writes:{path:string;body:Record<string,unknown>}[]=[];
  let reads=0,offline=false;
  const auth=new FeishuAuth(live,store,async(input,init)=>{
    assert.equal((init?.headers as Record<string,string>).authorization,'Bearer token_a');
    assert.equal(offline,false,'completed retries must not call Feishu');
    const url=new URL(String(input));
    if(init?.method==='GET'){
      reads++;
      if(url.pathname.endsWith('/get_node'))return json({code:0,data:{node:{node_token:url.searchParams.get('token'),obj_token:'parentdoc',space_id:'space',obj_type:'docx',title:'Parent'}}});
      assert.equal(url.pathname,'/open-apis/wiki/v2/spaces/space');
      return json({code:0,data:{space:{space_id:'space',name:'Discovered'}}});
    }
    const body=JSON.parse(String(init?.body));writes.push({path:url.pathname,body});
    if(url.pathname.endsWith('/nodes'))return json({code:0,data:{node:{node_token:'created'+writes.length,obj_token:'newdoc',obj_type:'docx',space_id:'space',parent_node_token:body.parent_node_token||'',title:body.title}}});
    assert.equal(url.pathname,'/open-apis/docx/v1/documents/newdoc/blocks/newdoc/children');
    return json({code:0,data:{}});
  });
  const service=new BridgeService(live,auth,store,'a');
  const input={target:'wiki_space',parent_node:'chosen',title:'Test',content:'Hello',operation_key:'chosen-parent'};
  const first=await service.createWiki(input);assert.equal(first.status,'success');
  assert.equal(writes[0].body.parent_node_token,'chosen');
  assert.equal((first.result as {url?:string}).url,undefined);
  const root=await service.createWiki({...input,parent_node:undefined,at_root:true,operation_key:'root'});
  assert.equal(root.status,'success');assert.equal('parent_node_token' in writes[2].body,false);
  const legacy=await service.createWiki({...input,target:'wiki',parent_node:undefined,operation_key:'legacy'});
  assert.equal(legacy.status,'success');assert.equal(writes[4].body.parent_node_token,'home');
  assert.match((legacy.result as {url:string}).url,/^https:\/\/test.feishu.cn\/wiki\/created/);
  const count=reads;offline=true;
  assert.deepEqual(await service.createWiki(input),JSON.parse(JSON.stringify(first)));
  await assert.rejects(service.createWiki({...input,parent_node:'changed'}),/操作编号/);
  assert.equal(reads,count);assert.equal(writes.length,6);store.close();
});

test('wiki creation rejects missing or conflicting locations, foreign parents and shortcuts before writing',async()=>{
  const store=new BridgeStore(':memory:');seed(store);
  const live={...settings,resourceMode:'user' as const,wiki:[]};let mode='foreign',writes=0;
  const auth=new FeishuAuth(live,store,async(input,init)=>{
    if(init?.method!=='GET'){writes++;throw Error('unexpected write');}
    if(String(input).includes('get_node'))return json({code:0,data:{node:{node_token:'parent',obj_token:'doc',obj_type:'docx',space_id:mode==='foreign'?'other':'space',node_type:mode==='shortcut'?'shortcut':'origin'}}});
    return json({code:0,data:{space:{space_id:'space',name:'Discovered'}}});
  });
  const service=new BridgeService(live,auth,store,'a');
  const input={target:'wiki_space',title:'Test',content:'Hello',operation_key:'blocked'};
  await assert.rejects(service.createWiki(input),/指定父页面/);
  await assert.rejects(service.createWiki({...input,parent_node:'parent',at_root:true}),/不能同时/);
  for(mode of ['foreign','shortcut'])await assert.rejects(service.createWiki({...input,parent_node:'parent'}));
  assert.equal(writes,0);store.close();
});

for(const mode of ['denied','append-failure','wrong-parent'])test(`wiki creation retains partial receipts without duplicate writes: ${mode}`,async()=>{
  const store=new BridgeStore(':memory:');seed(store);let creates=0,appends=0;
  const auth=new FeishuAuth(settings,store,async(input,init)=>{
    assert.equal((init?.headers as Record<string,string>).authorization,'Bearer token_a');
    const path=new URL(String(input)).pathname;
    if(init?.method==='GET')return json({code:0,data:{node:{node_token:'home',obj_token:'parentdoc',space_id:'space',obj_type:'docx'}}});
    if(path.endsWith('/nodes')){
      creates++;
      if(mode==='denied')return new Response(JSON.stringify({code:1770032,msg:'forbidden'}),{status:403});
      return json({code:0,data:{node:{node_token:'created',obj_token:'newdoc',obj_type:'docx',space_id:'space',parent_node_token:mode==='wrong-parent'?'other':'home'}}});
    }
    appends++;throw Error('write interrupted');
  });
  const service=new BridgeService(settings,auth,store,'a');
  const input={target:'wiki',title:'Test',content:'Hello',operation_key:'partial'};
  const first=await service.createWiki(input);assert.equal(first.status,'uncertain');
  if(mode!=='denied')assert.equal((first.result as {node_token:string}).node_token,'created');
  assert.deepEqual(await service.createWiki(input),first);
  assert.equal(creates,1);assert.equal(appends,mode==='append-failure'?1:0);store.close();
});

test('wiki reads use latest user revision and reject mixed, foreign or expired pagination',async()=>{
  const store=new BridgeStore(':memory:');seed(store);seed(store,'b');
  let revision=22,mode='normal',blockReads=0;
  const auth=new FeishuAuth(settings,store,async(input,init)=>{
    assert.equal(init?.method,'GET');
    assert.match((init?.headers as Record<string,string>).authorization,/^Bearer token_[ab]$/);
    const url=new URL(String(input));
    if(url.pathname.endsWith('/get_node'))return json({code:0,data:{node:{space_id:'space',node_token:url.searchParams.get('token'),obj_token:url.searchParams.get('token')==='other'?'otherdoc':'doc',obj_type:'docx',title:'Doc'}}});
    if(!url.pathname.endsWith('/blocks'))return json({code:0,data:{document:{revision_id:revision}}});
    blockReads++;
    // A read-only employee can read latest, but must never need a historical read.
    if(url.searchParams.get('document_revision_id')!=='-1')return new Response(JSON.stringify({code:1770032}),{status:403});
    if(mode==='denied')return new Response(JSON.stringify({code:1770032}),{status:403});
    if(mode==='changed')revision++;
    const last=url.searchParams.get('page_token')==='page2';
    return json({code:0,data:{items:[{block_id:last?'b2':'b1'}],has_more:!last,page_token:mode==='malformed'?undefined:'page2'}});
  });
  const a=new BridgeService(settings,auth,store,'a'),b=new BridgeService(settings,auth,store,'b');
  const first=await a.readWiki('wiki','node');assert.equal(first.revision,22);assert.ok(first.next);
  const before=blockReads;
  await assert.rejects(b.readWiki('wiki','node',first.next),/分页已失效/);
  await assert.rejects(a.readWiki('wiki','other',first.next),/分页已失效/);
  await assert.rejects(a.readWiki('wiki','node','invented'),/分页已失效/);
  assert.equal(blockReads,before);
  const second=await a.readWiki('wiki','node',first.next);assert.equal(second.next,undefined);assert.equal(second.blocks?.[0].block_id,'b2');
  revision++;await assert.rejects(a.readWiki('wiki','node',first.next),/分页期间发生变化/);
  mode='changed';await assert.rejects(a.readWiki('wiki','node'),/读取期间发生变化/);
  mode='denied';await assert.rejects(a.readWiki('wiki','node'),/1770032/);
  mode='malformed';await assert.rejects(a.readWiki('wiki','node'),/分页响应不完整/);
  store.delete('wiki_read',first.next!);await assert.rejects(a.readWiki('wiki','node',first.next),/分页已失效/);
  store.close();
});

test('coworker lookup and DM preserve actor, tenant, membership and idempotency boundaries',async()=>{
  const store=new BridgeStore(':memory:');seed(store);seed(store,'b');
  const live={...settings,resourceMode:'user' as const,chats:[],recipients:[]};
  let mode='normal',sends=0,lookups=0;
  const auth=new FeishuAuth(live,store,async(input,init)=>{
    const url=new URL(String(input));
    if(url.pathname.includes('/members')) {
      assert.equal((init?.headers as Record<string,string>).authorization,'Bearer token_a');
      if(url.pathname.endsWith('/is_in_chat'))return json({code:0,data:{is_in_chat:mode!=='sender-left'}});
      lookups++;
      if(mode==='recipient-left')return json({code:0,data:{items:[],has_more:false}});
      return json({code:0,data:{items:[
        {member_id_type:'open_id',member_id:'ou_liu',name:'刘明天',tenant_key:mode==='changed-tenant'?'foreign':'tenant_test'},
        {member_id_type:'open_id',member_id:'ou_outside',name:'刘明天',tenant_key:'foreign'},
        {member_id_type:'open_id',member_id:'ou_unknown',name:'刘明天'},
      ],has_more:false}});
    }
    if(url.pathname.endsWith('/tenant_access_token/internal'))return json({code:0,tenant_access_token:'bot_token',expire:7200});
    if(url.pathname==='/open-apis/im/v1/messages') {
      sends++;const body=JSON.parse(String(init?.body));
      assert.equal(body.receive_id,'ou_liu');assert.match(JSON.parse(body.content).text,/你好.*\n\n（由 a 通过公司助手发起）/);
      assert.equal((init?.headers as Record<string,string>).authorization,'Bearer bot_token');
      if(mode==='lost-response')throw Error('network uncertain');
      return json({code:0,data:{message_id:'om_sent'}});
    }
    throw Error(`unexpected ${url.pathname}`);
  });
  const a=new BridgeService(live,auth,store,'a'),b=new BridgeService(live,auth,store,'b');
  const found=await a.findPeople({chat:'oc_team',name:'刘明天'});
  assert.equal(found.candidates.length,1);assert.equal(found.candidates[0].exact_match,true);
  const recipient=found.candidates[0].recipient;
  const input={recipient,content:'你好',operation_key:'coworker-send-1'};
  await assert.rejects(b.sendPerson(input));assert.equal(sends,0);
  await assert.rejects(a.sendPerson({...input,recipient:'ou_liu'}));assert.equal(sends,0);
  for(mode of ['sender-left','recipient-left','changed-tenant']) {
    await assert.rejects(a.sendPerson(input));assert.equal(sends,0);
  }
  mode='normal';const first=await a.sendPerson(input);assert.equal(first.status,'success');assert.equal(sends,1);
  store.delete('recipient',recipient);
  const before=lookups;assert.equal((await a.sendPerson(input)).status,'success');assert.equal(sends,1);assert.equal(lookups,before);
  await assert.rejects(a.sendPerson({...input,content:'different'}));
  await assert.rejects(a.sendPerson({...input,operation_key:'expired-lookup'}));
  const again=await a.findPeople({chat:'oc_team',name:'刘明天'});
  const uncertain={recipient:again.candidates[0].recipient,content:'你好',operation_key:'uncertain-send'};
  mode='lost-response';assert.equal((await a.sendPerson(uncertain)).status,'uncertain');
  assert.equal((await a.sendPerson(uncertain)).status,'uncertain');assert.equal(sends,2);
  store.close();
});

test('coworker lookup exposes ambiguity and incomplete member visibility without sending',async()=>{
  const store=new BridgeStore(':memory:');seed(store);
  const live={...settings,resourceMode:'user' as const};
  const auth=new FeishuAuth(live,store,async(input,init)=>{
    assert.equal(init?.method,'GET');
    if(String(input).includes('is_in_chat'))return json({code:0,data:{is_in_chat:true}});
    return json({code:0,data:{items:[
      {member_id_type:'open_id',member_id:'ou_1',tenant_key:'tenant_test',name:'同名'},
      {member_id_type:'open_id',member_id:'ou_2',tenant_key:'tenant_test',name:'同名'}],has_more:true,page_token:'next',trigger_security_conf_limit:true}});
  });
  const page=await new BridgeService(live,auth,store,'a').findPeople({chat:'group',name:'同名'});
  assert.equal(page.candidates.length,2);assert.equal(page.complete,false);assert.equal(page.next,'next');assert.equal(page.visibility_limited,true);
  store.close();
});

test('live resources use each employee token, paginate and support wiki/chat reads without configured lists',async()=>{
  const store=new BridgeStore(':memory:');seed(store);seed(store,'b');
  const live={...settings,resourceMode:'user' as const,wiki:[],chats:[],tables:[]};
  const seen:string[]=[];
  const auth=new FeishuAuth(live,store,async(input,init)=>{
    assert.equal(init?.method,'GET');
    const url=new URL(String(input)),token=(init?.headers as Record<string,string>).authorization;
    seen.push(`${token} ${url.pathname}`);
    const own=token==='Bearer token_a'?'a':'b';
    if(url.pathname==='/open-apis/wiki/v2/spaces')return json({code:0,data:{items:[{space_id:`space_${own}`,name:`Wiki ${own}`}],has_more:false}});
    if(url.pathname==='/open-apis/im/v1/chats') {
      const next=url.searchParams.get('page_token');
      return json({code:0,data:{items:[{chat_id:next?'oc_next':`oc_${own}`,name:next?'Next':`Group ${own}`}],has_more:!next,page_token:next?undefined:'next-page'}});
    }
    if(url.pathname===`/open-apis/wiki/v2/spaces/space_${own}`)return json({code:0,data:{space:{space_id:`space_${own}`,name:'Wiki'}}});
    if(url.pathname===`/open-apis/wiki/v2/spaces/space_${own}/nodes`) {
      assert.equal(url.searchParams.has('parent_node_token'),false);
      return json({code:0,data:{items:[{space_id:`space_${own}`,node_token:'node',obj_token:'doc',obj_type:'docx',title:'Document'}],has_more:false}});
    }
    if(url.pathname==='/open-apis/wiki/v2/spaces/get_node')return json({code:0,data:{node:{space_id:`space_${own}`,node_token:'node',obj_token:'doc',obj_type:'docx',title:'Document'}}});
    if(url.pathname==='/open-apis/docx/v1/documents/doc')return json({code:0,data:{document:{revision_id:1}}});
    if(url.pathname==='/open-apis/docx/v1/documents/doc/blocks')return json({code:0,data:{items:[{block_id:'paragraph'}],has_more:false}});
    if(url.pathname.endsWith('/members/is_in_chat'))return json({code:0,data:{is_in_chat:url.pathname.includes(`/oc_${own}/`)}});
    if(url.pathname==='/open-apis/im/v1/messages')return json({code:0,data:{items:[],has_more:false}});
    return json({code:99991672});
  });
  const a=new BridgeService(live,auth,store,'a'),b=new BridgeService(live,auth,store,'b');
  const [ra,rb]=await Promise.all([a.resources(),b.resources()]);
  assert.deepEqual(ra.wiki,[{id:'wiki_space_a',name:'Wiki a'}]);
  assert.deepEqual(rb.chats,[{id:'oc_b',name:'Group b'}]);
  assert.equal(ra.pagination.chats.next,'next-page');assert.equal(ra.pagination.chats.complete,false);
  const second=await a.resources({kind:'chats',cursor:ra.pagination.chats.next});
  assert.deepEqual(second.chats,[{id:'oc_next',name:'Next'}]);assert.equal(second.pagination.chats.complete,true);
  assert.equal((await a.listWiki('wiki_space_a')).items[0].node_token,'node');
  assert.equal((await a.readWiki('wiki_space_a','node')).revision,1);
  assert.equal((await a.readChat({chat:'oc_a',period:'today'})).pagination_complete,true);
  await assert.rejects(b.listWiki('wiki_space_a'));
  await assert.rejects(b.readChat({chat:'oc_a',period:'today'}));
  assert.ok(seen.every(s=>s.startsWith('Bearer token_')));
  assert.deepEqual(live.wiki,[]);assert.deepEqual(live.chats,[]);
  store.close();
});

test('resource API denial and malformed pagination are reported, never passed off as empty success',async()=>{
  for(const mode of ['denied','malformed','repeated']) {
    const store=new BridgeStore(':memory:');seed(store);
    const live={...settings,resourceMode:'user' as const,wiki:[],chats:[],tables:[]};
    const auth=new FeishuAuth(live,store,async input=>{
      if(String(input).includes('/wiki/'))return json({code:99991672});
      return json(mode==='denied'?{code:99991672}:{code:0,data:{items:[],has_more:true,page_token:mode==='repeated'?'same':undefined}});
    });
    const service=new BridgeService(live,auth,store,'a');
    const result=await service.resources(mode==='repeated'?{kind:'chats',cursor:'same'}:{});
    assert.equal(result.pagination.chats.complete,false);
    assert.ok(result.errors.some(e=>e.resource==='chats'));
    if(mode!=='repeated')assert.ok(result.errors.some(e=>e.resource==='wiki'));
    store.close();
  }
});

test('company admission permits new coworkers only after verified same-tenant OAuth',async()=>{
  for(const scenario of ['coworker','other-tenant','token-denied','identity-denied']) {
    const store=new BridgeStore(':memory:');
    const company={...settings,accessMode:'tenant' as const,users:[]};
    const auth=new FeishuAuth(company,store,async input=>{
      if(String(input).includes('/oauth/token'))return json(scenario==='token-denied'?{code:999}:
        {code:0,access_token:'test-user-token',refresh_token:'test-refresh',expires_in:3600});
      return json(scenario==='identity-denied'?{code:999}:{code:0,data:{
        open_id:'ou_new_coworker',tenant_key:scenario==='other-tenant'?'other_company':'tenant_test',name:'Coworker'}});
    });
    if(scenario==='coworker') {
      const person=await auth.login('test-code','test-verifier');
      assert.equal(auth.person(person.sub).openId,'ou_new_coworker');
      assert.deepEqual(missingSettings(company),[]);
      company.tenant='different_company';
      assert.throws(()=>auth.person(person.sub));
    } else await assert.rejects(auth.login('test-code','test-verifier'));
    store.close();
  }
});

test('allowlist remains the default and company mode cannot bypass missing tenant',()=>{
  const store=new BridgeStore(':memory:');
  const coworker={sub:'new',openId:'ou_new',tenant:'tenant_test',name:'New'};
  assert.equal(new FeishuAuth(settings,store).allowed(coworker),false);
  assert.ok(missingSettings({...settings,users:[]}).includes('MCP_ALLOWED_USERS_JSON'));
  const empty={...settings,accessMode:'tenant' as const,tenant:'',users:[]};
  assert.ok(missingSettings(empty).includes('MCP_FEISHU_TENANT_KEY'));
  assert.equal(new FeishuAuth(empty,store).allowed({...coworker,tenant:''}),false);
  store.close();
});

test('upstream rejection keeps safe diagnostic ID and never retries an uncertain move',async()=>{
  const store=new BridgeStore(':memory:');seed(store);let calls=0;
  const auth=new FeishuAuth(settings,store,async()=>{calls++;return new Response(JSON.stringify({code:93101,msg:'secret-token-do-not-relay'}),{headers:{'x-tt-logid':'test-request-93101'}});});
  const ops=new Operations(store),input={file:'test-file'};
  const work=async(checkpoint:(value:unknown)=>void)=>{
    checkpoint({target:'wiki',file_name:'test.pdf',file_token:'test-file',stage:'uploaded'});
    await auth.user('a').call('POST','/wiki/v2/spaces/space/nodes/move_docs_to_wiki',{});
  };
  const result=await ops.run('a','upload_file','move-error-test',input,work);
  assert.equal(result.status,'uncertain');assert.match(JSON.stringify(result.error),/93101.*test-request-93101/);
  assert.doesNotMatch(JSON.stringify(result.error),/secret-token-do-not-relay/);
  assert.match(JSON.stringify(result.error),/知识库权益.*过期/);
  assert.equal((result.result as any).file_token,'test-file');
  await ops.run('a','upload_file','move-error-test',input,work);assert.equal(calls,1);
  store.close();
});

test('writes are durable, deduplicated, input-bound and isolated by employee',async()=>{
  const store=new BridgeStore(':memory:'),ops=new Operations(store);let writes=0;
  const input={value:1};
  const first=await ops.run('a','create','unique001',input,async()=>{writes++;return {id:'remote1'};});
  assert.equal((await ops.run('a','create','unique001',input,async()=>{writes++;})).status,'success');
  assert.equal(writes,1);assert.throws(()=>ops.status('b',first.operation_id));
  await assert.rejects(ops.run('a','create','unique001',{value:2},async()=>{}));
  const failed=await ops.run('a','send','unique002',{},async checkpoint=>{checkpoint({id:'partial'});throw Error('response lost');});
  assert.equal(failed.status,'uncertain');assert.deepEqual(failed.result,{id:'partial'});
  await ops.run('a','send','unique002',{},async()=>{writes++;});assert.equal(writes,1);store.close();
});
test('SSRF and OAuth callback boundaries',async()=>{
  for(const address of ['127.0.0.1','10.1.2.3','169.254.169.254','100.64.1.1','192.168.1.1','::1','::ffff:127.0.0.1','fc00::1','2002:7f00:1::'])
    assert.equal(publicAddress(address),false,address);
  assert.equal(publicAddress('8.8.8.8'),true);
  await assert.rejects(downloadAttachment('https://127.0.0.1/file'));
  assert.equal(allowedRedirect('https://chatgpt.com/connector_platform_oauth_redirect'),true);
  assert.equal(allowedRedirect('https://chatgpt.com.evil.test/connector/oauth/a'),false);
  assert.equal(allowedRedirect('https://chatgpt.com/connector/oauth/a?next=https://evil.test'),false);
});

test('attachment status reconciles persisted move without writing or crossing file/employee boundaries',async()=>{
  const store=new BridgeStore(':memory:');seed(store);seed(store,'b');
  const ops=new Operations(store);let mode='pending',calls=0;
  const receipt=await ops.run('a','upload_file','upload-recovery',{},async checkpoint=>{
    checkpoint({stage:'moving',task_id:'task',file_token:'file'});
    const {BridgeError}=await import('../src/bridge/errors.js');throw new BridgeError('MOVE_PENDING','pending');
  });
  const fetcher:typeof fetch=async(input,init)=>{
    calls++;assert.equal(init?.method,'GET');
    if(mode==='denied')return json({code:99991672});
    if(String(input).includes('/tasks/'))return json({code:0,data:{task:{move_result:[{status:mode==='pending'?1:0,node:{node_token:'node'}}]}}});
    return json({code:0,data:{node:{node_token:'node',obj_token:mode==='wrongfile'?'other':'file',obj_type:'file',
      space_id:mode==='wrongspace'?'other':'space',title:'fixture'}}});
  };
  const auth=new FeishuAuth(settings,store,fetcher),service=new BridgeService(settings,auth,store,'a');
  await assert.rejects(new BridgeService(settings,auth,store,'b').status(receipt.operation_id));assert.equal(calls,0);
  assert.equal((await service.status(receipt.operation_id)).status,'uncertain');
  for(mode of ['denied','wrongfile','wrongspace']){
    await assert.rejects(service.status(receipt.operation_id));assert.equal(ops.status('a',receipt.operation_id).status,'uncertain');
  }
  mode='complete';const verified=await service.status(receipt.operation_id);
  assert.equal(verified.status,'success');assert.equal(verified.error,undefined);
  assert.equal((verified.result as any).url,'https://test.feishu.cn/wiki/node');
  const previousCalls=calls;assert.deepEqual(await service.status(receipt.operation_id),verified);assert.equal(calls,previousCalls);
  store.close();
});
test('employee denial never falls back to bot; cross-space/reply and revision checks precede writes',async()=>{
  const store=new BridgeStore(':memory:');seed(store);let mode='deny',writes=0;
  const fetcher:typeof fetch=async(input,init)=>{
    const url=String(input);if(init?.method&&init.method!=='GET')writes++;
    if(mode==='deny')return json({code:99991672});
    if(url.includes('is_in_chat'))return json({code:0,data:{is_in_chat:true}});
    if(url.includes('/im/v1/chats/'))return json({code:0,data:{moderation_permission:'all_members'}});
    if(url.includes('/im/v1/messages/'))return json({code:0,data:{items:[{chat_id:'oc_other'}]}});
    if(url.includes('get_node'))return json({code:0,data:{node:{node_token:'node',obj_token:'doc',obj_type:'docx',space_id:mode==='cross'?'other':'space',title:'test'}}});
    return json({code:0,data:{document:{revision_id:3}}});
  };
  const auth=new FeishuAuth(settings,store,fetcher),service=new BridgeService(settings,auth,store,'a');
  await assert.rejects(service.readChat({chat:'group',start_time:1,end_time:2}));
  assert.equal(writes,0);mode='cross';await assert.rejects(service.readWiki('wiki','node'));
  mode='reply';await assert.rejects(service.sendChat({chat:'group',reply_to:'om_other',content:'hello',operation_key:'message1'}));
  await assert.rejects(service.editWiki({target:'wiki',node_token:'node',revision:2,mode:'append',content:'hello',operation_key:'edit0001'}));
  assert.equal(writes,0);store.close();
});
test('user refresh is serialized and permission revocation is effective',async()=>{
  const store=new BridgeStore(':memory:');const person=seed(store);
  store.put('feishu','a',{person,access:'old',refresh:'r',expires:0});let refreshes=0;
  const fetcher:typeof fetch=async(input,init)=>{
    if(String(input).includes('/oauth/token')){refreshes++;await new Promise(resolve=>setTimeout(resolve,10));return json({code:0,access_token:'new',refresh_token:'r2',expires_in:3600});}
    assert.equal((init?.headers as Record<string,string>).authorization,'Bearer new');return json({code:0,data:{}});
  };
  const auth=new FeishuAuth(settings,store,fetcher);
  await Promise.all([auth.user('a').call('GET','/one'),auth.user('a').call('GET','/two')]);assert.equal(refreshes,1);
  auth.disconnect('a');await assert.rejects(auth.user('a').call('GET','/one'));store.close();
});
test('an in-flight token refresh cannot restore a disconnected employee or erase a new login',async()=>{
  for(const scenario of ['disconnect','relogin','relogin-failure','remove-allowlist']) {
    const store=new BridgeStore(':memory:'),person=seed(store);
    const scopedSettings={...settings,users:[...settings.users]};
    store.put('feishu','a',{person,access:'expired',refresh:'old-refresh',expires:0});
    let finish!:()=>void,started!:()=>void,resourceCalls=0;
    const begun=new Promise<void>(resolve=>{started=resolve;});
    const gate=new Promise<void>(resolve=>{finish=resolve;});
    const auth=new FeishuAuth(scopedSettings,store,async(input)=>{
      if(String(input).includes('/oauth/token')) {
        started();await gate;
        return scenario==='relogin-failure'?json({code:999}):
          json({code:0,access_token:'refreshed-old-login',refresh_token:'rotated',expires_in:3600});
      }
      resourceCalls++;return json({code:0,data:{}});
    });
    const pending=auth.user('a').call('GET','/protected-resource');
    const rejected=assert.rejects(pending);
    await begun;
    if(scenario==='disconnect')auth.disconnect('a');
    else if(scenario==='remove-allowlist')scopedSettings.users=[];
    else store.put('feishu','a',{person,access:'new-login',refresh:'new-refresh',expires:Date.now()+3600000});
    finish();await rejected;
    assert.equal(resourceCalls,0,scenario);
    const saved=store.get<any>('feishu','a');
    if(scenario.startsWith('relogin'))assert.equal(saved?.access,'new-login',scenario);
    else assert.equal(saved,undefined,scenario);
    store.close();
  }
});

test('chat time metadata uses actual send time rather than dates inside the body',async()=>{
  const store=new BridgeStore(':memory:');seed(store);
  const sent=Date.parse('2026-10-20T14:50:52+08:00');
  let calls=0;
  const fetcher:typeof fetch=async(input)=>{
    calls++;
    if(String(input).includes('is_in_chat'))return json({code:0,data:{is_in_chat:true}});
    const query=new URL(String(input)).searchParams;
    assert.equal(query.get('start_time'),String(Date.parse('2026-10-19T00:00:00+08:00')/1000));
    assert.equal(query.get('end_time'),String(Date.parse('2026-10-26T12:00:00+08:00')/1000));
    return json({code:0,data:{has_more:false,items:[
      {message_id:'first',create_time:String(sent),body:{content:'日报：2026-10-08'}},
      {message_id:'old',create_time:String(sent-10*86400000)},
      {message_id:'missing'}]}});
  };
  const service=new BridgeService(settings,new FeishuAuth(settings,store,fetcher),store,'a');
  const range={chat:'group',start_time:'2026-10-19T00:00:00+08:00',end_time:'2026-10-26T12:00:00+08:00'};
  const page=await service.readChat(range);
  assert.equal(page.returned_message_count,3);assert.equal(page.unique_message_count,3);
  assert.equal(page.count_scope,'entire_query');assert.equal('page_count' in page,false);
  assert.equal(page.query.start_beijing,'2026-10-19 00:00:00');
  assert.equal(page.items[0].sent_at_beijing,'2026-10-20 14:50:52');
  assert.equal(page.items[0].within_requested_range,true);
  assert.equal(page.items[1].within_requested_range,false);
  assert.equal(page.items[2].within_requested_range,null);
  assert.deepEqual(page.time_check,{outside_range_count:1,unknown_time_count:1});
  assert.equal(page.has_more,false);assert.equal(page.next,undefined);
  const {query_ref,...expected}=page;
  const {query_ref:numericRef,...numeric}=await service.readChat({...range,start_time:page.query.start_time,end_time:page.query.end_time});
  const {query_ref:utcRef,...utc}=await service.readChat({...range,start_time:'2026-10-18T16:00:00Z',end_time:'2026-10-26T04:00:00Z'});
  assert.deepEqual(numeric,expected);assert.deepEqual(utc,expected);
  const before=calls;
  for(const start_time of ['2026-10-19T00:00:00','2026-02-30T00:00:00+08:00','invalid',NaN,Infinity,-1,1792339200000.5])
    await assert.rejects(service.readChat({...range,start_time}),/时间/);
  await assert.rejects(service.readChat({...range,end_time:range.start_time}),/结束时间/);
  assert.equal(calls,before);store.close();
});

test('relative ranges use the server clock and Beijing calendar across month and week boundaries',()=>{
  const now=Date.parse('2026-03-01T00:00:00+08:00'),seconds=(s:string)=>Date.parse(s)/1000;
  assert.deepEqual(resolveChatRange({},now),{start:seconds('2026-02-22T00:00:00+08:00'),end:now/1000,period:'last_7_days'});
  assert.deepEqual(resolveChatRange({period:'yesterday'},now),{start:seconds('2026-02-28T00:00:00+08:00'),end:now/1000-1,period:'yesterday'});
  assert.equal(resolveChatRange({period:'today'},now).start,now/1000);
  assert.equal(resolveChatRange({period:'this_week'},now).start,seconds('2026-02-23T00:00:00+08:00'));
  assert.deepEqual(resolveChatRange({period:'last_week'},now),{start:seconds('2026-02-16T00:00:00+08:00'),end:seconds('2026-02-23T00:00:00+08:00')-1,period:'last_week'});
  assert.equal(resolveChatRange({period:'this_week'},Date.parse('2026-10-26T12:00:00+08:00')).start,seconds('2026-10-26T00:00:00+08:00'));
  assert.throws(()=>resolveChatRange({period:'yesterday',start_time:1,end_time:2}),/混用/);
  assert.throws(()=>resolveChatRange({start_time:1}),/同时/);
});

test('chat reads all pages, deduplicates IDs, and reuses employee-bound immutable ranges',async()=>{
  const store=new BridgeStore(':memory:');seed(store);seed(store,'b');
  const requests:URLSearchParams[]=[];let denied=false;
  const fetcher:typeof fetch=async(input)=>{
    if(String(input).includes('is_in_chat'))return json({code:0,data:{is_in_chat:!denied}});
    const q=new URL(String(input)).searchParams;requests.push(q);
    const message=(id:string)=>({message_id:id,create_time:String(Number(q.get('start_time'))*1000+1000)});
    return q.has('page_token')?json({code:0,data:{items:[message('a'),message('b')],has_more:false}}):
      json({code:0,data:{items:[message('a')],has_more:true,page_token:'page2'}});
  };
  const auth=new FeishuAuth(settings,store,fetcher),service=new BridgeService(settings,auth,store,'a');
  const before=Math.floor(Date.now()/1000),first=await service.readChat({chat:'group',period:'last_7_days'});
  assert.ok(first.query.end_time>=before&&first.query.end_time<=Math.floor(Date.now()/1000));
  assert.equal(first.query.end_time-first.query.start_time,7*86400);
  assert.equal(first.pages_read,2);assert.equal(first.raw_message_count,3);
  assert.equal(first.unique_message_count,2);assert.equal(first.duplicate_message_count,1);
  assert.equal(first.pagination_complete,true);assert.equal(first.count_scope,'entire_query');
  await service.readChat({chat:'group',period:'yesterday'});
  const again=await new BridgeService(settings,auth,store,'a').readChat({chat:'group',query_ref:first.query_ref});
  assert.deepEqual(again,first);
  assert.equal(requests[0].get('start_time'),requests[1].get('start_time'));
  const count=requests.length;
  await assert.rejects(new BridgeService(settings,auth,store,'b').readChat({chat:'group',query_ref:first.query_ref}),/当前员工/);
  await assert.rejects(service.readChat({chat:'wrong',query_ref:first.query_ref}));
  await assert.rejects(service.readChat({chat:'group',query_ref:first.query_ref,period:'today'}),/不要同时/);
  await assert.rejects(service.readChat({chat:'group',query_ref:'00000000-0000-4000-8000-000000000000'}),/已过期/);
  denied=true;await assert.rejects(service.readChat({chat:'group',query_ref:first.query_ref}),/不在这个群/);
  assert.equal(requests.length,count);store.close();
});

test('chat pagination limits stay explicitly partial and malformed or failed pages never claim completion',async()=>{
  const store=new BridgeStore(':memory:');seed(store);let mode='limit';
  const fetcher:typeof fetch=async(input)=>{
    if(String(input).includes('is_in_chat'))return json({code:0,data:{is_in_chat:true}});
    const q=new URL(String(input)).searchParams,index=Number(q.get('page_token')||0);
    if(mode==='failure'&&index>0)throw Error('network failure');
    if(mode==='missing')return json({code:0,data:{items:[]}});
    if(mode==='no-id')return json({code:0,data:{items:[{}],has_more:false}});
    return json({code:0,data:{items:[{message_id:String(index),create_time:'1000'}],has_more:mode==='repeat'||index<20,
      page_token:mode==='repeat'?'1':String(index+1)}});
  };
  const service=new BridgeService(settings,new FeishuAuth(settings,store,fetcher),store,'a');
  const first=await service.readChat({chat:'group',start_time:1,end_time:2});
  assert.equal(first.pages_read,20);assert.equal(first.has_more,true);assert.equal(first.pagination_complete,false);
  assert.equal(first.count_scope,'current_batch');assert.equal(first.unique_message_count,20);
  const last=await service.readChat({chat:'group',query_ref:first.query_ref,cursor:first.next});
  assert.deepEqual(last.query,first.query);assert.equal(last.unique_message_count,1);
  assert.equal(last.pagination_complete,true);assert.equal(last.count_scope,'current_batch');
  for(mode of ['repeat','failure','missing','no-id'])await assert.rejects(service.readChat({chat:'group',start_time:1,end_time:2}));
  await assert.rejects(service.readChat({chat:'group',period:'today',cursor:'1'}),/原始起止时间/);
  store.close();
});
test('edit retries return the saved result after the document revision changes',async()=>{
  const store=new BridgeStore(':memory:');seed(store);let revision=3,writes=0;
  const fetcher:typeof fetch=async(input,init)=>{
    if(String(input).includes('get_node'))return json({code:0,data:{node:{node_token:'node',obj_token:'doc',obj_type:'docx',space_id:'space'}}});
    if(init?.method==='POST'){writes++;revision++;return json({code:0,data:{}});}
    return json({code:0,data:{document:{revision_id:revision}}});
  };
  const service=new BridgeService(settings,new FeishuAuth(settings,store,fetcher),store,'a');
  const input={target:'wiki',node_token:'node',revision:3,mode:'append' as const,content:'hello',operation_key:'edit-retry'};
  assert.equal((await service.editWiki(input)).status,'success');
  assert.equal((await service.editWiki(input)).status,'success');assert.equal(writes,1);
  await assert.rejects(service.editWiki({...input,content:'changed'}));store.close();
});
test('missing write identifiers are uncertain and do not cause another remote write',async()=>{
  const store=new BridgeStore(':memory:');seed(store);let writes=0;
  const fetcher:typeof fetch=async(_input,init)=>{
    if(init?.method==='POST')writes++;
    return json({code:0,data:{}});
  };
  const service=new BridgeService(settings,new FeishuAuth(settings,store,fetcher),store,'a');
  const input={table:'table',fields:{Name:'dummy'},operation_key:'missing-id'};
  assert.equal((await service.writeTable(input)).status,'uncertain');
  assert.equal((await service.writeTable(input)).status,'uncertain');assert.equal(writes,1);store.close();
});
for(const oauthScope of ['openid offline_access mcp','mcp']) test(`OAuth/PKCE/consent and MCP tools (${oauthScope}); rejects foreign clients, CSRF and revoked grants`,async()=>{
  const store=new BridgeStore(':memory:');
  const fakeFetch:typeof fetch=async(input)=>String(input).includes('/oauth/token')?
    json({code:0,access_token:'upstream-secret',refresh_token:'upstream-refresh',expires_in:3600}):
    json({code:0,data:{open_id:'ou_a',tenant_key:'tenant_test',name:'Alice'}});
  const feishu=new FeishuAuth(settings,store,fakeFetch);
  const {app,provider}=await createBridgeApp(settings,store,{feishu});assert.ok(provider);
  type Cookie={name:string;value:string;path:string};const cookies:Cookie[]=[];
  function req(method:'get'|'post',path:string) {
    return request(app)[method](path).set('Host','mcp.example.com').set('X-Forwarded-Proto','https')
      .set('Cookie',cookies.filter(c=>path.split('?')[0].startsWith(c.path)).map(c=>`${c.name}=${c.value}`).join('; '));
  }
  function capture(response:request.Response) {
    for(const line of (response.headers['set-cookie']||[]) as unknown as string[]) {
      const parts=line.split(';'),pair=parts[0],split=pair.indexOf('='),name=pair.slice(0,split),value=pair.slice(split+1);
      const path=parts.find(p=>p.trim().toLowerCase().startsWith('path='))?.trim().slice(5)||'/';
      const previous=cookies.findIndex(c=>c.name===name&&c.path===path);if(previous>=0)cookies.splice(previous,1);
      cookies.push({name,value,path});
    }
    return response;
  }
  const unauthorized=await req('post','/mcp').send({});assert.equal(unauthorized.status,401);
  assert.match(unauthorized.headers['www-authenticate'],/oauth-protected-resource/);
  assert.equal((await req('get','/api/v1/daily-summary')).status,404);
  const bad=await req('post','/register').send({redirect_uris:['https://evil.example/callback']});assert.equal(bad.status,400);
  const callback='https://chatgpt.com/connector_platform_oauth_redirect';
  const registered=await req('post','/register').send({redirect_uris:[callback],client_name:'ChatGPT',
    token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']});
  assert.equal(registered.status,201,JSON.stringify(registered.body));
  const verifier='test-verifier-with-at-least-43-characters-1234567890';
  const params=new URLSearchParams({client_id:registered.body.client_id,response_type:'code',redirect_uri:callback,
    scope:oauthScope,resource:settings.publicUrl+'/mcp',state:'client-state',
    code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'});
  let response=capture(await req('get','/authorize?'+params));assert.equal(response.status,303,JSON.stringify(response.body));
  const local=(url:string)=>{const value=new URL(url,settings.publicUrl);return value.pathname+value.search;};
  response=capture(await req('get',local(response.headers.location)));assert.equal(response.status,302);
  const feishuUrl=new URL(response.headers.location),state=feishuUrl.searchParams.get('state');
  assert.ok(state);assert.equal(feishuUrl.hostname,'accounts.feishu.cn');
  assert.equal((await req('get','/feishu/callback?code=code&state=wrong')).status,400);
  response=capture(await req('get',`/feishu/callback?code=code&state=${state}`));assert.equal(response.status,302);
  response=capture(await req('get',local(response.headers.location)));assert.equal(response.status,303);
  response=capture(await req('get',local(response.headers.location)));assert.equal(response.status,303);
  const consentPath=local(response.headers.location);
  response=capture(await req('get',consentPath));assert.equal(response.status,200);
  assert.match(response.headers['content-security-policy'],/form-action 'self' https:\/\/chatgpt\.com;/);
  const csrf=response.text.match(/name="csrf" value="([^"]+)"/)?.[1];assert.ok(csrf);
  assert.equal((await req('post',consentPath).type('form').send({csrf:'wrong',decision:'allow'})).status,400);
  response=capture(await req('post',consentPath).type('form').send({csrf,decision:'allow'}));assert.equal(response.status,303);
  response=capture(await req('get',local(response.headers.location)));assert.equal(response.status,303);
  const finished=new URL(response.headers.location);assert.equal(finished.origin,'https://chatgpt.com');
  const stale=await req('get',consentPath);
  assert.equal(stale.status,400);assert.match(stale.text,/重新连接/);assert.doesNotMatch(stale.text,/UPSTREAM_OR_INTERNAL/);
  assert.equal(finished.searchParams.get('state'),'client-state');const code=finished.searchParams.get('code');assert.ok(code);
  const token=await req('post','/token').type('form').send({grant_type:'authorization_code',code,
    client_id:registered.body.client_id,redirect_uri:callback,code_verifier:verifier,resource:settings.publicUrl+'/mcp'});
  assert.equal(token.status,200,JSON.stringify(token.body));assert.ok(token.body.refresh_token);
  assert.notEqual(token.body.access_token,'upstream-secret');
  const rpc=async(method:string,params:unknown={})=>req('post','/mcp').set('Authorization','Bearer '+token.body.access_token)
    .set('Accept','application/json, text/event-stream').set('MCP-Protocol-Version','2025-03-26').send({jsonrpc:'2.0',id:1,method,params});
  const list=await rpc('tools/list');assert.equal(list.status,200,JSON.stringify(list.body));
  assert.ok(list.body.result.tools.some((t:{name:string})=>t.name==='send_group_message'));
  const createTool=list.body.result.tools.find((t:{name:string})=>t.name==='create_wiki_document');
  assert.equal(createTool.inputSchema.properties.parent_node.type,'string');
  assert.equal(createTool.inputSchema.properties.at_root.type,'boolean');
  const previewTool=list.body.result.tools.find((t:{name:string})=>t.name==='prepare_wiki_document_move');
  assert.equal(previewTool.annotations.readOnlyHint,true);
  const uploadTool=list.body.result.tools.find((t:{name:string})=>t.name==='upload_wiki_attachment');
  assert.equal(uploadTool.inputSchema.properties.at_root.type,'boolean');
  for(const name of ['connect_bitable','list_connected_bitables','list_bitable_items','search_bitable_records','prepare_bitable_change']){
    const t=list.body.result.tools.find((t:{name:string})=>t.name===name);
    assert.equal(t.annotations.readOnlyHint,true);assert.equal(t.inputSchema.additionalProperties,false);
  }
  for(const name of ['create_bitable','apply_bitable_change','upload_bitable_attachment']){
    const t=list.body.result.tools.find((t:{name:string})=>t.name===name);
    assert.equal(t.annotations.readOnlyHint,false);assert.equal(t.inputSchema.additionalProperties,false);
  }
  for(const name of ['move_document_to_wiki','create_wiki_space','add_wiki_member','remove_wiki_member','update_wiki_space_settings','set_wiki_page_person_permission']){
    const t=list.body.result.tools.find((t:{name:string})=>t.name===name);
    assert.equal(t.annotations.readOnlyHint,false);assert.equal(t.inputSchema.additionalProperties,false);
  }
  for(const [name,args] of [
    ['prepare_bitable_change',{base:'base_test',change:{action:'run_script',script:'anything'}}],
    ['prepare_bitable_change',{base:'base_test',change:{action:'delete_records',table_id:'table',record_ids:[]}}],
    ['apply_bitable_change',{preview_id:'5cc59cad-e768-4e46-9d9e-083e0b828379',confirmed:'true',operation_key:'reject-bool'}],
    ['move_document_to_wiki',{preview_id:'5cc59cad-e768-4e46-9d9e-083e0b828379',confirmed:false,operation_key:'reject-unconfirmed'}],
    ['create_wiki_space',{name:'Test',visibility:'public',operation_key:'reject-public'}],
    ['update_wiki_space_settings',{target:'wiki',open_sharing:'open',operation_key:'reject-sharing'}],
    ['add_wiki_member',{target:'wiki',recipient:'invented',role:'editor',operation_key:'reject-editor'}],
    ['set_wiki_page_person_permission',{target:'wiki',node_token:'page',recipient:'person',permission:'full_access',scope:'single_page',operation_key:'reject-full'}],
    ['set_wiki_page_person_permission',{target:'wiki',node_token:'page',recipient:'person',permission:'view',operation_key:'reject-missing-scope'}],
    ['set_wiki_page_person_permission',{target:'wiki',node_token:'page',recipient:'person',permission:'view',scope:'space',operation_key:'reject-space'}]
  ] as const){
    const rejected=await rpc('tools/call',{name,arguments:args});
    assert.ok(rejected.body.error||rejected.body.result?.isError,JSON.stringify(rejected.body));
  }
  assert.ok(!list.body.result.tools.some((t:{name:string})=>t.name.includes('daily')));
  const identity=await rpc('tools/call',{name:'who_am_i',arguments:{}});assert.match(identity.body.result.content[0].text,/Alice/);
  const access=await provider.AccessToken.find(token.body.access_token);assert.ok(access?.grantId);
  store.revokeGrant(access.grantId);assert.equal((await rpc('tools/list')).status,401);
  store.close();
});
