// Stage 0 local trial ledger: deliberately no migrations, imports or production recovery UI.
const fs=require('node:fs');
const path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const Database=require('better-sqlite3');
const {imageSuffix,MAX_BYTES}=require('./ocr-service.cjs');
const fail=message=>{throw Object.assign(Error(message),{status:422});};
function amount(n){if(!Number.isSafeInteger(n)||n<=0)fail('金额须为安全范围内的正整数分');return n;}
function total(values){const n=values.reduce((a,b)=>a+BigInt(b),0n);if(n>BigInt(Number.MAX_SAFE_INTEGER))fail('金额合计超出安全范围');return Number(n);}
function text(s,max,required=true){if(typeof s!=='string'||s.length>max||(required&&!s.trim()))fail('文本字段无效');return s.trim();}
function date(s){if(typeof s!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(s)||!Number.isFinite(Date.parse(s))||new Date(s).toISOString().slice(0,10)!==s)fail('日期无效');return s;}
function createLedger(root,service){
 fs.mkdirSync(root,{recursive:true,mode:0o700});
 const attachments=path.join(root,'attachments');fs.mkdirSync(attachments,{recursive:true,mode:0o700});
 const db=new Database(path.join(root,'trial.sqlite'));db.pragma('journal_mode = WAL');db.pragma('synchronous = FULL');
 db.exec(`CREATE TABLE IF NOT EXISTS trial_state (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, digest TEXT NOT NULL, kind TEXT NOT NULL, created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, file TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL, mime TEXT NOT NULL);`);
 db.prepare('INSERT OR IGNORE INTO trial_state VALUES(1,?)').run(JSON.stringify({expenses:[],batches:[],advances:[]}));
 const read=()=>JSON.parse(db.prepare('SELECT json FROM trial_state WHERE id=1').get().json);
 let busy=false;
 async function command(input){
  if(!input||typeof input!=='object')fail('请求无效');
  if(input.kind==='read')return read();
  if(input.kind==='attachment'){
   if(typeof input.id!=='string')fail('附件编号无效');
   const record=db.prepare('SELECT * FROM attachments WHERE id=?').get(input.id);if(!record)fail('附件不存在');
   const bytes=fs.readFileSync(path.join(attachments,record.file));
   if(bytes.length!==record.size||createHash('sha256').update(bytes).digest('hex')!==record.sha256)fail('附件损坏，请保留现有数据并检查备份');
   return {mime:record.mime,base64:bytes.toString('base64')};
  }
  if(busy)fail('正在保存，请稍后再试');busy=true;
  let savedFile,committed=false;
  try{
   if(!['expense','batch','cancel'].includes(input.kind)||typeof input.requestId!=='string'||!/^[a-f0-9-]{36}$/.test(input.requestId))fail('保存请求无效');
   const digest=createHash('sha256').update(JSON.stringify(input)).digest('hex');
   const previous=db.prepare('SELECT digest FROM operations WHERE id=?').get(input.requestId);
   if(previous){if(previous.digest!==digest)fail('重复请求内容不一致，请重新打开面板');return read();}
   let attachment;
   if(input.kind==='expense'){
    const e=input.expense;if(!e||!['接待','办公'].includes(e.category))fail('费用类别无效');
    date(e.date);text(e.merchant,100);text(e.note,500,false);amount(e.amount);
    if(input.image){
     if(typeof input.image.base64!=='string'||input.image.base64.length>Math.ceil(MAX_BYTES/3)*4||!/^[A-Za-z0-9+/]+={0,2}$/.test(input.image.base64))fail('附件无效');
     const bytes=Buffer.from(input.image.base64,'base64'),suffix=imageSuffix(bytes);
     await service.recognize(bytes,{validateOnly:true});
     const id=randomUUID(),file=id+suffix;
     const fd=fs.openSync(path.join(attachments,file),'wx',0o600);savedFile=path.join(attachments,file);
     try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
     attachment={id,file,size:bytes.length,mime:suffix==='.png'?'image/png':'image/jpeg',sha256:createHash('sha256').update(bytes).digest('hex')};
    }
   }
   const result=db.transaction(()=>{
    const state=read();
    if(input.kind==='expense'){
     const e=input.expense;total([...state.expenses.map(e=>e.amount),e.amount]);
     const id=Math.max(0,...state.expenses.map(e=>e.id))+1;
     state.expenses.push({id,category:e.category,date:e.date,merchant:e.merchant.trim(),amount:e.amount,note:e.note.trim(),invoice:0,...(attachment?{attachmentId:attachment.id}:{})});
     if(attachment)db.prepare('INSERT INTO attachments VALUES(@id,@file,@sha256,@size,@mime)').run(attachment);
    }else if(input.kind==='batch'){
     date(input.date);if(!Array.isArray(input.allocations)||!input.allocations.length||input.allocations.length>state.expenses.length)fail('分配无效');
     const seen=new Set();
     for(const a of input.allocations){
      const e=state.expenses.find(e=>e.id===a.expenseId);if(!e||seen.has(a.expenseId))fail('费用不存在或重复分配');seen.add(a.expenseId);amount(a.amount);
      const paid=total(state.batches.filter(b=>b.active).flatMap(b=>b.allocations.filter(x=>x.expenseId===e.id).map(x=>x.amount)));
      if(a.amount>e.amount-paid)fail('分配超过当前待报销额，请刷新后重试');
     }
     const allocations=input.allocations.map(a=>({expenseId:a.expenseId,amount:a.amount}));total(allocations.map(a=>a.amount));
     state.batches.push({id:Math.max(0,...state.batches.map(b=>b.id))+1,date:input.date,active:true,allocations});
    }else{
     const batch=state.batches.find(b=>b.id===input.id);if(!batch)fail('批次不存在');batch.active=false;
    }
    db.prepare('UPDATE trial_state SET json=? WHERE id=1').run(JSON.stringify(state));
    db.prepare('INSERT INTO operations VALUES(?,?,?,?)').run(input.requestId,digest,input.kind,new Date().toISOString());
    return state;
   }).immediate();
   committed=true;return result;
  }finally{if(savedFile&&!committed)fs.rmSync(savedFile,{force:true});busy=false;}
 }
 return {command,close:()=>db.close()};
}
function ledgerMiddleware(ledger,origin){
 return async(req,res,next)=>{
  if(req.url!=='/api/ledger'){next();return;}
  const send=(status,value)=>{if(!res.destroyed){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));}};
  if(req.method!=='POST'||req.headers.host!==new URL(origin).host||req.headers.origin!==origin||req.headers['x-ledger-request']!=='1'||req.headers['content-type']!=='application/json'){send(403,{error:'只允许本机原型页面访问试用账本'});return;}
  try{const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>MAX_BYTES*1.4+8192)fail('请求过大');chunks.push(chunk);}const result=await ledger.command(JSON.parse(Buffer.concat(chunks).toString('utf8')));send(200,result);}
  catch(e){send(e.status||500,{error:e.status?e.message:'本地读写失败，请保留表单并重试'});}
 };
}
module.exports={createLedger,ledgerMiddleware};
