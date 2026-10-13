import {localDate} from './local-date.ts';

// Chromium handles the local download; Electron presents its native save dialog.
export function downloadExpenseCsv(content:string){
 const url=URL.createObjectURL(new Blob([content],{type:'text/csv;charset=utf-8'}));
 const link=document.createElement('a');
 try{
  link.href=url;link.download=`钱来-费用明细-${localDate()}.csv`;
  document.body.append(link);link.click();
 }catch{
  URL.revokeObjectURL(url);throw Error('未能发起 CSV 下载，请重试');
 }finally{link.remove();}
 // Keep the blob alive while Chromium starts the download, including a save prompt.
 setTimeout(()=>URL.revokeObjectURL(url),60_000);
}
