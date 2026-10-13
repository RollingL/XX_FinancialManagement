const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {createLedger}=require('../spike/trial-ledger.cjs');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOYVnECAAN+AdcpgjGUAAAAAElFTkSuQmCC','base64');
test('current pure invoice links and previously unlinked invoice history both permit expense correction without changing invoice or reimbursement facts',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'qianlai-invoice-edit-')),l=createLedger(root,{recognize:async()=>({validated:true})});t.after(()=>{l.close();fs.rmSync(root,{recursive:true,force:true});});
 const send=body=>l.command({...body,requestId:randomUUID()});
 let s=await send({kind:'expense',expense:{amount:10000,date:'2026-10-13',category:'接待',merchant:'合成商户',note:''}});
 s=await send({kind:'invoice',invoice:{identityType:'number',number:'SYNTHETIC-EDIT',code:'',date:'2026-10-13',seller:'',buyer:'',amount:1,note:''},image:{base64:png.toString('base64')}});
 s=await send({kind:'invoice-link',id:1,expectedRevision:1,expenseIds:[1]});
 const correct=amount=>({kind:'correct-expense',id:1,expected:structuredClone(s.expenses[0]),expectedRevision:s.expenseEvents?.length??0,expense:{amount,date:s.expenses[0].date,category:s.expenses[0].category,merchant:s.expenses[0].merchant,note:s.expenses[0].note}});
 const links=structuredClone(s.invoices);s=await send(correct(8000));assert.equal(s.expenses[0].amount,8000);assert.deepEqual(s.invoices,links);assert.deepEqual(s.batches,[]);
 s=await send({kind:'invoice-link',id:1,expectedRevision:s.invoices[0].revision,expenseIds:[]});const history=structuredClone(s.invoiceEvents);s=await send(correct(5000));assert.equal(s.expenses[0].amount,5000);assert.deepEqual(s.invoices[0].expenseIds,[]);assert.deepEqual(s.invoiceEvents,history);
 s=await send({kind:'batch',date:'2026-10-13',allocations:[{expenseId:1,amount:2000}]});const before=structuredClone(s);await assert.rejects(send(correct(1999)),/已报销|有效/);assert.deepEqual(await l.command({kind:'read'}),before);
});
