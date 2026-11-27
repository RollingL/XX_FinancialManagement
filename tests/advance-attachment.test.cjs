const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{randomUUID}=require('node:crypto');
const Database=require('better-sqlite3');
const {createLedger}=require('../spike/trial-ledger.cjs');
const {MAX_BYTES}=require('../spike/ocr-service.cjs');

// Generated 1 × 1 PNG; no payment screenshot, receipt text or user data.
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOYVnECAAN+AdcpgjGUAAAAAElFTkSuQmCC','base64');
const advance=(amount=12345,extra={})=>({kind:'advance',requestId:randomUUID(),advance:{amount,date:'2026-10-12',note:'合成到账附件'},image:{base64:png.toString('base64')},...extra});
function fixture(t,validate=async()=>({validated:true})){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'xx-advance-attachment-')),calls=[];
 const service={recognize:async(bytes,options)=>{calls.push({bytes:Buffer.from(bytes),options});assert.deepEqual(options,{validateOnly:true});return validate(bytes);}};
 let ledger=createLedger(root,service);
 t.after(()=>{ledger.close();fs.rmSync(root,{recursive:true,force:true});});
 return {root,calls,get ledger(){return ledger;},reopen(){ledger.close();ledger=createLedger(root,service);},db(fn){const db=new Database(path.join(root,'trial.sqlite'));try{return fn(db);}finally{db.close();}}};
}
const read=f=>f.ledger.command({kind:'read'});
async function snapshot(f){
 return {state:await read(f),...f.db(db=>({attachments:db.prepare('SELECT * FROM attachments ORDER BY id').all(),operations:db.prepare('SELECT * FROM operations ORDER BY id').all()})),files:fs.readdirSync(path.join(f.root,'attachments')).sort().map(file=>({file,base64:fs.readFileSync(path.join(f.root,'attachments',file)).toString('base64')}))};
}
const cash=s=>({advances:s.advances,advanceDetails:s.advanceDetails,expenses:s.expenses,flows:[...s.advances.map((amount,index)=>({kind:'advance',index,amount,...s.advanceDetails?.[index]})),...s.expenses.map(e=>({kind:'expense',...e,amount:-e.amount}))],balance:s.advances.reduce((a,b)=>a+b,0)-s.expenses.reduce((a,e)=>a+e.amount,0)});

test('advance attachment persists and reopens; idempotent retry skips decoding and creates no duplicate file',async t=>{
 const f=fixture(t),input=advance(),state=await f.ledger.command(input),id=state.advanceDetails[0].attachmentId;
 assert.equal(typeof id,'string');assert.deepEqual(state.advances,[12345]);assert.deepEqual(state.expenses,[]);assert.deepEqual(state.batches,[]);
 assert.deepEqual(await f.ledger.command({kind:'attachment',id}),{mime:'image/png',base64:png.toString('base64')});
 const saved=await snapshot(f);assert.equal(saved.attachments.length,1);assert.equal(saved.operations.length,1);assert.equal(saved.files.length,1);
 assert.equal(saved.operations[0].created_at,state.advanceDetails[0].createdAt);assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].bytes,png);
 f.reopen();assert.deepEqual(await read(f),state);assert.deepEqual(await f.ledger.command({kind:'attachment',id}),{mime:'image/png',base64:png.toString('base64')});
 assert.deepEqual(await f.ledger.command(input),state);assert.equal(f.calls.length,1);assert.deepEqual(await snapshot(f),saved);
 await assert.rejects(f.ledger.command({...input,image:{base64:'changed'}}),/重复请求内容不一致/);assert.equal(f.calls.length,1);assert.deepEqual(await snapshot(f),saved);
});

test('attachment is optional and legacy advance amounts remain undated and unchanged',async t=>{
 const f=fixture(t),legacy={expenses:[],batches:[],advances:[300000,1]},raw=JSON.stringify(legacy);
 f.db(db=>db.prepare('UPDATE trial_state SET json=? WHERE id=1').run(raw));f.reopen();assert.deepEqual(await read(f),legacy);
 assert.equal(f.db(db=>db.prepare('SELECT json FROM trial_state').get().json),raw);
 const state=await f.ledger.command(advance(2,{image:undefined}));
 assert.deepEqual(state.advances,[300000,1,2]);assert.equal(state.advanceDetails[0],undefined);assert.equal(state.advanceDetails[1],undefined);assert.equal(state.advanceDetails[2].attachmentId,undefined);
 const saved=await snapshot(f);assert.deepEqual(saved.attachments,[]);assert.deepEqual(saved.files,[]);assert.equal(f.calls.length,0);f.reopen();assert.deepEqual(await read(f),state);
});

test('advance image rejects invalid base64, unsupported signatures and byte overflow before decoding',async t=>{
 const f=fixture(t),before=await snapshot(f);
 const tooLarge=Buffer.alloc(MAX_BYTES+1);png.copy(tooLarge);
 for(const base64 of ['',3,'not base64!',Buffer.from('<svg/>').toString('base64'),tooLarge.toString('base64')]){
  await assert.rejects(f.ledger.command(advance(1,{image:{base64}})));assert.deepEqual(await snapshot(f),before);
 }
 assert.equal(f.calls.length,0);
});

test('decoder failure and pixel-limit rejection leave no ledger change or managed file; corrected request retries',async t=>{
 let failure='synthetic invalid PNG decode';const f=fixture(t,async()=>{if(failure)throw Error(failure);return {validated:true};}),before=await snapshot(f),input=advance();
 await assert.rejects(f.ledger.command(input),/invalid PNG decode/);assert.deepEqual(await snapshot(f),before);
 failure='synthetic image exceeds 20000000 pixels';await assert.rejects(f.ledger.command(input),/20000000 pixels/);assert.deepEqual(await snapshot(f),before);
 failure='';const state=await f.ledger.command(input);assert.deepEqual(state.advances,[12345]);assert.equal(f.calls.length,3);assert.equal((await snapshot(f)).files.length,1);
});

test('invalid advance fields are rejected before image validation and filesystem writes',async t=>{
 const f=fixture(t),before=await snapshot(f);
 for(const invalid of [null,{}, {amount:0,date:'2026-10-12'}, {amount:1,date:'2026-02-30'}, {amount:1,date:'2026-10-12',note:'x'.repeat(501)}]){
  await assert.rejects(f.ledger.command(advance(1,{advance:invalid})));assert.deepEqual(await snapshot(f),before);
 }
 assert.equal(f.calls.length,0);
});

test('failure after attachment and state writes rolls back all tables and removes the new file; same request can retry',async t=>{
 const f=fixture(t),before=await snapshot(f),input=advance();
 f.db(db=>db.exec("CREATE TRIGGER fail_attachment_save BEFORE INSERT ON operations WHEN NEW.kind='advance' BEGIN SELECT RAISE(ABORT,'synthetic operation failure'); END"));
 await assert.rejects(f.ledger.command(input),/synthetic operation failure/);assert.deepEqual(await snapshot(f),before);
 f.reopen();assert.deepEqual(await snapshot(f),before);f.db(db=>db.exec('DROP TRIGGER fail_attachment_save'));
 const state=await f.ledger.command(input);assert.deepEqual(state.advances,[12345]);assert.equal((await snapshot(f)).attachments.length,1);assert.equal((await snapshot(f)).files.length,1);
});

test('transaction rechecks cumulative cents and cleans only the failed request file',async t=>{
 const f=fixture(t);await f.ledger.command(advance(Number.MAX_SAFE_INTEGER));const before=await snapshot(f);
 await assert.rejects(f.ledger.command(advance(1)),/合计超出安全范围/);assert.equal(f.calls.length,2);assert.deepEqual(await snapshot(f),before);
 f.reopen();assert.deepEqual(await snapshot(f),before);
});

test('integrity reads reject a modified managed screenshot without mutating ledger or metadata',async t=>{
 const f=fixture(t),state=await f.ledger.command(advance()),id=state.advanceDetails[0].attachmentId,before=await snapshot(f),record=before.attachments[0];
 const altered=Buffer.from(png);altered[altered.length-1]^=1;fs.writeFileSync(path.join(f.root,'attachments',record.file),altered);
 await assert.rejects(f.ledger.command({kind:'attachment',id}),/附件损坏/);const after=await snapshot(f);assert.deepEqual(after.state,before.state);assert.deepEqual(after.attachments,before.attachments);assert.deepEqual(after.operations,before.operations);
});

test('expense and advance attachments coexist; reimbursement save and cancel preserve complete funds and attachments',async t=>{
 const f=fixture(t);await f.ledger.command({kind:'expense',requestId:randomUUID(),expense:{date:'2026-10-12',category:'接待',amount:20000,merchant:'合成费用',note:''},image:{base64:png.toString('base64')}});
 await f.ledger.command(advance(10000));const before=await snapshot(f);assert.equal(cash(before.state).balance,-10000);assert.equal(before.attachments.length,2);
 const batch=await f.ledger.command({kind:'batch',requestId:randomUUID(),date:'2026-10-12',allocations:[{expenseId:1,amount:20000}]});assert.deepEqual(cash(batch),cash(before.state));
 const cancelled=await f.ledger.command({kind:'cancel',requestId:randomUUID(),id:1});assert.deepEqual(cash(cancelled),cash(before.state));const after=await snapshot(f);assert.deepEqual(after.attachments,before.attachments);assert.deepEqual(after.files,before.files);
 for(const id of [cancelled.expenses[0].attachmentId,cancelled.advanceDetails[0].attachmentId])assert.deepEqual(await f.ledger.command({kind:'attachment',id}),{mime:'image/png',base64:png.toString('base64')});
});

test('concurrent duplicate save is rejected while validation runs; completed retry remains idempotent',async t=>{
 let finish;const f=fixture(t,()=>new Promise(resolve=>{finish=resolve;})),input=advance(),pending=f.ledger.command(input);
 await assert.rejects(f.ledger.command(input),/正在保存/);assert.equal(f.calls.length,1);finish({validated:true});const state=await pending;
 assert.deepEqual(await f.ledger.command(input),state);assert.equal(f.calls.length,1);const saved=await snapshot(f);assert.equal(saved.files.length,1);assert.equal(saved.attachments.length,1);assert.equal(saved.operations.length,1);
});
