import React,{useEffect,useRef,useState} from 'react';
import type {Batch,Expense} from './model.ts';
import {money,paid,remaining} from './model.ts';
import {batchCode,batchRecords,batchRecordsSummary,batchTotal} from './batch-records.ts';
import Pagination,{usePagination} from './Pagination.tsx';

export default function ReimbursementRecords({batches,expenses,onOpen}:{batches:Batch[];expenses:Expense[];onOpen:(id:number)=>void}){
 const [query,setQuery]=useState(''),[status,setStatus]=useState<'全部'|'有效'|'已撤销'>('全部'),[month,setMonth]=useState('');
 const filtered=batchRecords(batches,expenses,{query,status,month});
 const summary=batchRecordsSummary(filtered),pages=usePagination(filtered,JSON.stringify([query,status,month]));
 return <section className="workspace batch-workspace" aria-label="报销批次记录">
  <div className="workspace-heading"><h2>报销批次</h2><span>{batches.length} 批</span></div>
  <div className="filters"><label className="batch-search"><span className="sr-only">搜索报销记录</span><input placeholder="搜索批次、商户或费用备注" value={query} onChange={e=>setQuery(e.target.value)}/></label><label><span className="sr-only">报销月份</span><input type="month" aria-label="报销月份" value={month} onChange={e=>setMonth(e.target.value)}/></label><select aria-label="批次状态筛选" value={status} onChange={e=>setStatus(e.target.value as typeof status)}>{['全部','有效','已撤销'].map(value=><option key={value} value={value}>{value==='全部'?'全部状态':value}</option>)}</select>{(query||month||status!=='全部')&&<button className="link" onClick={()=>{setQuery('');setStatus('全部');setMonth('');}}>清除筛选</button>}</div>
  <div className="table-scroll"><table className="batch-table"><thead><tr><th>批次 / 报销日期</th><th>涉及费用</th><th className="num">登记金额</th><th>状态</th><th><span className="sr-only">详情</span></th></tr></thead><tbody>{pages.items.map(batch=>{
   const names=batch.allocations.map(a=>expenses.find(e=>e.id===a.expenseId)?.merchant??`费用 #${a.expenseId}（未找到）`);
   return <tr key={batch.id}><td><button className="expense-name" onClick={()=>onOpen(batch.id)}>{batchCode(batch.id)}</button><small className="subline">{batch.date}</small></td><td className="batch-expenses">{names.slice(0,2).join('、')}<small className="subline">共 {batch.allocations.length} 笔费用{names.length>2?` · 另 ${names.length-2} 笔可在明细查看`:''}</small></td><td className="num amount">¥{money(batchTotal(batch))}</td><td><span className={`status ${batch.active?'done':'cancelled'}`}>{batch.active?'有效':'已撤销'}</span></td><td><button className="link" aria-label={`查看 ${batchCode(batch.id)} 明细`} onClick={()=>onOpen(batch.id)}>明细</button></td></tr>;
  })}</tbody></table>{!filtered.length&&<div className="empty"><h2>{batches.length?'没有符合条件的报销记录':'还没有报销记录'}</h2><p>{batches.length?'调整关键词、月份或状态筛选。':'登记报销后，可在这里查看整批分配与撤销历史。'}</p></div>}</div>
  <Pagination pager={pages} label="报销记录"/>
  <footer className="table-footer"><span>筛选结果 {summary.count} 批 · 有效 {summary.activeCount} 批 · 已撤销 {summary.cancelledCount} 批</span><span>有效登记合计 <b>¥{money(summary.activeTotal)}</b></span></footer>
  <p className="advance-help">报销仅记录报账进度，不产生收付款。已撤销记录保留原分配，不计入有效登记合计。</p>
 </section>;
}

export function CancelConfirmation({id,saving,onKeep,onConfirm}:{id:number;saving:boolean;onKeep:()=>void;onConfirm:()=>void}){
 const keep=useRef<HTMLButtonElement>(null);
 useEffect(()=>{keep.current?.focus();keep.current?.closest('.cancel-confirm')?.scrollIntoView({block:'nearest'});},[id]);
 return <div className="cancel-confirm" role="alert"><p>撤销 {batchCode(id)} 整个批次？将恢复该批次所有关联费用的待报销额，资金余额不变。</p><button ref={keep} disabled={saving} onClick={onKeep}>保留</button><button disabled={saving} onClick={onConfirm}>{saving?'撤销中…':'确认撤销'}</button></div>;
}

export function BatchDetail({batch,batches,expenses,onExpense,onAskCancel,onClose,cancelId,onKeep,onConfirm,saving,error}:{batch:Batch;batches:Batch[];expenses:Expense[];onExpense:(id:number)=>void;onAskCancel:()=>void;onClose:()=>void;cancelId:number|null;onKeep:()=>void;onConfirm:()=>void;saving:boolean;error:string}){
 const pages=usePagination(batch.allocations,String(batch.id));
 return <div><div className="drawer-body"><span className={`status ${batch.active?'done':'cancelled'}`}>{batch.active?'有效':'已撤销'}</span><h3 className="detail-merchant">{batchCode(batch.id)}</h3><div className="detail-amount">{money(batchTotal(batch))}<small> 元</small></div><dl><div><dt>报销日期</dt><dd>{batch.date}</dd></div><div><dt>涉及费用</dt><dd>{batch.allocations.length} 笔</dd></div></dl><h3 className="batch-allocation-heading">{batch.active?'本批次分配':'原登记分配'}</h3>{!batch.active&&<p className="help">本批次已撤销，以下原分配保留供核对，不再计入费用报销进度。</p>}
  <div className="table-scroll"><table className="batch-detail-table"><thead><tr><th>关联费用 / 实际支出</th><th className="num">本批次分配</th><th className="num">当前已报销</th><th className="num">当前待报销</th></tr></thead><tbody>{pages.items.map(a=>{const expense=expenses.find(e=>e.id===a.expenseId);return <tr key={a.expenseId}><td>{expense?<><button className="expense-name" disabled={saving} aria-label={`查看关联费用 ${expense.id}`} onClick={()=>onExpense(expense.id)}>{expense.merchant}</button><small className="subline">{expense.date} · {expense.category} · #{expense.id} · ¥{money(expense.amount)}</small></>:<span>费用 #{a.expenseId}（未找到）</span>}</td><td className="num">¥{money(a.amount)}</td><td className="num">{expense?`¥${money(paid(expense.id,batches))}`:'—'}</td><td className="num">{expense?`¥${money(remaining(expense,batches))}`:'—'}</td></tr>;})}</tbody></table></div>
  <Pagination pager={pages} label="批次分配" disabled={saving}/>
  {cancelId===batch.id&&<CancelConfirmation id={batch.id} saving={saving} onKeep={onKeep} onConfirm={onConfirm}/>}{error&&<p className="error" role="alert">{error}</p>}
 </div><footer className="drawer-footer">{batch.active&&cancelId!==batch.id&&<button className="danger-button" disabled={saving} onClick={onAskCancel}>撤销整批</button>}<button disabled={saving} onClick={onClose}>返回记录</button></footer></div>;
}
