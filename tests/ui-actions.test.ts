import test from 'node:test';
import assert from 'node:assert/strict';
import {localDate,localDateLabel} from '../prototype/src/local-date.ts';
import {reimbursementRows} from '../prototype/src/reimbursement-draft.ts';
import {allocate,rowCents,sum,validateAllocation} from '../prototype/src/model.ts';
import type {Expense,Batch} from '../prototype/src/model.ts';
const expenses:Expense[]=[
 {id:1,date:'2026-10-10',category:'接待',merchant:'合成餐厅',amount:10000,invoice:0,note:''},
 {id:2,date:'2026-10-11',category:'办公',merchant:'合成用品',amount:8000,invoice:0,note:''},
 {id:3,date:'2026-10-12',category:'办公',merchant:'合成已报销',amount:2000,invoice:0,note:''},
];
const batches:Batch[]=[{id:1,date:'2026-10-12',active:true,allocations:[{expenseId:1,amount:3000},{expenseId:3,amount:2000}]}];
test('本地日期保留设备日历日期，跨月跨年不使用 UTC 切片',()=>{
 assert.equal(localDate(new Date(2026,0,1,0,1)),'2026-01-01');
 assert.equal(localDate(new Date(2026,11,31,23,59)),'2026-12-31');
 assert.equal(localDate(new Date(2027,0,1,0,0)),'2027-01-01');
});
test('标题日期包含年月日和对应星期',()=>{
 assert.equal(localDateLabel('2026-10-12'),'2026年10月12日星期一');
 assert.equal(localDateLabel('2026-10-13'),'2026年10月13日星期二');
});
test('空预选可打开草稿，已全部报销、不存在及重复编号不会增加额度',()=>{
 assert.deepEqual(reimbursementRows(expenses,batches,[]),{});
 assert.deepEqual(reimbursementRows(expenses,batches,[1,1,3,999]),{1:'70.00'});
 assert.deepEqual(reimbursementRows(expenses,batches,[3]),{});
});
test('增删选择保留其他行的分配及无效输入，不偷偷替换成全额',()=>{
 assert.deepEqual(reimbursementRows(expenses,batches,[1,2],{1:'12.34'}),{1:'12.34',2:'80.00'});
 assert.deepEqual(reimbursementRows(expenses,batches,[2],{1:'12.34',2:'0.00'}),{2:'0.00'});
 assert.deepEqual(reimbursementRows(expenses,batches,[1,2],{1:'1.001'}),{1:'1.001',2:'80.00'});
 assert.deepEqual(reimbursementRows(expenses,batches,[],{1:'12.34'}),{});
});
test('内部选择的剩余额度与既有分配校验一致，跨类别不能超额',()=>{
 const rows=reimbursementRows(expenses,batches,[1,2]);
 assert.equal(sum(Object.values(rows).map(rowCents)),15000);
 const chosen=expenses.filter(e=>Object.hasOwn(rows,e.id));
 assert.deepEqual(allocate(9000,chosen,batches),[{expenseId:1,amount:7000},{expenseId:2,amount:2000}]);
 assert.throws(()=>allocate(15001,chosen,batches));
 assert.throws(()=>validateAllocation([{expenseId:1,amount:7001}],chosen,batches));
 assert.throws(()=>validateAllocation([{expenseId:3,amount:1}],chosen,batches));
});
