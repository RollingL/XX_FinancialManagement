const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync,spawn}=require('node:child_process'),{once}=require('node:events');
const {randomUUID}=require('node:crypto');
const {createManagedLedger}=require('../spike/managed-ledger.cjs');
const {acquireLedgerLock}=require('../spike/ledger-lock.cjs');
const identity=require('../spike/process-identity.cjs');
const Database=require('better-sqlite3');

function fixture(t){
 const parent=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'qianlai-safe-lock-'))),root=path.join(parent,'ledger');
 t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));return {root,parent};
}

test('an abnormal owner exit can reopen a synthetic ledger with committed money unchanged',async t=>{
 const {root}=fixture(t);
 const child=spawnSync(process.execPath,['-e',`
  const {createManagedLedger}=require(process.argv[1]),{randomUUID}=require('node:crypto');
  (async()=>{const ledger=createManagedLedger(process.argv[2]);const state=await ledger.command({kind:'read'});
  await ledger.command({kind:'advance',requestId:randomUUID(),generation:state.generation,advance:{amount:12345,date:'2026-10-16',note:'synthetic abnormal exit'}});
  process.exit(17);})().catch(e=>{console.error(e);process.exit(1);});
 `,path.resolve('spike/managed-ledger.cjs'),root],{encoding:'utf8'});
 assert.equal(child.status,17,child.stderr);
 assert.equal(fs.existsSync(path.join(root,'.writer-lock','owner.json')),true);
 const reopened=createManagedLedger(root);
 try{assert.deepEqual((await reopened.command({kind:'read'})).advances,[12345]);}finally{await reopened.close();}
 assert.equal(fs.existsSync(path.join(root,'.writer-lock')),false);
});

function rawFixture(t){const result=fixture(t);fs.mkdirSync(result.root);return result;}
const ownerFile=root=>path.join(root,'.writer-lock','owner.json');
function replaceOwner(root,change){const owner=JSON.parse(fs.readFileSync(ownerFile(root),'utf8'));fs.writeFileSync(ownerFile(root),JSON.stringify(change(owner)));}
function abandonedOwner(root){
 const child=spawnSync(process.execPath,['-e',"require(process.argv[1]).acquireLedgerLock(process.argv[2]);process.exit(17)",path.resolve('spike/ledger-lock.cjs'),root],{encoding:'utf8'});
 assert.equal(child.status,17,child.stderr);return JSON.parse(fs.readFileSync(ownerFile(root),'utf8'));
}

test('a live owner cannot be reclaimed, including an old-looking creation date',t=>{
 const {root}=rawFixture(t),lock=acquireLedgerLock(root),original=fs.readFileSync(ownerFile(root),'utf8');
 assert.throws(()=>acquireLedgerLock(root),/原实例仍在运行/);
 replaceOwner(root,owner=>({...owner,createdAt:'2000-01-01T00:00:00.000Z'}));
 assert.throws(()=>acquireLedgerLock(root),/原实例仍在运行/);
 fs.writeFileSync(ownerFile(root),original);lock.release();lock.release();
 assert.equal(fs.existsSync(path.join(root,'.writer-lock')),false);
 assert.equal(fs.readdirSync(root).some(name=>name.startsWith('.writer-candidate-')),false);
});

test('a reused PID is recoverable only with a confirmed same-host different process start',t=>{
 const {root}=rawFixture(t);abandonedOwner(root);
 const current=identity.processIdentity(process.pid);assert.equal(current.state,'alive');assert.ok(current.startedAt);
 const priorStart=current.startedAt.slice(0,-1)+(current.startedAt.endsWith('0')?'1':'0');
 replaceOwner(root,owner=>({...owner,pid:process.pid,processStart:priorStart}));
 const lock=acquireLedgerLock(root);assert.equal(lock.recovered.reason,'pid-reused');
 assert.equal(identity.processIdentity(process.pid).state,'alive');
 assert.equal(JSON.parse(fs.readFileSync(path.join(lock.recovered.directory,'owner.json'),'utf8')).processStart,priorStart);lock.release();
});

test('foreign, unknown and unreadable owners are kept intact',t=>{
 const {root}=rawFixture(t);abandonedOwner(root);
 const original=JSON.parse(fs.readFileSync(ownerFile(root),'utf8'));
 for(const changed of [{...original,hostId:'0'.repeat(64)},{...original,hostId:null},{...original,pid:process.pid,processStart:null},{...original,pid:process.pid,processStart:'malformed-start'},{...original,unexpected:true}]){
  fs.writeFileSync(ownerFile(root),JSON.stringify(changed));const before=fs.readFileSync(ownerFile(root));
  assert.throws(()=>acquireLedgerLock(root,{allowLegacyRecovery:true}),/未接管账本/);
  assert.deepEqual(fs.readFileSync(ownerFile(root)),before);
 }
});

test('legacy absent-PID locks require explicit local-root recovery authorization',t=>{
 const {root}=rawFixture(t),previous=abandonedOwner(root);
 const legacy={token:previous.token,pid:previous.pid,createdAt:previous.createdAt};fs.writeFileSync(ownerFile(root),JSON.stringify(legacy));
 assert.throws(()=>acquireLedgerLock(root),/旧版锁缺少机器身份/);
 assert.ok(identity.isLocalVolume(root),'synthetic fixture must be on a supported local volume');
 const lock=acquireLedgerLock(root,{allowLegacyRecovery:true});assert.equal(lock.recovered.reason,'legacy-owner-absent');
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(lock.recovered.directory,'owner.json'),'utf8')),legacy);lock.release();
});

test('legacy live PIDs, unknown volumes and uncertain process status are never recovered',t=>{
 const {root}=rawFixture(t),previous=abandonedOwner(root);
 const legacy={token:previous.token,pid:process.pid,createdAt:previous.createdAt};fs.writeFileSync(ownerFile(root),JSON.stringify(legacy));
 assert.throws(()=>acquireLedgerLock(root,{allowLegacyRecovery:true}),/仍存在或无法确认/);
 const originalVolume=identity.isLocalVolume,originalProcess=identity.processIdentity;
 try{
  identity.isLocalVolume=()=>false;
  assert.throws(()=>acquireLedgerLock(root,{allowLegacyRecovery:true}),/旧版锁缺少机器身份/);
  identity.isLocalVolume=()=>true;identity.processIdentity=pid=>pid===process.pid?{state:'unknown'}:originalProcess(pid);
  assert.throws(()=>acquireLedgerLock(root,{allowLegacyRecovery:true}),/仍存在或无法确认/);
 }finally{identity.isLocalVolume=originalVolume;identity.processIdentity=originalProcess;}
 assert.deepEqual(JSON.parse(fs.readFileSync(ownerFile(root),'utf8')),legacy);
});

test('unrecognized contents and lock/guard symlinks cannot be followed or cleared',t=>{
 const {root,parent}=rawFixture(t),outside=path.join(parent,'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'keep'),'synthetic');
 fs.symlinkSync(outside,path.join(root,'.writer-lock'),'dir');assert.throws(()=>acquireLedgerLock(root),/普通目录/);fs.unlinkSync(path.join(root,'.writer-lock'));
 fs.mkdirSync(path.join(root,'.writer-lock'));fs.writeFileSync(path.join(root,'.writer-lock','extra'),'keep');assert.throws(()=>acquireLedgerLock(root),/内容无法识别/);
 assert.equal(fs.readFileSync(path.join(root,'.writer-lock','extra'),'utf8'),'keep');fs.rmSync(path.join(root,'.writer-lock'),{recursive:true});
 fs.rmSync(path.join(root,'.writer-guard.sqlite'),{force:true});fs.symlinkSync(path.join(outside,'keep'),path.join(root,'.writer-guard.sqlite'));assert.throws(()=>acquireLedgerLock(root),/普通文件/);
 assert.equal(fs.readFileSync(path.join(outside,'keep'),'utf8'),'synthetic');
});

test('release refuses a changed owner and atomically removes only its own lock',t=>{
 const {root}=rawFixture(t),lock=acquireLedgerLock(root),original=fs.readFileSync(ownerFile(root));
 replaceOwner(root,owner=>({...owner,token:randomUUID()}));assert.throws(()=>lock.release(),/所有者或内容已变化/);
 fs.writeFileSync(ownerFile(root),original);lock.release();
 assert.equal(fs.existsSync(path.join(root,'.writer-lock')),false);
 assert.deepEqual(fs.readdirSync(root),['.writer-guard.sqlite']);
});

test('an OS guard held by an exited process is automatically released',t=>{
 const {root}=rawFixture(t),file=path.join(root,'.writer-guard.sqlite');
 const child=spawnSync(process.execPath,['-e',"const Database=require(process.argv[1]);const db=new Database(process.argv[2]);db.exec('BEGIN IMMEDIATE');process.exit(17)",require.resolve('better-sqlite3'),file],{encoding:'utf8'});
 assert.equal(child.status,17,child.stderr);const db=new Database(file,{timeout:0});db.exec('BEGIN IMMEDIATE');db.exec('ROLLBACK');db.close();
 const lock=acquireLedgerLock(root);lock.release();
});

test('simultaneous processes recovering one abandoned lock admit exactly one live writer',async t=>{
 const {root}=rawFixture(t);abandonedOwner(root);
 const script=`
  const {acquireLedgerLock}=require(process.argv[1]);let lock;
  process.on('disconnect',()=>process.exit(0));
  process.on('message',message=>{
   if(message==='start'){try{lock=acquireLedgerLock(process.argv[2]);process.send({winner:true});}catch(e){process.send({winner:false,error:e.message});}}
   if(message==='close'){if(lock)lock.release();process.exit(0);}
  });process.send({ready:true});`;
 const children=Array.from({length:4},()=>spawn(process.execPath,['-e',script,path.resolve('spike/ledger-lock.cjs'),root],{stdio:['ignore','ignore','pipe','ipc']}));
 const exits=children.map(child=>once(child,'exit'));
 t.after(async()=>{for(const child of children)if(child.connected)child.send('close');await Promise.all(exits);});
 await Promise.all(children.map(child=>once(child,'message')));
 const outcomes=children.map(child=>once(child,'message'));children.forEach(child=>child.send('start'));
 const results=(await Promise.all(outcomes)).map(([message])=>message);
 assert.equal(results.filter(result=>result.winner).length,1,JSON.stringify(results));
 assert.throws(()=>acquireLedgerLock(root),/原实例仍在运行/);
 children.forEach(child=>child.send('close'));await Promise.all(exits);
 const reopened=acquireLedgerLock(root);reopened.release();
});
