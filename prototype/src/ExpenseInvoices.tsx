import React from 'react';
import type {LedgerState} from './ledger.ts';
import {money} from './model.ts';
import {invoiceExpenseIds} from './invoice-model.ts';
import Pagination,{usePagination} from './Pagination.tsx';

export default function ExpenseInvoices({state,expenseId,onManage}:{state:LedgerState;expenseId:number;onManage:()=>void}){
 const expense=state.expenses.find(item=>item.id===expenseId);
 const rows=(state.invoices??[]).filter(invoice=>invoiceExpenseIds(invoice).includes(expenseId));
 const pages=usePagination(rows,String(expenseId));
 return <section aria-label="关联发票"><h3>关联发票</h3>
  {pages.items.map(invoice=><div className="history" key={invoice.id}><div><strong>FP-{String(invoice.id).padStart(3,'0')} · {invoice.number}</strong><p>{invoice.seller||'销售方未填写'} · 票面金额 ¥{money(invoice.amount)}</p></div></div>)}
  {!rows.length&&<p className="help">暂无新发票关联。</p>}
  {!!expense?.invoice&&<p className="help">旧记录保留票额 ¥{money(expense.invoice)}，尚无对应原票明细；保留历史记录，不限制发票关联。</p>}
  {rows.length>0&&<Pagination pager={pages} label="关联发票"/>}
  <button type="button" onClick={onManage}>管理发票关联</button>
  <p className="help">发票只记录证明材料和费用关联，不新增支出或自动报销。</p>
 </section>;
}
