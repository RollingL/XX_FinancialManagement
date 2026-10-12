import {cents,decimal,sum} from './model.ts';
import type {Category,Expense} from './model.ts';
import type {LedgerState} from './ledger.ts';

export type CorrectionDraft={category:Category;date:string;merchant:string;amount:string;note:string};
export type CorrectionFields=Pick<Expense,'category'|'date'|'merchant'|'amount'|'note'>;
export type CorrectionCommand={kind:'correct-expense';requestId:string;id:number;expected:Expense;expectedRevision:number;expense:CorrectionFields};
export type CorrectionSession={expected:Expense;expectedRevision:number};

export function correctionRestriction(expense:Expense,state:LedgerState):string|null{
 if(expense.invoice!==0)return '已有发票关联票额，暂不支持纠错。';
 if(state.batches.some(batch=>batch.allocations.some(row=>row.expenseId===expense.id))||state.batchEvents?.some(event=>event.before.allocations.some(row=>row.expenseId===expense.id)))
  return '这笔费用已有报销历史，暂不支持纠错；即使当前已报销为 0，已撤销或已删除批次的历史关联仍保留。';
 return null;
}
export function expenseRevision(state:LedgerState,id:number){return state.expenseEvents?.filter(event=>event.expenseId===id).length??0;}
export function correctionSession(state:LedgerState,expense:Expense):CorrectionSession{
 const restriction=correctionRestriction(expense,state);if(restriction)throw new Error(restriction);
 return {expected:structuredClone(expense),expectedRevision:expenseRevision(state,expense.id)};
}
export function correctionDraft(expense:Expense):CorrectionDraft{
 return {category:expense.category,date:expense.date,merchant:expense.merchant,amount:decimal(expense.amount),note:expense.note};
}
export function correctionFields(draft:CorrectionDraft):CorrectionFields{
 if(!['接待','办公'].includes(draft.category))throw new Error('请选择费用类别');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(draft.date)||!Number.isFinite(Date.parse(draft.date))||new Date(draft.date).toISOString().slice(0,10)!==draft.date)throw new Error('请填写有效的实际支出日期');
 if(!draft.merchant.trim()||draft.merchant.length>100)throw new Error('商户或采购摘要须为 1 至 100 个字符');
 if(draft.note.length>500)throw new Error('备注不能超过 500 个字符');
 return {category:draft.category,date:draft.date,merchant:draft.merchant.trim(),amount:cents(draft.amount),note:draft.note.trim()};
}
export function correctionBalance(balance:number,oldAmount:number,newAmount:number){return sum([balance,oldAmount,-newAmount]);}
export function correctionChanged(before:Expense,after:CorrectionFields){
 return (['category','date','merchant','amount','note'] as const).some(key=>before[key]!==after[key]);
}
// Keep every attempted payload for this editor session. Returning to an earlier
// draft after a lost response must reuse its original request, not mutate it.
export function correctionRequest(session:CorrectionSession,draft:CorrectionDraft,attempts:readonly CorrectionCommand[],createId:()=>string=()=>crypto.randomUUID()):CorrectionCommand{
 const expense=correctionFields(draft);
 if(!correctionChanged(session.expected,expense))throw new Error('费用内容没有变化，请修改后再保存');
 const prior=attempts.find(attempt=>attempt.expectedRevision===session.expectedRevision&&JSON.stringify(attempt.expected)===JSON.stringify(session.expected)&&JSON.stringify(attempt.expense)===JSON.stringify(expense));
 return prior??{kind:'correct-expense',requestId:createId(),id:session.expected.id,expected:structuredClone(session.expected),expectedRevision:session.expectedRevision,expense};
}
export function expenseCorrections(state:LedgerState,id:number){
 return (state.expenseEvents??[]).filter(event=>event.expenseId===id).sort((a,b)=>b.revision-a.revision||b.at.localeCompare(a.at)||b.requestId.localeCompare(a.requestId));
}
