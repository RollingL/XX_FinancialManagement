const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const assert=require('node:assert/strict');

function launchScript(id,probe=false){
 const lines=['@echo off','setlocal','cd /d "%~dp0"','if not exist "%~dp0app\\xx-finance-stage0.exe" goto :failed',
  'set "TRIAL_ROOT=%~dp0trial-data"','if exist "%TRIAL_ROOT%" (',
  '  if not exist "%TRIAL_ROOT%\\trial-marker.txt" goto :failed',
  `  findstr /x /c:"${id}" "%TRIAL_ROOT%\\trial-marker.txt" >nul || goto :failed`,
  ') else (','  mkdir "%TRIAL_ROOT%" || goto :failed',`  >"%TRIAL_ROOT%\\trial-marker.txt" echo ${id}`,')',
  'if not exist "%TRIAL_ROOT%\\user-data" mkdir "%TRIAL_ROOT%\\user-data" || goto :failed',
  'if not exist "%~dp0backups" mkdir "%~dp0backups" || goto :failed',
  'set "ELECTRON_RUN_AS_NODE="','set "XX_FINANCE_MANAGED_TRIAL=1"','set "XX_FINANCE_USER_DATA_DIR=%TRIAL_ROOT%\\user-data"',
  'set "XX_FINANCE_DATA_DIR=%TRIAL_ROOT%\\user-data\\stage0-trial"','set "XX_FINANCE_BACKUP_DIR=%~dp0backups"',
  probe?'"%~dp0app\\xx-finance-stage0.exe" --probe >"%TRIAL_ROOT%\\probe-result.txt" 2>"%TRIAL_ROOT%\\probe-error.txt"':'start "" /wait "%~dp0app\\xx-finance-stage0.exe"',
  'if errorlevel 1 goto :failed',probe?'echo Check completed. Keep trial-data\\probe-result.txt for review.':'echo Closed. Your synthetic test data is preserved in trial-data.',
  'pause','exit /b 0',':failed','echo Stopped. Do not delete existing data or disable security software. Report this message.','pause','exit /b 1'];
 return lines.join('\r\n')+'\r\n';
}
function filesBelow(root){
 const result=[];
 function walk(dir){for(const item of fs.readdirSync(dir,{withFileTypes:true})){
  const file=path.join(dir,item.name);
  if(item.isSymbolicLink())throw Error('Portable package must not contain symbolic links');
  if(item.isDirectory())walk(file);else if(item.isFile())result.push(file);else throw Error('Unexpected portable package entry');
 }}walk(root);return result.sort();
}
function verifyInventory(root,manifest){
 const names=new Set();
 for(const item of manifest){
  assert.equal(typeof item.file,'string');
  const file=path.resolve(root,item.file),relative=path.relative(root,file);
  assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative),'Unsafe manifest path');
  assert.ok(!names.has(item.file),'Duplicate manifest path');names.add(item.file);
  assert.equal(fs.statSync(file).size,item.size);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),item.sha256);
 }
 assert.deepEqual(filesBelow(root).map(file=>path.relative(root,file).replaceAll('\\','/')).filter(file=>file!=='file-hashes.json').sort(),[...names].sort());
}
function probePackage(app){
 const isolated=fs.mkdtempSync(path.join(os.tmpdir(),'qianlai-win-build-probe-'));
 try{
  const env={...process.env,XX_FINANCE_MANAGED_TRIAL:'1',XX_FINANCE_USER_DATA_DIR:isolated,XX_FINANCE_DATA_DIR:path.join(isolated,'ledger'),XX_FINANCE_BACKUP_DIR:path.join(isolated,'backups'),PYTHONPATH:'',PYTHONHOME:'',PATH:path.join(process.env.SystemRoot,'System32')};
  delete env.ELECTRON_RUN_AS_NODE;
  const output=execFileSync(path.join(app,'xx-finance-stage0.exe'),['--probe'],{env,encoding:'utf8',maxBuffer:4*1024*1024,windowsHide:true});
  const report=JSON.parse(output);assert.equal(report.packaged,true);assert.equal(report.sqlite?.status,'passed');assert.equal(report.sqlite?.platform,'win32');assert.equal(report.sqlite?.arch,'x64');assert.equal(report.ocr?.status,'passed');
  const image=path.join(app,'resources','ocr-sample.png');
  const requests=[{id:'synthetic-validation',image_path:image,validate_only:true},{id:'synthetic-ocr',image_path:image}];
  const replies=execFileSync(path.join(app,'resources','ocr-probe','ocr-probe.exe'),['--serve'],{env,input:requests.map(x=>JSON.stringify(x)).join('\n')+'\n',encoding:'utf8',maxBuffer:4*1024*1024,windowsHide:true}).trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(replies.length,2);assert.equal(replies[0].id,requests[0].id);assert.equal(replies[0].result?.validated,true);assert.equal(replies[1].id,requests[1].id);assert.equal(replies[1].ok,true);assert.ok(replies[1].result?.texts?.some(text=>/1,?280\.50/.test(text)));assert.equal(replies[1].result.extraction.auto_bookkeeping,false);
  return {...report,workerPipe:{validation:'passed',ocr:'passed'}};
 }finally{fs.rmSync(isolated,{recursive:true,force:true});}
}
async function prepare(){
 assert.equal(process.platform,'win32','Only the Windows build runner may prepare this candidate');
 assert.equal(process.arch,'x64');assert.equal(process.env.GITHUB_ACTIONS,'true');
 if(process.argv[2]==='--verify-extracted'){
  assert.equal(process.argv.length,4);
  const extracted=fs.realpathSync(process.argv[3]),temp=fs.realpathSync(process.env.RUNNER_TEMP),relative=path.relative(temp,extracted);
  assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative),'Only verify the new runner temp extraction');
  verifyInventory(extracted,JSON.parse(fs.readFileSync(path.join(extracted,'file-hashes.json'),'utf8')));
  console.log(JSON.stringify({scope:'Extracted portable candidate on Windows runner; not clean Windows 10 acceptance',probe:probePackage(path.join(extracted,'app'))},null,2));return;
 }
 assert.equal(process.argv.length,2);
 const root=path.resolve(__dirname,'..'),sha=process.env.GITHUB_SHA;
 assert.match(sha||'',/^[a-f0-9]{40}$/);assert.match(process.env.GITHUB_RUN_ID||'',/^\d+$/);
 const buildId=`qianlai-${sha}-${process.env.GITHUB_RUN_ID}`;
 const app=path.join(root,'out','XXFinanceStage0-win32-x64');
 const destination=path.join(root,'out','windows-offline',`Qianlai-Windows10-x64-${sha.slice(0,12)}`);
 assert.ok(!fs.existsSync(destination),'Refuse to overwrite a previous portable candidate');
 const {listPackage}=await import('@electron/asar');
 const entries=listPackage(path.join(app,'resources','app.asar'));
 for(const entry of entries)assert.ok(!/(^|[\\/])(?:evidence|\.local-data|\.git|\.env|credentials|backups)(?:[\\/.]|$)|\.(?:sqlite|db|pem|pfx|p12)$/i.test(entry),`Private path in packaged source: ${entry}`);
 assert.ok(entries.some(entry=>entry.replaceAll('\\','/').endsWith('/dist/index.html')));
 const worker=path.join(app,'resources','ocr-probe');
 for(const name of ['ocr-probe.exe','_internal/python312.dll','_internal/msvcp140.dll','_internal/vcruntime140.dll','_internal/vcruntime140_1.dll'])assert.ok(fs.statSync(path.join(worker,name)).isFile(),`Missing bundled runtime: ${name}`);
 const models={
  'PP-OCRv6_det_small.onnx':'090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f',
  'ch_ppocr_mobile_v2.0_cls_mobile.onnx':'e47acedf663230f8863ff1ab0e64dd2d82b838fceb5957146dab185a89d6215c',
  'PP-OCRv6_rec_small.onnx':'6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884'};
 for(const [name,hash] of Object.entries(models))assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(worker,'_internal','models',name))).digest('hex'),hash,`Model checksum mismatch: ${name}`);
 for(const file of fs.readdirSync(path.join(worker,'_internal')).filter(name=>/^(?:msvcp|vcruntime|concrt).*\.dll$/i.test(name)))fs.copyFileSync(path.join(worker,'_internal',file),path.join(app,file),fs.constants.COPYFILE_EXCL);
 const report=probePackage(app);
 fs.mkdirSync(destination,{recursive:true});fs.cpSync(app,path.join(destination,'app'),{recursive:true});
 fs.mkdirSync(path.join(destination,'samples'));
 fs.copyFileSync(path.join(root,'spike','fixtures','ocr-sample.png'),path.join(destination,'samples','synthetic-payment.png'));
 fs.writeFileSync(path.join(destination,'START-TEST.cmd'),launchScript(buildId));
 fs.writeFileSync(path.join(destination,'CHECK-RUNTIME.cmd'),launchScript(buildId,true));
 fs.writeFileSync(path.join(destination,'READ-ME.txt'),'\ufeff'+fs.readFileSync(path.join(root,'docs','WINDOWS_OFFLINE_TRIAL.md'),'utf8'));
 fs.writeFileSync(path.join(destination,'build-info.json'),JSON.stringify({sourceCommit:sha,runId:process.env.GITHUB_RUN_ID,builtAt:new Date().toISOString(),buildOS:os.release(),node:process.version,scope:'Windows Server build smoke test only; Windows 10 clean offline acceptance NOT YET VERIFIED',probe:report},null,2));
 fs.copyFileSync(path.join(root,'out','windows-python-freeze.txt'),path.join(destination,'build-python-dependencies.txt'));
 const manifest=filesBelow(destination).map(file=>({file:path.relative(destination,file).replaceAll('\\','/'),size:fs.statSync(file).size,sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}));
 assert.ok(!manifest.some(item=>/(^|\/)trial-data\//.test(item.file)));
 fs.writeFileSync(path.join(destination,'file-hashes.json'),JSON.stringify(manifest,null,2));
 console.log(destination);
}
if(require.main===module)prepare().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={launchScript,filesBelow,verifyInventory};
