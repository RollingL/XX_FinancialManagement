const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {launchScript,filesBelow,verifyInventory}=require('../spike/prepare-windows-portable.cjs');
test('optional diagnostics leave business path creation to the runtime and preserve safe log/exit behavior',()=>{
 for(const probe of [false,true]){
  const script=launchScript('synthetic-build-id',probe);
  assert.ok(!script.includes('XX_FINANCE_USER_DATA_DIR='));assert.ok(!script.includes('XX_FINANCE_DATA_DIR='));assert.ok(!script.includes('XX_FINANCE_BACKUP_DIR='));assert.match(script,/Qianlai\.exe/);assert.match(script,/--diagnostics/);assert.ok(!script.includes('trial-marker.txt'));assert.ok(!script.includes('findstr'));assert.ok(!/\bcall\b/i.test(script));
  // NTSTATUS crashes can be negative in cmd.exe; ERRORLEVEL 1 misses those.
  assert.ok(script.includes('set "LAUNCH_EXIT=%errorlevel%"'));
  const launch=`"%~dp0Qianlai.exe" --diagnostics${probe?' --probe':''} >"%LOG_DIR%\\stdout.txt" 2>"%LOG_DIR%\\stderr.txt"`;
  assert.ok(script.includes(launch+'\r\nset "LAUNCH_EXIT=%errorlevel%"'));
  assert.ok(!/^start\s/im.test(script),'GUI invocation must preserve redirected handles instead of using START');
  assert.ok(script.includes('if not "%LAUNCH_EXIT%"=="0" goto :runtime_failed'));
  assert.ok(script.includes('exit /b %LAUNCH_EXIT%'));
  assert.ok(script.includes('DisableDelayedExpansion'));
  assert.ok(script.includes('%RANDOM%-%RANDOM%'));
  assert.ok(script.includes('ELECTRON_LOG_FILE=%LOG_DIR%\\chromium.log'));
  assert.ok(script.includes('2>"%LOG_DIR%\\stderr.txt"'));
  assert.ok(script.includes('ExitCode=%LAUNCH_EXIT%'));
  assert.ok(script.includes('if not exist "%~dp0diagnostics\\" mkdir "%~dp0diagnostics" 2>nul'));
  assert.ok(script.includes('if not exist "%~dp0diagnostics\\" goto :failed'));
  assert.ok(script.includes('set "LOG_ATTEMPT=0"\r\n:log_directory\r\nset /a LOG_ATTEMPT+=1 >nul'));
  assert.ok(script.includes('if %LOG_ATTEMPT% GTR 100 goto :failed'));
  assert.ok(script.includes(`set "LOG_DIR=%~dp0diagnostics\\${probe?'probe':'start'}-%RANDOM%-%RANDOM%-%LOG_ATTEMPT%"`));
  assert.ok(script.includes('mkdir "%LOG_DIR%" 2>nul && goto :log_ready\r\nif exist "%LOG_DIR%" goto :log_directory\r\ngoto :failed\r\n:log_ready'));
  assert.ok(script.indexOf('\r\n:log_ready\r\n')<script.indexOf('>"%LOG_DIR%\\status.txt"'),'Only the newly claimed directory may receive log writes');
  assert.ok(!/mkdir[^\r\n]*(?:trial-data|user-data|backups)/.test(script));
  assert.ok(!/powershell|curl|wget|https?:|executionpolicy|\brmdir\b|\bdel\b|Remove-Item/i.test(script));
  assert.equal(script.includes('--probe'),probe);assert.ok(!script.replaceAll('\r\n','').includes('\n'));
 }
});
test('launcher build identity cannot inject batch commands',()=>{
 for(const id of ['', 'id&echo bad', 'id\"', 'id%PATH%', 'id\r\nexit'])assert.throws(()=>launchScript(id),/build identity/);
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
