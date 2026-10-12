import test from 'node:test';
import assert from 'node:assert/strict';
import {balance,decimal,paid} from '../prototype/src/model.ts';
import type {Expense} from '../prototype/src/model.ts';
import type {Invoice,InvoiceEvent,LedgerState} from '../prototype/src/ledger.ts';
import {expenseHasInvoiceHistory,expenseInvoiceAmount,invoiceAllocatedAmount,invoiceAllocationChanges,invoiceAllocationRows,invoiceCode,invoiceRecords,invoiceRequest,normalizeInvoiceIdentifier,parseInvoiceAllocations,parseInvoiceDraft,parseInvoiceIdentity,validateInvoiceAllocations} from '../prototype/src/invoice-model.ts';
import type {InvoiceDraft,InvoiceRequestBody} from '../prototype/src/invoice-model.ts';
import {matchesExpense,paginate} from '../prototype/src/records.ts';

// Only synthetic in-memory fixtures: no ledger files, screenshots or services.
const expense=(id:number,extra:Partial<Expense>={}):Expense=>({id,category:id%2?'接待':'办公',date:'2026-10-12',merchant:`合成费用 ${id}`,amount:10000,invoice:0,note:`合成备注 ${id}`,...extra});
const invoice=(id=1,extra:Partial<Invoice>={}):Invoice=>({id,identityType:'number',number:`SYNTHETIC${id}`,code:'',date:'2026-10-12',seller:`合成销售方 ${id}`,buyer:'合成购买方',amount:20000,note:'合成票据',attachmentIds:[`synthetic-image-${id}`],allocations:[],revision:1,createdAt:'2026-10-12T01:00:00.000Z',...extra});
const ledger=(extra:Partial<LedgerState>={}):LedgerState=>({expenses:[expense(1),expense(2)],advances:[5000,3000],batches:[],...extra});
const draft=(extra:Partial<InvoiceDraft>={}):InvoiceDraft=>({identityType:'unconfirmed',number:'',code:'',date:'2026-10-12',seller:'',buyer:'',amount:'200.00',note:'合成草稿',...extra});
const audit=(before:Invoice|null,after:Invoice):InvoiceEvent=>({requestId:`synthetic-event-${after.id}-${after.revision}`,action:before?'invoice-allocate':'invoice',at:'2026-10-12T02:00:00.000Z',invoiceId:after.id,revision:after.revision,before,after});

test('legacy ledger without invoice arrays preserves its original covered amount',()=>{
 const state=ledger({expenses:[expense(1,{invoice:2500}),expense(2)]}),before=structuredClone(state);
 assert.equal(expenseInvoiceAmount(state,1),2500);
 assert.equal(expenseInvoiceAmount(state,2),0);
 assert.equal(expenseHasInvoiceHistory(state,1),true);
 assert.equal(expenseHasInvoiceHistory(state,2),false);
 assert.deepEqual(state,before);
});

test('expense coverage includes legacy plus all current invoices, and excludes only the edited invoice',()=>{
 const state=ledger({expenses:[expense(1,{invoice:1000}),expense(2)],invoices:[invoice(1,{allocations:[{expenseId:1,amount:2000},{expenseId:2,amount:500}]}),invoice(2,{allocations:[{expenseId:1,amount:3000}]})]});
 assert.equal(expenseInvoiceAmount(state,1),6000);
 assert.equal(expenseInvoiceAmount(state,1,1),4000);
 assert.equal(expenseInvoiceAmount(state,1,2),3000);
 assert.equal(expenseInvoiceAmount(state,2),500);
 assert.equal(expenseInvoiceAmount(state,2,1),0);
});

test('invoice history remains after complete unlinking, including associations on the seventh row',()=>{
 const linked=invoice(1,{allocations:Array.from({length:7},(_,i)=>({expenseId:i+1,amount:100})),revision:2}),unlinked=invoice(1,{revision:3});
 const state=ledger({expenses:Array.from({length:8},(_,i)=>expense(i+1)),invoices:[unlinked],invoiceEvents:[audit(invoice(),linked),audit(linked,unlinked)]});
 assert.equal(expenseInvoiceAmount(state,7),0);
 assert.equal(expenseHasInvoiceHistory(state,7),true);
 assert.equal(expenseHasInvoiceHistory(state,8),false);
 assert.equal(expenseHasInvoiceHistory(ledger({invoices:[linked]}),7),true);
});

test('invoice search covers code, number, both parties, note and stable display id with case/space handling',()=>{
 const records=[invoice(7,{number:'ABCD7',code:'CODE8',seller:'合成 North',buyer:'合成 SOUTH',note:'合成 Receipt Note'})];
 for(const query of [' fp-007 ','7','abcd7','code8',' north ','south','receipt note'])assert.deepEqual(invoiceRecords(records,{query,unallocatedOnly:false}),records);
 assert.deepEqual(invoiceRecords(records,{query:'absent',unallocatedOnly:false}),[]);
 assert.equal(invoiceCode(7),'FP-007');
 assert.equal(invoiceCode(1000),'FP-1000');
});

test('unallocated filter intersects search and sorts date then id without changing source order',()=>{
 const records=[invoice(1,{date:'2026-10-10'}),invoice(2,{date:'2026-10-12',note:'合成选中'}),invoice(4,{date:'2026-10-12',note:'合成选中',allocations:[{expenseId:1,amount:1}]}),invoice(3,{date:'2026-10-12',note:'合成选中',identityType:'unconfirmed'})],before=structuredClone(records);
 assert.deepEqual(invoiceRecords(records,{query:'',unallocatedOnly:false}).map(value=>value.id),[4,3,2,1]);
 assert.deepEqual(invoiceRecords(records,{query:'合成选中',unallocatedOnly:true}).map(value=>value.id),[3,2]);
 assert.deepEqual(records,before);
});

test('identity parsing normalizes NFKC, whitespace and case without inventing fixed tax number lengths',()=>{
 assert.equal(normalizeInvoiceIdentifier('  ａｂ １２\tcd\n '),'AB12CD');
 assert.deepEqual(parseInvoiceIdentity({identityType:'number',number:' ａｂ １ ',code:'discarded'}),{identityType:'number',number:'AB1',code:''});
 assert.deepEqual(parseInvoiceIdentity({identityType:'code-number',number:' n 1 ',code:' c 2 '}),{identityType:'code-number',number:'N1',code:'C2'});
 assert.equal(parseInvoiceIdentity({identityType:'number',number:'X',code:''}).number,'X');
 assert.throws(()=>parseInvoiceIdentity({identityType:'number',number:' ',code:''}),/号码/);
 assert.throws(()=>parseInvoiceIdentity({identityType:'code-number',number:'N',code:' '}),/代码/);
 assert.throws(()=>normalizeInvoiceIdentifier('x'.repeat(101)),/100/);
});

test('identity normalization stays canonical after uppercasing combining characters',()=>{
 const canonical='\u03aa\u0301';
 for(const value of ['\u0390','\u03b9\u0308\u0301','\u0399\u0308\u0301',canonical]){
  assert.equal(normalizeInvoiceIdentifier(value),canonical);
  assert.equal(normalizeInvoiceIdentifier(normalizeInvoiceIdentifier(value)),canonical);
 }
 assert.deepEqual(parseInvoiceIdentity({identityType:'code-number',number:'\u0390',code:'\u03b9\u0308\u0301'}),{identityType:'code-number',number:canonical,code:canonical});
});

test('unconfirmed identity may preserve tentative identifiers but cannot allocate even an empty replacement',()=>{
 assert.deepEqual(parseInvoiceIdentity({identityType:'unconfirmed',number:'',code:''}),{identityType:'unconfirmed',number:'',code:''});
 assert.deepEqual(parseInvoiceIdentity({identityType:'unconfirmed',number:' ａ ',code:' b '}),{identityType:'unconfirmed',number:'A',code:'B'});
 assert.throws(()=>validateInvoiceAllocations([],ledger(),invoice(1,{identityType:'unconfirmed'})),/先核对/);
 assert.throws(()=>validateInvoiceAllocations([{expenseId:1,amount:1}],ledger(),invoice(1,{identityType:'unconfirmed'})),/先核对/);
});

test('invoice draft parses exact cents, real dates, optional parties and note while limiting lengths',()=>{
 assert.deepEqual(parseInvoiceDraft(draft({date:'2024-02-29',amount:'1.01',seller:'  合成甲  ',buyer:' 合成乙 ',note:'  合成备注 '})),{identityType:'unconfirmed',number:'',code:'',date:'2024-02-29',seller:'合成甲',buyer:'合成乙',amount:101,note:'合成备注'});
 for(const amount of ['0','-1','1.001','1e3','90071992547409.92'])assert.throws(()=>parseInvoiceDraft(draft({amount})));
 for(const date of ['2026-02-29','2026-04-31','2026-2-01',''])assert.throws(()=>parseInvoiceDraft(draft({date})),/日期/);
 assert.throws(()=>parseInvoiceDraft(draft({seller:'s'.repeat(201)})),/200/);
 assert.throws(()=>parseInvoiceDraft(draft({buyer:'b'.repeat(201)})),/200/);
 assert.throws(()=>parseInvoiceDraft(draft({note:'n'.repeat(501)})),/500/);
 assert.equal(parseInvoiceDraft(draft({amount:decimal(Number.MAX_SAFE_INTEGER)})).amount,Number.MAX_SAFE_INTEGER);
});

test('editing a fully allocated invoice excludes its old rows and can replace all allocations or clear them',()=>{
 const current=invoice(1,{amount:10000,allocations:[{expenseId:1,amount:10000}]}),state=ledger({invoices:[current]}),before=structuredClone(state);
 assert.equal(validateInvoiceAllocations([{expenseId:1,amount:10000}],state,current),10000);
 assert.deepEqual(parseInvoiceAllocations({2:'60.00',1:'40.00'},state,current),[{expenseId:1,amount:4000},{expenseId:2,amount:6000}]);
 assert.deepEqual(parseInvoiceAllocations({},state,current),[]);
 assert.deepEqual(state,before);
});

test('legacy coverage and other invoices consume expense capacity independently of reimbursement progress',()=>{
 const current=invoice(1,{allocations:[{expenseId:1,amount:2000}]}),other=invoice(2,{allocations:[{expenseId:1,amount:3000}]}),state=ledger({expenses:[expense(1,{invoice:1000}),expense(2)],invoices:[current,other],batches:[{id:1,date:'2026-10-12',active:true,allocations:[{expenseId:1,amount:10000}]}]});
 assert.equal(paid(1,state.batches),10000);
 assert.equal(validateInvoiceAllocations([{expenseId:1,amount:6000}],state,current),6000);
 assert.throws(()=>validateInvoiceAllocations([{expenseId:1,amount:6001}],state,current),/费用 #1/);
 const noReimbursement={...state,batches:[]};
 assert.equal(validateInvoiceAllocations([{expenseId:1,amount:6000}],noReimbursement,current),6000);
});

test('invoice side total, duplicate ids, absent expenses and nonpositive/unsafe row amounts are rejected',()=>{
 const state=ledger(),current=invoice(1,{amount:1000});
 assert.throws(()=>validateInvoiceAllocations([{expenseId:1,amount:600},{expenseId:2,amount:401}],state,current),/发票金额/);
 assert.throws(()=>validateInvoiceAllocations([{expenseId:1,amount:1},{expenseId:1,amount:2}],state,current),/重复/);
 assert.throws(()=>validateInvoiceAllocations([{expenseId:99,amount:1}],state,current),/不存在/);
 for(const expenseId of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>validateInvoiceAllocations([{expenseId,amount:1}],state,current),/编号/);
 for(const amount of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>validateInvoiceAllocations([{expenseId:1,amount}],state,current),/正整数分/);
 assert.throws(()=>parseInvoiceAllocations({1:''},state,current));
 assert.throws(()=>parseInvoiceAllocations({1:'0'},state,current));
 assert.throws(()=>parseInvoiceAllocations({1:'1.001'},state,current));
});

test('safe integer limits are preserved in aggregate coverage and invoice allocation totals',()=>{
 const max=Number.MAX_SAFE_INTEGER,current=invoice(1,{amount:max}),state=ledger({expenses:[expense(1,{amount:max})],invoices:[current]});
 assert.equal(validateInvoiceAllocations([{expenseId:1,amount:max}],state,current),max);
 const excessive=ledger({expenses:[expense(1,{amount:max,invoice:max})],invoices:[invoice(1,{allocations:[{expenseId:1,amount:1}]})]});
 assert.throws(()=>expenseInvoiceAmount(excessive,1),/安全范围/);
 const aggregate=ledger({expenses:[expense(1,{amount:max}),expense(2,{amount:max})],invoices:[current]});
 assert.throws(()=>validateInvoiceAllocations([{expenseId:1,amount:max},{expenseId:2,amount:1}],aggregate,current),/安全范围/);
});

test('search and six-row pagination never narrow the complete allocation draft across categories',()=>{
 const state=ledger({expenses:Array.from({length:8},(_,i)=>expense(i+1)),invoices:[]}),current=invoice(1,{amount:10000,allocations:[{expenseId:1,amount:101},{expenseId:7,amount:202},{expenseId:8,amount:303}]}),rows=invoiceAllocationRows(current),before=structuredClone(rows);
 const second=paginate(state.expenses,2),search=state.expenses.filter(expense=>matchesExpense(expense,'合成备注 7'));
 assert.deepEqual(second.items.map(expense=>expense.id),[7,8]);
 assert.deepEqual(search.map(expense=>expense.id),[7]);
 assert.equal(state.expenses[6].category,'接待');assert.equal(state.expenses[7].category,'办公');
 assert.deepEqual(parseInvoiceAllocations(rows,state,current),current.allocations);
 assert.deepEqual(rows,before);
 assert.equal(invoiceAllocatedAmount(current),606);
});

test('all list, attachment and audit collections support six-row pagination and page clamp',()=>{
 const records=Array.from({length:8},(_,i)=>invoice(i+1)),list=invoiceRecords(records,{query:'',unallocatedOnly:false});
 assert.equal(paginate(list,1).items.length,6);assert.equal(paginate(list,2).items.length,2);
 assert.equal(paginate(invoiceRecords(records,{query:'SYNTHETIC1',unallocatedOnly:false}),2).page,1);
 assert.equal(paginate([],99).page,1);
 assert.equal(paginate(Array.from({length:7},(_,i)=>`synthetic-scan-${i}`),2).items.length,1);
 assert.equal(paginate(Array.from({length:8},(_,i)=>audit(null,invoice(i+1))),2).items.length,2);
});

test('audit allocation changes expose moved amounts even when total and number of allocations are unchanged',()=>{
 const before=invoice(1,{allocations:[{expenseId:1,amount:100},{expenseId:2,amount:200}]}),after=invoice(1,{allocations:[{expenseId:1,amount:200},{expenseId:3,amount:100}],revision:2}),original=structuredClone({before,after});
 assert.equal(invoiceAllocatedAmount(before),invoiceAllocatedAmount(after));
 assert.deepEqual(invoiceAllocationChanges(before,after),[{expenseId:1,before:100,after:200},{expenseId:2,before:200,after:0},{expenseId:3,before:0,after:100}]);
 assert.deepEqual(invoiceAllocationChanges(before,before),[]);
 assert.deepEqual(invoiceAllocationChanges(null,invoice()),[]);
 assert.deepEqual({before,after},original);
});

test('same create payload including image bytes reuses its id; changed image or draft gets a distinct id and the old payload remains retryable',()=>{
 const body:InvoiceRequestBody={kind:'invoice',invoice:parseInvoiceDraft(draft()),image:{base64:'synthetic-image-one'}};
 let number=0;const createId=()=>`synthetic-${++number}`;
 const first=invoiceRequest(body,[],createId),snapshot=structuredClone(first),attempts=[first];
 assert.equal(invoiceRequest(structuredClone(body),attempts,createId),first);
 const differentImage=invoiceRequest({...body,image:{base64:'synthetic-image-two'}},attempts,createId);attempts.push(differentImage);
 const differentDraft=invoiceRequest({...body,invoice:{...body.invoice,note:'不同合成备注'}},attempts,createId);attempts.push(differentDraft);
 assert.equal(new Set(attempts.map(request=>request.requestId)).size,3);
 assert.equal(invoiceRequest(body,attempts,createId),first);
 body.invoice.note='mutated outside request';body.image.base64='mutated outside request';
 assert.deepEqual(first,snapshot);
});

test('identity, attachment and allocation retries preserve expected revision and separate edited payloads',()=>{
 const bodies:InvoiceRequestBody[]=[{kind:'invoice-identity',id:1,expectedRevision:3,identity:{identityType:'number',number:'SYNTHETIC',code:''}},{kind:'invoice-attachment',id:1,expectedRevision:3,image:{base64:'synthetic'}},{kind:'invoice-allocate',id:1,expectedRevision:3,allocations:[{expenseId:1,amount:100}]}];
 for(const body of bodies){
  let count=0;const createId=()=>`attempt-${++count}`,first=invoiceRequest(body,[],createId);
  assert.equal(invoiceRequest(structuredClone(body),[first],createId),first);
  assert.equal(first.kind,body.kind);assert.equal('expectedRevision' in first&&first.expectedRevision,3);
  const revised=invoiceRequest({...body,expectedRevision:4} as InvoiceRequestBody,[first],createId);
  assert.notEqual(revised.requestId,first.requestId);
 }
});

test('invoice parsing, validation, request creation and queries leave the complete cash and reimbursement facts unchanged',()=>{
 const current=invoice(),state=ledger({invoices:[current],batches:[{id:7,date:'2026-10-12',active:false,allocations:[{expenseId:1,amount:1000}]}],advanceDetails:{0:{date:'2026-10-10',note:'合成到账',createdAt:'2026-10-10T00:00:00Z'}}}),original=structuredClone(state),cash=balance(state.expenses,state.advances);
 const allocations=parseInvoiceAllocations({1:'10.01',2:'20.02'},state,current);
 invoiceRequest({kind:'invoice-allocate',id:current.id,expectedRevision:current.revision,allocations},[],()=> 'synthetic-request');
 invoiceRecords(state.invoices!,{query:'synthetic',unallocatedOnly:true});expenseInvoiceAmount(state,1);expenseHasInvoiceHistory(state,1);
 assert.equal(balance(state.expenses,state.advances),cash);
 assert.deepEqual(state,original);
});
