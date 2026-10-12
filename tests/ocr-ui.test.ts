import test from 'node:test';
import assert from 'node:assert/strict';
import {initialOcrValues,manualAmount} from '../prototype/src/ocr.ts';
import type {OcrResult} from '../prototype/src/ocr.ts';
function result(suggested:number|null,warnings:string[]=[]):OcrResult{return{texts:[],extraction:{payment_status:'paid',fields:{actual_paid:5000,account_balance:90000,refund:1000},suggested_expense_cents:suggested,warnings,candidates:[],auto_bookkeeping:false,requires_confirmation:true}};}
test('不确定支付额不以余额或退款补位；外币全部留空',()=>{
 assert.deepEqual(initialOcrValues(result(null)),{actual_paid:'',account_balance:'900.00',refund:'10.00'});
 assert.equal(initialOcrValues(result(5000)).actual_paid,'50.00');
 assert.deepEqual(initialOcrValues(result(5000,['unsupported_currency'])),{actual_paid:'',account_balance:'',refund:''});
});
test('手动核对允许留空和零，严格精确到分',()=>{
 assert.throws(()=>manualAmount('-','account_balance'));
 assert.equal(manualAmount('','actual_paid'),null);assert.equal(manualAmount('0.00','refund'),0);assert.equal(manualAmount('0.01','actual_paid'),1);assert.equal(manualAmount('-1.23','account_balance'),-123);
 for(const value of ['1.001','1e3','-1.00','9007199254740992'])assert.throws(()=>manualAmount(value,'actual_paid'));
});
