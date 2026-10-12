'use strict';
// The caller owns the managed ledger's process lock and maintenance gate throughout export.
// This module never opens an existing ledger through createLedger or switches an active root.
const fs=require('node:fs'),path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const {isDeepStrictEqual}=require('node:util');
const Database=require('better-sqlite3');
const APPLICATION_VERSION=require('../package.json').version;
const FORMAT='qianlai-ledger-backup',VERSION=1,SCHEMA='trial-state-json-v0';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH=/^[a-f0-9]{64}$/,IMAGE=/^([a-f0-9-]{36})\.(png|jpg)$/;
const MAX_DB=256*1024*1024,MAX_JSON=64*1024*1024,MAX_MANIFEST=16*1024*1024,MAX_IMAGE=20*1024*1024;
const expectedSql={
 trial_state:'CREATE TABLE trial_state (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL)',
 operations:'CREATE TABLE operations (id TEXT PRIMARY KEY, digest TEXT NOT NULL, kind TEXT NOT NULL, created_at TEXT NOT NULL)',
 attachments:'CREATE TABLE attachments (id TEXT PRIMARY KEY, file TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL, mime TEXT NOT NULL)',
};
const fail=message=>{throw Error(message);};
const requireThat=(value,message)=>{if(!value)fail(message);};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const positive=value=>Number.isSafeInteger(value)&&value>0;
const validDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
const timestamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const safeText=(value,max,required=false)=>typeof value==='string'&&value.length<=max&&(!required||!!value.trim());
const normalizedSql=sql=>sql.replace(/\s+/g,'').toLowerCase();
const same=(a,b,message)=>requireThat(isDeepStrictEqual(a,b),message);
function directory(input){
 requireThat(typeof input==='string'&&!!input&&!input.includes('\0'),'目录参数无效');
 const absolute=path.resolve(input),stat=fs.lstatSync(absolute);
 requireThat(stat.isDirectory()&&!stat.isSymbolicLink(),'目录不能是符号链接或普通文件');
 return fs.realpathSync(absolute);
}
function inside(parent,child){const relative=path.relative(parent,child);return relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative));}
function fileBytes(file,max){
 const stat=fs.lstatSync(file);
 requireThat(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1,'只允许独立普通文件，拒绝链接');
 requireThat(stat.size>0&&stat.size<=max,'文件为空或超过备份支持大小');
 const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
 try{
  const current=fs.fstatSync(fd);requireThat(current.isFile()&&current.nlink===1&&current.ino===stat.ino&&current.dev===stat.dev,'文件在读取时发生变化');
  const bytes=fs.readFileSync(fd);requireThat(bytes.length===stat.size,'文件在读取时发生变化');return bytes;
 }finally{fs.closeSync(fd);}
}
function jsonFile(file,max){try{return JSON.parse(fileBytes(file,max).toString('utf8'));}catch(e){fail(`JSON 文件无效：${e.message}`);}}
function writeFile(file,bytes){const fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function syncFile(file){const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function syncDirectory(dir){
 let fd;try{fd=fs.openSync(dir,'r');fs.fsyncSync(fd);}catch(e){
  // Windows directory fsync is not portable; Windows durability remains an explicit acceptance item.
  if(process.platform!=='win32'||!['EPERM','EINVAL','EISDIR','EBADF'].includes(e.code))throw e;
 }finally{if(fd!==undefined)fs.closeSync(fd);}
}
function exactNames(dir,names){same(fs.readdirSync(dir).sort(),[...names].sort(),'目录包含未知、缺失或重复文件');}
function ownedDirectory(dir,identity){const current=fs.lstatSync(dir,{throwIfNoEntry:false});return current?.isDirectory()&&!current.isSymbolicLink()&&current.dev===identity.dev&&current.ino===identity.ino;}
function publishDirectory(partial,target,completion){
 // mkdir is the no-replace operation. A prior exists check followed by rename could replace
 // a competing process's empty directory on POSIX. The final marker publishes this copy.
 fs.mkdirSync(target,{mode:0o700});const identity=fs.lstatSync(target);let published=false;
 const check=()=>requireThat(ownedDirectory(target,identity),'发布目标目录已被其他操作替换');
 const copy=(from,to)=>{check();fs.copyFileSync(from,to,fs.constants.COPYFILE_EXCL);syncFile(to);};
 try{
  for(const name of fs.readdirSync(partial).filter(name=>name!==completion)){
   if(name==='attachments'){
    check();fs.mkdirSync(path.join(target,name),{mode:0o700});
    for(const file of fs.readdirSync(path.join(partial,name)))copy(path.join(partial,name,file),path.join(target,name,file));
    syncDirectory(path.join(target,name));
   }else copy(path.join(partial,name),path.join(target,name));
  }
  check();syncDirectory(target);fs.copyFileSync(path.join(partial,completion),path.join(target,completion),fs.constants.COPYFILE_EXCL);published=true;
  syncFile(path.join(target,completion));syncDirectory(target);syncDirectory(path.dirname(target));
 }catch(e){
  if(published){e.publishedDirectory=target;e.message+='；已生成目录但未确认持久化完成，请保留并检查该目录';}
  else if(ownedDirectory(target,identity)){try{fs.rmSync(target,{recursive:true});}catch{e.incompleteDirectory=target;}}
  else e.incompleteDirectory=target;
  throw e;
 }
}
function imageName(name){const match=typeof name==='string'&&IMAGE.exec(name);requireThat(match&&UUID.test(match[1]),'附件路径不是受管单层文件名');return match[2];}
function imageBytes(file,name){
 const extension=imageName(name),bytes=fileBytes(file,MAX_IMAGE);
 const png=bytes.length>=8&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
 const jpeg=bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
 requireThat(extension==='png'?png:jpeg,'附件格式与文件名不符');return bytes;
}
function inspectDatabase(file){
 fileBytes(file,MAX_DB);
 const db=new Database(file,{readonly:true,fileMustExist:true});
 try{
  same(db.pragma('integrity_check'),[{integrity_check:'ok'}],'数据库完整性检查失败');
  const schema=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name").all();
  const tables=schema.filter(row=>row.type==='table');
  same(tables.map(row=>row.name).sort(),Object.keys(expectedSql).sort(),'不支持的数据库结构');
  for(const row of schema){
   if(row.type==='table')requireThat(normalizedSql(row.sql)===normalizedSql(expectedSql[row.name]),'数据库表结构不兼容');
   else requireThat(row.type==='index'&&row.sql===null&&['sqlite_autoindex_operations_1','sqlite_autoindex_attachments_1'].includes(row.name),'拒绝未知索引、触发器、视图或虚拟表');
  }
  const states=db.prepare('SELECT id,json FROM trial_state').all();requireThat(states.length===1&&states[0].id===1&&Buffer.byteLength(states[0].json)<=MAX_JSON,'账本状态行无效或过大');
  const state=JSON.parse(states[0].json),attachments=db.prepare('SELECT * FROM attachments ORDER BY id').all(),operations=db.prepare('SELECT * FROM operations ORDER BY id').all();
  requireThat(object(state)&&Array.isArray(state.expenses)&&Array.isArray(state.advances)&&Array.isArray(state.batches),'账本 JSON 结构无效');
  if(state.generation!==undefined)requireThat(typeof state.generation==='string'&&UUID.test(state.generation),'账本 generation 无效');
  if(state.resetReceipt!==undefined){
   const receipt=state.resetReceipt;
   requireThat(object(receipt)&&typeof receipt.requestId==='string'&&UUID.test(receipt.requestId)&&typeof receipt.fromGeneration==='string'&&UUID.test(receipt.fromGeneration)&&timestamp(receipt.at)&&typeof state.generation==='string'&&state.generation!==receipt.fromGeneration,'清空回执或 generation 无效');
   same(Object.keys(receipt).sort(),['requestId','fromGeneration','at'].sort(),'清空回执包含未知字段');
   // This technical receipt survives clearing operations and does not represent a business event.
  }
  const expenses=new Map(),batchIds=new Set(),used=new Map(),references=new Set(),attachmentIds=new Set(),attachmentNames=new Set();
  let expenseTotal=0n,advanceTotal=0n,reimbursed=0n,allocationCount=0;
  const addReference=id=>{if(id!==undefined){requireThat(typeof id==='string'&&UUID.test(id),'附件引用无效');references.add(id);}};
  for(const e of state.expenses){
   requireThat(object(e)&&positive(e.id)&&!expenses.has(e.id)&&positive(e.amount)&&validDate(e.date)&&['接待','办公'].includes(e.category)&&safeText(e.merchant,100,true)&&safeText(e.note,500)&&Number.isSafeInteger(e.invoice)&&e.invoice>=0&&e.invoice<=e.amount,'费用记录无效');
   expenses.set(e.id,e);expenseTotal+=BigInt(e.amount);addReference(e.attachmentId);
  }
  for(const amount of state.advances){requireThat(positive(amount),'预支金额无效');advanceTotal+=BigInt(amount);}
  if(state.advanceDetails!==undefined){
   requireThat(object(state.advanceDetails),'预支元数据无效');
   for(const [index,detail] of Object.entries(state.advanceDetails)){
    requireThat(/^(0|[1-9]\d*)$/.test(index)&&Number.isSafeInteger(Number(index))&&Number(index)<state.advances.length&&object(detail)&&validDate(detail.date)&&safeText(detail.note,500)&&timestamp(detail.createdAt),'预支元数据索引、日期或字段无效');addReference(detail.attachmentId);
   }
  }
  function validateBatch(batch){
   requireThat(object(batch)&&positive(batch.id)&&validDate(batch.date)&&typeof batch.active==='boolean'&&batch.deleted===undefined&&Array.isArray(batch.allocations)&&batch.allocations.length>0,'批次记录无效或含不支持的软删除字段');
   const seen=new Set();let sum=0n;
   for(const a of batch.allocations){requireThat(object(a)&&positive(a.expenseId)&&expenses.has(a.expenseId)&&!seen.has(a.expenseId)&&positive(a.amount)&&a.amount<=expenses.get(a.expenseId).amount,'分配引用、金额或重复项无效');seen.add(a.expenseId);sum+=BigInt(a.amount);}
   requireThat(sum<=BigInt(Number.MAX_SAFE_INTEGER),'批次合计超过安全整数');
  }
  for(const batch of state.batches){
   validateBatch(batch);requireThat(!batchIds.has(batch.id),'重复批次编号');batchIds.add(batch.id);allocationCount+=batch.allocations.length;
   if(batch.active)for(const a of batch.allocations){const value=(used.get(a.expenseId)||0n)+BigInt(a.amount);requireThat(value<=BigInt(expenses.get(a.expenseId).amount),'有效分配超过费用金额');used.set(a.expenseId,value);reimbursed+=BigInt(a.amount);}
  }
  const operationMap=new Map();
  for(const op of operations){requireThat(UUID.test(op.id)&&HASH.test(op.digest)&&['expense','advance','batch','cancel','delete-batch'].includes(op.kind)&&timestamp(op.created_at),'请求操作记录无效');operationMap.set(op.id,op);}
  const events=state.batchEvents===undefined?[]:state.batchEvents;requireThat(Array.isArray(events),'批次删除审计无效');const deletedIds=new Set(),eventRequests=new Set();let deletedAllocationCount=0;
  for(const event of events){
   requireThat(object(event)&&event.action==='delete-batch'&&positive(event.batchId)&&!batchIds.has(event.batchId)&&!deletedIds.has(event.batchId)&&UUID.test(event.requestId)&&!eventRequests.has(event.requestId)&&timestamp(event.at)&&event.after===null,'批次删除审计无效');
   validateBatch(event.before);requireThat(event.before.id===event.batchId,'删除审计批次不一致');
   const op=operationMap.get(event.requestId);requireThat(op&&op.kind==='delete-batch'&&op.created_at===event.at,'删除审计缺少对应请求操作');
   deletedIds.add(event.batchId);eventRequests.add(event.requestId);deletedAllocationCount+=event.before.allocations.length;
  }
  for(const op of operations)if(op.kind==='delete-batch')requireThat(eventRequests.has(op.id),'删除请求缺少审计事实');
  for(const row of attachments){
   const extension=imageName(row.file);requireThat(UUID.test(row.id)&&row.file===`${row.id}.${extension}`&&HASH.test(row.sha256)&&positive(row.size)&&row.size<=MAX_IMAGE&&row.mime===(extension==='png'?'image/png':'image/jpeg')&&!attachmentNames.has(row.file.toLowerCase()),'附件元数据无效');
   attachmentIds.add(row.id);attachmentNames.add(row.file.toLowerCase());
  }
  for(const id of references)requireThat(attachmentIds.has(id),'附件引用缺少元数据');
  requireThat(expenseTotal<=BigInt(Number.MAX_SAFE_INTEGER)&&advanceTotal<=BigInt(Number.MAX_SAFE_INTEGER),'账本金钱合计超过安全整数');
  const balance=advanceTotal-expenseTotal;
  return {attachments,references,schemaSha256:hash(Buffer.from(JSON.stringify(schema))),summary:{expenseCount:expenses.size,advanceCount:state.advances.length,batchCount:state.batches.length,activeBatchCount:state.batches.filter(b=>b.active).length,cancelledBatchCount:state.batches.filter(b=>!b.active).length,deletedBatchCount:events.length,allocationCount,deletedAllocationCount,operationCount:operations.length,attachmentCount:attachments.length,totalExpenseCents:expenseTotal.toString(),totalAdvanceCents:advanceTotal.toString(),balanceCents:balance.toString(),personalFundingCents:(balance<0n?-balance:0n).toString(),reimbursedCents:reimbursed.toString(),pendingCents:(expenseTotal-reimbursed).toString()}};
 }finally{db.close();}
}
function attachmentInventory(root,inspection,copyTo){
 const canonical=directory(root);requireThat(canonical===path.resolve(root),'附件目录包含符号链接');
 const rows=new Map(inspection.attachments.map(row=>[row.file,row])),files=[],seen=new Set();
 for(const name of fs.readdirSync(root).sort()){
  imageName(name);requireThat(!seen.has(name.toLowerCase()),'附件文件名大小写冲突');seen.add(name.toLowerCase());
  const bytes=imageBytes(path.join(root,name),name),sha256=hash(bytes),row=rows.get(name);
  if(row)requireThat(row.size===bytes.length&&row.sha256===sha256,'附件缺失或校验值不匹配');
  if(copyTo)writeFile(path.join(copyTo,name),bytes);
  files.push({path:`attachments/${name}`,size:bytes.length,sha256,registered:!!row,referenced:!!row&&inspection.references.has(row.id)});
 }
 for(const name of rows.keys())requireThat(seen.has(name.toLowerCase()),'附件元数据对应文件缺失');
 return files;
}
function result(directory,manifest,ledgerId=manifest.ledgerId){return {directory,backupId:manifest.backupId,ledgerId,summary:manifest.summary,manifest};}
function rejectPendingReset(source){requireThat(!fs.lstatSync(path.join(source,'reset-journal.json'),{throwIfNoEntry:false}),'账本清空尚未完成，请完成恢复处理后再备份');}
async function createBackup({db,dataDir,destinationParent,ledgerId,sourceKind}){
 requireThat(UUID.test(ledgerId)&&sourceKind==='isolated-test','只支持有明确标识的隔离账本');
 const source=directory(dataDir);rejectPendingReset(source);const parent=directory(destinationParent);
 requireThat(!inside(source,parent),'备份目标不能位于账本目录内');
 requireThat(db&&db.open&&fs.realpathSync(db.name)===path.join(source,'trial.sqlite'),'数据库连接与来源目录不一致');
 fileBytes(path.join(source,'trial.sqlite'),MAX_DB);directory(path.join(source,'attachments'));
 const backupId=randomUUID(),partial=fs.mkdtempSync(path.join(parent,'.partial-backup-')),target=path.join(parent,`backup-${backupId}`);let published=false;
 try{
  await db.backup(path.join(partial,'database.sqlite'));
  rejectPendingReset(source);
  // Normalize only the completed copy; never checkpoint or rewrite the source ledger.
  const copy=new Database(path.join(partial,'database.sqlite'),{fileMustExist:true});
  try{copy.pragma('journal_mode = DELETE');}finally{copy.close();}
  const inspection=inspectDatabase(path.join(partial,'database.sqlite'));
  fs.mkdirSync(path.join(partial,'attachments'),{mode:0o700});
  const attachments=attachmentInventory(path.join(source,'attachments'),inspection,path.join(partial,'attachments'));
  const bytes=fileBytes(path.join(partial,'database.sqlite'),MAX_DB);
  const manifest={format:FORMAT,formatVersion:VERSION,applicationVersion:APPLICATION_VERSION,sourceRevision:null,backupId,ledgerId,sourceKind,schema:SCHEMA,schemaSha256:inspection.schemaSha256,createdAt:new Date().toISOString(),database:{path:'database.sqlite',size:bytes.length,sha256:hash(bytes)},attachments,summary:{...inspection.summary,attachmentFileCount:attachments.length}};
  const serialized=Buffer.from(JSON.stringify(manifest,null,2)+'\n');requireThat(serialized.length<=MAX_MANIFEST,'附件清单超过支持大小');
  writeFile(path.join(partial,'manifest.json'),serialized);writeFile(path.join(partial,'COMPLETE'),JSON.stringify({backupId,manifestSha256:hash(serialized)})+'\n');
  verifyContents(partial);syncDirectory(path.join(partial,'attachments'));syncDirectory(partial);
  rejectPendingReset(source);
  publishDirectory(partial,target,'COMPLETE');published=true;fs.rmSync(partial,{recursive:true});return result(target,manifest);
 }catch(e){if(published)e.publishedDirectory=target;try{if(fs.existsSync(partial))fs.rmSync(partial,{recursive:true,force:true});}catch{e.incompleteDirectory=partial;}throw e;}
}
function verifyContents(root){
 exactNames(root,['database.sqlite','attachments','manifest.json','COMPLETE']);
 const manifestBytes=fileBytes(path.join(root,'manifest.json'),MAX_MANIFEST),manifest=JSON.parse(manifestBytes.toString('utf8')),complete=jsonFile(path.join(root,'COMPLETE'),1024);
 requireThat(object(manifest)&&manifest.format===FORMAT&&manifest.formatVersion===VERSION&&manifest.schema===SCHEMA&&manifest.sourceKind==='isolated-test'&&UUID.test(manifest.backupId)&&UUID.test(manifest.ledgerId)&&timestamp(manifest.createdAt)&&HASH.test(manifest.schemaSha256)&&safeText(manifest.applicationVersion,100,true)&&(manifest.sourceRevision===null||/^[a-f0-9]{40}$/.test(manifest.sourceRevision)),'备份格式或版本不支持');
 same(Object.keys(manifest).sort(),['format','formatVersion','applicationVersion','sourceRevision','backupId','ledgerId','sourceKind','schema','schemaSha256','createdAt','database','attachments','summary'].sort(),'备份清单包含未知字段');
 same(complete,{backupId:manifest.backupId,manifestSha256:hash(manifestBytes)},'备份完成标记或清单哈希不匹配');
 const bytes=fileBytes(path.join(root,'database.sqlite'),MAX_DB);
 same(manifest.database,{path:'database.sqlite',size:bytes.length,sha256:hash(bytes)},'数据库文件校验不匹配');
 const inspection=inspectDatabase(path.join(root,'database.sqlite'));
 requireThat(inspection.schemaSha256===manifest.schemaSha256,'数据库结构指纹不匹配');
 const attachments=attachmentInventory(path.join(root,'attachments'),inspection);
 same(manifest.attachments,attachments,'附件清单与完整文件集不匹配');
 same(manifest.summary,{...inspection.summary,attachmentFileCount:attachments.length},'备份金额或计数摘要不匹配');
 return result(root,manifest);
}
function verifyBackup(backupDir){
 const root=directory(backupDir);requireThat(!path.basename(root).startsWith('.partial-'),'未发布的暂存目录不能恢复');return verifyContents(root);
}
function restoreBackup({backupDir,targetDir}){
 const verified=verifyBackup(backupDir),source=verified.directory;
 requireThat(typeof targetDir==='string'&&!!targetDir&&!targetDir.includes('\0'),'恢复目标无效');
 const requested=path.resolve(targetDir),parent=directory(path.dirname(requested)),target=path.join(parent,path.basename(requested));
 requireThat(!inside(source,target)&&!inside(target,source),'恢复目标不能与备份目录重叠');
 requireThat(!fs.existsSync(target)&&!fs.lstatSync(target,{throwIfNoEntry:false}),'恢复目标必须是不存在的新目录');
 const partial=fs.mkdtempSync(path.join(parent,'.partial-restore-')),ledgerId=randomUUID();let published=false;
 try{
  writeFile(path.join(partial,'trial.sqlite'),fileBytes(path.join(source,'database.sqlite'),MAX_DB));
  fs.mkdirSync(path.join(partial,'attachments'),{mode:0o700});
  for(const item of verified.manifest.attachments){const name=item.path.slice('attachments/'.length);writeFile(path.join(partial,'attachments',name),imageBytes(path.join(source,'attachments',name),name));}
  const inspection=inspectDatabase(path.join(partial,'trial.sqlite')),attachments=attachmentInventory(path.join(partial,'attachments'),inspection);
  same(attachments,verified.manifest.attachments,'恢复后附件不一致');
  requireThat(hash(fileBytes(path.join(partial,'trial.sqlite'),MAX_DB))===verified.manifest.database.sha256,'恢复后完整数据库内容不一致');
  same({...inspection.summary,attachmentFileCount:attachments.length},verified.summary,'恢复后账目不一致');
  writeFile(path.join(partial,'managed-ledger.json'),JSON.stringify({formatVersion:1,ledgerId,sourceKind:'isolated-test'},null,2)+'\n');
  syncDirectory(path.join(partial,'attachments'));syncDirectory(partial);
  publishDirectory(partial,target,'managed-ledger.json');published=true;fs.rmSync(partial,{recursive:true});
  return result(target,verified.manifest,ledgerId);
 }catch(e){if(published)e.publishedDirectory=target;try{if(fs.existsSync(partial))fs.rmSync(partial,{recursive:true,force:true});}catch{e.incompleteDirectory=partial;}throw e;}
}
module.exports={createBackup,verifyBackup,restoreBackup,inspectDatabase};
