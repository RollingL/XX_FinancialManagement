// Only synthetic invoices/images in fresh temporary ledgers. No OCR models or real accounts.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{randomUUID,createHash}=require('node:crypto'),{deflateSync}=require('node:zlib');
const Database=require('better-sqlite3'),{createLedger}=require('../spike/trial-ledger.cjs');
let imageSerial=0;
function crc32(bytes){let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let n=0;n<8;n++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
function chunk(type,bytes){const name=Buffer.from(type),head=Buffer.alloc(4),crc=Buffer.alloc(4);head.writeUInt32BE(bytes.length);crc.writeUInt32BE(crc32(Buffer.concat([name,bytes])));return Buffer.concat([head,name,bytes,crc]);}
function png(){const header=Buffer.alloc(13);header.writeUInt32BE(1,0);header.writeUInt32BE(1,4);header[8]=8;header[9]=2;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('tEXt',Buffer.from(`fixture\0synthetic-${++imageSerial}`)),chunk('IDAT',deflateSync(Buffer.from([0,10,20,30]))),chunk('IEND',Buffer.alloc(0))]);}
const image=bytes=>({base64:bytes.toString('base64')});
const fields=(changes={})=>({identityType:'number',number:`SYN-${randomUUID()}`,code:'',date:'2026-10-12',seller:'合成销方',buyer:'合成购方',amount:10000,note:'仅测试',...changes});
async function fixture(t,{managed=false,seed=true}={}){
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'xx-invoice-ledger-')),root=path.join(base,'ledger'),calls=[];let validator,ledger;const others=[];
 const service={recognize:async(bytes,options)=>{calls.push({sha256:createHash('sha256').update(bytes).digest('hex'),options});assert.deepEqual(options,{validateOnly:true});if(validator)await validator(bytes);return {validated:true};}};
 const open=()=>managed?require('../spike/managed-ledger.cjs').createManagedLedger(root,service):createLedger(root,service);ledger=open();
 const f={root,calls,get ledger(){return ledger;},setValidator(fn){validator=fn;},db(fn){const db=new Database(path.join(root,'trial.sqlite'));try{return fn(db);}finally{db.close();}},async reopen(){await ledger.close();ledger=open();},another(){const other=createLedger(root,service);others.push(other);return other;},async command(input){return ledger.command(managed?{...input,generation:(await ledger.command({kind:'read'})).generation}:input);}};
 t.after(async()=>{await ledger.close();for(const other of others)other.close();fs.rmSync(base,{recursive:true,force:true});});
 if(seed){
  f.payment=png();for(const amount of [1000,1])await f.command({kind:'advance',requestId:randomUUID(),advance:{amount,date:'2026-10-01',note:'合成预支'},image:image(f.payment)});
  for(const [i,amount] of [10001,20002,30003].entries())await f.command({kind:'expense',requestId:randomUUID(),expense:{amount,date:'2026-10-02',category:i===0?'接待':'办公',merchant:`合成费用${i+1}`,note:'合成备注'},...(i===0?{image:image(f.payment)}:{})});
  for(const amount of [500,100,100])await f.command({kind:'batch',requestId:randomUUID(),date:'2026-10-03',allocations:[{expenseId:2,amount}]});
  await f.command({kind:'cancel',requestId:randomUUID(),id:2});await f.command({kind:'delete-batch',requestId:randomUUID(),id:3});
 }
 return f;
}
const read=f=>f.ledger.command({kind:'read'});
function replace(f,state){f.db(db=>db.prepare('UPDATE trial_state SET json=? WHERE id=1').run(JSON.stringify(state,null,2)));}
const createInput=(changes={},bytes=png())=>({kind:'invoice',requestId:randomUUID(),invoice:fields(changes),image:image(bytes)});
async function create(f,changes={},bytes=png()){const state=await f.command(createInput(changes,bytes));return state.invoices.at(-1);}
const change=(invoice,kind,extra)=>({kind,requestId:randomUUID(),id:invoice.id,expectedRevision:invoice.revision,...extra});
async function apply(f,invoice,kind,extra){return (await f.command(change(invoice,kind,extra))).invoices.find(item=>item.id===invoice.id);}
function unchangedFacts(state){const {invoices,invoiceEvents,...facts}=state;return {facts,flows:[...state.advances.map((amount,index)=>({kind:'advance',index,amount,details:state.advanceDetails?.[index]})),...state.expenses.map(expense=>({kind:'expense',...expense,amount:-expense.amount}))],balance:state.advances.reduce((a,b)=>a+b,0)-state.expenses.reduce((a,b)=>a+b.amount,0)};}
async function snapshot(f){return {state:await read(f),...f.db(db=>({raw:db.prepare('SELECT json FROM trial_state').get().json,operations:db.prepare('SELECT * FROM operations ORDER BY id').all(),attachments:db.prepare('SELECT * FROM attachments ORDER BY id').all()})),files:fs.readdirSync(path.join(f.root,'attachments')).sort().map(file=>({file,sha256:createHash('sha256').update(fs.readFileSync(path.join(f.root,'attachments',file))).digest('hex')}))};}
async function rejectsUnchanged(f,input,pattern){const before=await snapshot(f);await assert.rejects(f.command(input),pattern);assert.deepEqual(await snapshot(f),before);}
function assertEvents(f,state){
 const previous=new Map();for(const event of state.invoiceEvents){const invoice=event.after;assert.deepEqual(Object.keys(event).sort(),['action','after','at','before','invoiceId','requestId','revision']);assert.equal(event.invoiceId,invoice.id);assert.equal(event.revision,invoice.revision);assert.deepEqual(event.before,previous.get(invoice.id)??null);assert.equal(invoice.revision,(previous.get(invoice.id)?.revision??0)+1);assert.ok(Number.isFinite(Date.parse(event.at)));const op=f.db(db=>db.prepare('SELECT * FROM operations WHERE id=?').get(event.requestId));assert.equal(op.kind,event.action);assert.equal(op.created_at,event.at);previous.set(invoice.id,invoice);}
 for(const invoice of state.invoices)assert.deepEqual(invoice,previous.get(invoice.id));
}

test('new invoices preserve all cash and reimbursement facts, normalize identity, retain originals and reopen with complete audit',async t=>{
 const f=await fixture(t),before=await snapshot(f);assert.equal(Object.hasOwn(before.state,'invoices'),false);assert.equal(Object.hasOwn(before.state,'invoiceEvents'),false);await f.reopen();assert.deepEqual(await snapshot(f),before);
 const bytes=png(),input=createInput({identityType:'unconfirmed',number:' ａｂ １２\t ',code:'  ｘ ９ ',amount:1,seller:' 合成销方 ',buyer:' ',note:' 合成备注 '},bytes),state=await f.command(input),invoice=state.invoices[0];
 assert.deepEqual(invoice,{id:1,identityType:'unconfirmed',number:'AB12',code:'X9',date:'2026-10-12',seller:'合成销方',buyer:'',amount:1,note:'合成备注',attachmentIds:invoice.attachmentIds,allocations:[],revision:1,createdAt:state.invoiceEvents[0].at});
 assert.deepEqual(unchangedFacts(state),unchangedFacts(before.state));assert.equal(invoice.attachmentIds.length,1);assert.deepEqual(await f.command({kind:'attachment',id:invoice.attachmentIds[0]}),{mime:'image/png',base64:bytes.toString('base64')});assertEvents(f,state);
 const saved=await snapshot(f);await f.reopen();assert.deepEqual(await snapshot(f),saved);
});

test('identity duplicates are rejected conservatively across confirmed and unconfirmed invoices; confirmation changes only identity and revision',async t=>{
 const f=await fixture(t),first=await create(f,{identityType:'code-number',number:' ｎｏ １２ ',code:' ａ '}),other=await create(f,{identityType:'code-number',number:'NO12',code:'B'});
 for(const candidate of [{identityType:'number',number:'no12',code:''},{identityType:'code-number',number:'ＮＯ１２',code:'A'},{identityType:'unconfirmed',number:'NO 12',code:''}])await rejectsUnchanged(f,createInput(candidate),/打开已有发票/);
 const pending=await create(f,{identityType:'unconfirmed',number:'',code:''});await rejectsUnchanged(f,change(pending,'invoice-identity',{identity:{identityType:'number',number:'NO12',code:''}}),/打开已有发票/);
 const confirmed=await apply(f,pending,'invoice-identity',{identity:{identityType:'code-number',number:'new １',code:' c '}});assert.deepEqual(confirmed,{...pending,identityType:'code-number',number:'NEW1',code:'C',revision:2});
 await rejectsUnchanged(f,change(confirmed,'invoice-identity',{identity:{identityType:'number',number:'NEW2',code:''}}),/不能再次修改/);
 const reserved=await create(f,{identityType:'unconfirmed',number:'RESERVED',code:'R'});await rejectsUnchanged(f,createInput({number:reserved.number,code:'',identityType:'number'}),/打开已有发票/);assert.equal(first.amount,other.amount);assertEvents(f,await read(f));
});

test('equivalent combining-character identities deduplicate and remain valid after managed reopen',async t=>{
 const f=await fixture(t,{managed:true,seed:false}),canonical='\u03aa\u0301';
 const invoice=await create(f,{identityType:'code-number',number:'\u0390',code:'\u03b9\u0308\u0301'});
 assert.equal(invoice.number,canonical);assert.equal(invoice.code,canonical);
 for(const number of ['\u03b9\u0308\u0301','\u0399\u0308\u0301',canonical])await rejectsUnchanged(f,createInput({identityType:'code-number',number,code:canonical}),/打开已有发票/);
 const saved=await snapshot(f);await f.reopen();assert.deepEqual(await snapshot(f),saved);
});

test('invoice image hashes deduplicate within and across invoices but payment screenshot hashes do not consume invoice identity or value',async t=>{
 const f=await fixture(t),baseline=unchangedFacts(await read(f)),aBytes=png(),a=await create(f,{},aBytes),bBytes=png(),b=await create(f,{},bBytes);
 await rejectsUnchanged(f,createInput({},aBytes),/原图重复/);await rejectsUnchanged(f,change(a,'invoice-attachment',{image:image(aBytes)}),/原图重复/);await rejectsUnchanged(f,change(b,'invoice-attachment',{image:image(aBytes)}),/原图重复/);
 const sameAsPayment=await create(f,{},f.payment),state=await read(f);assert.notEqual(sameAsPayment.attachmentIds[0],state.expenses[0].attachmentId);
 const extra=png(),updated=await apply(f,a,'invoice-attachment',{image:image(extra)});assert.equal(updated.amount,a.amount);assert.deepEqual(updated.allocations,a.allocations);assert.deepEqual(updated.attachmentIds.slice(0,-1),a.attachmentIds);assert.equal(updated.revision,2);assert.deepEqual(await f.command({kind:'attachment',id:updated.attachmentIds[1]}),{mime:'image/png',base64:extra.toString('base64')});assert.deepEqual(unchangedFacts(await read(f)),baseline);assertEvents(f,await read(f));
});

test('many-to-many allocations enforce both limits including legacy invoice baseline and replace only this invoice allocations',async t=>{
 const f=await fixture(t),legacy=await read(f);legacy.expenses[0].invoice=100;legacy.expenses[0].legacyDetails={synthetic:'preserve'};replace(f,legacy);const baseline=unchangedFacts(await read(f));
 let a=await create(f,{amount:10000}),b=await create(f,{amount:20000});a=await apply(f,a,'invoice-allocate',{allocations:[{expenseId:2,amount:3000},{expenseId:1,amount:4001}]});b=await apply(f,b,'invoice-allocate',{allocations:[{expenseId:1,amount:5900},{expenseId:3,amount:12000}]});
 a=await apply(f,a,'invoice-allocate',{allocations:[{expenseId:2,amount:5999},{expenseId:1,amount:4001}]});assert.deepEqual(a.allocations,[{expenseId:1,amount:4001},{expenseId:2,amount:5999}]);
 await rejectsUnchanged(f,change(a,'invoice-allocate',{allocations:[{expenseId:1,amount:4002}]}),/费用可用票额/);await rejectsUnchanged(f,change(a,'invoice-allocate',{allocations:[{expenseId:2,amount:10001}]}),/票面金额/);
 const bBefore=structuredClone(b);a=await apply(f,a,'invoice-allocate',{allocations:[]});const state=await read(f);assert.deepEqual(state.invoices[1],bBefore);assert.deepEqual(a.allocations,[]);assert.deepEqual(unchangedFacts(state),baseline);assert.equal(state.expenses[0].invoice,100);assertEvents(f,state);
});

test('unconfirmed invoices cannot allocate and unchanged or merely reordered allocations produce no writes',async t=>{
 const f=await fixture(t),pending=await create(f,{identityType:'unconfirmed',number:'',code:''});await rejectsUnchanged(f,change(pending,'invoice-allocate',{allocations:[{expenseId:1,amount:1}]}),/先核对/);await rejectsUnchanged(f,change(pending,'invoice-allocate',{allocations:[]}),/没有变化/);
 let ready=await apply(f,pending,'invoice-identity',{identity:{identityType:'number',number:'ABC',code:''}});ready=await apply(f,ready,'invoice-allocate',{allocations:[{expenseId:1,amount:1},{expenseId:3,amount:2}]});
 await rejectsUnchanged(f,change(ready,'invoice-allocate',{allocations:[{expenseId:3,amount:2},{expenseId:1,amount:1}]}),/没有变化/);
});

test('invoice and reimbursement allocations are independent and every reimbursement mutation preserves invoice and full cash facts',async t=>{
 const f=await fixture(t),original=await read(f);let invoice=await create(f,{amount:20002});invoice=await apply(f,invoice,'invoice-allocate',{allocations:[{expenseId:2,amount:20002}]});const baseline=await read(f),cashBefore=unchangedFacts(baseline);
 const state=await f.command({kind:'batch',requestId:randomUUID(),date:'2026-10-12',allocations:[{expenseId:2,amount:19502}]}),id=state.batches.at(-1).id;
 for(const kind of ['cancel','delete-batch'])await f.command({kind,requestId:randomUUID(),id});
 const after=await read(f);assert.deepEqual(after.invoices,baseline.invoices);assert.deepEqual(after.invoiceEvents,baseline.invoiceEvents);for(const key of ['expenses','advances','advanceDetails'])assert.deepEqual(after[key],original[key]);assert.deepEqual(unchangedFacts(after).flows,cashBefore.flows);assert.equal(unchangedFacts(after).balance,cashBefore.balance);assert.deepEqual(after.batches,baseline.batches);
});

test('all invoice commands require exact request shapes, safe IDs and revisions, valid identity and required metadata',async t=>{
 const f=await fixture(t),invoice=await create(f),base=createInput();
 const invalid=[...([0,-1,1.5,'1',Number.MAX_SAFE_INTEGER+1,NaN,Infinity].map(amount=>({...base,invoice:{...base.invoice,amount}}))),
 ...([{date:''},{date:'2026-02-30'},{date:null},{seller:'s'.repeat(201)},{buyer:null},{note:'n'.repeat(501)},{number:'x'.repeat(101)},{code:'x'.repeat(101)},{identityType:'other'},{number:''},{code:'unexpected'},{identityType:'code-number',code:''},{id:1},{allocations:[]},{revision:1}].map(extra=>({...base,invoice:{...base.invoice,...extra}}))),
 {...base,image:undefined},{...base,image:{...base.image,path:'/external'}},{...base,extra:true},{...base,requestId:'a'.repeat(36)}];
 for(const input of invalid)await rejectsUnchanged(f,input);
 for(const kind of ['invoice-identity','invoice-attachment','invoice-allocate']){
  const input=change(invoice,kind,kind==='invoice-identity'?{identity:{identityType:'number',number:'new',code:''}}:kind==='invoice-attachment'?{image:image(png())}:{allocations:[{expenseId:1,amount:1}]});
  for(const extra of [{id:0},{id:'1'},{id:Number.MAX_SAFE_INTEGER+1},{expectedRevision:0},{expectedRevision:'1'},{expectedRevision:1.5},{expectedRevision:Number.MAX_SAFE_INTEGER+1},{extra:true},{requestId:'-'.repeat(36)}])await rejectsUnchanged(f,{...input,...extra});
  await rejectsUnchanged(f,{...input,id:999},/不存在/);
 }
 const pending=await create(f,{identityType:'unconfirmed',number:'',code:''});for(const identity of [{identityType:'unconfirmed',number:'',code:''},{identityType:'number',number:'',code:''},{identityType:'code-number',number:'X',code:''},{identityType:'number',number:'X',code:'',amount:1}])await rejectsUnchanged(f,change(pending,'invoice-identity',{identity}));
});

test('invalid allocations and missing expenses cannot create or overwrite associations',async t=>{
 const f=await fixture(t),invoice=await create(f);
 for(const allocations of [null,{},[{expenseId:1,amount:0}],[{expenseId:1,amount:-1}],[{expenseId:1,amount:0.5}],[{expenseId:1,amount:'1'}],[{expenseId:'1',amount:1}],[{expenseId:1,amount:Number.MAX_SAFE_INTEGER+1}],[{expenseId:1,amount:1,extra:true}],[{expenseId:1,amount:1},{expenseId:1,amount:1}],[{expenseId:999,amount:1}]])await rejectsUnchanged(f,change(invoice,'invoice-allocate',{allocations}));
});

test('integer-cent maxima and aggregate allocations use exact arithmetic without rounding overflow',async t=>{
 const f=await fixture(t,{seed:false});for(const amount of [Number.MAX_SAFE_INTEGER-1,1])await f.command({kind:'expense',requestId:randomUUID(),expense:{category:'办公',date:'2026-10-12',merchant:'合成边界费用',amount,note:''}});const state=await read(f);state.expenses[0].invoice=1;replace(f,state);let invoice=await create(f,{amount:Number.MAX_SAFE_INTEGER});
 invoice=await apply(f,invoice,'invoice-allocate',{allocations:[{expenseId:1,amount:Number.MAX_SAFE_INTEGER-2}]});assert.equal(invoice.allocations[0].amount,Number.MAX_SAFE_INTEGER-2);
 await rejectsUnchanged(f,createInput({amount:1}),/票面金额合计超出安全范围/);
 await rejectsUnchanged(f,change(invoice,'invoice-allocate',{allocations:[{expenseId:1,amount:Number.MAX_SAFE_INTEGER-1}]}),/费用可用票额/);await rejectsUnchanged(f,change(invoice,'invoice-allocate',{allocations:[{expenseId:1,amount:Number.MAX_SAFE_INTEGER},{expenseId:2,amount:1}]}),/票面金额/);
 const last=await apply(f,invoice,'invoice-allocate',{allocations:[{expenseId:1,amount:Number.MAX_SAFE_INTEGER-2},{expenseId:2,amount:1}]});assert.equal(last.allocations[1].amount,1);assertEvents(f,await read(f));
});

test('compare-and-swap rejects stale identities, attachments and allocations; independent writers recheck current revision',async t=>{
 const f=await fixture(t),pending=await create(f,{identityType:'unconfirmed',number:'',code:''}),ready=await apply(f,pending,'invoice-identity',{identity:{identityType:'number',number:'CONFIRMED',code:''}});
 for(const input of [change(pending,'invoice-identity',{identity:{identityType:'number',number:'OTHER',code:''}}),change(pending,'invoice-attachment',{image:image(png())}),change(pending,'invoice-allocate',{allocations:[{expenseId:1,amount:1}]})])await rejectsUnchanged(f,input,/发票已变化/);
 const second=f.another(),a=change(ready,'invoice-allocate',{allocations:[{expenseId:1,amount:1}]}),b=change(ready,'invoice-allocate',{allocations:[{expenseId:3,amount:1}]}),results=await Promise.allSettled([f.command(a),second.command(b)]);assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.match(results.find(result=>result.status==='rejected').reason.message,/发票已变化/);assert.equal((await read(f)).invoices[0].revision,3);
});

test('attachment decoding waits cannot bypass transaction-time CAS or conservative identity uniqueness',async t=>{
 const f=await fixture(t),invoice=await create(f),other=f.another();let release,started;const waiting=new Promise(resolve=>{started=resolve;});f.setValidator(async()=>{started();await new Promise(resolve=>{release=resolve;});});
 const pending=f.command(change(invoice,'invoice-attachment',{image:image(png())}));await waiting;const updated=await other.command(change(invoice,'invoice-allocate',{allocations:[{expenseId:1,amount:1}]}));const before=await snapshot(f);release();await assert.rejects(pending,/发票已变化/);assert.deepEqual(await snapshot(f),before);assert.equal(updated.invoices[0].revision,2);
 f.setValidator(undefined);
 const waitingAgain=new Promise(resolve=>{started=resolve;});let firstDecode=true;f.setValidator(async()=>{if(firstDecode){firstDecode=false;started();await new Promise(resolve=>{release=resolve;});}});
 const duplicate=createInput({number:'CONCURRENT-IDENTITY'}),pendingCreate=f.command(duplicate);await waitingAgain;await other.command(createInput({number:duplicate.invoice.number}));const identityWinner=await snapshot(f);release();await assert.rejects(pendingCreate,/打开已有发票/);assert.deepEqual(await snapshot(f),identityWinner);f.setValidator(undefined);
});

test('every invoice request is idempotent across reopen and old retries never replay changes or decode images again',async t=>{
 const f=await fixture(t),inputs=[],first=createInput({identityType:'unconfirmed',number:'',code:''});inputs.push(first);let state=await f.command(first),invoice=state.invoices[0];
 for(const [kind,extra] of [['invoice-identity',{identity:{identityType:'number',number:'RETRY',code:''}}],['invoice-attachment',{image:image(png())}],['invoice-allocate',{allocations:[{expenseId:1,amount:1}]}]]){const input=change(invoice,kind,extra);inputs.push(input);state=await f.command(input);invoice=state.invoices[0];const saved=await snapshot(f),calls=f.calls.length;assert.deepEqual(await f.command(input),state);assert.deepEqual(await snapshot(f),saved);assert.equal(f.calls.length,calls);}
 const saved=await snapshot(f),calls=f.calls.length;await f.reopen();for(const input of inputs){assert.deepEqual(await f.command(input),saved.state);assert.deepEqual(await snapshot(f),saved);assert.equal(f.calls.length,calls);}
 for(const input of inputs)await rejectsUnchanged(f,{...input,unexpected:true},/重复请求内容不一致/);assertEvents(f,saved.state);
});

test('decode failures and malformed or oversized images leave state, audits, metadata and files untouched',async t=>{
 const f=await fixture(t),invoice=await create(f);
 for(const bytes of [Buffer.from('not an image'),Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(20*1024*1024)])])for(const kind of ['invoice','invoice-attachment'])await rejectsUnchanged(f,kind==='invoice'?createInput({},bytes):change(invoice,kind,{image:image(bytes)}));
 for(const base64 of ['', 'not-base64!',null])await rejectsUnchanged(f,{...createInput(),image:{base64}});
 f.setValidator(()=>{throw Error('synthetic decoder rejects damaged or oversized-pixel image');});for(const input of [createInput(),change(invoice,'invoice-attachment',{image:image(png())})])await rejectsUnchanged(f,input,/synthetic decoder/);f.setValidator(undefined);
});

test('transaction failures roll back every invoice command including its audit, operation and newly copied original; same request retries',async t=>{
 const f=await fixture(t),inputs=[createInput({identityType:'unconfirmed',number:'',code:''})];
 for(let step=0;step<4;step++){
  if(step){const invoice=(await read(f)).invoices[0];inputs.push(change(invoice,['','invoice-identity','invoice-attachment','invoice-allocate'][step],step===1?{identity:{identityType:'number',number:'ROLLBACK',code:''}}:step===2?{image:image(png())}:{allocations:[{expenseId:1,amount:1}]}));}
  const input=inputs[step];f.db(db=>db.exec("CREATE TRIGGER fail_invoice BEFORE INSERT ON operations WHEN NEW.kind LIKE 'invoice%' BEGIN SELECT RAISE(ABORT,'synthetic invoice transaction failure'); END"));await rejectsUnchanged(f,input,/synthetic invoice transaction failure/);f.db(db=>db.exec('DROP TRIGGER fail_invoice'));await f.reopen();const before=await snapshot(f),state=await f.command(input);assert.equal(state.invoiceEvents.length,step+1);assert.equal((await snapshot(f)).operations.length,before.operations.length+1);assertEvents(f,state);
 }
});

test('invoice association history permanently blocks expense correction even after allocations are cleared',async t=>{
 const f=await fixture(t),original=await read(f);let invoice=await create(f);const correction=state=>({kind:'correct-expense',requestId:randomUUID(),id:1,expected:state.expenses[0],expectedRevision:(state.expenseEvents??[]).filter(event=>event.expenseId===1).length,expense:{category:'接待',date:'2026-10-02',merchant:'合成费用1',amount:10000,note:'合成更正'}});
 const corrected=await f.command(correction(original));invoice=await apply(f,invoice,'invoice-allocate',{allocations:[{expenseId:1,amount:1}]});await rejectsUnchanged(f,{...correction(corrected),expense:{...correction(corrected).expense,amount:9999}},/发票分配历史/);
 invoice=await apply(f,invoice,'invoice-allocate',{allocations:[]});await f.reopen();await rejectsUnchanged(f,{...correction(await read(f)),expense:{...correction(corrected).expense,amount:9999}},/发票分配历史/);assert.deepEqual(invoice.allocations,[]);
 const state=await read(f);state.invoiceEvents=state.invoiceEvents.filter(event=>event.action==='invoice-allocate').slice(-1);replace(f,state);await rejectsUnchanged(f,correction(state),/发票分配历史/); // The retained before snapshot alone is sufficient.
});

test('malformed optional invoice collections and unsafe ID or revision increments reject without overwriting legacy data',async t=>{
 const f=await fixture(t),initial=await read(f);
 for(const extension of [{invoices:null},{invoiceEvents:false}]){replace(f,{...initial,...extension});await rejectsUnchanged(f,createInput(),/现有发票数据无效/);}
 replace(f,initial);const invoice=await create(f),state=await read(f);state.invoices[0].id=Number.MAX_SAFE_INTEGER;replace(f,state);await rejectsUnchanged(f,createInput(),/发票编号/);
 state.invoices[0]={...invoice,revision:Number.MAX_SAFE_INTEGER};replace(f,state);await rejectsUnchanged(f,change(state.invoices[0],'invoice-allocate',{allocations:[{expenseId:1,amount:1}]}),/发票修订/);
});

test('managed reset clears invoices, all invoice audit and originals, rejects old generation requests and preserves new records on reset retry',async t=>{
 const f=await fixture(t,{managed:true}),initial=await read(f),input=createInput(),first=await f.command(input),invoice=first.invoices[0],allocate=change(invoice,'invoice-allocate',{allocations:[{expenseId:1,amount:1}]});await f.command(allocate);
 const reset={kind:'reset-ledger',requestId:randomUUID(),generation:initial.generation,confirmation:'清空当前账本'};await f.ledger.command(reset);const empty=await read(f),snapshotEmpty=await snapshot(f);assert.equal(Object.hasOwn(empty,'invoices'),false);assert.equal(Object.hasOwn(empty,'invoiceEvents'),false);assert.deepEqual(snapshotEmpty.attachments,[]);assert.deepEqual(snapshotEmpty.files,[]);assert.deepEqual(snapshotEmpty.operations,[]);
 await f.command(createInput());const fresh=await snapshot(f);for(const old of [input,allocate]){await assert.rejects(f.ledger.command({...old,generation:initial.generation}),/代际已变化/);assert.deepEqual(await snapshot(f),fresh);}
 await f.ledger.command(reset);assert.deepEqual(await snapshot(f),fresh);assert.notEqual(empty.generation,initial.generation);
});
