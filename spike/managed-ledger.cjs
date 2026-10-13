// Opt-in isolated ledgers only. Existing unmarked trial roots are never adopted.
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const Database=require('better-sqlite3');
const {createLedger}=require('./trial-ledger.cjs');
const {resetLedger,readResetStatus,CONFIRMATION}=require('./ledger-reset.cjs');
const MARKER='managed-ledger.json',LOCK='.writer-lock',OWNER='owner.json';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail=message=>{throw Object.assign(Error(message),{status:409});};
function regular(file,directory=false){
 let stat;try{stat=fs.lstatSync(file);}catch(e){if(e.code==='ENOENT')fail(`受管账本缺少 ${path.basename(file)}，请保留原目录`);throw e;}
 if(stat.isSymbolicLink()||!(directory?stat.isDirectory():stat.isFile()))fail(`受管账本路径须为普通${directory?'目录':'文件'}：${path.basename(file)}`);
 return stat;
}
function writeJson(file,value){
 const fd=fs.openSync(file,'wx',0o600);
 try{fs.writeFileSync(fd,JSON.stringify(value)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
function inspectManagedRoot(root,{complete=true}={}){
 regular(root,true);const markerPath=path.join(root,MARKER),stat=regular(markerPath);
 if(stat.size>4096)fail('受管账本标识无效，请保留原目录');
 let marker;try{marker=JSON.parse(fs.readFileSync(markerPath,'utf8'));}catch{fail('受管账本标识无效，请保留原目录');}
 if(!marker||Array.isArray(marker)||Object.keys(marker).sort().join(',')!=='formatVersion,ledgerId,sourceKind'||marker.formatVersion!==1||typeof marker.ledgerId!=='string'||!uuid.test(marker.ledgerId)||marker.sourceKind!=='isolated-test')fail('受管账本标识无效；仅支持本版本创建的隔离测试账本');
 if(complete){regular(path.join(root,'trial.sqlite'));regular(path.join(root,'attachments'),true);}
 for(const suffix of ['-wal','-shm']){
  const file=path.join(root,'trial.sqlite'+suffix);
  try{fs.lstatSync(file);}catch(e){if(e.code==='ENOENT')continue;throw e;}
  regular(file);
 }
 return marker;
}
function acquireManagedLock(root,{create=false}={}){
 if(typeof root!=='string'||!root.trim())fail('必须明确指定隔离账本目录');root=path.resolve(root);
 // Resolve parent aliases once; the final root itself must still pass the no-symlink check.
 root=path.join(fs.realpathSync(path.dirname(root)),path.basename(root));
 let created=false;
 if(create){
  try{fs.mkdirSync(root,{mode:0o700});created=true;}catch(e){if(e.code!=='EEXIST')throw e;}
  if(created)writeJson(path.join(root,MARKER),{formatVersion:1,ledgerId:randomUUID(),sourceKind:'isolated-test'});
 }
 const marker=inspectManagedRoot(root,{complete:!created}),lockDir=path.join(root,LOCK),token=randomUUID();
 try{fs.mkdirSync(lockDir,{mode:0o700});}catch(e){if(e.code==='EEXIST')fail('账本正在使用或有残留锁，请先正常关闭原实例；不会自动抢锁');throw e;}
 try{writeJson(path.join(lockDir,OWNER),{token,pid:process.pid,createdAt:new Date().toISOString()});}
 catch(e){throw Error(`账本锁初始化失败，请保留目录和锁：${e.message}`);}
 let released=false;
 function release(){
  if(released)return;
  regular(lockDir,true);const ownerPath=path.join(lockDir,OWNER);regular(ownerPath);
  let owner;try{owner=JSON.parse(fs.readFileSync(ownerPath,'utf8'));}catch{fail('账本锁所有者无效，未释放锁');}
  if(owner?.token!==token||fs.readdirSync(lockDir).sort().join(',')!==OWNER)fail('账本锁所有者或内容已变化，未释放锁');
  fs.unlinkSync(ownerPath);fs.rmdirSync(lockDir);released=true;
 }
 try{
  const latest=inspectManagedRoot(root,{complete:!created});if(latest.ledgerId!==marker.ledgerId)fail('账本标识已变化，请保留目录');
 }catch(e){release();throw e;}
 return {root,marker,created,release,token};
}
function createManagedLedger(root,service,{createBackup,backupDestination}={}){
 if(backupDestination!==undefined){if(typeof backupDestination!=='string'||!path.isAbsolute(backupDestination))fail('备份目录必须由启动配置指定绝对路径');regular(backupDestination,true);backupDestination=fs.realpathSync(backupDestination);}
 const lock=acquireManagedLock(root,{create:true});let ledger=null,rawState,opening=false;
 const database=path.join(lock.root,'trial.sqlite');
 const publicGeneration=raw=>`${lock.marker.ledgerId}:${raw??'legacy'}`;
 function readRaw(){const db=new Database(database,{readonly:true,fileMustExist:true});try{return JSON.parse(db.prepare('SELECT json FROM trial_state WHERE id=1').get().json);}finally{db.close();}}
 function status(){return readResetStatus(lock.root);}
 function open(){opening=true;const value=createLedger(lock.root,service,lock.token);opening=false;return value;}
 try{
  if(!lock.created)require('./ledger-backup.cjs').inspectDatabase(database);
  if(lock.created){
   ledger=open();const db=new Database(database,{fileMustExist:true});
   try{db.transaction(()=>{const state=JSON.parse(db.prepare('SELECT json FROM trial_state WHERE id=1').get().json);state.generation=randomUUID();db.prepare('UPDATE trial_state SET json=? WHERE id=1').run(JSON.stringify(state));}).immediate();}finally{db.close();}
  }
  rawState=readRaw();if(rawState.generation!==undefined&&(typeof rawState.generation!=='string'||!uuid.test(rawState.generation)))fail('账本代际无效，请保留原目录');
  let pending=true;try{pending=status().pending;}catch(e){if(!e.pending)throw e;}
  if(!pending&&!ledger)ledger=open();
 }catch(e){if(opening)throw Error(`受管账本打开失败，连接状态无法确认，保留锁：${e.message}`);if(ledger){try{ledger.close();}catch{throw Error(`受管账本打开失败，保留锁：${e.message}`);}}lock.release();throw Error(`现有受管账本不完整，未初始化或补表：${e.message}`);}
 let active=null,closing=false,closed=false,closePromise;const backupResults=new Map();
 function run(action){
  if(closing||closed)return Promise.reject(Object.assign(Error('账本正在关闭或已经关闭'),{status:409}));
  if(active)return Promise.reject(Object.assign(Error('账本正在保存或维护，请稍后再试'),{status:409}));
  active=Promise.resolve().then(action).finally(()=>{active=null;});return active;
 }
 function pendingError(){throw Object.assign(Error('清空尚未完成，普通操作与备份已暂停，请继续本次清理'),{status:409,code:'RESET_PENDING',pending:true});}
 function normalStatus(){const value=status();if(value.pending)pendingError();return value;}
 function assertGeneration(input){if(input.generation!==publicGeneration(rawState.generation))fail('账本代际已变化，请刷新后重新操作');}
 function request(input){if(typeof input.requestId!=='string'||!uuid.test(input.requestId))fail('维护请求编号无效');}
 function publicState(state){return {...state,generation:publicGeneration(state.generation)};}
 function information(){
  const value=status();rawState=readRaw();
  return {supported:true,backupConfigured:!!backupDestination,canReset:uuid.test(rawState.generation||''),generation:publicGeneration(rawState.generation),pendingReset:value.pending?{requestId:value.requestId,fromGeneration:publicGeneration(value.fromGeneration),phase:value.phase}:null};
 }
 async function exportBackup(destinationParent){
  normalStatus();const marker=inspectManagedRoot(lock.root);if(marker.ledgerId!==lock.marker.ledgerId)fail('账本标识已变化，停止备份');
  const db=new Database(database,{readonly:true,fileMustExist:true});
  try{return await (createBackup||require('./ledger-backup.cjs').createBackup)({db,dataDir:lock.root,destinationParent,ledgerId:marker.ledgerId,sourceKind:'isolated-test'});}
  finally{db.close();}
 }
 async function reset(input){
  request(input);if(input.confirmation!==CONFIRMATION)fail('请输入完整确认文字“清空当前账本”');
  const prefix=lock.marker.ledgerId+':',from=typeof input.generation==='string'&&input.generation.startsWith(prefix)?input.generation.slice(prefix.length):'';
  if(!uuid.test(from))fail('账本代际已变化或旧账本不支持清空，请刷新后重试');
  const pending=status();rawState=readRaw();
  if(pending.pending){if(pending.requestId!==input.requestId||pending.fromGeneration!==from)pendingError();}
  else{
   if(rawState.resetReceipt?.requestId===input.requestId&&rawState.resetReceipt?.fromGeneration===from)return {reset:true,completed:true,generation:publicGeneration(rawState.generation)};
   if(input.generation!==publicGeneration(rawState.generation))fail('账本代际已变化，请刷新后重试');
  }
  service?.stop?.();await service?.finished;
  if(ledger){await ledger.close();ledger=null;}
  try{
   rawState=resetLedger({root:lock.root,requestId:input.requestId,generation:from,confirmation:input.confirmation});backupResults.clear();
   return {reset:true,completed:true,generation:publicGeneration(rawState.generation)};
  }finally{
   rawState=readRaw();let unfinished=true;try{unfinished=status().pending;}catch(e){if(!e.pending)throw e;}
   if(!unfinished&&!closing)ledger=open();
  }
 }
 function command(input){return run(async()=>{
  if(!input||typeof input!=='object')fail('请求无效');
  if(input.kind==='maintenance-info')return information();
  if(input.kind==='reset-ledger')return await reset(input);
  normalStatus();
  if(!ledger)fail('账本连接不可用，请保留数据并重新打开受管实例');
  if(input.kind==='read'){rawState=await ledger.command(input);return publicState(rawState);}
  assertGeneration(input);
  if(input.kind==='create-backup'){
   request(input);if(Object.keys(input).some(key=>!['kind','requestId','generation'].includes(key)))fail('备份仅使用服务启动时配置的目录');
   if(!backupDestination)fail('尚未配置本机备份目录');
   if(backupResults.has(input.requestId))return backupResults.get(input.requestId);
   const result=await exportBackup(backupDestination);backupResults.set(input.requestId,result);return result;
  }
  const {generation,...payload}=input,result=await ledger.command(payload);
  if(input.kind==='attachment')return result;
  rawState=result;return publicState(rawState);
 });}
 function backup(destinationParent){return run(()=>exportBackup(destinationParent));}
 function close(){
  if(closePromise)return closePromise;closing=true;
  closePromise=(async()=>{if(active)try{await active;}catch{}if(ledger)await ledger.close();ledger=null;if(opening)fail('账本连接关闭状态无法确认，保留锁，请保留原目录');lock.release();closed=true;})();return closePromise;
 }
 return {command,backup,close,root:lock.root,ledgerId:lock.marker.ledgerId};
}
module.exports={createManagedLedger,acquireManagedLock,inspectManagedRoot};
