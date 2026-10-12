import React from 'react';
import {cents,money} from './model.ts';
import type {Expense} from './model.ts';
import type {LedgerState} from './ledger.ts';
import {correctionBalance,correctionChanged,correctionFields,expenseCorrections} from './expense-correction.ts';
import type {CorrectionDraft} from './expense-correction.ts';
import Pagination,{usePagination} from './Pagination.tsx';
import './expense-correction.css';

type Props={expense:Expense;draft:CorrectionDraft;balance:number;saving:boolean;error:string;onChange:(draft:CorrectionDraft)=>void;onSave:(event:React.FormEvent)=>void;onCancel:()=>void};
export default function ExpenseCorrection({expense,draft,balance,saving,error,onChange,onSave,onCancel}:Props){
 let after:number|null=null,changed=false;
 try{after=correctionBalance(balance,expense.amount,cents(draft.amount));}catch{/* 无效金额不展示计算结果。 */}
 try{changed=correctionChanged(expense,correctionFields(draft));}catch{/* 提交时给出字段错误。 */}
 return <form onSubmit={onSave} className="expense-correction">
  <div className="drawer-body">
   <p className="help">费用 #{expense.id} · 原金额 ¥{money(expense.amount)}。保存后保留原编号{expense.attachmentId?'和支付截图':'及原附件状态'}。</p>
   <p className="correction-warning" id="correction-warning">仅用于修正录入错误。纠错不是实际退款；实际退款暂未支持，不能通过改小原金额代替。</p>
   <fieldset className="expense-fields" disabled={saving} aria-describedby="correction-warning">
    <div className="segmented" role="group" aria-label="纠错费用类别">{(['接待','办公'] as const).map(category=><button key={category} type="button" aria-pressed={draft.category===category} className={draft.category===category?'active':''} onClick={()=>onChange({...draft,category})}>{category}费用</button>)}</div>
    <label className="field">实际支出金额（元）<input inputMode="decimal" required className="amount-input" value={draft.amount} onChange={event=>onChange({...draft,amount:event.target.value})}/></label>
    <label className="field">实际支出日期<input type="date" required value={draft.date} onChange={event=>onChange({...draft,date:event.target.value})}/></label>
    <label className="field">商户或采购摘要<input required maxLength={100} value={draft.merchant} onChange={event=>onChange({...draft,merchant:event.target.value})}/></label>
    <label className="field">备注（选填）<textarea maxLength={500} value={draft.note} onChange={event=>onChange({...draft,note:event.target.value})}/></label>
    <div className="calculation" aria-live="polite"><span>纠错后资金余额</span><strong>{after===null?'填写有效金额后计算':`${money(after)} 元`}</strong>{after!==null&&after<0&&<small>本人垫付 {money(-after)} 元</small>}<small>{after===balance?'金额未变，资金余额不变。':'仅以新金额替换原支出金额，不新增收付款。'}</small></div>
   </fieldset>
   {!changed&&!error&&<p className="help">修改内容后可保存；只增加首尾空格不算纠错。</p>}
   {error&&<div role="alert" className="error"><p>{error}</p><p>草稿已保留。若保存结果未确认，保持内容不变可重试；提示费用已变化时，请刷新账本后重新核对。</p></div>}
  </div>
  <footer className="drawer-footer"><button type="button" disabled={saving} onClick={onCancel}>取消纠错</button><button type="submit" className="primary" disabled={saving}>{saving?'保存中…':'保存纠错'}</button></footer>
 </form>;
}

const historyFields=[['amount','支出金额'],['date','支出日期'],['category','费用类别'],['merchant','商户或采购摘要'],['note','备注']] as const;
function historyValue(expense:Expense,key:typeof historyFields[number][0]){return key==='amount'?`${money(expense.amount)} 元`:expense[key]||'（空）';}
export function ExpenseCorrectionHistory({state,expenseId,disabled=false}:{state:LedgerState;expenseId:number;disabled?:boolean}){
 const events=expenseCorrections(state,expenseId),pages=usePagination(events,String(expenseId));
 return <section className="correction-history" aria-labelledby="correction-history-title">
  <h3 id="correction-history-title">纠错记录</h3>
  {!events.length?<p className="help">暂无纠错记录。</p>:<>{pages.items.map(event=><article className="correction-event" key={event.requestId}>
   <header><strong>第 {event.revision} 次修订</strong><time dateTime={event.at}>{new Date(event.at).toLocaleString('zh-CN',{hour12:false})}</time></header>
   <table><caption className="sr-only">第 {event.revision} 次费用纠错前后对照</caption><thead><tr><th scope="col">字段</th><th scope="col">纠错前</th><th scope="col">纠错后</th></tr></thead><tbody>{historyFields.map(([key,label])=><tr key={key}><th scope="row">{label}</th><td>{historyValue(event.before,key)}</td><td>{historyValue(event.after,key)}</td></tr>)}</tbody></table>
  </article>)}<Pagination pager={pages} label="纠错记录" disabled={disabled}/></>}
 </section>;
}
