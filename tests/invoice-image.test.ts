import test,{after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {runInNewContext} from 'node:vm';
import {rolldown} from 'rolldown';
import {singleImage,validateImageFile,MAX_IMAGE_BYTES} from '../prototype/src/image-file.ts';

// Compile only this component in memory. External modules are explicit fakes;
// no ledger, OCR worker, browser, or user images are opened by these tests.
const bundle=await rolldown({input:fileURLToPath(new URL('../prototype/src/ExpenseScreenshot.tsx',import.meta.url)),external:()=>true});
const compiled=await bundle.generate({format:'cjs',exports:'named'});
await bundle.close();
const code=compiled.output[0].code;
const bitmapDescriptor=Object.getOwnPropertyDescriptor(globalThis,'createImageBitmap');
beforeEach(()=>Object.defineProperty(globalThis,'createImageBitmap',{configurable:true,writable:true,value:async()=>({width:100,height:100,close(){}})}));
after(()=>{if(bitmapDescriptor)Object.defineProperty(globalThis,'createImageBitmap',bitmapDescriptor);else Reflect.deleteProperty(globalThis,'createImageBitmap');});
const png=()=>new File([new Uint8Array([137,80,78,71,13,10,26,10])],'synthetic.png',{type:'image/png'});
const jpeg=()=>new File([new Uint8Array([255,216,255,224])],'synthetic.jpg',{type:'image/jpeg'});
const settle=async()=>{for(let i=0;i<3;i++)await new Promise<void>(resolve=>setImmediate(resolve));};
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(finish=>{resolve=finish;});return {promise,resolve};}
type Node={type:unknown;props:Record<string,any>};
function nodes(value:any):Node[]{
 if(Array.isArray(value))return value.flatMap(nodes);
 if(!value||typeof value!=='object'||!('props' in value))return [];
 return [value,...nodes(value.props.children)];
}
function text(value:any):string{
 if(Array.isArray(value))return value.map(text).join('');
 if(value&&typeof value==='object')return text(value.props?.children);
 return typeof value==='string'||typeof value==='number'?String(value):'';
}
function harness(options:{kind?:'expense'|'advance'|'invoice';disabled?:boolean;attachment?:boolean;validate?:typeof validateImageFile;recognize?:(file:File,signal:AbortSignal)=>Promise<any>;read?:()=>Promise<any>}={}){
 const slots:any[]=[],effects:Array<()=>void>=[],cleanups=new Map<number,()=>void>();let cursor=0,tree:Node;
 const files:Array<File|null>=[],fields:any[]=[],busy:boolean[]=[],created:string[]=[],revoked:string[]=[],reads:any[]=[],recognitions:File[]=[];
 const react={
  useState(initial:any){const index=cursor++;if(!(index in slots))slots[index]=initial;return [slots[index],(value:any)=>{slots[index]=value;}];},
  useRef(initial:any){const index=cursor++;if(!(index in slots))slots[index]={current:initial};return slots[index];},
  useEffect(effect:()=>void|(()=>void),deps:any[]){const index=cursor++,prior=slots[index];if(!prior||deps.some((value,i)=>value!==prior[i])){slots[index]=deps;effects.push(()=>{cleanups.get(index)?.();const cleanup=effect();if(cleanup)cleanups.set(index,cleanup);});}}
 };
 const jsx=(type:unknown,props:Record<string,any>):Node=>({type,props});
 const modules:Record<string,any>={
  react,'react/jsx-runtime':{jsx,jsxs:jsx,Fragment:'fragment'},
  './image-file.ts':{singleImage,validateImageFile:options.validate??validateImageFile},
  './model.ts':{decimal:(cents:number)=>(cents/100).toFixed(2)},
  './ocr.ts':{recognizeScreenshot:(file:File,signal:AbortSignal)=>{recognitions.push(file);return options.recognize?.(file,signal)??Promise.resolve({expense_fields:{amount_cents:1234,date:'2026-10-12',merchant:'合成商户'},extraction:{fields:{account_balance:null,refund:null}},texts:['合成识别']});}},
  './ledger.ts':{ledgerCommand:(command:any)=>{reads.push(command);return options.read?.()??Promise.resolve({mime:'image/png',base64:'iVBORw0KGgo='});}}
 };
 const exports:Record<string,any>={};
 runInNewContext(code,{exports,require:(name:string)=>{assert.ok(name in modules,`Unexpected dependency ${name}`);return modules[name];},AbortController,Blob,Uint8Array,atob,URL:{createObjectURL:()=>{const url=`blob:synthetic-${created.length}`;created.push(url);return url;},revokeObjectURL:(url:string)=>revoked.push(url)}});
 const props={kind:options.kind??'invoice',disabled:options.disabled??false,onFile:(file:File|null)=>files.push(file),onFields:(value:any)=>fields.push(value),onBusy:(value:boolean)=>busy.push(value)};
 function render(){cursor=0;tree=options.attachment?exports.ExpenseAttachment({id:'synthetic-original',kind:props.kind}):exports.default(props);while(effects.length)effects.shift()!();return tree;}
 function find(type:string,label?:string){render();const found=nodes(tree).find(node=>node.type===type&&(label===undefined||text(node)===label));assert.ok(found,`Missing ${type} ${label??''}`);return found;}
 render();
 return {files,fields,busy,created,revoked,reads,recognitions,props,render,find,
  pick(selected:File[]){find('input').props.onChange({target:{files:selected,value:'selected'}});},
  drop(selected:File[]){let prevented=0,stopped=0;render().props.onDrop({dataTransfer:{files:selected},preventDefault(){prevented++;},stopPropagation(){stopped++;}});assert.equal(prevented,1);assert.equal(stopped,1);},
  unmount(){for(const cleanup of cleanups.values())cleanup();cleanups.clear();}
 };
}

test('发票使用原图文案和原生文件输入，手动核对且无可选/OCR提示',()=>{
 const h=harness();assert.equal(h.render().props['aria-label'],'发票原图');
 assert.equal(text(h.find('label')),'上传发票原图');
 assert.equal(h.find('input').props.type,'file');assert.equal(h.find('input').props.accept,'image/png,image/jpeg');
 assert.match(text(h.render()),/身份和票面金额请手动核对/);assert.match(text(h.render()),/不会自动新增费用或报销/);
 assert.doesNotMatch(text(h.render()),/（可选）|本机离线识别/);assert.equal(h.recognitions.length,0);h.unmount();
});

test('发票选择 PNG/JPEG 仅回传附件，替换和移除释放 URL 且不清空文字',async()=>{
 const h=harness(),first=png(),second=jpeg();h.pick([first]);await settle();
 assert.equal(h.files[0],first);assert.deepEqual(h.busy,[true,false]);
 assert.equal(h.find('img').props.alt,'待保存的发票原图');
 h.pick([second]);await settle();assert.equal(h.files[1],second);assert.deepEqual(h.revoked,['blob:synthetic-0']);
 h.find('button','移除发票原图').props.onClick();assert.equal(h.files.at(-1),null);
 assert.deepEqual(h.revoked,['blob:synthetic-0','blob:synthetic-1']);assert.equal(h.fields.length,0);assert.equal(h.recognitions.length,0);assert.equal(h.reads.length,0);
 assert.equal(nodes(h.render()).some(node=>node.type==='img'),false);h.unmount();
});

test('发票拖拽阻止文件导航，校验忙碌期间的重复拖拽不会打断请求',async()=>{
 const gate=deferred<void>();let checks=0;
 const h=harness({validate:async()=>{checks++;await gate.promise;}}),image=png();
 h.drop([image]);h.drop([png()]);assert.equal(checks,1);assert.equal(h.find('input').props.disabled,true);
 assert.equal(h.files.length,0);gate.resolve();await settle();assert.equal(h.files[0],image);
 assert.deepEqual(h.busy,[true,false]);assert.equal(h.recognitions.length,0);h.unmount();assert.deepEqual(h.revoked,h.created);
});

test('发票点击和拖拽拒绝多图、非图片、超限大小、伪造签名及超限像素',async t=>{
 const h=harness(),large=png();Object.defineProperty(large,'size',{value:MAX_IMAGE_BYTES+1});
 for(const files of [[png(),png()],[new File(['%PDF'],'synthetic.pdf',{type:'application/pdf'})],[large]]){h.drop(files);await settle();assert.equal(h.files.length,0);}
 h.pick([new File(['invalid'],'synthetic.png',{type:'image/png'})]);await settle();assert.match(text(h.render()),/格式无效/);
 t.mock.method(globalThis,'createImageBitmap',async()=>({width:5000,height:4001,close(){}} as ImageBitmap));
 h.pick([png()]);await settle();assert.match(text(h.render()),/2000 万像素/);
 assert.equal(h.files.length,0);assert.equal(h.created.length,0);assert.equal(h.recognitions.length,0);assert.equal(h.busy.at(-1),false);h.unmount();
});

test('禁用入口不开始校验，发票卸载后迟到的校验不能回写或创建预览',async()=>{
 const gate=deferred<void>();let checks=0,signal:AbortSignal|undefined;
 const validate=async(_file:File,value?:AbortSignal)=>{checks++;signal=value;await gate.promise;};
 const disabled=harness({disabled:true,validate});disabled.drop([png()]);disabled.pick([png()]);assert.equal(checks,0);disabled.unmount();
 const h=harness({validate});h.drop([png()]);h.unmount();assert.equal(signal?.aborted,true);gate.resolve();await settle();
 assert.equal(h.files.length,0);assert.equal(h.fields.length,0);assert.equal(h.created.length,0);assert.deepEqual(h.busy,[true,false]);
});

test('预支仍只保留截图；费用仍填识别字段，允许人工停止并忽略迟到 OCR',async()=>{
 const advance=harness({kind:'advance'});advance.pick([png()]);await settle();assert.equal(advance.recognitions.length,0);assert.equal(advance.fields.length,0);
 advance.find('button','移除到账截图').props.onClick();assert.equal(advance.fields.length,0);advance.unmount();
 const expense=harness({kind:'expense'});expense.pick([png()]);await settle();assert.equal(expense.recognitions.length,1);
 assert.equal(expense.fields.at(-1).amount,'12.34');assert.match(text(expense.render()),/对照原图核对/);expense.unmount();
 const gate=deferred<any>();let signal:AbortSignal|undefined;
 const pending=harness({kind:'expense',recognize:async(_file,value)=>{signal=value;return gate.promise;}});pending.pick([png()]);await settle();
 pending.find('button','停止识别，手动填写').props.onClick();assert.equal(signal?.aborted,true);const count=pending.fields.length;
 gate.resolve({expense_fields:{amount_cents:9999}});await settle();assert.equal(pending.fields.length,count);assert.equal(pending.busy.at(-1),false);pending.unmount();
});

test('已保存原票附件只调用附件读取，标题/alt 清楚且卸载释放 URL',async()=>{
 const h=harness({attachment:true});await settle();assert.equal(h.find('h3').props.children.join(''),'发票原图附件');
 assert.equal(h.find('img').props.alt,'该张原票已保留的发票原图');
 assert.equal(h.reads.length,1);assert.equal(h.reads[0].kind,'attachment');assert.equal(h.reads[0].id,'synthetic-original');assert.equal(h.recognitions.length,0);
 h.unmount();assert.deepEqual(h.revoked,h.created);
 const late=deferred<any>(),pending=harness({attachment:true,read:()=>late.promise});pending.unmount();late.resolve({mime:'image/png',base64:'iVBORw0KGgo='});await settle();assert.equal(pending.created.length,0);
});
