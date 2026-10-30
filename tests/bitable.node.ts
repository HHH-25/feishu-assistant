import test from 'node:test';
import assert from 'node:assert/strict';
import {BridgeStore} from '../src/bridge/store.js';
import {BitableService} from '../src/bridge/bitable.js';
import {FeishuAuth} from '../src/bridge/feishu.js';
import {changeSchema,type BitableChange} from '../src/bridge/bitableSchema.js';
import type {BridgeSettings} from '../src/bridge/settings.js';
type Obj=Record<string,any>;
const config:BridgeSettings={port:3010,host:'127.0.0.1',publicUrl:'https://example.com',dbPath:':memory:',keyPath:'',appId:'test',appSecret:'fixture',tenant:'tenant',users:['ou_a','ou_b'],resourceMode:'user',scopes:'offline_access',wiki:[],chats:[],tables:[],recipients:[]};
const clone=<T>(v:T):T=>JSON.parse(JSON.stringify(v));
function fixture(){
  const store=new BridgeStore(':memory:');
  for(const sub of ['a','b'])store.put('feishu',sub,{person:{sub,openId:'ou_'+sub,tenant:'tenant',name:sub},access:'token_'+sub,expires:Date.now()+3600000});
  const s={app:{app_token:'appOne',name:'Test base',is_advanced:true,advance_version:'v2'},tables:[{table_id:'tblOne',name:'Customers',revision:1},{table_id:'tblTwo',name:'Related',revision:1}],
    fields:[{field_id:'fldName',field_name:'Name',type:1,is_primary:true},{field_id:'fldNumber',field_name:'Count',type:2},
      {field_id:'fldSelect',field_name:'Status',type:3,property:{options:[{name:'Open',id:'optOpen'}]}},
      {field_id:'fldPerson',field_name:'Owner',type:11},{field_id:'fldLink',field_name:'Related',type:18,property:{table_id:'tblTwo'}},
      {field_id:'fldFile',field_name:'Files',type:17},{field_id:'fldCalc',field_name:'Formula',type:20}],
    records:[{record_id:'recOne',fields:{Name:'Alice',Count:1,Status:'Open',Files:[{file_token:'fileOld'}]},last_modified_time:1},{record_id:'recTwo',fields:{Name:'Bob',Count:2},last_modified_time:1}] as Obj[],
    views:[{view_id:'vewOne',view_name:'Grid',view_type:'grid',property:{hidden_fields:[]}}] as Obj[],
    roles:[] as Obj[],members:[] as Obj[],dashboards:[{block_id:'blkOne',name:'Dashboard'}],workflows:[{workflow_id:'wfOne',title:'Send notification',status:'Disable'}],
    writes:[] as {method:string;path:string;body:any}[],calls:[] as string[],mode:'ok',downloads:0,bytes:Buffer.from('attachment fixture'),
    delay:undefined as undefined|(()=>Promise<void>),serial:10};
  const ok=(data:unknown)=>new Response(JSON.stringify({code:0,data}));
  const page=(items:Obj[],key='items')=>({[key]:items,has_more:false});
  const auth=new FeishuAuth(config,store,async(input,init)=>{
    assert.equal((init?.headers as Obj).authorization,'Bearer token_a');
    const url=new URL(String(input)),p=url.pathname.replace('/open-apis',''),method=init?.method??'GET';
    const b=typeof init?.body==='string'?JSON.parse(init.body):undefined;s.calls.push(method+' '+p);
    const writing=method!=='GET'&&!p.endsWith('/batch_get')&&!p.endsWith('/search');
    if(s.mode==='denied'||(s.mode==='write-denied'&&writing))return new Response(JSON.stringify({code:1254302}),{status:403});
    if(writing){s.writes.push({method,path:p,body:clone(b??{})});if(s.delay)await s.delay();}
    if(p==='/wiki/v2/spaces/get_node')return ok({node:{node_token:'wikiOne',obj_token:'appOne',obj_type:s.mode==='wrong-wiki-type'?'docx':'bitable',node_type:'origin'}});
    if(p==='/drive/v1/medias/upload_all'){
      assert.ok(init?.body instanceof FormData);assert.equal(init.body.get('parent_type'),'bitable_file');assert.equal(init.body.get('parent_node'),'appOne');
      assert.deepEqual(Buffer.from(await (init.body.get('file') as Blob).arrayBuffer()),s.bytes);return ok({file_token:'mediaNew'});
    }
    if(p==='/bitable/v1/apps'&&method==='POST'){s.app.name=b.name;return ok({app:{...s.app,url:'https://test.feishu.cn/base/appOne',default_table_id:'tblOne'}});}
    if(p==='/bitable/v1/apps/appOne'){
      if(method==='PUT'){Object.assign(s.app,b);if(s.mode==='stale-read')s.app.name='Not updated';}
      return ok({app:{...s.app,app_token:s.mode==='wrong-app'?'appOther':'appOne'}});
    }
    if(p==='/bitable/v1/apps/appOne/tables'){
      if(method==='POST'){const table={table_id:'tbl'+(++s.serial),name:b.table.name,revision:1};s.tables.push(table);return ok({table_id:table.table_id});}
      if(s.mode==='bad-page')return ok({items:s.tables,has_more:true});
      if(s.mode==='repeat-page')return ok({items:[],has_more:true,page_token:'same'});
      return ok(page(s.tables));
    }
    const table=/^\/bitable\/v1\/apps\/appOne\/tables\/(tbl\w+)(.*)$/.exec(p);
    if(table){const [,tid,rest]=table;
      assert.ok(s.tables.some(t=>t.table_id===tid),'request must target known table');
      if(rest===''){
        if(method==='PATCH'){s.tables.find(t=>t.table_id===tid)!.name=b.name;return ok({name:b.name});}
        if(method==='DELETE'){s.tables=s.tables.filter(t=>t.table_id!==tid);return ok({});}
      }
      if(rest==='/fields'){
        if(method==='POST'){const field={field_id:'fld'+(++s.serial),...b};s.fields.push(field);return ok({field});}
        return ok(page(s.fields));
      }
      if(rest.startsWith('/fields/')){
        const fid=rest.split('/')[2];
        if(method==='DELETE'){s.fields=s.fields.filter(f=>f.field_id!==fid);return ok({field_id:fid,deleted:true});}
        if(method==='PUT'){const field={field_id:fid,...b};s.fields=s.fields.map(f=>f.field_id===fid?field:f);return ok({field});}
      }
      if(rest==='/records/search'){
        assert.equal(url.searchParams.get('user_id_type'),'open_id');
        if(s.mode==='paged')return ok(url.searchParams.has('page_token')?{items:[s.records[1]],has_more:false}:{items:[s.records[0]],has_more:true,page_token:'page2'});
        return ok({...page(s.records),total:s.records.length});
      }
      if(rest==='/records/batch_get'){
        assert.equal(b.user_id_type,'open_id');
        const records=b.record_ids.flatMap((id:string)=>s.records.filter(r=>r.record_id===id));
        return ok({records,absent_record_ids:b.record_ids.filter((id:string)=>!records.some((r:Obj)=>r.record_id===id)),forbidden_record_ids:s.mode==='record-forbidden'?[b.record_ids[0]]:[]});
      }
      if(rest==='/records/batch_create'){
        const records=b.records.map((r:Obj)=>({...r,record_id:'rec'+(++s.serial),last_modified_time:1}));s.records.push(...records);
        return ok({records:s.mode==='partial-ack'?records.slice(1):records});
      }
      if(rest==='/records/batch_update'){
        for(const wanted of b.records){const rec=s.records.find(r=>r.record_id===wanted.record_id)!;Object.assign(rec.fields,wanted.fields);rec.last_modified_time++;}
        const records=b.records.map((r:Obj)=>s.records.find(x=>x.record_id===r.record_id));
        if(s.mode==='stale-record')records[0].fields.Count=999;
        return ok({records:s.mode==='wrong-record-ack'?[{...records[0],record_id:'foreign'}]:records});
      }
      if(rest==='/records/batch_delete'){
        s.records=s.records.filter(r=>!b.records.includes(r.record_id));return ok({records:b.records.map((record_id:string)=>({record_id,deleted:s.mode!=='false-delete'}))});
      }
      if(rest==='/views'){
        if(method==='POST'){const view={view_id:'vew'+(++s.serial),...b};s.views.push(view);return ok({view});}
        return ok(page(s.views));
      }
      if(rest.startsWith('/views/')){
        const vid=rest.split('/')[2],view=s.views.find(v=>v.view_id===vid);
        if(method==='DELETE'){s.views=s.views.filter(v=>v.view_id!==vid);return ok({});}
        if(method==='PATCH')Object.assign(view!,b);return ok({view});
      }
    }
    if(p==='/base/v2/apps/appOne/roles'){
      if(method==='POST'){const role={role_id:'rol'+(++s.serial),...b};s.roles.push(role);return ok({role});}return ok(page(s.mode==='reordered-roles'?s.roles.map(r=>({...r,table_roles:[...r.table_roles].reverse()})):s.roles));
    }
    if(p.startsWith('/base/v2/apps/appOne/roles/')){
      const rid=p.split('/').at(-1),role={role_id:rid,...b};s.roles=s.roles.map(r=>r.role_id===rid?role:r);return ok({role});
    }
    const members=/^\/bitable\/v1\/apps\/appOne\/roles\/(\w+)\/members(?:\/(\w+))?$/.exec(p);
    if(members){
      if(method==='POST'){assert.equal(url.searchParams.get('member_id_type'),'open_id');s.members.push({member_type:'user',open_id:b.member_id,member_name:'Coworker'});return ok({});}
      if(method==='DELETE'){s.members=s.members.filter(m=>m.open_id!==members[2]);return ok({});}
      return ok(page(s.members));
    }
    if(p.startsWith('/bitable/v1/apps/appOne/roles/')&&method==='DELETE'){s.roles=s.roles.filter(r=>r.role_id!==p.split('/').at(-1));return ok({});}
    if(p==='/bitable/v1/apps/appOne/dashboards')return ok(page(s.dashboards,'dashboards'));
    if(p.endsWith('/dashboards/blkOne/copy')){const d={block_id:'blk'+(++s.serial),name:b.name};s.dashboards.push(d);return ok(d);}
    if(p==='/bitable/v1/apps/appOne/workflows')return ok({workflows:s.workflows});
    if(p.endsWith('/workflows/wfOne')){s.workflows[0].status=b.status;return ok({});}
    throw Error('Unexpected API '+method+' '+p);
  });
  const recipient=async(ref:string)=>{if(ref!=='person_verified')throw Error('Unverified person');return {open_id:'ou_coworker',name:'Coworker'};};
  const downloader=async()=>{s.downloads++;return s.bytes;};
  return {s,store,a:new BitableService(auth.user('a'),store,'a',recipient,downloader),b:new BitableService(auth.user('b'),store,'b',recipient,downloader)};
}
async function connected(f:ReturnType<typeof fixture>){return (await f.a.connect('https://test.feishu.cn/base/appOne?table=tblOne')).base;}
async function change(f:ReturnType<typeof fixture>,base:string,c:BitableChange){
  const p=await f.a.prepare(base,c);const result=await f.a.apply({preview_id:p.preview_id,confirmed:p.requires_confirmation?true:undefined,operation_key:'operation-'+f.s.serial+'-'+f.s.writes.length});
  assert.equal(result.status,'success',JSON.stringify(result));return result.result as Obj;
}
const role=()=>({role_name:'Technical editors',table_roles:[{table_id:'tblOne',table_perm:2 as const,field_perm:{Name:3 as const,Count:1 as const},allow_add_record:true,allow_delete_record:false,view_perm:1 as const}],block_roles:[],base_rule:{base_complex_edit:0 as const,copy:1 as const}});

test('base links and wiki links resolve with current employee; unknown URLs, changed identity and foreign references fail closed',async()=>{
  const f=fixture(),base=await connected(f);assert.equal(f.a.catalog().length,1);assert.equal(f.b.catalog().length,0);
  await assert.rejects(f.b.list({base,kind:'tables'}),/本人/);
  for(const url of ['https://evil.test/base/appOne','http://test.feishu.cn/base/appOne','https://test.feishu.cn/drive/folder/folder','https://test.feishu.cn/base/appOne?table=foreign','https://test.feishu.cn/base/appOne?table=..%2Fetc'])await assert.rejects(f.a.connect(url));
  const wiki=await f.a.connect('https://test.feishu.cn/wiki/wikiOne');assert.ok(wiki.base);
  await assert.rejects(f.a.prepare(wiki.base,{action:'set_advanced',enabled:true}),/知识库/);
  f.s.mode='wrong-wiki-type';await assert.rejects(f.a.list({base:wiki.base,kind:'tables'}));f.s.mode='wrong-app';await assert.rejects(f.a.list({base,kind:'tables'}));
  f.s.mode='denied';await assert.rejects(f.a.list({base,kind:'tables'}));assert.equal(f.s.writes.length,0);f.store.close();
});

test('schema discovery and filtered queries validate fields and bind pagination to employee, exact query and next cursor',async()=>{
  const f=fixture(),base=await connected(f);
  for(const kind of ['tables','fields','views','roles','dashboards','workflows'] as const){const p=await f.a.list({base,kind,table_id:'tblOne'});assert.equal(p.complete,true);}
  const input={base,table_id:'tblOne',filter:{conjunction:'and' as const,conditions:[{field_name:'Count',operator:'isGreater' as const,value:['0']}]},sort:[{field_name:'Count',desc:true}]};
  assert.equal((await f.a.search(input)).scope,'table');
  await assert.rejects(f.a.search({...input,view_id:'vewOne'}),/忽略/);
  await assert.rejects(f.a.search({...input,field_names:['Missing']}),/字段/);
  f.s.mode='paged';const first=await f.a.search(input);assert.equal(first.next,'page2');
  await assert.rejects(f.a.search({...input,cursor:'page2'}),/query_ref/);
  await assert.rejects(f.b.search({...input,query_ref:first.query_ref,cursor:'page2'}),/当前员工/);
  await assert.rejects(f.a.search({...input,sort:[],query_ref:first.query_ref,cursor:'page2'}),/条件改变/);
  const second=await f.a.search({...input,query_ref:first.query_ref,cursor:'page2'});assert.equal(second.complete,true);assert.equal(second.items[0].record_id,'recTwo');
  f.s.mode='bad-page';await assert.rejects(f.a.list({base,kind:'tables'}),/分页/);
  f.s.mode='repeat-page';await assert.rejects(f.a.prepare(base,{action:'create_table',name:'Any'}),/分页/);
  assert.equal(f.s.writes.length,0);f.store.close();
});

test('create base and table CRUD use verified acknowledgements and readback; deleting a table requires concrete confirmation',async()=>{
  const f=fixture();const created=await f.a.create({name:'Created',operation_key:'create-base'});assert.equal(created.status,'success');
  const base=(created.result as Obj).base;
  assert.equal((await f.a.create({name:'Created',operation_key:'create-base'})).operation_id,created.operation_id);assert.equal(f.s.writes.length,1);
  await assert.rejects(f.a.create({name:'Changed',operation_key:'create-base'}),/操作编号/);
  await change(f,base,{action:'rename_base',name:'Renamed'});
  const table=await change(f,base,{action:'create_table',name:'New table'});assert.ok(table.table_id);
  await change(f,base,{action:'rename_table',table_id:table.table_id,name:'Renamed table'});
  const p=await f.a.prepare(base,{action:'delete_table',table_id:table.table_id});assert.equal(p.requires_confirmation,true);
  await assert.rejects(f.a.apply({preview_id:p.preview_id,operation_key:'delete-table'}),/确认/);
  assert.equal((await f.a.apply({preview_id:p.preview_id,confirmed:true,operation_key:'delete-table'})).status,'success');
  f.store.close();
});

test('fields and all supported view types can be created, changed and deleted; rejects foreign fields and unsupported expressions',async()=>{
  const f=fixture(),base=await connected(f);
  const field=await change(f,base,{action:'create_field',table_id:'tblOne',field:{field_name:'Check',type:7}});
  await change(f,base,{action:'update_field',table_id:'tblOne',field_id:field.field_id,field:{field_name:'Checked',type:7}});
  await assert.rejects(f.a.prepare(base,{action:'delete_field',table_id:'tblOne',field_id:'fldName'}),/索引/);
  await change(f,base,{action:'delete_field',table_id:'tblOne',field_id:field.field_id});
  for(const view_type of ['grid','kanban','gallery','gantt','form'] as const){
    const view=await change(f,base,{action:'create_view',table_id:'tblOne',view_name:view_type,view_type});
    await change(f,base,{action:'update_view',table_id:'tblOne',view_id:view.view_id,view_name:'Changed '+view_type,property:{hidden_fields:['fldNumber'],filter_info:{conjunction:'and',conditions:[{field_id:'fldNumber',operator:'isGreater',value:'["0"]'}]}}});
    await change(f,base,{action:'delete_view',table_id:'tblOne',view_id:view.view_id});
  }
  await assert.rejects(f.a.prepare(base,{action:'update_view',table_id:'tblOne',view_id:'vewOne',property:{hidden_fields:['foreign']}}));
  assert.equal(changeSchema.safeParse({action:'create_field',table_id:'tblOne',field:{field_name:'Formula',type:20,property:{formula_expression:'1+1'}}}).success,false);
  f.store.close();
});

test('batch records validate field types, known options, computed fields and linked records; update preserves unspecified values',async()=>{
  const f=fixture(),base=await connected(f);
  for(const fields of [{Missing:'x'},{Count:'not number'},{Formula:1},{Status:'Implicit new option'},{Owner:[{id:'user_id_wrong'}]},{Related:['nonexistent']},{Files:[{url:'https://evil'}]}])
    await assert.rejects(f.a.prepare(base,{action:'create_records',table_id:'tblOne',records:[{fields}]}));
  assert.equal(f.s.writes.length,0);
  const created=await change(f,base,{action:'create_records',table_id:'tblOne',records:[{fields:{Name:'Carol',Count:3,Status:'Open',Owner:[{id:'ou_coworker'}],Related:['recOne'],Files:[{file_token:'fileOne'}]}},{fields:{Name:'D'}}]});
  assert.equal(created.count,2);
  await change(f,base,{action:'update_records',table_id:'tblOne',records:[{record_id:'recOne',fields:{Count:5}},{record_id:'recTwo',fields:{Count:6}}]});
  assert.equal(f.s.records.find(r=>r.record_id==='recOne')!.fields.Name,'Alice');
  const deleted=await change(f,base,{action:'delete_records',table_id:'tblOne',record_ids:created.record_ids});assert.equal(deleted.count,2);
  await assert.rejects(f.a.prepare(base,{action:'delete_records',table_id:'tblOne',record_ids:['recOne','recOne']}),/重复/);
  f.store.close();
});

test('advanced roles use v2 permission values, verified same-company member handles and explicit workflow state confirmation',async()=>{
  const f=fixture(),base=await connected(f);
  await change(f,base,{action:'set_advanced',enabled:false});await assert.rejects(f.a.prepare(base,{action:'create_role',role:role()}),/开启/);
  await change(f,base,{action:'set_advanced',enabled:true});
  const created=await change(f,base,{action:'create_role',role:role()});
  assert.equal(f.s.writes.at(-1)?.path,'/base/v2/apps/appOne/roles');assert.equal(f.s.writes.at(-1)?.body.table_roles[0].field_perm.Name,3);
  await change(f,base,{action:'update_role',role_id:created.role_id,role:{...role(),role_name:'Updated role'}});
  await assert.rejects(f.a.prepare(base,{action:'add_role_member',role_id:created.role_id,recipient:'invented'}),/Unverified/);
  await change(f,base,{action:'add_role_member',role_id:created.role_id,recipient:'person_verified'});
  assert.equal((await f.a.list({base,kind:'role_members',role_id:created.role_id})).items.length,1);
  await change(f,base,{action:'remove_role_member',role_id:created.role_id,recipient:'person_verified'});
  await change(f,base,{action:'delete_role',role_id:created.role_id});
  const dashboard=await change(f,base,{action:'copy_dashboard',block_id:'blkOne',name:'Copied'});assert.notEqual(dashboard.block_id,'blkOne');
  const p=await f.a.prepare(base,{action:'set_workflow',workflow_id:'wfOne',status:'Enable'});assert.equal(p.requires_confirmation,true);assert.match(p.notice,/消息/);
  await assert.rejects(f.a.apply({preview_id:p.preview_id,operation_key:'workflow'}),/确认/);
  assert.equal((await f.a.apply({preview_id:p.preview_id,confirmed:true,operation_key:'workflow'})).status,'success');
  await change(f,base,{action:'set_workflow',workflow_id:'wfOne',status:'Disable'});f.store.close();
});

test('role readback tolerates reordered tables but rejects foreign field actions and unsupported advanced versions',async()=>{
  const f=fixture(),base=await connected(f),r=role();
  r.table_roles.push({...r.table_roles[0],table_id:'tblTwo'});f.s.mode='reordered-roles';
  await change(f,base,{action:'create_role',role:r});
  await assert.rejects(f.a.prepare(base,{action:'create_role',role:{...role(),table_roles:[{...role().table_roles[0],field_action_rules:{attachment_export:{Missing:0}}}]}}),/不存在/);
  f.s.app.advance_version='v1';
  await assert.rejects(f.a.prepare(base,{action:'create_role',role:{...role(),table_roles:[{...role().table_roles[0],field_action_rules:{attachment_export:{Files:0}}}]}}),/v2/);
  f.store.close();
});

test('preview is employee-bound, expires, detects stale content and cannot be replayed under another operation key',async()=>{
  const f=fixture(),base=await connected(f),c:BitableChange={action:'update_records',table_id:'tblOne',records:[{record_id:'recOne',fields:{Count:7}}]};
  const p=await f.a.prepare(base,c);await assert.rejects(f.b.apply({preview_id:p.preview_id,operation_key:'foreign'}),/当前员工/);
  f.s.records[0].fields.Count=8;await assert.rejects(f.a.apply({preview_id:p.preview_id,operation_key:'stale'}),/变化/);assert.equal(f.s.writes.length,0);
  f.store.delete('bitable_preview',p.preview_id);await assert.rejects(f.a.apply({preview_id:p.preview_id,operation_key:'expired'}),/过期/);
  const fresh=await f.a.prepare(base,c),input={preview_id:fresh.preview_id,operation_key:'first-operation'};
  const receipt=await f.a.apply(input);assert.equal(receipt.status,'success');
  assert.deepEqual(await f.a.apply(input),receipt);assert.equal(f.s.writes.length,1);
  await assert.rejects(f.a.apply({...input,operation_key:'reuse'}),/变化/);
  await assert.rejects(f.b.status(receipt.operation_id),/本人/);f.store.close();
});

test('uncertain or partial batches keep durable receipts, do not retry writes, and only reconcile successful readback',async()=>{
  for(const mode of ['write-denied','partial-ack','wrong-record-ack','stale-record']){
    const f=fixture(),base=await connected(f);
    const c:BitableChange=mode==='partial-ack'?{action:'create_records',table_id:'tblOne',records:[{fields:{Name:'First'}},{fields:{Name:'Second'}}]}:{action:'update_records',table_id:'tblOne',records:[{record_id:'recOne',fields:{Count:10}}]};
    const p=await f.a.prepare(base,c),input={preview_id:p.preview_id,operation_key:'uncertain-'+mode};f.s.mode=mode;
    const receipt=await f.a.apply(input);assert.equal(receipt.status,'uncertain');
    assert.deepEqual(await f.a.apply(input),receipt);const writes=f.s.writes.length;
    if(mode==='stale-record'){
      await assert.rejects(f.a.status(receipt.operation_id));f.s.mode='ok';f.s.records[0].fields.Count=10;
      assert.equal((await f.a.status(receipt.operation_id)).status,'success');
    }else if(mode!=='write-denied')await assert.rejects(f.a.status(receipt.operation_id));
    assert.equal(f.s.writes.length,writes);f.store.close();
  }
});

test('attachments upload original bytes using employee identity once, and adding token preserves prior attachments when supplied',async()=>{
  const f=fixture(),base=await connected(f),input={base,table_id:'tblOne',file_name:'report.pdf',file:{download_url:'https://files.test/report',file_id:'file1'},operation_key:'media-upload'};
  const receipt=await f.a.upload(input);assert.equal(receipt.status,'success');assert.equal((receipt.result as Obj).attached_to_record,false);
  assert.deepEqual(await f.a.upload({...input,file:{...input.file,download_url:'https://expired.test'}}),receipt);assert.equal(f.s.downloads,1);
  await change(f,base,{action:'update_records',table_id:'tblOne',records:[{record_id:'recOne',fields:{Files:[{file_token:'fileOld'},{file_token:(receipt.result as Obj).file_token}]}}]});
  assert.equal(f.s.records[0].fields.Files.length,2);
  f.s.bytes=Buffer.alloc(20*1024*1024+1);await assert.rejects(f.a.upload({...input,operation_key:'oversize'}),/20MiB/);
  await assert.rejects(f.a.upload({...input,file_name:'../secret'}),/名称/);f.store.close();
});

test('writes to the same base are serialized; forbidden reads cause no write and schema limits reject oversized batches',async()=>{
  const f=fixture(),base=await connected(f),p=await f.a.prepare(base,{action:'create_table',name:'A'}),q=await f.a.prepare(base,{action:'create_table',name:'B'});
  let release!:()=>void;const held=new Promise<void>(r=>release=r);let entered!:()=>void;const started=new Promise<void>(r=>entered=r);
  f.s.delay=async()=>{entered();await held;};const first=f.a.apply({preview_id:p.preview_id,operation_key:'concurrent-first'});await started;
  await assert.rejects(f.a.apply({preview_id:q.preview_id,operation_key:'concurrent-second'}),/正在执行/);release();assert.equal((await first).status,'success');
  assert.equal(changeSchema.safeParse({action:'create_records',table_id:'tblOne',records:Array.from({length:101},()=>({fields:{Name:'A'}}))}).success,false);
  f.s.mode='record-forbidden';await assert.rejects(f.a.prepare(base,{action:'delete_records',table_id:'tblOne',record_ids:['recOne']}),/无权/);
  assert.equal(f.s.writes.length,1);f.store.close();
});
