'use strict';
// Caller holds the managed-root lifetime lock and maintenance gate, with its ledger connection closed.
const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const Database=require('better-sqlite3');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const IMAGE=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(png|jpg)$/;
const JOURNAL='reset-journal.json',CONFIRMATION='清空当前账本';
function error(message,code='RESET_INVALID',pending=false){return Object.assign(Error(message),{status:409,code,pending});}
function requireThat(value,message){if(!value)throw error(message);}
function stat(file,directory=false){
 const value=fs.lstatSync(file);requireThat(!value.isSymbolicLink()&&(directory?value.isDirectory():value.isFile()&&value.nlink===1),'清空只允许受管目录中的独立普通文件，拒绝链接或子目录');return value;
}
function sameFile(file,identity,directory=false){const current=stat(file,directory);requireThat(current.dev===identity.dev&&current.ino===identity.ino,'受管目录或文件在清空时发生变化，请保留现场');return current;}
function readJson(file,max=4096){
 const identity=stat(file);requireThat(identity.size>0&&identity.size<=max,'清空标识文件无效');
 const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
 try{const current=fs.fstatSync(fd);requireThat(current.dev===identity.dev&&current.ino===identity.ino&&current.nlink===1,'清空标识文件发生变化');return {value:JSON.parse(fs.readFileSync(fd,'utf8')),identity};}finally{fs.closeSync(fd);}
}
function syncDirectory(directory){
 let fd;try{fd=fs.openSync(directory,'r');fs.fsyncSync(fd);}catch(e){
  // Directory fsync is not portable on Windows; Windows crash durability remains unverified.
  if(process.platform!=='win32'||!['EPERM','EINVAL','EISDIR','EBADF'].includes(e.code))throw e;
 }finally{if(fd!==undefined)fs.closeSync(fd);}
}
function context(root){
 requireThat(typeof root==='string'&&root.length>0&&!root.includes('\0'),'清空账本目录无效');
 const requested=path.resolve(root);stat(requested,true);root=fs.realpathSync(requested);
 const rootIdentity=stat(root,true),marker=readJson(path.join(root,'managed-ledger.json')).value;
 requireThat(marker?.formatVersion===1&&marker.sourceKind==='isolated-test'&&UUID.test(marker.ledgerId),'只允许清空有明确标识的新受管合成账本');
 const database=path.join(root,'trial.sqlite'),attachments=path.join(root,'attachments'),databaseIdentity=stat(database),attachmentIdentity=stat(attachments,true);
 for(const suffix of ['-wal','-shm','-journal']){const file=database+suffix;if(fs.lstatSync(file,{throwIfNoEntry:false}))stat(file);}
 return {root,rootIdentity,database,databaseIdentity,attachments,attachmentIdentity,journalPath:path.join(root,JOURNAL)};
}
function inventory(ctx){
 sameFile(ctx.root,ctx.rootIdentity,true);sameFile(ctx.attachments,ctx.attachmentIdentity,true);sameFile(ctx.database,ctx.databaseIdentity);
 return fs.readdirSync(ctx.attachments).sort().map(name=>{requireThat(IMAGE.test(name),'附件目录含非受管条目，清空未执行，请保留目录');const file=path.join(ctx.attachments,name);return {file,identity:stat(file)};});
}
function journalAt(ctx){
 if(!fs.lstatSync(ctx.journalPath,{throwIfNoEntry:false}))return null;
 try{
  const {value,identity}=readJson(ctx.journalPath);
  requireThat(value&&Object.keys(value).sort().join(',')==='at,fromGeneration,requestId,toGeneration,version'&&value.version===1&&UUID.test(value.requestId)&&UUID.test(value.fromGeneration)&&UUID.test(value.toGeneration)&&value.fromGeneration!==value.toGeneration&&typeof value.at==='string'&&new Date(value.at).toISOString()===value.at,'清空待办标识无效');
  return {value,identity};
 }catch(e){throw error(`清空状态无法确认，请保留账本与清理标识：${e.message}`,'RESET_PENDING',true);}
}
function readState(db){const row=db.prepare('SELECT json FROM trial_state WHERE id=1').get();requireThat(row,'账本状态不存在');return JSON.parse(row.json);}
function receiptMatches(state,journal){return state.generation===journal.toGeneration&&state.resetReceipt?.requestId===journal.requestId&&state.resetReceipt?.fromGeneration===journal.fromGeneration&&state.resetReceipt?.at===journal.at;}
function phaseFor(state,journal){
 if(receiptMatches(state,journal))return 'cleanup';
 if(state.generation===journal.fromGeneration)return 'prepared';
 throw error('账本代际与清空待办不一致，请保留数据并检查','RESET_PENDING',true);
}
function readResetStatus(root){
 const ctx=context(root),journal=journalAt(ctx);if(!journal)return {pending:false};
 const db=new Database(ctx.database,{readonly:true,fileMustExist:true});
 try{const value=journal.value;return {pending:true,requestId:value.requestId,fromGeneration:value.fromGeneration,toGeneration:value.toGeneration,at:value.at,phase:phaseFor(readState(db),value)};}finally{db.close();}
}
function writeJournal(ctx,value){
 sameFile(ctx.root,ctx.rootIdentity,true);const fd=fs.openSync(ctx.journalPath,'wx',0o600);let identity;
 try{identity=fs.fstatSync(fd);fs.writeFileSync(fd,JSON.stringify(value)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 syncDirectory(ctx.root);return {value,identity};
}
function removeJournal(ctx,journal){sameFile(ctx.root,ctx.rootIdentity,true);sameFile(ctx.journalPath,journal.identity);fs.unlinkSync(ctx.journalPath);syncDirectory(ctx.root);}
function checkpoint(db){const rows=db.pragma('wal_checkpoint(TRUNCATE)');requireThat(rows.length===1&&rows[0].busy===0,'数据库仍被占用，清理未完成');}
function resetLedger({root,requestId,generation,confirmation}={}){
 requireThat(confirmation===CONFIRMATION,'请输入完整确认文字“清空当前账本”');
 requireThat(typeof requestId==='string'&&UUID.test(requestId)&&typeof generation==='string'&&UUID.test(generation),'清空请求或账本代际无效');
 const ctx=context(root);let journal=journalAt(ctx),db,committed=false;
 try{
  // A complete preflight happens before creating the intent or modifying any business fact.
  inventory(ctx);db=new Database(ctx.database,{fileMustExist:true});let state=readState(db);
  if(journal){
   requireThat(journal.value.requestId===requestId&&journal.value.fromGeneration===generation,'另一次清空尚未完成，请使用原请求继续清理');
   committed=phaseFor(state,journal.value)==='cleanup';
  }else{
   if(state.resetReceipt?.requestId===requestId&&state.resetReceipt?.fromGeneration===generation)return state;
   requireThat(UUID.test(state.generation||'')&&state.generation===generation,'账本代际已变化或旧账本不支持清空，请刷新后重试');
   journal=writeJournal(ctx,{version:1,requestId,fromGeneration:generation,toGeneration:randomUUID(),at:new Date().toISOString()});
  }
  db.pragma('secure_delete = ON');db.pragma('synchronous = FULL');
  if(!committed){
   try{
    state=db.transaction(()=>{
     const current=readState(db);requireThat(current.generation===generation,'账本代际已变化，未清空');
     const empty={expenses:[],batches:[],advances:[],generation:journal.value.toGeneration,resetReceipt:{requestId,fromGeneration:generation,at:journal.value.at}};
     db.prepare('UPDATE trial_state SET json=? WHERE id=1').run(JSON.stringify(empty));db.prepare('DELETE FROM operations').run();db.prepare('DELETE FROM attachments').run();return empty;
    }).immediate();committed=true;
   }catch(e){removeJournal(ctx,journal);journal=null;throw e;}
  }
  // Business deletion is committed. Cleanup must finish before the wrapper permits normal access.
  requireThat(Object.keys(state).sort().join(',')==='advances,batches,expenses,generation,resetReceipt'&&['expenses','batches','advances'].every(key=>Array.isArray(state[key])&&state[key].length===0)&&db.prepare('SELECT count(*) n FROM operations').get().n===0&&db.prepare('SELECT count(*) n FROM attachments').get().n===0,'待清理账本出现新的业务记录，已停止清理，请保留数据');
  for(const item of inventory(ctx)){sameFile(ctx.root,ctx.rootIdentity,true);sameFile(ctx.attachments,ctx.attachmentIdentity,true);sameFile(item.file,item.identity);fs.unlinkSync(item.file);}
  syncDirectory(ctx.attachments);checkpoint(db);db.exec('VACUUM');checkpoint(db);db.close();db=null;
  const fd=fs.openSync(ctx.database,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  try{removeJournal(ctx,journal);journal=null;}catch(e){
   // If final directory synchronization fails, put the minimal pending marker back for retry.
   if(!fs.lstatSync(ctx.journalPath,{throwIfNoEntry:false}))journal=writeJournal(ctx,journal.value);throw e;
  }
  return state;
 }catch(e){
  if(committed||journal||fs.lstatSync(ctx.journalPath,{throwIfNoEntry:false}))throw error(`清空尚未完成，普通操作已暂停，请继续本次清理：${e.message}`,'RESET_PENDING',true);
  throw e;
 }finally{if(db?.open)db.close();}
}
module.exports={resetLedger,resumeReset:resetLedger,readResetStatus,CONFIRMATION};
