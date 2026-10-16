const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawn,spawnSync}=require('node:child_process');
const {launchScript}=require('../spike/prepare-windows-portable.cjs');
const available=process.platform==='win32'&&process.env.QIANLAI_TEST_LAUNCHER&&process.env.QIANLAI_TEST_LAUNCHER_CHILD;
const skip=available?false:'Requires reviewed Windows x64 launcher and synthetic fixture builds; not a Mac substitute.';
function fixture(t){
 const parent=fs.mkdtempSync(path.join(os.tmpdir(),'qianlai-supervisor-')),root=path.join(parent,'中文 space & bang! %value%');
 fs.mkdirSync(path.join(root,'app'),{recursive:true});
 fs.copyFileSync(process.env.QIANLAI_TEST_LAUNCHER,path.join(root,'Qianlai.exe'));
 fs.copyFileSync(process.env.QIANLAI_TEST_LAUNCHER_CHILD,path.join(root,'app','xx-finance-stage0.exe'));
 t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));
 return {root,exe:path.join(root,'Qianlai.exe'),env:{...process.env,QIANLAI_FIXTURE_DIRECTORY:root,NODE_OPTIONS:'--invalid-option',ELECTRON_RUN_AS_NODE:'1'}};
}
async function until(check,label){
 for(let i=0;i<100;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,50));}
 assert.fail(`Timed out waiting for ${label}`);
}
function alive(pid){try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}}
test('native GUI supervisor preserves codes and redirected logs with Unicode/shell-special paths',{skip},t=>{
 const f=fixture(t);
 for(const code of [0,7,0xc0000005]){
  const result=spawnSync(f.exe,['--diagnostics'],{cwd:f.root,env:{...f.env,QIANLAI_FIXTURE_MODE:'exit',QIANLAI_FIXTURE_EXIT:String(code)},encoding:'utf8',timeout:20000,windowsHide:true});
  assert.ifError(result.error);assert.equal(result.status>>>0,code,result.stderr);
  assert.match(result.stdout,/synthetic stdout/);assert.match(result.stderr,/synthetic stderr/);
  fs.unlinkSync(path.join(f.root,'main.txt'));
  assert.equal(fs.existsSync(path.join(f.root,'trial-data')),false,'Diagnostics must not create a ledger root for the fixture');
 }
});
for(const ending of ['normal-main-return','kill-main','kill-launcher'])test(`private job cleans only its synthetic descendants: ${ending}`,{skip},async t=>{
 const sentinel=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
 t.after(()=>sentinel.kill());
 const f=fixture(t),child=spawn(f.exe,['--diagnostics'],{cwd:f.root,env:{...f.env,QIANLAI_FIXTURE_MODE:ending==='normal-main-return'?'return-with-descendant':'wait'},stdio:'ignore',windowsHide:true});
 const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
 t.after(()=>{if(child.exitCode===null)child.kill();});
 await until(()=>fs.existsSync(path.join(f.root,'descendant.txt')),'synthetic process tree');
 const main=Number(fs.readFileSync(path.join(f.root,'main.txt'),'utf8')),descendant=Number(fs.readFileSync(path.join(f.root,'descendant.txt'),'utf8'));
 if(ending==='kill-main')process.kill(main);else if(ending==='kill-launcher')child.kill();
 await Promise.race([exited,new Promise((_,reject)=>setTimeout(()=>reject(Error('Launcher did not exit')),10000).unref())]);
 await until(()=>!alive(main)&&!alive(descendant),'both owned processes to exit');
 assert.ok(process.pid!==main&&process.pid!==descendant);
 assert.equal(sentinel.exitCode,null,'Unrelated synthetic process must remain running');
});

test('optional diagnostic CMD preserves zero, positive and crash exit codes with separate logs',{skip},t=>{
 const f=fixture(t);
 fs.writeFileSync(path.join(f.root,'START-TEST.cmd'),launchScript('synthetic-build-id'));
 const seen=new Set();
 for(const code of [0,7,0xc0000005]){
  const run=spawnSync(process.env.ComSpec||'cmd.exe',['/d','/c','START-TEST.cmd'],{
   cwd:f.root,env:{...f.env,QIANLAI_FIXTURE_MODE:'exit',QIANLAI_FIXTURE_EXIT:String(code)},input:'',encoding:'utf8',timeout:20000,windowsHide:true,
  });
  assert.ifError(run.error);assert.equal(run.status>>>0,code,run.stdout+run.stderr);
  const logRoot=path.join(f.root,'diagnostics'),added=fs.readdirSync(logRoot).filter(name=>!seen.has(name));
  assert.equal(added.length,1);seen.add(added[0]);const logs=path.join(logRoot,added[0]);
  const status=fs.readFileSync(path.join(logs,'status.txt'),'utf8'),match=status.match(/ExitCode=(-?\d+)/);
  assert.ok(match,status);assert.equal(Number(match[1])>>>0,code);
  assert.match(fs.readFileSync(path.join(logs,'stdout.txt'),'utf8'),/synthetic stdout/);
  assert.match(fs.readFileSync(path.join(logs,'stderr.txt'),'utf8'),/synthetic stderr/);
  fs.unlinkSync(path.join(f.root,'main.txt'));
  assert.equal(fs.existsSync(path.join(f.root,'trial-data')),false,'Diagnostics must not create a ledger root for the fixture');
 }
});
