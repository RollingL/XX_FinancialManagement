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
// Windows FlushFileBuffers requires a writable handle; these are newly copied owned files.
function syncFile(file){const fd=fs.openSync(file,fs.constants.O_RDWR|(fs.constants.O_NOFOLLOW||0));try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
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
  function validateExpense(e){
   requireThat(object(e)&&positive(e.id)&&positive(e.amount)&&validDate(e.date)&&['接待','办公'].includes(e.category)&&safeText(e.merchant,100,true)&&safeText(e.note,500)&&Number.isSafeInteger(e.invoice)&&e.invoice>=0&&e.invoice<=e.amount,'费用记录无效');
   if(e.attachmentId!==undefined)requireThat(typeof e.attachmentId==='string'&&UUID.test(e.attachmentId),'费用附件标识无效');
  }
  for(const e of state.expenses){
   validateExpense(e);requireThat(!expenses.has(e.id),'重复费用编号');
   expenses.set(e.id,e);expenseTotal+=BigInt(e.amount);addReference(e.attachmentId);
  }
  for(const [index,amount] of state.advances.entries()){requireThat(positive(amount)||(amount===0&&state.advanceDetails?.[index]?.deleted===true),'预支金额无效');advanceTotal+=BigInt(amount);}
  if(state.advanceDetails!==undefined){
   requireThat(object(state.advanceDetails),'预支元数据无效');
   for(const [index,detail] of Object.entries(state.advanceDetails)){
    requireThat(/^(0|[1-9]\d*)$/.test(index)&&Number.isSafeInteger(Number(index))&&Number(index)<state.advances.length&&object(detail)&&(detail.deleted===true?(state.advances[Number(index)]===0&&(Object.keys(detail).join(',')==='deleted'||(validDate(detail.date)&&safeText(detail.note,500)&&timestamp(detail.createdAt)))):validDate(detail.date)&&safeText(detail.note,500)&&timestamp(detail.createdAt)),'预支元数据索引、日期或字段无效');addReference(detail.attachmentId);
   }
  }
  const knownExpenseIds=new Set([...expenses.keys(),...(Array.isArray(state.expenseEvents)?state.expenseEvents:[]).map(event=>event?.before?.id).filter(positive)]);
  function validateBatch(batch,historical=false){
   requireThat(object(batch)&&positive(batch.id)&&validDate(batch.date)&&typeof batch.active==='boolean'&&batch.deleted===undefined&&Array.isArray(batch.allocations)&&batch.allocations.length>0,'批次记录无效或含不支持的软删除字段');
   const seen=new Set();let sum=0n;
   for(const a of batch.allocations){requireThat(object(a)&&positive(a.expenseId)&&knownExpenseIds.has(a.expenseId)&&!seen.has(a.expenseId)&&positive(a.amount)&&(historical||!batch.active||(expenses.has(a.expenseId)&&a.amount<=expenses.get(a.expenseId).amount)),'分配引用、金额或重复项无效');seen.add(a.expenseId);sum+=BigInt(a.amount);}
   requireThat(sum<=BigInt(Number.MAX_SAFE_INTEGER),'批次合计超过安全整数');
   if(batch.invoiceLinks!==undefined){
    requireThat(Array.isArray(batch.invoiceLinks),'批次发票关联无效');const invoicesSeen=new Set();
    for(const link of batch.invoiceLinks){requireThat(object(link)&&positive(link.invoiceId)&&!invoicesSeen.has(link.invoiceId)&&Array.isArray(link.expenseIds)&&link.expenseIds.length>0&&link.expenseIds.every(id=>positive(id)&&seen.has(id))&&new Set(link.expenseIds).size===link.expenseIds.length,'批次发票引用或费用关联无效');same(Object.keys(link).sort(),['expenseIds','invoiceId'],'批次发票关联包含未知字段');invoicesSeen.add(link.invoiceId);}
   }

  }
  for(const batch of state.batches){
   validateBatch(batch);requireThat(!batchIds.has(batch.id),'重复批次编号');batchIds.add(batch.id);allocationCount+=batch.allocations.length;
   if(batch.active)for(const a of batch.allocations){const value=(used.get(a.expenseId)||0n)+BigInt(a.amount);requireThat(value<=BigInt(expenses.get(a.expenseId).amount),'有效分配超过费用金额');used.set(a.expenseId,value);reimbursed+=BigInt(a.amount);}
  }
  const operationMap=new Map();
  const invoiceActions=['invoice','invoice-identity','invoice-attachment','invoice-allocate','invoice-link','invoice-edit','invoice-delete'];
  const sharedInvoiceActions=['batch-invoice-link','expense-invoice-unlink'];
  for(const op of operations){requireThat(UUID.test(op.id)&&HASH.test(op.digest)&&['expense','advance','batch','cancel','delete-batch','correct-expense','delete-expense','correct-advance','delete-advance',...invoiceActions].includes(op.kind)&&timestamp(op.created_at),'请求操作记录无效');operationMap.set(op.id,op);}
  const corrections=state.expenseEvents===undefined?[]:state.expenseEvents;requireThat(Array.isArray(corrections),'费用纠错审计无效');
  const correctionRequests=new Set(),latestCorrection=new Map(),editable=new Set(['category','date','merchant','amount','note']);
  const stableFields=expense=>Object.fromEntries(Object.entries(expense).filter(([key])=>!editable.has(key)));
  for(const event of corrections){
   requireThat(object(event)&&['correct-expense','delete-expense'].includes(event.action)&&typeof event.requestId==='string'&&UUID.test(event.requestId)&&!correctionRequests.has(event.requestId)&&timestamp(event.at)&&positive(event.expenseId)&&positive(event.revision),'费用纠错审计字段无效');
   same(Object.keys(event).sort(),['requestId','action','at','expenseId','revision','before','after'].sort(),'费用纠错审计包含未知字段');
   validateExpense(event.before);addReference(event.before.attachmentId);if(event.action==='delete-expense'){requireThat(event.after===null,'费用删除审计 after 无效');}else validateExpense(event.after);
   requireThat(event.before.id===event.expenseId&&(event.after===null||event.after.id===event.expenseId),'费用纠错审计编号或票额无效');
   if(event.after)same(stableFields(event.before),stableFields(event.after),'费用纠错改变了编号、附件、票额或旧元数据');
   requireThat(!isDeepStrictEqual(event.before,event.after),'费用纠错前后没有变化');
   const previous=latestCorrection.get(event.expenseId);
   requireThat(event.revision===(previous?previous.revision+1:1),'费用纠错修订顺序无效');
   if(previous){requireThat(previous.after!==null,'已删除费用不能再次修改');same(event.before,previous.after,'费用纠错前后审计链不连续');}
   const op=operationMap.get(event.requestId);requireThat(op&&op.kind===event.action&&op.created_at===event.at,'费用纠错审计缺少对应请求操作');
   correctionRequests.add(event.requestId);latestCorrection.set(event.expenseId,event);
  }
  for(const [id,event] of latestCorrection)if(event.after===null)requireThat(!expenses.has(id),'已删除费用仍存在');else same(event.after,expenses.get(id),'费用纠错最后修订与当前费用不一致');
  for(const op of operations)if(['correct-expense','delete-expense'].includes(op.kind))requireThat(correctionRequests.has(op.id),'费用纠错请求缺少审计事实');
  const advanceEvents=state.advanceEvents===undefined?[]:state.advanceEvents;requireThat(Array.isArray(advanceEvents),'预支审计无效');
  const advanceRequests=new Set(),advanceLatest=new Map();
  function validateAdvanceSnapshot(value){requireThat(object(value)&&positive(value.amount)&&(value.details===null||object(value.details)),'预支审计快照无效');same(Object.keys(value).sort(),['amount','details'],'预支审计快照包含未知字段');if(value.details){same(Object.keys(value.details).filter(key=>key!=='attachmentId').sort(),['createdAt','date','note'],'预支审计元数据包含未知字段');requireThat(validDate(value.details.date)&&safeText(value.details.note,500)&&timestamp(value.details.createdAt)&&value.details.deleted===undefined,'预支审计元数据无效');addReference(value.details.attachmentId);}}
  for(const event of advanceEvents){
   requireThat(object(event)&&['correct-advance','delete-advance'].includes(event.action)&&UUID.test(event.requestId)&&!advanceRequests.has(event.requestId)&&timestamp(event.at)&&Number.isSafeInteger(event.advanceId)&&event.advanceId>=0&&event.advanceId<state.advances.length&&positive(event.revision),'预支审计字段无效');
   same(Object.keys(event).sort(),['requestId','action','at','advanceId','revision','before','after'].sort(),'预支审计包含未知字段');validateAdvanceSnapshot(event.before);
   if(event.action==='delete-advance')requireThat(event.after===null,'预支删除审计无效');else{validateAdvanceSnapshot(event.after);requireThat(!isDeepStrictEqual(event.before,event.after),'预支修改没有变化');if(event.before.details){requireThat(event.after.details!==null,'预支修改不能删除元数据');same({createdAt:event.before.details.createdAt,attachmentId:event.before.details.attachmentId},{createdAt:event.after.details.createdAt,attachmentId:event.after.details.attachmentId},'预支修改改变了操作时间或附件');}}
   const previous=advanceLatest.get(event.advanceId);requireThat(event.revision===(previous?previous.revision+1:1),'预支修订顺序无效');if(previous){requireThat(previous.after!==null,'已删预支不能修改');same(event.before,previous.after,'预支审计链不连续');}
   const op=operationMap.get(event.requestId);requireThat(op&&op.kind===event.action&&op.created_at===event.at,'预支审计缺少操作');advanceLatest.set(event.advanceId,event);advanceRequests.add(event.requestId);
  }
  for(const [id,event] of advanceLatest)if(event.after===null){requireThat(state.advances[id]===0&&state.advanceDetails?.[id]?.deleted===true,'已删预支当前状态不一致');same(state.advanceDetails[id],{...(event.before.details??{}),deleted:true},'已删预支元数据不一致');}else same({amount:state.advances[id],details:state.advanceDetails?.[id]??null},event.after,'预支最后修订不一致');
  for(const op of operations)if(['correct-advance','delete-advance'].includes(op.kind))requireThat(advanceRequests.has(op.id),'预支操作缺少审计');
  for(const [id,detail] of Object.entries(state.advanceDetails??{}))if(detail.deleted===true)requireThat(advanceLatest.get(Number(id))?.after===null,'预支删除缺少审计');
  const events=state.batchEvents===undefined?[]:state.batchEvents;requireThat(Array.isArray(events),'批次删除审计无效');const deletedIds=new Set(),eventRequests=new Set();let deletedAllocationCount=0;
  for(const event of events){
   requireThat(object(event)&&event.action==='delete-batch'&&positive(event.batchId)&&!batchIds.has(event.batchId)&&!deletedIds.has(event.batchId)&&UUID.test(event.requestId)&&!eventRequests.has(event.requestId)&&timestamp(event.at)&&event.after===null,'批次删除审计无效');
   validateBatch(event.before,true);requireThat(event.before.id===event.batchId,'删除审计批次不一致');
   const op=operationMap.get(event.requestId);requireThat(op&&op.kind==='delete-batch'&&op.created_at===event.at,'删除审计缺少对应请求操作');
   deletedIds.add(event.batchId);eventRequests.add(event.requestId);deletedAllocationCount+=event.before.allocations.length;
  }
  for(const op of operations)if(op.kind==='delete-batch')requireThat(eventRequests.has(op.id),'删除请求缺少审计事实');
  for(const row of attachments){
   const extension=imageName(row.file);requireThat(UUID.test(row.id)&&row.file===`${row.id}.${extension}`&&HASH.test(row.sha256)&&positive(row.size)&&row.size<=MAX_IMAGE&&row.mime===(extension==='png'?'image/png':'image/jpeg')&&!attachmentNames.has(row.file.toLowerCase()),'附件元数据无效');
   attachmentIds.add(row.id);attachmentNames.add(row.file.toLowerCase());
  }
  const invoices=state.invoices===undefined?[]:state.invoices,invoiceEvents=state.invoiceEvents===undefined?[]:state.invoiceEvents;
  requireThat(Array.isArray(invoices)&&Array.isArray(invoiceEvents),'发票记录或审计无效');
  const attachmentMap=new Map(attachments.map(row=>[row.id,row])),cashReferences=new Set(references);
  const invoiceKeys=['id','identityType','number','code','date','seller','buyer','amount','note','attachmentIds','allocations','revision','createdAt'].sort();
  const normalizedIdentity=value=>typeof value==='string'&&value===value.trim().normalize('NFKC').replace(/\s/g,'').toUpperCase().normalize('NFKC')&&value.length<=100;
  const linkedIds=invoice=>invoice.expenseIds??invoice.allocations.map(item=>item.expenseId);
  function validateInvoice(invoice,historical=false){
   requireThat(object(invoice),'发票记录无效');same(Object.keys(invoice).filter(key=>key!=='expenseIds').sort(),invoiceKeys,'发票记录包含未知或缺失字段');if(invoice.expenseIds!==undefined){requireThat(Array.isArray(invoice.expenseIds)&&invoice.expenseIds.every(positive)&&new Set(invoice.expenseIds).size===invoice.expenseIds.length,'发票关联费用无效');}
   requireThat(positive(invoice.id)&&positive(invoice.revision)&&positive(invoice.amount)&&validDate(invoice.date)&&timestamp(invoice.createdAt)&&safeText(invoice.seller,200)&&safeText(invoice.buyer,200)&&safeText(invoice.note,500)&&normalizedIdentity(invoice.number)&&normalizedIdentity(invoice.code),'发票字段或金额无效');
   requireThat(['unconfirmed','number','code-number'].includes(invoice.identityType)&&(invoice.identityType!=='number'||(!!invoice.number&&!invoice.code))&&(invoice.identityType!=='code-number'||(!!invoice.number&&!!invoice.code)),'发票身份字段无效');
   requireThat(Array.isArray(invoice.attachmentIds)&&invoice.attachmentIds.length>0&&Array.isArray(invoice.allocations),'发票附件或分配无效');
   const ids=new Set(),hashes=new Set(),allocated=new Set();let sum=0n;
   for(const id of invoice.attachmentIds){
    const row=attachmentMap.get(id);requireThat(typeof id==='string'&&UUID.test(id)&&row&&!ids.has(id)&&!cashReferences.has(id)&&!hashes.has(row.sha256),'发票附件缺失、重复或混用了资金截图');
    ids.add(id);hashes.add(row.sha256);addReference(id);
   }
   requireThat(invoice.identityType!=='unconfirmed'||linkedIds(invoice).length===0,'待核对发票不能关联');for(const id of linkedIds(invoice))requireThat((historical?knownExpenseIds:expenses).has(id),'发票关联费用不存在');
   for(const allocation of invoice.allocations){
    requireThat(object(allocation)&&positive(allocation.expenseId)&&!allocated.has(allocation.expenseId)&&positive(allocation.amount),'发票分配引用或金额无效');
    same(Object.keys(allocation).sort(),['amount','expenseId'],'发票分配包含未知或缺失字段');allocated.add(allocation.expenseId);sum+=BigInt(allocation.amount);
   }
   // Legacy amounts are historical metadata; associations no longer carry monetary limits.
  }
  const registry=()=>({records:new Map(),identities:new Map(),hashes:new Map(),allocations:new Map(),amount:0n});
  function registerInvoice(invoice,index,historical=false){
   validateInvoice(invoice,historical);requireThat(!index.records.has(invoice.id),'重复发票编号');
   index.amount+=BigInt(invoice.amount);requireThat(index.amount<=BigInt(Number.MAX_SAFE_INTEGER),'发票票面总额超过安全整数');
   if(invoice.number){
    const codes=index.identities.get(invoice.number)||new Map();
    requireThat(!codes.size||(!!invoice.code&&!codes.has('')&&!codes.has(invoice.code)),'发票号码重复或与已有待核对号码冲突');
    codes.set(invoice.code,invoice.id);index.identities.set(invoice.number,codes);
   }
   for(const id of invoice.attachmentIds){const sha=attachmentMap.get(id).sha256;requireThat(!index.hashes.has(sha),'不同发票重复使用相同图像');index.hashes.set(sha,invoice.id);}
   index.records.set(invoice.id,invoice);
  }
  function unregisterInvoice(invoice,index){
   index.records.delete(invoice.id);index.amount-=BigInt(invoice.amount);
   if(invoice.number){const codes=index.identities.get(invoice.number);codes.delete(invoice.code);if(!codes.size)index.identities.delete(invoice.number);}
   for(const id of invoice.attachmentIds)index.hashes.delete(attachmentMap.get(id).sha256);

  }
  const currentInvoices=registry(),historicInvoices=registry(),invoiceRequests=new Set(),createdInvoiceIds=new Set();
  for(const invoice of invoices)registerInvoice(invoice,currentInvoices);
  const unchangedInvoiceFields=(invoice,mutable)=>Object.fromEntries(Object.entries(invoice).filter(([key])=>key!=='revision'&&!mutable.includes(key)));
  for(const event of invoiceEvents){
   requireThat(object(event)&&[...invoiceActions,...sharedInvoiceActions].includes(event.action)&&typeof event.requestId==='string'&&UUID.test(event.requestId)&&(sharedInvoiceActions.includes(event.action)||!invoiceRequests.has(event.requestId))&&timestamp(event.at)&&positive(event.invoiceId)&&positive(event.revision),'发票审计字段无效');
   same(Object.keys(event).sort(),['requestId','action','at','invoiceId','revision','before','after'].sort(),'发票审计包含未知或缺失字段');
   if(event.after!==null){validateInvoice(event.after,true);requireThat(event.after.id===event.invoiceId&&event.after.revision===event.revision,'发票审计编号或修订不一致');}else requireThat(event.action==='invoice-delete','仅删除可为空审计');
   const previous=historicInvoices.records.get(event.invoiceId);
   if(event.action==='invoice'){
    requireThat(!previous&&!createdInvoiceIds.has(event.invoiceId)&&event.before===null&&event.revision===1&&event.after.createdAt===event.at&&event.after.allocations.length===0&&event.after.attachmentIds.length===1&&linkedIds(event.after).length===0,'新增发票审计无效');createdInvoiceIds.add(event.invoiceId);
   }else{
    requireThat(previous&&event.revision===previous.revision+1,'发票修订顺序无效');same(event.before,previous,'发票前后审计链不连续');
    if(event.action==='invoice-delete'){requireThat(event.after===null,'发票删除审计无效');}
    else if(event.action==='invoice-edit'){same(unchangedInvoiceFields(previous,['identityType','number','code','date','seller','buyer','amount','note']),unchangedInvoiceFields(event.after,['identityType','number','code','date','seller','buyer','amount','note']),'发票编辑改变了关联或附件');requireThat(!isDeepStrictEqual(previous,event.after),'发票编辑没有变化');}
    else if(event.action==='invoice-identity'){
     requireThat(previous.identityType==='unconfirmed'&&['number','code-number'].includes(event.after.identityType),'发票身份只能从待核对确认');
     same(unchangedInvoiceFields(previous,['identityType','number','code']),unchangedInvoiceFields(event.after,['identityType','number','code']),'确认发票改变了其他字段');
    }else if(event.action==='invoice-attachment'){
     same(unchangedInvoiceFields(previous,['attachmentIds']),unchangedInvoiceFields(event.after,['attachmentIds']),'补充发票图像改变了其他字段');
     requireThat(event.after.attachmentIds.length===previous.attachmentIds.length+1,'发票补图必须仅追加一张');same(event.after.attachmentIds.slice(0,-1),previous.attachmentIds,'发票补图改变了原有附件');
    }else{
     same(unchangedInvoiceFields(previous,['allocations','expenseIds']),unchangedInvoiceFields(event.after,['allocations','expenseIds']),'发票分配改变了其他字段');requireThat(!isDeepStrictEqual({allocations:previous.allocations,expenseIds:previous.expenseIds},{allocations:event.after.allocations,expenseIds:event.after.expenseIds}),'发票分配没有变化');
    }
    unregisterInvoice(previous,historicInvoices);
   }
   const op=operationMap.get(event.requestId);requireThat(op&&op.kind===(event.action==='batch-invoice-link'?'batch':event.action==='expense-invoice-unlink'?'delete-expense':event.action)&&op.created_at===event.at,'发票审计缺少对应请求操作');
   // Replay all invoices together so an old over-allocation cannot be hidden by a later release.
   if(event.after!==null)registerInvoice(event.after,historicInvoices,true);invoiceRequests.add(event.requestId);
  }
  same([...historicInvoices.records.keys()].sort((a,b)=>a-b),invoices.map(i=>i.id).sort((a,b)=>a-b),'发票审计当前集合不一致');
  for(const invoice of invoices)same(historicInvoices.records.get(invoice.id),invoice,'发票最后修订与当前记录不一致或缺少审计');
  for(const op of operations)if(invoiceActions.includes(op.kind))requireThat(invoiceRequests.has(op.id),'发票请求缺少审计事实');
  for(const id of references)requireThat(attachmentIds.has(id),'附件引用缺少元数据');
  requireThat(expenseTotal<=BigInt(Number.MAX_SAFE_INTEGER)&&advanceTotal<=BigInt(Number.MAX_SAFE_INTEGER),'账本金钱合计超过安全整数');
  const balance=advanceTotal-expenseTotal;
  return {attachments,references,invoiceCount:invoices.length,schemaSha256:hash(Buffer.from(JSON.stringify(schema))),summary:{expenseCount:expenses.size,advanceCount:state.advances.filter(amount=>amount>0).length,batchCount:state.batches.length,activeBatchCount:state.batches.filter(b=>b.active).length,cancelledBatchCount:state.batches.filter(b=>!b.active).length,deletedBatchCount:events.length,allocationCount,deletedAllocationCount,operationCount:operations.length,attachmentCount:attachments.length,totalExpenseCents:expenseTotal.toString(),totalAdvanceCents:advanceTotal.toString(),balanceCents:balance.toString(),personalFundingCents:(balance<0n?-balance:0n).toString(),reimbursedCents:reimbursed.toString(),pendingCents:(expenseTotal-reimbursed).toString()}};
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
