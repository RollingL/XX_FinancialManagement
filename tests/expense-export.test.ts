import test from 'node:test';
import assert from 'node:assert/strict';
import type {Batch,Expense} from '../prototype/src/model.ts';
import type {Invoice,LedgerState} from '../prototype/src/ledger.ts';
import {balance} from '../prototype/src/model.ts';
import {paginate} from '../prototype/src/records.ts';
import {expenseCsv,expenseFilterError,expenseStatus,filterExpenses} from '../prototype/src/expense-export.ts';
import type {ExpenseFilters} from '../prototype/src/expense-export.ts';

const expense=(id:number,changes:Partial<Expense>={}):Expense=>({id,date:'2026-10-12',category:id%2?'接待':'办公',merchant:`合成商户 ${id}`,note:'合成备注',amount:10001,invoice:0,...changes});
const ledger=(changes:Partial<LedgerState>={}):LedgerState=>({expenses:[expense(1),expense(2),expense(3)],batches:[],advances:[5000],...changes});
const filters=(changes:Partial<ExpenseFilters>={}):ExpenseFilters=>({category:'全部费用',query:'',status:'全部状态',startDate:'',endDate:'',...changes});
const invoice=(id:number,allocations:Invoice['allocations']):Invoice=>({id,identityType:'number',number:`SYNTHETIC-${id}`,code:'',date:'2026-10-12',seller:'合成销方',buyer:'',amount:30000,note:'',attachmentIds:[`synthetic-${id}`],allocations,revision:1,createdAt:'2026-10-12T00:00:00.000Z'});
const header='"费用编号","实际支出日期","费用类别","商户/采购摘要","备注","支出金额（元）","已报销金额（元）","待报销金额（元）","报销状态"';

test('filtering spans all pages and combines category, merchant/note/id search, status, dates',()=>{
 const state=ledger({expenses:Array.from({length:14},(_,index)=>expense(index+1,{date:'2026-10-12',merchant:`合成 NORTH ${index+1}`})),batches:[{id:1,date:'2026-10-12',active:true,allocations:[{expenseId:8,amount:10000},{expenseId:10,amount:10001}]}],invoices:[invoice(1,[{expenseId:12,amount:10001}])]});
 const all=filterExpenses(state,filters());assert.equal(all.length,14);assert.equal(paginate(all,1).items.length,6);assert.equal(paginate(all,3).items.length,2);
 assert.equal(expenseCsv(state,all).split('\r\n').length,16);
 const selected=filterExpenses(state,filters({category:'办公',query:' north ',status:'未报销',startDate:'2026-10-12',endDate:'2026-10-12'}));
 assert.deepEqual(selected.map(row=>row.id),[2,4,6,12,14]);
 assert.deepEqual(filterExpenses(state,filters({query:'14'})).map(row=>row.id),[14]);
 assert.equal(filterExpenses(state,filters({query:'合成备注'})).length,14);
 assert.deepEqual(filterExpenses(state,filters({query:'没有该商户'})),[]);
});

test('date filters include both business-date boundaries and accept either unbounded end',()=>{
 const state=ledger({expenses:['2024-02-28','2024-02-29','2024-03-01','2024-03-02'].map((date,index)=>expense(index+1,{date}))});
 const ids=(changes:Partial<ExpenseFilters>)=>filterExpenses(state,filters(changes)).map(row=>row.id);
 assert.deepEqual(ids({startDate:'2024-02-29',endDate:'2024-03-01'}),[2,3]);
 assert.deepEqual(ids({startDate:'2024-02-29',endDate:'2024-02-29'}),[2]);
 assert.deepEqual(ids({startDate:'2024-03-01'}),[3,4]);
 assert.deepEqual(ids({endDate:'2024-02-29'}),[1,2]);
 assert.deepEqual(ids({}),[1,2,3,4]);
 assert.deepEqual(ids({startDate:'2025-01-01'}),[]);
});

test('invalid dates and reversed ranges report errors and fail closed without hiding a valid leap day',()=>{
 const state=ledger();
 for(const date of ['2026-02-29','1900-02-29','2026-04-31','2026-13-01','2026-00-01','2026-10-00','2026-1-01','2026-10-12T00:00:00Z',' 2026-10-12','not-a-date']){
  for(const side of ['startDate','endDate'] as const){const value=filters({[side]:date});assert.match(expenseFilterError(value),/有效/);assert.deepEqual(filterExpenses(state,value),[]);}
 }
 for(const date of ['2024-02-29','2000-02-29','2026-10-12'])assert.equal(expenseFilterError(filters({startDate:date,endDate:date})), '');
 const reversed=filters({startDate:'2026-10-13',endDate:'2026-10-12'});assert.match(expenseFilterError(reversed),/不能晚于/);assert.deepEqual(filterExpenses(state,reversed),[]);
 assert.equal(expenseFilterError(filters()),'');
});

test('reimbursement statuses use only active allocations and stay independent of invoice associations',()=>{
 const batches:Batch[]=[{id:1,date:'2026-10-12',active:true,allocations:[{expenseId:2,amount:1},{expenseId:3,amount:10001}]},{id:2,date:'2026-10-12',active:false,allocations:[{expenseId:1,amount:10001},{expenseId:2,amount:10000}]}];
 const state=ledger({batches,invoices:[invoice(1,[{expenseId:1,amount:10001}])]});
 assert.deepEqual(state.expenses.map(row=>expenseStatus(row,batches)),['未报销','部分报销','已报销']);
 for(const [status,id] of [['未报销',1],['部分报销',2],['已报销',3]] as const)assert.deepEqual(filterExpenses(state,filters({status})).map(row=>row.id),[id]);
 assert.deepEqual(filterExpenses(state,filters({status:'unknown'})),[]);
 const lines=expenseCsv(state,state.expenses).split('\r\n');
 assert.ok(lines[1].includes(',100.01,0.00,100.01,"未报销"'));
 assert.ok(lines[2].includes(',100.01,0.01,100.00,"部分报销"'));
 assert.ok(lines[3].includes(',100.01,100.01,0.00,"已报销"'));
});

test('reminder and legacy invoice metadata never change filtering, CSV, statuses or totals',()=>{
 const state=ledger(),before=expenseCsv(state,state.expenses),ids=filterExpenses(state,filters()).map(e=>e.id),funds=balance(state.expenses,state.advances);
 state.expenses[0].invoiceIssued=true;state.expenses[1].invoiceIssued=false;state.expenses[2].invoice=1;state.invoices=[invoice(1,[{expenseId:1,amount:1}])];
 assert.equal(expenseCsv(state,state.expenses),before);assert.deepEqual(filterExpenses(state,filters()).map(e=>e.id),ids);assert.equal(balance(state.expenses,state.advances),funds);
 assert.doesNotMatch(before,/发票|开票|FP-/);
});

test('CSV contains the fixed whitelist with BOM, CRLF, quoted text and exact integer-cent values without grouping',()=>{
 const state=ledger({expenses:[expense(Number.MAX_SAFE_INTEGER,{amount:Number.MAX_SAFE_INTEGER,invoice:1})],batches:[{id:1,date:'2026-10-12',active:true,allocations:[{expenseId:Number.MAX_SAFE_INTEGER,amount:1}]}]});
 Object.assign(state.expenses[0],{attachmentId:'DO-NOT-EXPORT-ATTACHMENT',path:'/private/DO-NOT-EXPORT',unexpected:'DO-NOT-EXPORT-UNKNOWN'});
 const csv=expenseCsv(state,state.expenses);
 assert.equal(csv,'\uFEFF'+header+'\r\n9007199254740991,"2026-10-12","接待","合成商户 9007199254740991","合成备注",90071992547409.91,0.01,90071992547409.90,"部分报销"\r\n');
 assert.equal(Buffer.from(csv,'utf8').subarray(0,3).toString('hex'),'efbbbf');assert.ok(!csv.includes('DO-NOT-EXPORT'));
 const invalid=expense(1,{amount:Number.MAX_SAFE_INTEGER+1});assert.throws(()=>expenseCsv(ledger({expenses:[invalid]}),[invalid]),/安全范围/);
});

test('quotes, commas, CRLF and Chinese text round-trip in their own quoted cells without changing the source',()=>{
 const original=expense(1,{merchant:'合成商户, "甲"',note:'第一行\r\n第二行, "乙"'}),state=ledger({expenses:[original]});
 const csv=expenseCsv(state,state.expenses);
 assert.equal(csv,'\uFEFF'+header+'\r\n1,"2026-10-12","接待","合成商户, ""甲""","第一行\r\n第二行, ""乙""",100.01,0.00,100.01,"未报销"\r\n');
 assert.equal(state.expenses[0].note,'第一行\r\n第二行, "乙"');
});

test('formula prefixes, fullwidth variants, whitespace, controls and invisible formatting are escaped only in exported text',()=>{
 const attacks=['=1+1','+SUM(1,2)','-1+2','@SUM(A1)','＝1+1','＋1','－1','＠SUM(A1)','\t=1','\r=1','\n=1',' =1','  ordinary text','\u0000=1','\u0085=1','\u00a0=1','\u200b=1','\u200e=1','\u202e=1','\ufeff=1','\u2066=1','\u00ad=1','\ufe0f=1','\u034f=1'];
 for(const value of attacks){
  const state=ledger({expenses:[expense(1,{merchant:value,note:value})]}),csv=expenseCsv(state,state.expenses),escaped='"\''+value.replaceAll('"','""')+'"';
  assert.ok(csv.includes(','+escaped+','+escaped+','),JSON.stringify(value));assert.equal(state.expenses[0].merchant,value);assert.equal(state.expenses[0].note,value);
 }
 for(const value of ['普通商户','文本=1','商户@example.test','123','']){
  const state=ledger({expenses:[expense(1,{merchant:value,note:value})]});assert.ok(expenseCsv(state,state.expenses).includes(',"'+value+'","'+value+'",'));
 }
});

test('trusted numeric output never receives the text formula prefix, including a synthetic negative result',()=>{
 // Export formatting is tested independently of write-side amount validation.
 const state=ledger({expenses:[expense(1,{amount:1})],batches:[{id:1,date:'2026-10-12',active:true,allocations:[{expenseId:1,amount:2}]}]});
 const csv=expenseCsv(state,state.expenses);assert.ok(csv.includes(',0.01,0.02,-0.01,"部分报销"'));assert.ok(!csv.includes("'-0.01"));
});

test('empty export keeps only the fixed header and filter/export leave all ledger facts and ordering unchanged',()=>{
 const state=ledger({expenses:[expense(3),expense(1),expense(2)],invoices:[invoice(1,[{expenseId:2,amount:1}])]});
 const before=structuredClone(state),originalBalance=balance(state.expenses,state.advances),options=filters(),originalOptions=structuredClone(options);
 const all=filterExpenses(state,options);assert.deepEqual(all.map(row=>row.id),[3,1,2]);assert.notEqual(all,state.expenses);
 assert.equal(expenseCsv(state,[]),'\uFEFF'+header+'\r\n');expenseCsv(state,all);
 assert.deepEqual(state,before);assert.deepEqual(options,originalOptions);assert.equal(balance(state.expenses,state.advances),originalBalance);
});
