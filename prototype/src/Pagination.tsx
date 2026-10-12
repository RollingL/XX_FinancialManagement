import React,{useEffect,useState} from 'react';
import {PAGE_SIZE,paginate} from './records.ts';

export function usePagination<T>(items:T[],resetKey:string){
 const [cursor,setCursor]=useState({key:resetKey,page:1});
 const result=paginate(items,cursor.key===resetKey?cursor.page:1);
 const {page}=result;
 useEffect(()=>{setCursor(old=>old.key===resetKey&&old.page===page?old:{key:resetKey,page});},[resetKey,page]);
 return {...result,setPage:(next:number)=>setCursor({key:resetKey,page:next})};
}
export default function Pagination({pager,label,disabled=false}:{pager:{page:number;pages:number;count:number;setPage:(page:number)=>void};label:string;disabled?:boolean}){
 return <div className="pagination" role="navigation" aria-label={`${label}分页`}><span>共 {pager.count} 条 · 每页 {PAGE_SIZE} 条</span><div><button type="button" aria-label={`${label}上一页`} disabled={disabled||pager.page===1} onClick={()=>pager.setPage(pager.page-1)}>上一页</button><span aria-live="polite">第 {pager.page} / {pager.pages} 页</span><button type="button" aria-label={`${label}下一页`} disabled={disabled||pager.page===pager.pages} onClick={()=>pager.setPage(pager.page+1)}>下一页</button></div></div>;
}
