const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{randomUUID,createHash}=require('node:crypto');
const Database=require('better-sqlite3'),{createLedger}=require('../spike/trial-ledger.cjs');
const {createManagedLedger}=require('../spike/managed-ledger.cjs');
const {resetLedger,resumeReset,readResetStatus,CONFIRMATION}=require('../spike/ledger-reset.cjs');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOYVnECAAN+AdcpgjGUAAAAAElFTkSuQmCC','base64');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t){
 const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xx-ledger-reset-'))),root=path.join(base,'ledger'),generation=randomUUID(),external=path.join(base,'raw.png'),backup=path.join(base,'backup'),other=path.join(base,'other');
 t.after(()=>fs.rmSync(base,{recursive:true,force:true}));fs.mkdirSync(backup);fs.mkdirSync(other);fs.writeFileSync(external,png);fs.writeFileSync(path.join(backup,'database.sqlite'),'synthetic untouched backup');fs.writeFileSync(path.join(other,'trial.sqlite'),'synthetic untouched other ledger');
 let ledger=createLedger(root,{recognize:async()=>({validated:true})});
 try{
  await ledger.command({kind:'advance',requestId:randomUUID(),advance:{amount:10000,date:'2026-10-01',note:'合成预支'},image:{base64:png.toString('base64')}});
  await ledger.command({kind:'expense',requestId:randomUUID(),expense:{amount:15000,date:'2026-10-02',category:'接待',merchant:'合成接待商户',note:'合成费用'},image:{base64:png.toString('base64')}});
  await ledger.command({kind:'expense',requestId:randomUUID(),expense:{amount:5000,date:'2026-10-03',category:'办公',merchant:'合成办公摘要',note:'合成办公备注'}});
  await ledger.command({kind:'batch',requestId:randomUUID(),date:'2026-10-04',allocations:[{expenseId:1,amount:3000},{expenseId:2,amount:2000}]});
  await ledger.command({kind:'batch',requestId:randomUUID(),date:'2026-10-05',allocations:[{expenseId:1,amount:1000}]});
  await ledger.command({kind:'delete-batch',requestId:randomUUID(),id:2});
 }finally{ledger.close();}
 const marker={formatVersion:1,ledgerId:randomUUID(),sourceKind:'isolated-test'};fs.writeFileSync(path.join(root,'managed-ledger.json'),JSON.stringify(marker));
 const db=new Database(path.join(root,'trial.sqlite'));try{const state=JSON.parse(db.prepare('SELECT json FROM trial_state').get().json);state.generation=generation;state.syntheticExtra={draft:'合成未来业务字段'};db.prepare('UPDATE trial_state SET json=? WHERE id=1').run(JSON.stringify(state));}finally{db.close();}
 fs.writeFileSync(path.join(root,'attachments',randomUUID()+'.png'),png); // Legal orphan is also owned by this ledger.
 const args={root,requestId:randomUUID(),generation,confirmation:CONFIRMATION};
 return {base,root,args,external,backup,other,db(fn){const db=new Database(path.join(root,'trial.sqlite'));try{return fn(db);}finally{db.close();}}};
}
function facts(f){return f.db(db=>({raw:db.prepare('SELECT json FROM trial_state').get().json,operations:db.prepare('SELECT * FROM operations ORDER BY id').all(),attachments:db.prepare('SELECT * FROM attachments ORDER BY id').all()}));}
const state=f=>JSON.parse(facts(f).raw);
const files=f=>fs.readdirSync(path.join(f.root,'attachments')).sort().map(name=>({name,sha256:hash(fs.readFileSync(path.join(f.root,'attachments',name)))}));
const journal=f=>path.join(f.root,'reset-journal.json');
function assertEmpty(f,result){
 assert.deepEqual(Object.keys(result).sort(),['advances','batches','expenses','generation','resetReceipt']);assert.deepEqual(result.expenses,[]);assert.deepEqual(result.advances,[]);assert.deepEqual(result.batches,[]);assert.notEqual(result.generation,f.args.generation);
 assert.deepEqual(result.resetReceipt,{requestId:f.args.requestId,fromGeneration:f.args.generation,at:result.resetReceipt.at});assert.ok(Number.isFinite(Date.parse(result.resetReceipt.at)));
 assert.deepEqual(facts(f),{raw:JSON.stringify(result),operations:[],attachments:[]});
}

test('wrong confirmation or invalid request performs no reset and cancellation has no command to execute',async t=>{
 const f=await fixture(t),before=facts(f),beforeFiles=files(f),dbHash=hash(fs.readFileSync(path.join(f.root,'trial.sqlite')));
 for(const confirmation of [undefined,'','清空',' 清空当前账本','清空当前账本 '])assert.throws(()=>resetLedger({...f.args,confirmation}),/完整确认文字/);
 for(const requestId of [undefined,'bad',3])assert.throws(()=>resetLedger({...f.args,requestId}),/请求或账本代际无效/);
 assert.deepEqual(facts(f),before);assert.deepEqual(files(f),beforeFiles);assert.equal(hash(fs.readFileSync(path.join(f.root,'trial.sqlite'))),dbHash);assert.equal(fs.existsSync(journal(f)),false);assert.deepEqual(readResetStatus(f.root),{pending:false});
});

test('all facts, histories, metadata, operations and owned files reset while external images, backups and other roots remain',async t=>{
 const f=await fixture(t),untouched=[f.external,path.join(f.backup,'database.sqlite'),path.join(f.other,'trial.sqlite'),path.join(f.root,'managed-ledger.json')].map(file=>({file,sha256:hash(fs.readFileSync(file))}));
 assert.equal(files(f).length,3);const before=state(f);assert.ok(before.advanceDetails);assert.ok(before.batchEvents);assert.ok(before.syntheticExtra);
 const result=resetLedger(f.args);assertEmpty(f,result);assert.deepEqual(files(f),[]);assert.deepEqual(readResetStatus(f.root),{pending:false});assert.equal(fs.existsSync(journal(f)),false);
 for(const item of untouched)assert.equal(hash(fs.readFileSync(item.file)),item.sha256);
 assert.equal(f.db(db=>db.pragma('freelist_count',{simple:true})),0);for(const suffix of ['-wal','-shm','-journal'])assert.equal(fs.existsSync(path.join(f.root,'trial.sqlite'+suffix)),false);
});

test('stale generations and old ledgers without a generation are refused without upgrading their data',async t=>{
 const f=await fixture(t),before=facts(f),beforeFiles=files(f);assert.throws(()=>resetLedger({...f.args,generation:randomUUID()}),/代际已变化/);assert.deepEqual(facts(f),before);assert.deepEqual(files(f),beforeFiles);
 const legacy=state(f);delete legacy.generation;f.db(db=>db.prepare('UPDATE trial_state SET json=? WHERE id=1').run(JSON.stringify(legacy,null,2)));const old=facts(f);
 assert.throws(()=>resetLedger(f.args),/旧账本不支持/);assert.deepEqual(facts(f),old);assert.equal(fs.existsSync(journal(f)),false);
});

test('a transaction failure preserves the entire ledger and every attachment and removes its intent journal',async t=>{
 const f=await fixture(t);f.db(db=>db.exec("CREATE TRIGGER fail_reset BEFORE DELETE ON attachments BEGIN SELECT RAISE(ABORT,'synthetic reset transaction failure'); END"));
 const before=facts(f),beforeFiles=files(f);assert.throws(()=>resetLedger(f.args),/synthetic reset transaction failure/);assert.deepEqual(facts(f),before);assert.deepEqual(files(f),beforeFiles);assert.deepEqual(readResetStatus(f.root),{pending:false});
 f.db(db=>db.exec('DROP TRIGGER fail_reset'));assertEmpty(f,resetLedger(f.args));assert.deepEqual(files(f),[]);
});

test('partial attachment cleanup stays pending and same request resumes after reopening without resetting twice',async t=>{
 const f=await fixture(t),original=fs.unlinkSync;let removals=0;
 const mocked=t.mock.method(fs,'unlinkSync',function(file){if(path.dirname(file)===path.join(f.root,'attachments')&&++removals===2)throw Error('synthetic unlink failure');return original.call(this,file);});
 assert.throws(()=>resetLedger(f.args),e=>e.code==='RESET_PENDING'&&e.pending&&/尚未完成/.test(e.message));mocked.mock.restore();
 const pending=readResetStatus(f.root),empty=state(f);assert.equal(pending.pending,true);assert.equal(pending.phase,'cleanup');assert.equal(pending.requestId,f.args.requestId);assertEmpty(f,empty);assert.equal(files(f).length,2);
 const intent=JSON.parse(fs.readFileSync(journal(f),'utf8'));assert.deepEqual(Object.keys(intent).sort(),['at','fromGeneration','requestId','toGeneration','version']);assert.equal(JSON.stringify(intent).includes('合成'),false);
 assert.throws(()=>resetLedger({...f.args,requestId:randomUUID()}),e=>e.code==='RESET_PENDING');assert.deepEqual(state(f),empty);
 delete require.cache[require.resolve('../spike/ledger-reset.cjs')];const reopened=require('../spike/ledger-reset.cjs');assert.deepEqual(reopened.readResetStatus(f.root),pending);assert.deepEqual(reopened.resumeReset(f.args),empty);assert.deepEqual(files(f),[]);assert.deepEqual(readResetStatus(f.root),{pending:false});
});

test('a durable prepared intent resumes the same confirmed request rather than automatically writing on status read',async t=>{
 const f=await fixture(t),before=facts(f),beforeFiles=files(f),value={version:1,requestId:f.args.requestId,fromGeneration:f.args.generation,toGeneration:randomUUID(),at:new Date().toISOString()};fs.writeFileSync(journal(f),JSON.stringify(value));
 assert.equal(readResetStatus(f.root).phase,'prepared');assert.deepEqual(facts(f),before);assert.deepEqual(files(f),beforeFiles);
 const result=resumeReset(f.args);assertEmpty(f,result);assert.equal(result.generation,value.toGeneration);assert.equal(result.resetReceipt.at,value.at);assert.deepEqual(files(f),[]);
});

test('completed reset retries preserve new records and attachments, and stale requests cannot initiate another reset',async t=>{
 const f=await fixture(t),empty=resetLedger(f.args);assert.deepEqual(resetLedger(f.args),empty);
 const ledger=createManagedLedger(f.root,{recognize:async()=>({validated:true})});try{const current=await ledger.command({kind:'read'});await ledger.command({kind:'expense',requestId:randomUUID(),generation:current.generation,expense:{amount:99,date:'2026-10-12',category:'办公',merchant:'清空后的合成新费用',note:''},image:{base64:png.toString('base64')}});}finally{await ledger.close();}
 const before=facts(f),beforeFiles=files(f);assert.equal(state(f).expenses.length,1);assert.equal(beforeFiles.length,1);assert.deepEqual(resumeReset(f.args),state(f));assert.deepEqual(facts(f),before);assert.deepEqual(files(f),beforeFiles);
 assert.throws(()=>resetLedger({...f.args,requestId:randomUUID()}),/代际已变化/);assert.deepEqual(facts(f),before);assert.deepEqual(files(f),beforeFiles);
});

test('unsafe attachment roots, entries, database hardlinks and final root symlinks are rejected before business deletion',async t=>{
 for(const mode of ['attachment-link','directory-entry','unknown-entry','attachment-root-link','database-hardlink','root-link']){
  const f=await fixture(t),before=facts(f),externalHash=hash(fs.readFileSync(f.external));let root=f.root;
  if(mode==='attachment-link')fs.symlinkSync(f.external,path.join(f.root,'attachments',randomUUID()+'.png'));
  if(mode==='directory-entry')fs.mkdirSync(path.join(f.root,'attachments',randomUUID()+'.png'));
  if(mode==='unknown-entry')fs.writeFileSync(path.join(f.root,'attachments','not-managed.txt'),'keep');
  if(mode==='attachment-root-link'){fs.renameSync(path.join(f.root,'attachments'),path.join(f.base,'saved-attachments'));fs.symlinkSync(f.backup,path.join(f.root,'attachments'));}
  if(mode==='database-hardlink')fs.linkSync(path.join(f.root,'trial.sqlite'),path.join(f.base,'shared.sqlite'));
  if(mode==='root-link'){root=path.join(f.base,'linked-ledger');fs.symlinkSync(f.root,root);}
  assert.throws(()=>resetLedger({...f.args,root}),/拒绝|非受管/);assert.deepEqual(facts(f),before);assert.equal(hash(fs.readFileSync(f.external)),externalHash);assert.equal(fs.existsSync(journal(f)),false);
 }
});

test('checkpoint and vacuum failures keep cleanup pending and retry completes without a second generation change',async t=>{
 for(const failure of ['checkpoint','vacuum']){
  const f=await fixture(t),method=failure==='checkpoint'?'pragma':'exec',original=Database.prototype[method];
  const mocked=t.mock.method(Database.prototype,method,function(sql,...args){if(failure==='checkpoint'&&sql==='wal_checkpoint(TRUNCATE)')return [{busy:1,log:1,checkpointed:0}];if(failure==='vacuum'&&sql==='VACUUM')throw Error('synthetic vacuum failure');return original.call(this,sql,...args);});
  assert.throws(()=>resetLedger(f.args),e=>e.code==='RESET_PENDING');mocked.mock.restore();const empty=state(f);assertEmpty(f,empty);assert.deepEqual(files(f),[]);assert.equal(readResetStatus(f.root).phase,'cleanup');
  assert.deepEqual(resumeReset(f.args),empty);assert.deepEqual(readResetStatus(f.root),{pending:false});
 }
});

test('invalid pending journals block access and unexpected new facts during pending cleanup are never erased',async t=>{
 const f=await fixture(t),before=facts(f);fs.writeFileSync(journal(f),'broken');assert.throws(()=>readResetStatus(f.root),e=>e.code==='RESET_PENDING');assert.throws(()=>resetLedger(f.args),e=>e.code==='RESET_PENDING');assert.deepEqual(facts(f),before);fs.unlinkSync(journal(f));
 const original=fs.unlinkSync,mocked=t.mock.method(fs,'unlinkSync',function(file){if(path.dirname(file)===path.join(f.root,'attachments'))throw Error('synthetic blocked cleanup');return original.call(this,file);});assert.throws(()=>resetLedger(f.args),e=>e.code==='RESET_PENDING');mocked.mock.restore();
 const changed=state(f);changed.syntheticUnexpected='do not erase';f.db(db=>db.prepare('UPDATE trial_state SET json=? WHERE id=1').run(JSON.stringify(changed)));const pendingFacts=facts(f),pendingFiles=files(f);
 assert.throws(()=>resumeReset(f.args),e=>e.code==='RESET_PENDING'&&/新的业务记录/.test(e.message));assert.deepEqual(facts(f),pendingFacts);assert.deepEqual(files(f),pendingFiles);
});
