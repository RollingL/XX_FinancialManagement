const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {randomUUID}=require('node:crypto'),{spawnSync}=require('node:child_process');
const {createManagedLedger,acquireManagedLock}=require('../spike/managed-ledger.cjs');
const {parse,main:maintenance}=require('../spike/ledger-maintenance.cjs');
const {createLedger}=require('../spike/trial-ledger.cjs');
const Database=require('better-sqlite3');
const generations=new WeakMap();
const send=(ledger,input)=>ledger.command({...input,generation:Object.hasOwn(input,'generation')?input.generation:generations.get(ledger)});
const markerName='managed-ledger.json',lockName='.writer-lock';
const advance=()=>({kind:'advance',requestId:randomUUID(),advance:{amount:100,date:'2026-10-12',note:'synthetic advance'}});
const image={base64:Buffer.from([137,80,78,71,13,10,26,10]).toString('base64')};
function fixture(t,service,dependencies){
 const parent=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'qianlai-managed-test-'))),root=path.join(parent,'ledger');
 let ledger;
 t.after(async()=>{if(ledger)await ledger.close().catch(()=>{});fs.rmSync(parent,{recursive:true,force:true});});
 return {root,parent,open(){ledger=createManagedLedger(root,service,dependencies);const db=new Database(path.join(root,'trial.sqlite'),{readonly:true,fileMustExist:true});try{const state=JSON.parse(db.prepare('SELECT json FROM trial_state WHERE id=1').get().json);generations.set(ledger,`${ledger.ledgerId}:${state.generation??'legacy'}`);}finally{db.close();}return ledger;}};
}
function deferred(){let resolve,reject;const promise=new Promise((done,fail)=>{resolve=done;reject=fail;});return {promise,resolve,reject};}

test('unknown, incomplete and invalid marker roots are refused without creating a database',t=>{
 const f=fixture(t);fs.mkdirSync(f.root);
 assert.throws(()=>f.open(),/缺少 managed-ledger.json/);assert.deepEqual(fs.readdirSync(f.root),[]);
 for(const marker of [{formatVersion:1,ledgerId:randomUUID(),sourceKind:'real'},{formatVersion:2,ledgerId:randomUUID(),sourceKind:'isolated-test'},{formatVersion:1,ledgerId:randomUUID(),sourceKind:'isolated-test',extra:true},{formatVersion:1,ledgerId:'bad',sourceKind:'isolated-test'},{formatVersion:1,ledgerId:[randomUUID()],sourceKind:'isolated-test'}]){
  fs.writeFileSync(path.join(f.root,markerName),JSON.stringify(marker));assert.throws(()=>f.open(),/标识无效/);assert.equal(fs.existsSync(path.join(f.root,'trial.sqlite')),false);assert.equal(fs.existsSync(path.join(f.root,lockName)),false);
 }
 fs.writeFileSync(path.join(f.root,markerName),JSON.stringify({formatVersion:1,ledgerId:randomUUID(),sourceKind:'isolated-test'}));assert.throws(()=>f.open(),/缺少 trial.sqlite/);assert.equal(fs.existsSync(path.join(f.root,'trial.sqlite')),false);
});

test('a valid marker with an empty database is rejected rather than initialized',t=>{
 const f=fixture(t);fs.mkdirSync(f.root);fs.mkdirSync(path.join(f.root,'attachments'));
 fs.writeFileSync(path.join(f.root,markerName),JSON.stringify({formatVersion:1,ledgerId:randomUUID(),sourceKind:'isolated-test'}));
 fs.writeFileSync(path.join(f.root,'trial.sqlite'),'');
 assert.throws(()=>f.open(),/未初始化或补表/);assert.equal(fs.statSync(path.join(f.root,'trial.sqlite')).size,0);assert.equal(fs.existsSync(path.join(f.root,lockName)),false);
});

test('existing unknown triggers are refused before createLedger can write the database',async t=>{
 const f=fixture(t),ledger=f.open();await send(ledger,advance());await ledger.close();
 const Database=require('better-sqlite3'),db=new Database(path.join(f.root,'trial.sqlite'));
 db.exec("CREATE TRIGGER unexpected_trigger AFTER UPDATE ON trial_state BEGIN SELECT 1; END");db.close();
 const before=fs.readFileSync(path.join(f.root,'trial.sqlite'));
 assert.throws(()=>f.open(),/未初始化或补表/);assert.deepEqual(fs.readFileSync(path.join(f.root,'trial.sqlite')),before);assert.equal(fs.existsSync(path.join(f.root,lockName)),false);
});

test('fresh root has an isolated identity, persists unchanged, and excludes a second process',async t=>{
 const f=fixture(t),ledger=f.open(),marker=JSON.parse(fs.readFileSync(path.join(f.root,markerName),'utf8'));
 assert.equal(marker.formatVersion,1);assert.equal(marker.sourceKind,'isolated-test');assert.equal(marker.ledgerId,ledger.ledgerId);
 const state=await send(ledger,advance());assert.deepEqual(state.advances,[100]);
 const child=spawnSync(process.execPath,['-e',"const {createManagedLedger}=require(process.argv[1]);try{createManagedLedger(process.argv[2]);process.exitCode=9;}catch(e){process.stderr.write(e.message);process.exitCode=3;}",path.resolve('spike/managed-ledger.cjs'),f.root],{encoding:'utf8'});
 assert.equal(child.status,3,child.stderr);assert.match(child.stderr,/正在使用或有残留锁/);
 assert.throws(()=>acquireManagedLock(f.root),/正在使用或有残留锁/);
 await ledger.close();assert.equal(fs.existsSync(path.join(f.root,lockName)),false);
 const reopened=f.open();assert.equal(reopened.ledgerId,marker.ledgerId);assert.deepEqual(await reopened.command({kind:'read'}),state);
});

test('a leftover lock is preserved, never automatically removed or claimed',async t=>{
 const f=fixture(t),ledger=f.open();await ledger.close();
 const lock=path.join(f.root,lockName);fs.mkdirSync(lock);fs.writeFileSync(path.join(lock,'unrecognized'),'keep');
 assert.throws(()=>f.open(),/残留锁/);assert.equal(fs.readFileSync(path.join(lock,'unrecognized'),'utf8'),'keep');
});

test('symlink roots, marker, database, attachments and WAL are refused',async t=>{
 const f=fixture(t),ledger=f.open();await ledger.close();
 const alias=path.join(f.parent,'alias');fs.symlinkSync(f.root,alias,'dir');assert.throws(()=>createManagedLedger(alias),/普通目录/);
 for(const name of [markerName,'trial.sqlite','attachments']){
  const original=path.join(f.root,name),outside=path.join(f.parent,'outside-'+name);fs.renameSync(original,outside);fs.symlinkSync(outside,original);
  assert.throws(()=>f.open(),/普通/);assert.equal(fs.existsSync(path.join(f.root,lockName)),false);fs.unlinkSync(original);fs.renameSync(outside,original);
 }
 const outside=path.join(f.parent,'synthetic-wal');fs.writeFileSync(outside,'synthetic');fs.symlinkSync(outside,path.join(f.root,'trial.sqlite-wal'));
 assert.throws(()=>f.open(),/普通文件/);assert.equal(fs.readFileSync(outside,'utf8'),'synthetic');
});

test('pending attachment validation reserves the gate and close keeps the lock until save finishes',async t=>{
 const waiting=deferred(),started=deferred();let backupCalls=0;
 const f=fixture(t,{recognize(){started.resolve();return waiting.promise;}},{createBackup:async()=>{backupCalls++;}}),ledger=f.open();
 const pending=send(ledger,{...advance(),image});await started.promise;
 await assert.rejects(ledger.backup(f.parent),/正在保存或维护/);assert.equal(backupCalls,0);
 await assert.rejects(send(ledger,advance()),/正在保存或维护/);
 const closing=ledger.close();assert.equal(fs.existsSync(path.join(f.root,lockName)),true);
 assert.throws(()=>createManagedLedger(f.root),/残留锁/);await assert.rejects(ledger.command({kind:'read'}),/正在关闭/);
 waiting.resolve({});await pending;await closing;assert.equal(fs.existsSync(path.join(f.root,lockName)),false);
 const reopened=f.open(),state=await reopened.command({kind:'read'});assert.deepEqual(state.advances,[100]);assert.ok(state.advanceDetails[0].attachmentId);assert.equal(fs.readdirSync(path.join(f.root,'attachments')).length,1);
});

test('close waits for failed attachment validation and leaves no partial record or file',async t=>{
 const waiting=deferred(),started=deferred(),f=fixture(t,{recognize(){started.resolve();return waiting.promise;}}),ledger=f.open();
 const pending=send(ledger,{...advance(),image});await started.promise;
 const rejected=assert.rejects(pending,/synthetic validation cancelled/),closing=ledger.close();assert.equal(fs.existsSync(path.join(f.root,lockName)),true);
 waiting.reject(Error('synthetic validation cancelled'));await rejected;await closing;
 assert.equal(fs.existsSync(path.join(f.root,lockName)),false);assert.deepEqual(fs.readdirSync(path.join(f.root,'attachments')),[]);
 const state=await f.open().command({kind:'read'});assert.deepEqual([state.expenses,state.batches,state.advances],[[],[],[]]);
});

test('backup uses a readonly existing database, rejects concurrent commands, and closes before releasing lock',async t=>{
 const waiting=deferred(),started=deferred();let backupDb;
 const f=fixture(t,undefined,{createBackup:async options=>{backupDb=options.db;assert.equal(options.sourceKind,'isolated-test');assert.equal(options.dataDir,f.root);assert.equal(options.db.readonly,true);started.resolve();await waiting.promise;return {directory:'synthetic-result',ledgerId:options.ledgerId};}}),ledger=f.open();
 await send(ledger,advance());const backup=ledger.backup(f.parent);await started.promise;
 await assert.rejects(ledger.command({kind:'read'}),/正在保存或维护/);await assert.rejects(send(ledger,advance()),/正在保存或维护/);await assert.rejects(ledger.backup(f.parent),/正在保存或维护/);
 const closing=ledger.close();assert.equal(fs.existsSync(path.join(f.root,lockName)),true);assert.equal(backupDb.open,true);
 waiting.resolve();assert.equal((await backup).ledgerId,ledger.ledgerId);await closing;assert.equal(backupDb.open,false);assert.equal(fs.existsSync(path.join(f.root,lockName)),false);
});

test('failed maintenance frees the gate but holds the lifetime lock until close',async t=>{
 const f=fixture(t,undefined,{createBackup:async()=>{throw Error('synthetic backup failure');}}),ledger=f.open();
 await assert.rejects(ledger.backup(f.parent),/synthetic backup failure/);assert.equal(fs.existsSync(path.join(f.root,lockName)),true);
 const state=await send(ledger,advance());assert.deepEqual(state.advances,[100]);await ledger.close();assert.equal(fs.existsSync(path.join(f.root,lockName)),false);
});

test('close refuses to release a lock whose owner token changed',async t=>{
 const f=fixture(t),ledger=f.open(),ownerFile=path.join(f.root,lockName,'owner.json'),changed={token:randomUUID()};fs.writeFileSync(ownerFile,JSON.stringify(changed));
 await assert.rejects(ledger.close(),/所有者或内容已变化/);assert.deepEqual(JSON.parse(fs.readFileSync(ownerFile,'utf8')),changed);await assert.rejects(ledger.command({kind:'read'}),/正在关闭/);
});

test('maintenance CLI requires exact explicit flags without defaults, duplicate flags or unknown options',()=>{
 assert.deepEqual(parse(['backup','--source','/synthetic/ledger','--destination','/synthetic/backups']),{command:'backup',source:'/synthetic/ledger',destination:'/synthetic/backups'});
 assert.deepEqual(parse(['verify','--backup','/synthetic/backup']),{command:'verify',backup:'/synthetic/backup'});
 assert.deepEqual(parse(['restore','--backup','/synthetic/backup','--target','/synthetic/new-ledger']),{command:'restore',backup:'/synthetic/backup',target:'/synthetic/new-ledger'});
 for(const args of [[],['init'],['constructor'],['__proto__'],['backup'],['backup','--source','/synthetic'],['backup','--source','/a','--source','/b','--destination','/c'],['verify','--backup',''],['restore','--backup','/a','--target','/b','--overwrite','yes']])assert.throws(()=>parse(args));
});

test('uncertain base initialization failure retains its lock rather than assuming the database closed',t=>{
 const f=fixture(t),mkdir=fs.mkdirSync;t.mock.method(fs,'mkdirSync',(directory,options)=>{if(directory===path.join(f.root,'attachments'))throw Error('synthetic initialization failure');return mkdir(directory,options);});
 assert.throws(()=>f.open(),/连接状态无法确认，保留锁/);assert.equal(fs.existsSync(path.join(f.root,lockName,'owner.json')),true);assert.equal(fs.existsSync(path.join(f.root,'trial.sqlite')),false);
});

test('ordinary createLedger cannot bypass a managed marker with or without a running owner',async t=>{
 const f=fixture(t),ledger=f.open();await send(ledger,advance());const state=await ledger.command({kind:'read'});
 const before=fs.readFileSync(path.join(f.root,'trial.sqlite'));
 assert.throws(()=>createLedger(f.root),/持锁入口/);assert.throws(()=>createLedger(f.root,undefined,randomUUID()),/持锁入口/);
 assert.deepEqual(fs.readFileSync(path.join(f.root,'trial.sqlite')),before);assert.deepEqual(await ledger.command({kind:'read'}),state);
 await ledger.close();const closedBytes=fs.readFileSync(path.join(f.root,'trial.sqlite'));
 assert.throws(()=>createLedger(f.root),/持锁入口/);assert.deepEqual(fs.readFileSync(path.join(f.root,'trial.sqlite')),closedBytes);
 const dangling=path.join(f.parent,'dangling');fs.mkdirSync(dangling);fs.symlinkSync(path.join(f.parent,'missing-marker'),path.join(dangling,markerName));
 assert.throws(()=>createLedger(dangling),/持锁入口/);assert.equal(fs.existsSync(path.join(dangling,'trial.sqlite')),false);
 const lock=path.join(f.root,lockName),owner=path.join(f.parent,'owner-target');fs.mkdirSync(lock);const token=randomUUID();fs.writeFileSync(owner,JSON.stringify({token}));fs.symlinkSync(owner,path.join(lock,'owner.json'));
 assert.throws(()=>createLedger(f.root,undefined,token),/持锁入口/);assert.deepEqual(fs.readFileSync(path.join(f.root,'trial.sqlite')),closedBytes);
});

test('unmanaged roots expose unsupported maintenance metadata without adding state',async t=>{
 const f=fixture(t),ledger=createLedger(f.root);try{
  const before=await ledger.command({kind:'read'});
  assert.deepEqual(await ledger.command({kind:'maintenance-info'}),{supported:false,backupConfigured:false,canReset:false});assert.deepEqual(await ledger.command({kind:'read'}),before);
 }finally{ledger.close();}
});

test('generation is created only for new roots and stale requests fail before base idempotency',async t=>{
 const f=fixture(t),ledger=f.open(),state=await ledger.command({kind:'read'}),generation=state.generation;
 assert.match(generation,new RegExp('^'+ledger.ledgerId+':[a-f0-9-]{36}$'));
 const input={...advance(),generation};await ledger.command(input);const expected=await ledger.command({kind:'read'});
 for(const value of [undefined,'stale',`${randomUUID()}:${generation.split(':')[1]}`])await assert.rejects(ledger.command({...input,generation:value}),/代际已变化/);
 await assert.rejects(ledger.command({kind:'attachment',id:randomUUID(),generation:'stale'}),/代际已变化/);
 assert.deepEqual(await ledger.command({kind:'read'}),expected);assert.deepEqual(await ledger.command(input),expected);
 const info=await ledger.command({kind:'maintenance-info'});assert.equal(info.canReset,true);assert.equal(info.backupConfigured,false);assert.equal(info.generation,generation);assert.equal(info.pendingReset,null);
 await assert.rejects(ledger.command({kind:'create-backup',requestId:randomUUID(),generation}),/尚未配置/);
});

test('reset waits for OCR service shutdown while the gate rejects other work',async t=>{
 const started=deferred(),finished=deferred(),f=fixture(t,{stop(){started.resolve();},finished:finished.promise}),ledger=f.open();
 const generation=(await ledger.command({kind:'read'})).generation;
 const pending=ledger.command({kind:'reset-ledger',requestId:randomUUID(),generation,confirmation:'清空当前账本'});await started.promise;
 await assert.rejects(ledger.command({...advance(),generation}),/正在保存或维护/);await assert.rejects(ledger.command({kind:'read'}),/正在保存或维护/);
 finished.resolve();assert.equal((await pending).completed,true);await assert.rejects(ledger.command({...advance(),generation}),/代际已变化/);
});

test('configured backup uses only trusted destination, same-process idempotency and maintenance gate',async t=>{
 let calls=0;const started=deferred(),waiting=deferred(),options={createBackup:async input=>{calls++;assert.equal(input.destinationParent,f.parent);started.resolve();await waiting.promise;return {directory:'synthetic-backup',summary:{balanceCents:'0'}};}};
 const f=fixture(t,undefined,options);options.backupDestination=f.parent;const ledger=f.open(),generation=(await ledger.command({kind:'read'})).generation;
 const input={kind:'create-backup',requestId:randomUUID(),generation};
 await assert.rejects(ledger.command({...input,destinationParent:'/renderer-cannot-select-this'}),/启动时配置/);
 const pending=ledger.command(input);await started.promise;
 await assert.rejects(ledger.command({kind:'reset-ledger',requestId:randomUUID(),generation,confirmation:'清空当前账本'}),/正在保存或维护/);
 await assert.rejects(ledger.command({kind:'read'}),/正在保存或维护/);
 waiting.resolve();const result=await pending;assert.deepEqual(await ledger.command(input),result);assert.equal(calls,1);
 assert.equal((await ledger.command({kind:'maintenance-info'})).backupConfigured,true);
});

test('reset changes generation, clears data and attachments, and completed retries preserve subsequent data',async t=>{
 let stops=0,backups=0;const options={createBackup:async()=>({directory:`synthetic-${++backups}`,summary:{}})};
 const f=fixture(t,{recognize:async()=>({}),stop(){stops++;},finished:Promise.resolve()},options);options.backupDestination=f.parent;
 const ledger=f.open(),oldGeneration=(await ledger.command({kind:'read'})).generation,original={...advance(),image,generation:oldGeneration};await ledger.command(original);
 const backupId=randomUUID();await ledger.command({kind:'create-backup',requestId:backupId,generation:oldGeneration});
 const reset={kind:'reset-ledger',requestId:randomUUID(),generation:oldGeneration,confirmation:'清空当前账本'};
 await assert.rejects(ledger.command({...reset,confirmation:'清空'}),/完整确认/);
 const result=await ledger.command(reset);assert.equal(result.completed,true);assert.notEqual(result.generation,oldGeneration);assert.equal(stops,1);
 const state=await ledger.command({kind:'read'});assert.deepEqual([state.advances,state.expenses,state.batches],[[],[],[]]);assert.deepEqual(fs.readdirSync(path.join(f.root,'attachments')),[]);
 await assert.rejects(ledger.command(original),/代际已变化/);await assert.rejects(ledger.command({kind:'create-backup',requestId:backupId,generation:oldGeneration}),/代际已变化/);
 const current=await ledger.command({...advance(),image,generation:result.generation});assert.equal(current.advances.length,1);
 assert.equal((await ledger.command(reset)).completed,true);assert.equal(stops,1);assert.deepEqual(await ledger.command({kind:'read'}),current);assert.equal(fs.readdirSync(path.join(f.root,'attachments')).length,1);
 await ledger.command({kind:'create-backup',requestId:backupId,generation:result.generation});assert.equal(backups,2);
});

function prepared(root,generation){const value={version:1,requestId:randomUUID(),fromGeneration:generation.split(':')[1],toGeneration:randomUUID(),at:new Date().toISOString()};fs.writeFileSync(path.join(root,'reset-journal.json'),JSON.stringify(value));return value;}
test('prepared reset restarts in restricted mode and CLI backup refuses until the original reset continues',async t=>{
 const f=fixture(t),ledger=f.open();await send(ledger,advance());const oldGeneration=(await ledger.command({kind:'read'})).generation;await ledger.close();const journal=prepared(f.root,oldGeneration);
 await assert.rejects(maintenance(['backup','--source',f.root,'--destination',f.parent]),/清空尚未完成/);assert.equal(fs.existsSync(path.join(f.root,lockName)),false);
 const reopened=f.open(),info=await reopened.command({kind:'maintenance-info'});assert.equal(info.pendingReset.requestId,journal.requestId);assert.equal(info.pendingReset.fromGeneration,oldGeneration);assert.equal(info.pendingReset.phase,'prepared');
 await assert.rejects(reopened.command({kind:'read'}),/清空尚未完成/);await assert.rejects(reopened.backup(f.parent),/清空尚未完成/);
 await assert.rejects(reopened.command({kind:'reset-ledger',requestId:randomUUID(),generation:oldGeneration,confirmation:'清空当前账本'}),/清空尚未完成/);
 const result=await reopened.command({kind:'reset-ledger',requestId:journal.requestId,generation:oldGeneration,confirmation:'清空当前账本'});assert.equal(result.completed,true);assert.equal((await reopened.command({kind:'read'})).advances.length,0);assert.equal(fs.existsSync(path.join(f.root,'reset-journal.json')),false);
});

test('cleanup failure blocks read/write/backup and same-request continuation survives restart',async t=>{
 const f=fixture(t,{recognize:async()=>({})}),ledger=f.open();await send(ledger,{...advance(),image});const generation=(await ledger.command({kind:'read'})).generation,input={kind:'reset-ledger',requestId:randomUUID(),generation,confirmation:'清空当前账本'};
 const unlink=fs.unlinkSync;let once=true;
 t.mock.method(fs,'unlinkSync',file=>{if(once&&String(file).startsWith(path.join(f.root,'attachments'))){once=false;throw Error('synthetic unlink failure');}return unlink(file);});
 await assert.rejects(ledger.command(input),error=>error.code==='RESET_PENDING');
 const info=await ledger.command({kind:'maintenance-info'});assert.equal(info.pendingReset.phase,'cleanup');assert.equal(info.pendingReset.fromGeneration,generation);
 await assert.rejects(ledger.command({kind:'read'}),/清空尚未完成/);await assert.rejects(send(ledger,advance()),/清空尚未完成/);await assert.rejects(ledger.backup(f.parent),/清空尚未完成/);
 await ledger.close();await assert.rejects(maintenance(['backup','--source',f.root,'--destination',f.parent]),/清空尚未完成/);
 const reopened=f.open();assert.equal((await reopened.command(input)).completed,true);assert.deepEqual(fs.readdirSync(path.join(f.root,'attachments')),[]);assert.equal((await reopened.command({kind:'maintenance-info'})).pendingReset,null);
});

test('malformed reset journal is never ignored by restarted wrapper or CLI',async t=>{
 const f=fixture(t),ledger=f.open();await ledger.close();const journal=path.join(f.root,'reset-journal.json');fs.writeFileSync(journal,'broken synthetic journal');
 const reopened=f.open();await assert.rejects(reopened.command({kind:'read'}),error=>error.code==='RESET_PENDING');await assert.rejects(reopened.command({kind:'maintenance-info'}),error=>error.code==='RESET_PENDING');await reopened.close();
 await assert.rejects(maintenance(['backup','--source',f.root,'--destination',f.parent]),/清空状态无法确认/);assert.equal(fs.readFileSync(journal,'utf8'),'broken synthetic journal');
});

test('legacy managed roots do not acquire persisted generation and cannot reset',async t=>{
 const f=fixture(t),ledger=f.open();await ledger.close();const db=new Database(path.join(f.root,'trial.sqlite'));const old={expenses:[],batches:[],advances:[]};db.prepare('UPDATE trial_state SET json=? WHERE id=1').run(JSON.stringify(old));db.close();
 const reopened=f.open(),info=await reopened.command({kind:'maintenance-info'});assert.equal(info.generation,`${reopened.ledgerId}:legacy`);assert.equal(info.canReset,false);
 const state=await send(reopened,advance());assert.deepEqual(state.advances,[100]);await assert.rejects(reopened.command({kind:'reset-ledger',requestId:randomUUID(),generation:info.generation,confirmation:'清空当前账本'}),/旧账本不支持/);
 const check=new Database(path.join(f.root,'trial.sqlite'),{readonly:true,fileMustExist:true});try{assert.equal(JSON.parse(check.prepare('SELECT json FROM trial_state').get().json).generation,undefined);}finally{check.close();}
});

test('matching raw generation in another ledger identity cannot admit an old tab request',async t=>{
 const a=fixture(t),first=a.open(),generation=(await first.command({kind:'read'})).generation;
 const b=fixture(t),second=b.open();await second.close();const db=new Database(path.join(b.root,'trial.sqlite'));const state=JSON.parse(db.prepare('SELECT json FROM trial_state').get().json);state.generation=generation.split(':')[1];db.prepare('UPDATE trial_state SET json=?').run(JSON.stringify(state));db.close();
 const reopened=b.open(),current=(await reopened.command({kind:'read'})).generation;assert.notEqual(current,generation);assert.equal(current.split(':')[1],generation.split(':')[1]);
 await assert.rejects(reopened.command({...advance(),generation}),/代际已变化/);assert.equal((await reopened.command({kind:'read'})).advances.length,0);
});

test('CLI restore rejects a new child directory nested inside a managed root',async t=>{
 const f=fixture(t);f.open();const target=path.join(f.root,'nested-restored');
 await assert.rejects(maintenance(['restore','--backup',path.join(f.parent,'unused-backup'),'--target',target]),/其他受管账本之外/);assert.equal(fs.existsSync(target),false);
});
