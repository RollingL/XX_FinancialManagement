const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {launchScript,filesBelow,verifyInventory}=require('../spike/prepare-windows-portable.cjs');
test('portable launchers pin managed data and backup paths, preserve data, and never request network or policy bypass',()=>{
 for(const probe of [false,true]){
  const script=launchScript('synthetic-build-id',probe);
  assert.match(script,/XX_FINANCE_MANAGED_TRIAL=1/);assert.match(script,/trial-marker\.txt/);assert.match(script,/findstr \/x \/c:"synthetic-build-id"/);
  for(const name of ['USER_DATA_DIR','DATA_DIR','BACKUP_DIR'])assert.match(script,new RegExp('XX_FINANCE_'+name+'='));
  assert.match(script,/ELECTRON_RUN_AS_NODE=/);assert.ok(script.includes('if errorlevel 1 goto :failed'));
  assert.ok(script.includes('if not exist "%~dp0backups" mkdir "%~dp0backups" || goto :failed'));
  assert.ok(!/powershell|curl|wget|https?:|executionpolicy|\brmdir\b|\bdel\b|Remove-Item/i.test(script));
  assert.equal(script.includes('--probe'),probe);assert.ok(!script.replaceAll('\r\n','').includes('\n'));
 }
});
test('extracted inventory rejects altered, unexpected, duplicated or escaping files',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'qianlai-portable-hash-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const body=Buffer.from('synthetic'),manifest=[{file:'file.txt',size:body.length,sha256:require('node:crypto').createHash('sha256').update(body).digest('hex')}];
 fs.writeFileSync(path.join(root,'file.txt'),body);fs.writeFileSync(path.join(root,'file-hashes.json'),JSON.stringify(manifest));
 assert.doesNotThrow(()=>verifyInventory(root,manifest));
 assert.throws(()=>verifyInventory(root,[...manifest,...manifest]),/Duplicate/);
 assert.throws(()=>verifyInventory(root,[{...manifest[0],file:'../outside'}]),/Unsafe/);
 fs.writeFileSync(path.join(root,'extra'),'synthetic');assert.throws(()=>verifyInventory(root,manifest));fs.unlinkSync(path.join(root,'extra'));
 fs.writeFileSync(path.join(root,'file.txt'),'changed!!');assert.throws(()=>verifyInventory(root,manifest));
});
test('portable inventory includes hidden files and refuses symlinks instead of following outside the package',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'qianlai-portable-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.writeFileSync(path.join(root,'.hidden'),'synthetic');fs.mkdirSync(path.join(root,'child'));fs.writeFileSync(path.join(root,'child','file'),'synthetic');
 assert.deepEqual(filesBelow(root).map(file=>path.relative(root,file)),['.hidden',path.join('child','file')]);
 if(process.platform!=='win32'){fs.symlinkSync(os.tmpdir(),path.join(root,'escape'));assert.throws(()=>filesBelow(root),/symbolic/);}
});
