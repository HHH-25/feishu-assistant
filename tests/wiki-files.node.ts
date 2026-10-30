import test from 'node:test';
import assert from 'node:assert/strict';
import {BridgeStore} from '../src/bridge/store.js';
import {BridgeService} from '../src/bridge/service.js';
import {FeishuAuth} from '../src/bridge/feishu.js';
import {FeishuWikiClient} from '../src/clients/wiki.js';
import type {BridgeSettings} from '../src/bridge/settings.js';

const settings:BridgeSettings={port:3010,host:'127.0.0.1',publicUrl:'https://example.com',dbPath:':memory:',keyPath:'',
  appId:'test',appSecret:'fixture',tenant:'tenant',users:['ou_a','ou_b'],resourceMode:'user',scopes:'offline_access',wiki:[],chats:[],tables:[],recipients:[]};
const response=(data:unknown)=>new Response(JSON.stringify({code:0,data}));
function fixture(config=settings){
  const store=new BridgeStore(':memory:');
  for(const sub of ['a','b'])store.put('feishu',sub,{person:{sub,openId:'ou_'+sub,tenant:'tenant',name:sub},access:'token_'+sub,expires:Date.now()+3600000});
  const state={mode:'ok',downloads:0,uploads:0,moves:[] as any[],roots:0,title:'Source',taskStatus:1,bytes:Buffer.from('original bytes'),parent:'',source:'source',type:'docx'};
  const auth=new FeishuAuth(config,store,async(input,init)=>{
    assert.equal((init?.headers as Record<string,string>).authorization,'Bearer token_a');
    const url=new URL(String(input)),body=typeof init?.body==='string'?JSON.parse(init.body):undefined;
    if(url.pathname.endsWith('/metas/batch_query')){
      if(state.mode==='metadata-denied')return new Response(JSON.stringify({code:1770032}),{status:403});
      const doc=body.request_docs[0];state.source=doc.doc_token;state.type=doc.doc_type;
      return response({metas:[{...doc,title:state.title,url:state.mode==='already-wiki'?'https://test.feishu.cn/wiki/old':'https://test.feishu.cn/docx/source'}]});
    }
    if(url.pathname.endsWith('/root_folder/meta')){
      state.roots++;
      if(state.mode==='root-denied')return new Response(JSON.stringify({code:1770032}),{status:403});
      return response({token:'employee_root'});
    }
    if(url.pathname.endsWith('/upload_all')){
      state.uploads++;assert.ok(init?.body instanceof FormData);
      assert.equal(init.body.get('parent_type'),'explorer');
      assert.equal(init.body.get('parent_node'),config.wiki[0]?.staging_folder_token??'employee_root');
      assert.equal(init.body.get('size'),String(state.bytes.length));
      assert.deepEqual(Buffer.from(await (init.body.get('file') as Blob).arrayBuffer()),state.bytes);
      state.source='uploaded';state.type='file';return response({file_token:'uploaded'});
    }
    if(url.pathname.endsWith('/move_docs_to_wiki')){
      state.moves.push(body);state.parent=body.parent_wiki_token??'';
      if(state.mode==='move-denied')return new Response(JSON.stringify({code:131006}),{status:403});
      return response(state.mode==='async'?{task_id:'task'}:{wiki_token:'destination'});
    }
    if(url.pathname.includes('/tasks/'))return response({task:{move_result:[{status:state.taskStatus,node:{node_token:'destination'}}]}});
    if(url.pathname.endsWith('/get_node')){
      const parent=url.searchParams.get('token')==='parent';
      return response({node:{node_token:parent?'parent':'destination',obj_token:parent?'parentdoc':state.mode==='wrong-source'?'elsewhere':state.source,
        obj_type:parent?'docx':state.mode==='wrong-type'?'sheet':state.type,space_id:state.mode==='wrong-space'?'other':'space',node_type:'origin',title:'Page',
        parent_node_token:state.mode==='wrong-parent'?'other':state.parent}});
    }
    assert.equal(url.pathname,'/open-apis/wiki/v2/spaces/space');
    return response({space:{space_id:'space',name:'Knowledge'}});
  });
  const download=async()=>{state.downloads++;return state.bytes;};
  return {store,state,a:new BridgeService(config,auth,store,'a',download),b:new BridgeService(config,auth,store,'b',download)};
}
const upload={target:'wiki_space',at_root:true,file_name:'test.pdf',file:{download_url:'https://files.example.test/fixture',file_id:'file'},operation_key:'upload-test'};
const source={target:'wiki_space',at_root:true,source_url:'https://test.feishu.cn/docx/source'};

test('uploads all four original formats into a discovered wiki using employee root; retries do not download/upload twice',async()=>{
  const {a,store,state}=fixture();
  for(const ext of ['pdf','docx','xlsx','txt']){
    const input={...upload,file_name:'test.'+ext,operation_key:ext};
    const receipt=await a.uploadWiki(input);assert.equal(receipt.status,'success');
    assert.equal((receipt.result as any).obj_type,'file');assert.equal((receipt.result as any).at_root,true);
    assert.deepEqual(state.moves.at(-1),{obj_type:'file',obj_token:'uploaded',apply:false});
    assert.deepEqual(await a.uploadWiki({...input,file:{...input.file,download_url:'https://expired.test'}}),receipt);
  }
  assert.equal(state.downloads,4);assert.equal(state.uploads,4);assert.equal(state.moves.length,4);
  await assert.rejects(a.uploadWiki({...upload,operation_key:'pdf',at_root:false,parent_node:'parent'}),/操作编号/);
  store.close();
});

test('upload requires a destination, supports explicit parent and configured staging, rejects empty or oversized data',async()=>{
  const {a,store,state}=fixture();
  await assert.rejects(a.uploadWiki({...upload,at_root:undefined}),/选择/);
  await assert.rejects(a.uploadWiki({...upload,parent_node:'parent'}),/不能同时/);
  await assert.rejects(a.uploadWiki({...upload,file_name:'../test.pdf'}));
  await assert.rejects(a.uploadWiki({...upload,file_name:'test.exe'}));
  state.mode='root-denied';await assert.rejects(a.uploadWiki(upload));assert.equal(state.downloads,0);
  state.mode='ok';
  for(const bytes of [Buffer.alloc(0),Buffer.alloc(20*1024*1024+1)]){state.bytes=bytes;await assert.rejects(a.uploadWiki(upload),/20 MiB/);}
  assert.equal(state.uploads,0);state.bytes=Buffer.from('file');
  assert.equal((await a.uploadWiki({...upload,at_root:undefined,parent_node:'parent'})).status,'success');
  assert.equal(state.moves[0].parent_wiki_token,'parent');store.close();
  const configured=fixture({...settings,wiki:[{id:'fixed',name:'fixed',space_id:'space',parent_node_token:'parent',url_origin:'https://test.feishu.cn',staging_folder_token:'staging'}]});
  assert.equal((await configured.a.uploadWiki({...upload,target:'fixed',at_root:undefined})).status,'success');
  assert.equal(configured.state.roots,0);configured.store.close();
});

test('upload partial failures preserve uploaded file and never repeat writes; mismatched destination is not success',async()=>{
  for(const mode of ['move-denied','wrong-parent','wrong-source','wrong-type']){
    const {a,store,state}=fixture();state.mode=mode;
    const receipt=await a.uploadWiki(upload);assert.equal(receipt.status,'uncertain');
    assert.equal((receipt.result as any).file_token,'uploaded');
    assert.equal((receipt.result as any).stage,mode==='move-denied'?'uploaded':'moving');
    assert.deepEqual(await a.uploadWiki(upload),receipt);assert.equal(state.uploads,1);assert.equal(state.moves.length,1);
    if(mode!=='move-denied')await assert.rejects(a.status(receipt.operation_id));
    store.close();
  }
});

test('existing cloud document preview is read-only, owner-bound and must be confirmed; validates source and location',async()=>{
  const {a,b,store,state}=fixture();
  for(const url of ['https://evil.test/docx/source','https://test.feishu.cn/wiki/source','https://test.feishu.cn/drive/folder/source','http://test.feishu.cn/docx/source'])
    await assert.rejects(a.prepareWikiMove({...source,source_url:url}));
  state.mode='metadata-denied';await assert.rejects(a.prepareWikiMove(source));
  state.mode='already-wiki';await assert.rejects(a.prepareWikiMove(source));state.mode='ok';
  const preview=await a.prepareWikiMove({...source,at_root:undefined,parent_node:'parent'});
  assert.equal(preview.source_title,'Source');assert.match(preview.notice,/继承/);assert.equal(state.moves.length,0);
  const input={preview_id:preview.preview_id,confirmed:true,operation_key:'move-key'};
  await assert.rejects(b.moveExistingWiki(input),/不属于/);
  await assert.rejects(a.moveExistingWiki({...input,confirmed:false}),/确认/);
  state.title='Renamed';await assert.rejects(a.moveExistingWiki(input),/变化/);assert.equal(state.moves.length,0);state.title='Source';
  const receipt=await a.moveExistingWiki(input);assert.equal(receipt.status,'success');
  assert.deepEqual(state.moves[0],{obj_type:'docx',obj_token:'source',parent_wiki_token:'parent',apply:false});
  store.delete('wiki_move_preview',preview.preview_id);
  assert.deepEqual(await a.moveExistingWiki(input),receipt);
  await assert.rejects(a.moveExistingWiki({...input,operation_key:'expired'}),/过期/);
  assert.equal(state.moves.length,1);store.close();
});

test('existing document types are preserved; denied moves cannot be repeated by reusing preview with another operation key',async()=>{
  const {a,store,state}=fixture();
  for(const [path,type] of Object.entries({docs:'doc',docx:'docx',sheets:'sheet',base:'bitable',mindnotes:'mindnote',file:'file',slides:'slides'})){
    const preview=await a.prepareWikiMove({...source,source_url:`https://test.feishu.cn/${path}/source?ignored=1`});
    const result=await a.moveExistingWiki({preview_id:preview.preview_id,confirmed:true,operation_key:path});
    assert.equal(result.status,'success');assert.equal(state.moves.at(-1).obj_type,type);
  }
  state.mode='move-denied';const preview=await a.prepareWikiMove(source);
  const input={preview_id:preview.preview_id,confirmed:true,operation_key:'denied'};
  const receipt=await a.moveExistingWiki(input);assert.equal(receipt.status,'uncertain');
  assert.equal((receipt.result as any).stage,'move_requested');
  assert.deepEqual(await a.moveExistingWiki(input),receipt);
  assert.equal((await a.moveExistingWiki({...input,operation_key:'new-key'})).status,'uncertain');
  assert.equal(state.moves.length,8);store.close();
});

test('upload and existing-document async receipts poll only own persisted task and verify exact destination before completion',async()=>{
  for(const kind of ['upload','move']){
    const {a,b,store,state}=fixture();state.mode='async';
    const preview=kind==='move'?await a.prepareWikiMove(source):undefined;
    const receipt=kind==='upload'?await a.uploadWiki(upload):await a.moveExistingWiki({preview_id:preview!.preview_id,confirmed:true,operation_key:'async'});
    assert.equal(receipt.status,'uncertain');await assert.rejects(b.status(receipt.operation_id),/本人/);
    assert.equal((await a.status(receipt.operation_id)).status,'uncertain');
    state.taskStatus=-1;await assert.rejects(a.status(receipt.operation_id),/任务失败/);
    state.taskStatus=0;state.mode='wrong-parent';await assert.rejects(a.status(receipt.operation_id),/不匹配/);
    state.mode='ok';const complete=await a.status(receipt.operation_id);assert.equal(complete.status,'success');assert.equal(complete.error,undefined);
    assert.equal(state.moves.length,1);assert.equal(state.uploads,kind==='upload'?1:0);store.close();
  }
});

test('wiki move task rejects ambiguous, missing and invalid responses',async()=>{
  for(const data of [{},{task:{move_result:[]}},{task:{move_result:[{status:0},{status:0}]}},{task:{move_result:[{status:0}]}},{task:{move_result:[{status:99}]}}]){
    const client=new FeishuWikiClient(async()=>data);await assert.rejects(client.task('task'));
  }
  for(const data of [{},{applied:true,task_id:'task'},{wiki_token:'node',task_id:4},{wiki_token:'bad/id',task_id:'task'}]){
    const client=new FeishuWikiClient(async()=>data);await assert.rejects(client.move('space','','source','docx'));
  }
});
