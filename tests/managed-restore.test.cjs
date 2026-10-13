const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {randomUUID}=require('node:crypto');
const {createManagedLedger}=require('../spike/managed-ledger.cjs');
const {verifyBackup}=require('../spike/ledger-backup.cjs');
function fixture(t){const parent=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'qianlai-restore-ui-'))),root=path.join(parent,'ledger');let ledger;const open=()=>ledger=createManagedLedger(root,undefined,{backupDestination:parent});t.after(async()=>{await ledger?.close();fs.rmSync(parent,{recursive:true,force:true});});return {root,parent,open};}
async function advance(ledger,amount){const state=await ledger.command({kind:'read'});return ledger.command({kind:'advance',requestId:randomUUID(),generation:state.generation,advance:{amount,date:'2026-10-13',note:'synthetic'}});}
async function backup(ledger){const state=await ledger.command({kind:'read'});return ledger.command({kind:'create-backup',requestId:randomUUID(),generation:state.generation});}
async function plan(ledger,saved){const state=await ledger.command({kind:'read'});return ledger.command({kind:'prepare-restore',generation:state.generation,backup:saved.directory});}
test('restore previews, backs up current facts, switches identity, rejects stale drafts and retries after reopen',async t=>{
 const f=fixture(t);let ledger=f.open();await advance(ledger,101);const saved=await backup(ledger);const current=await advance(ledger,202),preview=await plan(ledger,saved);
 assert.equal(preview.summary.totalAdvanceCents,'101');const input={kind:'restore-backup',requestId:randomUUID(),token:preview.token,generation:preview.generation,confirmation:'恢复备份'};
 const result=await ledger.command(input);assert.equal(result.completed,true);assert.notEqual(result.generation,current.generation);const restoredRoot=ledger.root;const {warning,...receipt}=result;if(warning)assert.match(warning,/持久化未确认|原连接关闭未确认/);
 assert.equal(verifyBackup(result.backupDirectory).summary.totalAdvanceCents,'303');assert.deepEqual((await ledger.command({kind:'read'})).advances,[101]);
 await assert.rejects(ledger.command({kind:'advance',requestId:randomUUID(),generation:current.generation,advance:{amount:1,date:'2026-10-13',note:''}}),/代际已变化/);
 assert.deepEqual(await ledger.command(input),receipt);await assert.rejects(ledger.command({...input,generation:result.generation}),/原确认内容不一致/);await ledger.close();ledger=f.open();assert.equal(ledger.root,restoredRoot);assert.deepEqual(await ledger.command(input),receipt);await assert.rejects(ledger.command({...input,generation:result.generation}),/原确认内容不一致/);
 await advance(ledger,303);assert.deepEqual((await ledger.command({kind:'read'})).advances,[101,303]);assert.deepEqual(await ledger.command(input),receipt);await ledger.close();
});
test('stale state/source, wrong confirmation, and foreign token leave current ledger unchanged',async t=>{
 const f=fixture(t),ledger=f.open();await advance(ledger,100);const saved=await backup(ledger),preview=await plan(ledger,saved),input={kind:'restore-backup',requestId:randomUUID(),token:preview.token,generation:preview.generation,confirmation:'恢复备份'};
 await assert.rejects(ledger.command({...input,confirmation:'恢复'}),/确认文字/);await assert.rejects(ledger.command({...input,token:randomUUID()}),/预览已失效/);
 const current=await advance(ledger,200);await assert.rejects(ledger.command(input),/账本已变化/);assert.deepEqual(await ledger.command({kind:'read'}),current);
 const next=await plan(ledger,saved);fs.appendFileSync(path.join(saved.directory,'manifest.json'),' ');await assert.rejects(ledger.command({...input,token:next.token}),/哈希/);assert.deepEqual(await ledger.command({kind:'read'}),current);assert.equal(fs.existsSync(path.join(f.root,'active-ledger.json')),false);
});
test('failed pointer publication preserves original ledger and complete pre-restore backup',async t=>{
 const f=fixture(t),ledger=f.open();await advance(ledger,100);const saved=await backup(ledger),current=await advance(ledger,200),preview=await plan(ledger,saved),original=fs.renameSync;
 t.mock.method(fs,'renameSync',function(from,to){if(to===path.join(f.root,'active-ledger.json'))throw Error('synthetic pointer failure');return original.call(this,from,to);});
 await assert.rejects(ledger.command({kind:'restore-backup',requestId:randomUUID(),token:preview.token,generation:preview.generation,confirmation:'恢复备份'}),/synthetic pointer failure/);
 assert.deepEqual(await ledger.command({kind:'read'}),current);assert.equal(ledger.root,f.root);assert.equal(fs.existsSync(path.join(f.root,'active-ledger.json')),false);
 const backups=fs.readdirSync(f.parent).filter(name=>name.startsWith('backup-')).map(name=>verifyBackup(path.join(f.parent,name)));assert.ok(backups.some(item=>item.summary.totalAdvanceCents==='300'));
});
test('tampered restore pointer cannot adopt unrelated or unmarked roots',async t=>{
 const f=fixture(t),ledger=f.open();await ledger.close();fs.writeFileSync(path.join(f.root,'active-ledger.json'),JSON.stringify({version:1,directory:'../other',ledgerId:randomUUID(),receipt:{}}));assert.throws(()=>f.open(),/恢复入口标识无效/);assert.equal(fs.existsSync(path.join(f.root,'.writer-lock')),false);
});
