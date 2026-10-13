const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {randomUUID}=require('node:crypto'),Database=require('better-sqlite3');
const {createManagedLedger}=require('../spike/managed-ledger.cjs');
const {verifyBackup,restoreBackup,inspectDatabase}=require('../spike/ledger-backup.cjs');
const service={recognize:async()=>({})},image=n=>({base64:Buffer.from([137,80,78,71,13,10,26,10,n]).toString('base64')});
function fixture(t){const parent=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'qianlai-crud-backup-'))),root=path.join(parent,'ledger');let ledger=createManagedLedger(root,service,{backupDestination:parent});t.after(async()=>{await ledger.close();fs.rmSync(parent,{recursive:true,force:true});});return {root,parent,get ledger(){return ledger;},async send(input){const state=await ledger.command({kind:'read'});return ledger.command({requestId:randomUUID(),generation:state.generation,...input});},async reopen(){await ledger.close();ledger=createManagedLedger(root,service,{backupDestination:parent});}};}
const invoice={identityType:'number',number:'SYNTHETIC',code:'',date:'2026-10-13',seller:'合成',buyer:'',amount:1,note:''};
test('deleted advances, edited/deleted expenses and deleted invoice audits fully back up, restore, reopen',async t=>{
 const f=fixture(t);let state=await f.send({kind:'advance',advance:{amount:100,date:'2026-10-13',note:''},image:image(1)});
 state=await f.send({kind:'correct-advance',id:0,expectedAmount:100,expected:state.advanceDetails[0],expectedRevision:0,advance:{amount:200,date:'2026-10-12',note:'改'}});
 state=await f.send({kind:'delete-advance',id:0,expectedAmount:200,expected:state.advanceDetails[0],expectedRevision:1});
 state=await f.send({kind:'expense',expense:{category:'办公',date:'2026-10-13',merchant:'合成',amount:100,note:''},image:image(2)});
 for(const n of [3,4])state=await f.send({kind:'invoice',invoice:{...invoice,number:'SYNTHETIC'+n},image:image(n)});
 state=await f.send({kind:'batch',date:'2026-10-13',allocations:[{expenseId:1,amount:10}],invoiceLinks:state.invoices.map(item=>({invoiceId:item.id,expectedRevision:1,expenseIds:[1]}))});
 state=await f.send({kind:'cancel',id:1});
 state=await f.send({kind:'correct-expense',id:1,expected:state.expenses[0],expectedRevision:0,expense:{category:'接待',date:'2026-10-13',merchant:'合成改',amount:2,note:''}});
 state=await f.send({kind:'delete-expense',id:1,expected:state.expenses[0],expectedRevision:1});
 state=await f.send({kind:'invoice-edit',id:1,expectedRevision:state.invoices[0].revision,invoice:{...invoice,number:'SYNTHETIC3',amount:2}});
 state=await f.send({kind:'invoice-delete',id:1,expectedRevision:state.invoices[0].revision});
 const saved=await f.ledger.backup(f.parent);assert.equal(saved.summary.balanceCents,'0');assert.equal(saved.summary.advanceCount,0);assert.equal(saved.summary.expenseCount,0);verifyBackup(saved.directory);
 const restored=restoreBackup({backupDir:saved.directory,targetDir:path.join(f.parent,'restored')});inspectDatabase(path.join(restored.directory,'trial.sqlite'));
 const db=new Database(path.join(restored.directory,'trial.sqlite'),{readonly:true});try{const raw=JSON.parse(db.prepare('SELECT json FROM trial_state').get().json);assert.deepEqual({...raw,generation:state.generation},state);}finally{db.close();}
 await f.reopen();assert.deepEqual(await f.ledger.command({kind:'read'}),state);
 const file=path.join(f.root,'trial.sqlite');await f.ledger.close();const edit=new Database(file);try{const raw=JSON.parse(edit.prepare('SELECT json FROM trial_state').get().json);raw.advanceEvents[1].before.amount++;edit.prepare('UPDATE trial_state SET json=?').run(JSON.stringify(raw));}finally{edit.close();}assert.throws(()=>inspectDatabase(file),/审计链/);
});
