import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';

const bash=process.platform==='win32'?'E:/Git/Git/bin/bash.exe':'/bin/bash';
const posix=p=>p.replace(/\\/g,'/').replace(/^([A-Za-z]):/,(_,drive)=>'/'+drive.toLowerCase());
function write(root,file,content){const p=path.join(root,file);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,content);return p;}

// Isolated service/health/module-load stubs inject installation failures. No real service or credentials used.
for(const variant of ['wiki-bitable','identity-organization']){
const identity=variant==='identity-organization';
const files=identity?['dist/src/bridge/feishu.js','dist/src/bridge/service.js','dist/src/bridge/tools.js']:
  ['dist/src/bridge/service.js','dist/src/bridge/tools.js','dist/src/bridge/operations.js','dist/src/clients/wiki.js','dist/src/bridge/bitable.js','dist/src/bridge/bitableSchema.js'];
const source=fs.readFileSync('deploy/install-'+variant+'.sh','utf8');
const backupPrefix=identity?'feishu-identity':'feishu-wikibitable';
for(const mode of ['success','health-fail','load-fail','checksum-fail','upgrade-rollback'])test('installer integration '+variant+': '+mode,()=>{
  fs.mkdirSync('tmp/installer-tests',{recursive:true});
  const root=fs.mkdtempSync(path.resolve('tmp/installer-tests/run-')),app=path.join(root,'app'),pkg=path.join(root,'package'),backups=path.join(root,'backups'),bin=path.join(root,'bin');
  fs.mkdirSync(backups,{recursive:true});
  const oldFiles=identity||mode==='upgrade-rollback'?files:files.slice(0,4);
  for(const file of oldFiles)write(app,file,'old '+file);
  write(app,'.env.local','ORIGINAL=fixture\n');
  write(app,'data/keep.db','untouched database fixture');
  for(const file of files)write(pkg,file,'new '+file);
  const sums=files.map(file=>createHash('sha256').update('new '+file).digest('hex')+'  '+file).join('\n')+'\n';
  write(pkg,'SHA256SUMS',sums);
  if(mode==='checksum-fail')write(pkg,files[0],'damaged');
  const script=source.replace('cd /opt/feishu-mcp','cd "'+posix(app)+'"').replace('/root/'+backupPrefix+'-backup-XXXXXXXX','"'+posix(backups)+'/'+backupPrefix+'-backup-XXXXXXXX"');
  write(pkg,'install.sh',script);
  write(bin,'id','#!/usr/bin/env bash\necho 0\n');
  write(bin,'sleep','#!/usr/bin/env bash\nexit 0\n');
  write(bin,'systemctl','#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$INSTALL_LOG"\n');
  write(bin,'curl','#!/usr/bin/env bash\necho \'{"service":"feishu-mcp","ready":true}\'\n');
  write(bin,'node',`#!/usr/bin/env bash
code="$(cat)"
if [[ "$code" == *withBitableScopes* ]]; then
  printf 'UPDATED=fixture\\n' > .env.local
  if [ "$INSTALL_MODE" = load-fail ]; then exit 7; fi
fi
if [[ "$code" == *FeishuAuth.prototype.identity* ]] && [ "$INSTALL_MODE" = load-fail ]; then exit 7; fi
if [[ "$*" == *JSON.parse* ]] && { [ "$INSTALL_MODE" = health-fail ] || [ "$INSTALL_MODE" = upgrade-rollback ]; }; then exit 8; fi
exit 0
`);
  for(const file of fs.readdirSync(bin))fs.chmodSync(path.join(bin,file),0o755);
  const run=spawnSync(bash,['--noprofile','--norc','-c','export PATH="'+posix(bin)+':$PATH"; bash "'+posix(path.join(pkg,'install.sh'))+'"'],{encoding:'utf8',env:{...process.env,INSTALL_MODE:mode,INSTALL_LOG:posix(path.join(root,'service.log'))}});
  assert.equal(run.status,mode==='success'?0:mode==='checksum-fail'?1:mode==='load-fail'?7:1,run.stdout+run.stderr);
  assert.equal(fs.readFileSync(path.join(app,'data/keep.db'),'utf8'),'untouched database fixture');
  if(mode==='success'){
    for(const file of files)assert.equal(fs.readFileSync(path.join(app,file),'utf8'),'new '+file);
    assert.equal(fs.readFileSync(path.join(app,'.env.local'),'utf8'),identity?'ORIGINAL=fixture\n':'UPDATED=fixture\n');
  }else{
    for(const file of oldFiles)assert.equal(fs.readFileSync(path.join(app,file),'utf8'),'old '+file);
    for(const file of files.filter(f=>!oldFiles.includes(f)))assert.equal(fs.existsSync(path.join(app,file)),false);
    assert.equal(fs.readFileSync(path.join(app,'.env.local'),'utf8'),'ORIGINAL=fixture\n');
  }
  if(mode==='checksum-fail')assert.equal(fs.readdirSync(backups).length,0);
  else assert.equal(fs.readdirSync(backups).length,1);
});
}
