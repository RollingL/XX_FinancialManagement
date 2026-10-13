const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {randomUUID,createHash}=require('node:crypto');
const Database=require('better-sqlite3');
const {createManagedLedger}=require('../spike/managed-ledger.cjs');
const {inspectDatabase,verifyBackup,restoreBackup}=require('../spike/ledger-backup.cjs');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
// Synthetic 1 x 1 PNGs. A valid tEXt chunk gives each scan a distinct byte hash.
const pixel=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOYVnECAAN+AdcpgjGUAAAAAElFTkSuQmCC','base64');
function png(label){
 const body=Buffer.from(`tEXtfixture\0${label}`),chunk=Buffer.alloc(body.length+8);chunk.writeUInt32BE(body.length-4);body.copy(chunk,4);let crc=0xffffffff;
 for(const byte of body){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}chunk.writeUInt32BE((crc^0xffffffff)>>>0,chunk.length-4);
 return Buffer.concat([pixel.subarray(0,-12),chunk,pixel.subarray(-12)]);
}
const image=label=>({base64:png(label).toString('base64')}),service={recognize:async()=>({validated:true})};
const invoice=(overrides={})=>({identityType:'number',number:'SYNTHETIC-1',code:'',date:'2026-10-12',seller:'合成销方',buyer:'合成购方',amount:6000,note:'合成发票',...overrides});
function mutate(file,fn){const db=new Database(file,{fileMustExist:true});try{return fn(db);}finally{db.close();}}
function snapshot(root){
 const db=new Database(path.join(root,'trial.sqlite'),{readonly:true,fileMustExist:true});
 try{
  const raw=db.prepare('SELECT json FROM trial_state WHERE id=1').get().json,state=JSON.parse(raw);
  return {raw,state,operations:db.prepare('SELECT * FROM operations ORDER BY id').all(),attachments:db.prepare('SELECT * FROM attachments ORDER BY id').all(),files:fs.readdirSync(path.join(root,'attachments')).sort().map(name=>({name,hex:fs.readFileSync(path.join(root,'attachments',name)).toString('hex')})),cash:{advances:state.advances,advanceDetails:state.advanceDetails,expenses:state.expenses,flows:[...state.advances.map((amount,index)=>({kind:'advance',index,amount,...state.advanceDetails?.[index]})),...state.expenses.map(e=>({kind:'expense',...e,amount:-e.amount}))],balance:state.advances.reduce((sum,n)=>sum+BigInt(n),0n)-state.expenses.reduce((sum,e)=>sum+BigInt(e.amount),0n)}};
 }finally{db.close();}
}
function fixture(t){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'qianlai-invoice-backup-'))),source=path.join(root,'source'),destination=path.join(root,'backups');fs.mkdirSync(destination);
 const opened=new Set();const open=(directory=source)=>{const value=createManagedLedger(directory,service);opened.add(value);return value;};let ledger=open();
 t.after(async()=>{for(const value of opened)await value.close();fs.rmSync(root,{recursive:true,force:true});});
 return {root,source,destination,open,get ledger(){return ledger;},async reopen(){await ledger.close();ledger=open();return ledger;},async command(input){const state=await ledger.command({kind:'read'});return ledger.command({...input,requestId:randomUUID(),generation:state.generation});},async change(kind,id,payload){const state=await ledger.command({kind:'read'});return this.command({kind,id,expectedRevision:state.invoices.find(item=>item.id===id).revision,...payload});},async correct(id,changes){const state=await ledger.command({kind:'read'}),expected=state.expenses.find(e=>e.id===id),{category,date,merchant,amount,note}=expected;return this.command({kind:'correct-expense',id,expectedRevision:(state.expenseEvents||[]).filter(e=>e.expenseId===id).length,expected,expense:{category,date,merchant,amount,note,...changes}});}};
}
async function populated(f){
 await f.command({kind:'advance',advance:{amount:5000,date:'2026-10-12',note:'合成到账'},image:image('shared-payment-bytes')});
 for(const [index,amount] of [4000,3000,1000].entries())await f.command({kind:'expense',expense:{category:index===0?'接待':'办公',date:'2026-10-12',merchant:`合成费用 ${index+1}`,amount,note:''},...(index===0?{image:image('shared-payment-bytes')}:{})});
 await f.ledger.close();mutate(path.join(f.source,'trial.sqlite'),db=>{const state=JSON.parse(db.prepare('SELECT json FROM trial_state').get().json);state.expenses[2].invoice=400;db.prepare('UPDATE trial_state SET json=?').run(JSON.stringify(state));});await f.reopen();
 await f.correct(1,{amount:5000,note:'先纠错后关联发票'});
 await f.command({kind:'invoice',invoice:invoice({identityType:'unconfirmed',number:' ａ １ ',amount:6000}),image:image('shared-payment-bytes')});
 await f.change('invoice-attachment',1,{image:image('scan-two')});
 // Creating an unallocated invoice must not block an unrelated later expense correction.
 await f.correct(2,{amount:3001,note:'发票创建后、分配前纠错'});const cash=snapshot(f.source).cash;
 await f.change('invoice-identity',1,{identity:{identityType:'number',number:' abc １２ ',code:''}});
 await f.change('invoice-allocate',1,{allocations:[{expenseId:2,amount:2000},{expenseId:1,amount:4000}]});
 await f.command({kind:'invoice',invoice:invoice({identityType:'code-number',number:'OTHER001',code:'CODE-A',amount:5000}),image:image('other-invoice')});
 await f.change('invoice-allocate',2,{allocations:[{expenseId:1,amount:1000},{expenseId:2,amount:1001},{expenseId:3,amount:600}]});
 await f.change('invoice-allocate',1,{allocations:[{expenseId:1,amount:3000}]});
 await f.change('invoice-allocate',2,{allocations:[]});
 await f.change('invoice-allocate',2,{allocations:[{expenseId:1,amount:2000},{expenseId:2,amount:1501},{expenseId:3,amount:600}]});
 await f.command({kind:'batch',date:'2026-10-12',allocations:[{expenseId:1,amount:1000},{expenseId:2,amount:501}]});
 assert.deepEqual(snapshot(f.source).cash,cash);return snapshot(f.source);
}
function changeInvoiceEverywhere(state,id,change){
 for(const record of [...state.invoices,...state.invoiceEvents.flatMap(event=>[event.before,event.after]).filter(Boolean)])if(record.id===id)change(record);
}
function reseal(directory,original,change){
 const database=path.join(directory,'database.sqlite');fs.writeFileSync(database,original);
 mutate(database,db=>{const state=JSON.parse(db.prepare('SELECT json FROM trial_state').get().json);change(state,db);db.prepare('UPDATE trial_state SET json=?').run(JSON.stringify(state));});
 const file=path.join(directory,'manifest.json'),manifest=JSON.parse(fs.readFileSync(file,'utf8')),bytes=fs.readFileSync(database);manifest.database={path:'database.sqlite',size:bytes.length,sha256:hash(bytes)};
 const serialized=Buffer.from(JSON.stringify(manifest,null,2)+'\n');fs.writeFileSync(file,serialized);fs.writeFileSync(path.join(directory,'COMPLETE'),JSON.stringify({backupId:manifest.backupId,manifestSha256:hash(serialized)}));
}

test('invoice create, scan, confirm and many-to-many changes round-trip with expense corrections and unchanged cash',async t=>{
 const f=fixture(t),before=await populated(f),saved=await f.ledger.backup(f.destination);assert.deepEqual(verifyBackup(saved.directory).summary,saved.summary);
 assert.equal(before.state.invoices[0].number,'ABC12');assert.equal(before.state.invoices[0].amount,6000);assert.equal(before.state.invoices[0].attachmentIds.length,2);assert.deepEqual(before.state.expenses.map(e=>e.invoice),[0,0,400]);
 assert.deepEqual(before.state.expenseEvents.map(event=>event.after),before.state.expenses.slice(0,2));assert.equal(before.cash.balance,-4001n);
 assert.deepEqual({expense:saved.summary.totalExpenseCents,advance:saved.summary.totalAdvanceCents,balance:saved.summary.balanceCents,paid:saved.summary.reimbursedCents,pending:saved.summary.pendingCents},{expense:'9001',advance:'5000',balance:'-4001',paid:'1501',pending:'7500'});
 assert.equal(saved.summary.attachmentCount,5);assert.ok(saved.manifest.attachments.every(item=>item.registered&&item.referenced));
 for(const name of ['restored-a','restored-b']){
  const restored=restoreBackup({backupDir:saved.directory,targetDir:path.join(f.root,name)});assert.notEqual(restored.ledgerId,f.ledger.ledgerId);assert.deepEqual(fs.readFileSync(path.join(restored.directory,'trial.sqlite')),fs.readFileSync(path.join(saved.directory,'database.sqlite')));assert.deepEqual(snapshot(restored.directory),before);
  const ledger=f.open(restored.directory),state=await ledger.command({kind:'read'});assert.deepEqual({...state,generation:before.state.generation},before.state);
  for(const id of state.invoices.flatMap(item=>item.attachmentIds)){const actual=await ledger.command({kind:'attachment',id,generation:state.generation}),row=before.attachments.find(item=>item.id===id);assert.equal(hash(Buffer.from(actual.base64,'base64')),row.sha256);}
  await ledger.close();assert.deepEqual(snapshot(restored.directory),before);
 }
 await f.reopen();assert.deepEqual(snapshot(f.source),before);
});

test('combining-character invoice identities survive confirmation, backup and new-directory restore',async t=>{
 const f=fixture(t),canonical='\u03aa\u0301';
 await f.command({kind:'invoice',invoice:invoice({identityType:'unconfirmed',number:'',code:''}),image:image('unicode-identity')});
 await f.change('invoice-identity',1,{identity:{identityType:'code-number',number:'\u0390',code:'\u03b9\u0308\u0301'}});
 const before=snapshot(f.source);assert.equal(before.state.invoices[0].number,canonical);assert.equal(before.state.invoices[0].code,canonical);
 const saved=await f.ledger.backup(f.destination);verifyBackup(saved.directory);
 const restored=restoreBackup({backupDir:saved.directory,targetDir:path.join(f.root,'unicode-restored')});
 const ledger=f.open(restored.directory);await ledger.command({kind:'read'});await ledger.close();
 assert.deepEqual(snapshot(restored.directory),before);await f.reopen();assert.deepEqual(snapshot(f.source),before);
});

test('legacy no-invoice state stays byte-for-byte unchanged and keeps the original manifest summary keys',async t=>{
 const f=fixture(t);await f.command({kind:'expense',expense:{category:'接待',date:'2026-10-12',merchant:'合成旧费用',amount:1,note:''}});const before=snapshot(f.source),saved=await f.ledger.backup(f.destination);
 assert.equal(before.state.invoices,undefined);assert.equal(before.state.invoiceEvents,undefined);assert.equal(saved.manifest.formatVersion,1);
 assert.deepEqual(Object.keys(saved.summary).sort(),['expenseCount','advanceCount','batchCount','activeBatchCount','cancelledBatchCount','deletedBatchCount','allocationCount','deletedAllocationCount','operationCount','attachmentCount','totalExpenseCents','totalAdvanceCents','balanceCents','personalFundingCents','reimbursedCents','pendingCents','attachmentFileCount'].sort());
 const restored=restoreBackup({backupDir:saved.directory,targetDir:path.join(f.root,'legacy')}),ledger=f.open(restored.directory);await ledger.command({kind:'read'});await ledger.close();assert.deepEqual(snapshot(restored.directory),before);assert.deepEqual(snapshot(f.source),before);
});

test('strict invoice fields, canonical identity, attachments and pure associations reject resealed backups',async t=>{
 const f=fixture(t);await populated(f);const saved=await f.ledger.backup(f.destination),original=fs.readFileSync(path.join(saved.directory,'database.sqlite'));
 const cases=[
  ['null invoices',s=>{s.invoices=null;}],['null events',s=>{s.invoiceEvents=null;}],['missing events',s=>{delete s.invoiceEvents;}],['no current invoice',s=>{s.invoices=[];}],
  ['unknown field',s=>{s.invoices[0].extra=true;}],['missing field',s=>{delete s.invoices[0].buyer;}],['duplicate id',s=>{s.invoices[1].id=1;}],['zero id',s=>{s.invoices[0].id=0;}],['unsafe revision',s=>{s.invoices[0].revision=Number.MAX_SAFE_INTEGER+1;}],
  ['invalid date',s=>{s.invoices[0].date='2026-02-30';}],['invalid createdAt',s=>{s.invoices[0].createdAt='2026-10-12';}],['long seller',s=>{s.invoices[0].seller='x'.repeat(201);}],['nontext buyer',s=>{s.invoices[0].buyer=null;}],['long note',s=>{s.invoices[0].note='x'.repeat(501);}],
  ['zero amount',s=>{s.invoices[0].amount=0;}],['fractional amount',s=>{s.invoices[0].amount=0.1;}],['unsafe amount',s=>{s.invoices[0].amount=Number.MAX_SAFE_INTEGER+1;}],['total invoice overflow',s=>{changeInvoiceEverywhere(s,1,i=>{i.amount=Number.MAX_SAFE_INTEGER;});}],
  ['unknown identity',s=>{s.invoices[0].identityType='invoice';}],['empty confirmed number',s=>{s.invoices[0].number='';}],['number-only with code',s=>{s.invoices[0].code='CODE';}],['code-number without code',s=>{s.invoices[1].code='';}],
  ['noncanonical number',s=>{s.invoices[0].number=' ａ b ';}],['noncanonical code',s=>{s.invoices[1].code=' code-a ';}],['long number',s=>{s.invoices[0].number='X'.repeat(101);}],['unconfirmed allocation',s=>{s.invoices[0].identityType='unconfirmed';}],
  ['no attachment',s=>{s.invoices[0].attachmentIds=[];}],['missing attachment',s=>{s.invoices[0].attachmentIds[0]=randomUUID();}],['invalid attachment',s=>{s.invoices[0].attachmentIds[0]='../outside.png';}],['duplicate attachment',s=>{s.invoices[0].attachmentIds.push(s.invoices[0].attachmentIds[0]);}],
  ['payment attachment reuse',s=>{s.invoices[0].attachmentIds[0]=s.expenses[0].attachmentId;}],['advance attachment reuse',s=>{s.invoices[0].attachmentIds[0]=s.advanceDetails['0'].attachmentId;}],['cross-invoice image reuse',s=>{s.invoices[1].attachmentIds=[s.invoices[0].attachmentIds[0]];}],
  ['same image under different ids', (s,db)=>{db.prepare('UPDATE attachments SET sha256=(SELECT sha256 FROM attachments WHERE id=?) WHERE id=?').run(s.invoices[0].attachmentIds[0],s.invoices[0].attachmentIds[1]);}],
  ['unknown expense',s=>{s.invoices[0].expenseIds[0]=99;}],['duplicate expense',s=>{s.invoices[0].expenseIds.push(s.invoices[0].expenseIds[0]);}],['zero expense',s=>{s.invoices[0].expenseIds[0]=0;}],['invalid associations',s=>{s.invoices[0].expenseIds={};}],

 ];
 for(const [label,change] of cases){reseal(saved.directory,original,change);assert.throws(()=>verifyBackup(saved.directory),undefined,label);}
 reseal(saved.directory,original,()=>{});verifyBackup(saved.directory);
});

test('identity conflicts include unconfirmed known numbers and missing codes but permit distinct explicit codes',async t=>{
 const f=fixture(t);await f.command({kind:'invoice',invoice:invoice({identityType:'code-number',number:'SAME',code:'A'}),image:image('a')});await f.command({kind:'invoice',invoice:invoice({identityType:'code-number',number:'SAME',code:'B'}),image:image('b')});
 const saved=await f.ledger.backup(f.destination),original=fs.readFileSync(path.join(saved.directory,'database.sqlite'));verifyBackup(saved.directory);
 for(const [identityType,code] of [['code-number','A'],['number',''],['unconfirmed',''],['unconfirmed','A']]){reseal(saved.directory,original,s=>changeInvoiceEverywhere(s,2,i=>{i.identityType=identityType;i.code=code;}));assert.throws(()=>verifyBackup(saved.directory),/号码/);}
 reseal(saved.directory,original,s=>changeInvoiceEverywhere(s,2,i=>{i.identityType='unconfirmed';i.number='';i.code='';}));verifyBackup(saved.directory);
});

test('invoice event transitions cannot change stable facts, skip revisions or omit matching operations',async t=>{
 const f=fixture(t);await populated(f);const saved=await f.ledger.backup(f.destination),original=fs.readFileSync(path.join(saved.directory,'database.sqlite'));
 const events=s=>({create:s.invoiceEvents[0],scan:s.invoiceEvents[1],identity:s.invoiceEvents[2],allocate:s.invoiceEvents[3]});
 const cases=[
  ['unknown event key',s=>{s.invoiceEvents[0].extra=1;}],['unknown action',s=>{s.invoiceEvents[0].action='delete-invoice';}],['wrong event invoice id',s=>{s.invoiceEvents[0].invoiceId=2;}],['wrong revision',s=>{s.invoiceEvents[1].revision=3;}],['duplicate request id',s=>{s.invoiceEvents[1].requestId=s.invoiceEvents[0].requestId;}],
  ['wrong before initial',s=>{events(s).create.before={};}],['initial allocated',s=>{events(s).create.after.allocations=[{expenseId:1,amount:1}];}],['initial multiple scans',s=>{events(s).create.after.attachmentIds=events(s).scan.after.attachmentIds;}],['initial timestamp mismatch',s=>{events(s).create.after.createdAt='2026-01-01T00:00:00.000Z';}],
  ['broken chain',s=>{events(s).scan.before.note='changed before';}],['scan modifies amount',s=>{events(s).scan.after.amount++;}],['scan removes image',s=>{events(s).scan.after.attachmentIds.shift();}],['scan changes image order',s=>{events(s).scan.after.attachmentIds.reverse();}],
  ['confirmation remains unconfirmed',s=>{events(s).identity.after.identityType='unconfirmed';}],['confirmation modifies note',s=>{events(s).identity.after.note='changed';}],['allocation modifies seller',s=>{events(s).allocate.after.seller='changed';}],['allocation no change',s=>{events(s).allocate.after.expenseIds=[];}],
  ['last after differs',s=>{s.invoiceEvents.at(-1).after.note='not current';}],['reordered events',s=>{[s.invoiceEvents[0],s.invoiceEvents[1]]=[s.invoiceEvents[1],s.invoiceEvents[0]];}],
  ['missing operation',(s,db)=>{db.prepare('DELETE FROM operations WHERE id=?').run(s.invoiceEvents[0].requestId);}],['operation action mismatch',(s,db)=>{db.prepare('UPDATE operations SET kind=? WHERE id=?').run('expense',s.invoiceEvents[0].requestId);}],
  ['operation timestamp mismatch',(s,db)=>{db.prepare('UPDATE operations SET created_at=? WHERE id=?').run('2026-01-01T00:00:00.000Z',s.invoiceEvents[0].requestId);}],['extra operation',(s,db)=>{db.prepare('INSERT INTO operations VALUES(?,?,?,?)').run(randomUUID(),'a'.repeat(64),'invoice-allocate',s.invoiceEvents[0].at);}],
 ];
 for(const [label,change] of cases){reseal(saved.directory,original,change);assert.throws(()=>verifyBackup(saved.directory),undefined,label);}
 reseal(saved.directory,original,()=>{});verifyBackup(saved.directory);
});

test('multiple invoices may associate the same expense without amount ceilings; old amounts remain historical metadata',async t=>{
 const f=fixture(t);await f.command({kind:'expense',expense:{category:'接待',date:'2026-10-12',merchant:'合成费用',amount:1000,note:''}});
 for(const number of ['A','B'])await f.command({kind:'invoice',invoice:invoice({number,amount:1}),image:image(number)});
 for(const id of [1,2])await f.change('invoice-link',id,{expenseIds:[1]});
 const saved=await f.ledger.backup(f.destination),original=fs.readFileSync(path.join(saved.directory,'database.sqlite'));verifyBackup(saved.directory);
 // Old allocation cents stay byte-for-byte and never become cash or reimbursement facts.
 reseal(saved.directory,original,s=>{for(const record of [...s.invoices,...s.invoiceEvents.flatMap(event=>[event.before,event.after]).filter(Boolean)]){const ids=record.expenseIds;if(ids?.length){record.allocations=ids.map(expenseId=>({expenseId,amount:2000}));delete record.expenseIds;}}});
 verifyBackup(saved.directory);const restored=restoreBackup({backupDir:saved.directory,targetDir:path.join(f.root,'legacy-associations')});
 assert.equal(snapshot(restored.directory).cash.balance,-1000n);assert.equal(snapshot(restored.directory).state.invoices[0].allocations[0].amount,2000);
});

test('pending invoice corruption blocks managed reopening without modifying or repairing source state',async t=>{
 const f=fixture(t);await populated(f);await f.ledger.close();mutate(path.join(f.source,'trial.sqlite'),db=>{const state=JSON.parse(db.prepare('SELECT json FROM trial_state').get().json);state.invoiceEvents[1].before.amount++;db.prepare('UPDATE trial_state SET json=?').run(JSON.stringify(state));});
 const before=snapshot(f.source);assert.throws(()=>createManagedLedger(f.source,service),/审计链/);assert.equal(fs.existsSync(path.join(f.source,'.writer-lock')),false);assert.deepEqual(snapshot(f.source),before);
});

test('reset removes invoice records, audit, operations and scans while preserving external backup for restoration',async t=>{
 const f=fixture(t),before=await populated(f),saved=await f.ledger.backup(f.destination),state=await f.ledger.command({kind:'read'});
 await f.ledger.command({kind:'reset-ledger',generation:state.generation,requestId:randomUUID(),confirmation:'清空当前账本'});
 const cleared=snapshot(f.source);assert.equal(cleared.state.invoices,undefined);assert.equal(cleared.state.invoiceEvents,undefined);assert.equal(cleared.state.expenseEvents,undefined);assert.deepEqual(cleared.state.expenses,[]);assert.deepEqual(cleared.operations,[]);assert.deepEqual(cleared.attachments,[]);assert.deepEqual(cleared.files,[]);assert.equal(cleared.cash.balance,0n);
 const empty=await f.ledger.backup(f.destination);assert.equal(empty.summary.attachmentCount,0);await f.reopen();assert.deepEqual(snapshot(f.source),cleared);
 const restored=restoreBackup({backupDir:saved.directory,targetDir:path.join(f.root,'pre-reset')}),ledger=f.open(restored.directory);await ledger.close();assert.deepEqual(snapshot(restored.directory),before);inspectDatabase(path.join(f.source,'trial.sqlite'));
});
