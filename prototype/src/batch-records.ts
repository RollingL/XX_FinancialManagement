import {sum} from './model.ts';
import type {Batch,Expense} from './model.ts';
import {matchesExpense} from './records.ts';

export const batchCode=(id:number)=>`BX-${String(id).padStart(3,'0')}`;
export const batchTotal=(batch:Batch)=>sum(batch.allocations.map(row=>row.amount));

export function batchRecords(batches:Batch[],expenses:Expense[],filters:{query:string;status:'全部'|'有效'|'已撤销';month:string}){
 const key=filters.query.trim().toLocaleLowerCase();
 const byId=new Map(expenses.map(expense=>[expense.id,expense]));
 return batches.filter(batch=>{
  if(filters.status!=='全部'&&batch.active!==(filters.status==='有效')) return false;
  if(filters.month&&!batch.date.startsWith(filters.month)) return false;
  return !key||[batchCode(batch.id),String(batch.id),batch.date].some(value=>value.toLocaleLowerCase().includes(key))
   ||batch.allocations.some(row=>{
    const expense=byId.get(row.expenseId);
    return expense?matchesExpense(expense,key):false;
   });
 }).sort((a,b)=>b.date.localeCompare(a.date)||b.id-a.id);
}

export function batchRecordsSummary(filtered:Batch[]){
 const active=filtered.filter(batch=>batch.active);
 return {count:filtered.length,activeCount:active.length,cancelledCount:filtered.length-active.length,activeTotal:sum(active.map(batchTotal))};
}
