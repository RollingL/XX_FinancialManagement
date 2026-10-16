const fs=require('node:fs');
const path=require('node:path');

function regularFile(file){
 const stat=fs.lstatSync(file);
 if(!stat.isFile()||!stat.size)throw Error(`Windows package resource is missing or empty: ${file}`);
}
function peX64(file){
 regularFile(file);
 const bytes=fs.readFileSync(file);
 if(bytes.length<64||bytes.toString('ascii',0,2)!=='MZ')throw Error(`Expected Windows x64 PE resource: ${file}`);
 const offset=bytes.readUInt32LE(60);
 if(offset>bytes.length-6||bytes.readUInt32LE(offset)!==0x4550||bytes.readUInt16LE(offset+4)!==0x8664)throw Error(`Expected Windows x64 PE resource: ${file}`);
 return {bytes,offset};
}
function checkWindowsLauncher(file){
 const {bytes,offset}=peX64(file),optional=offset+24;
 if(optional+70>bytes.length||bytes.readUInt16LE(offset+20)<70||bytes.readUInt16LE(optional)!==0x20b||bytes.readUInt16LE(optional+68)!==2)throw Error(`Expected a Windows GUI x64 launcher without a console subsystem: ${file}`);
}
function checkWindowsPackage(root,arch,host={platform:process.platform,arch:process.arch}){
 if(arch!=='x64'||host.platform!=='win32'||host.arch!=='x64')throw Error('Build this Windows acceptance package on Windows x64 with x64 Node and Python; Mac OCR is not compatible.');
 const worker=path.join(root,'spike','ocr-dist','ocr-probe');
 peX64(path.join(worker,'ocr-probe.exe'));
 peX64(path.join(worker,'_internal','python312.dll'));
 peX64(path.join(worker,'_internal','onnxruntime','capi','onnxruntime_pybind11_state.pyd'));
 peX64(path.join(root,'node_modules','better-sqlite3','prebuilds','win32-x64.node'));
 checkWindowsLauncher(path.join(root,'out','windows-launcher','Qianlai.exe'));
 for(const name of ['PP-OCRv6_det_small.onnx','ch_ppocr_mobile_v2.0_cls_mobile.onnx','PP-OCRv6_rec_small.onnx'])regularFile(path.join(worker,'_internal','models',name));
 // This checks package inputs, not DLL loading, OCR accuracy or Windows acceptance.
}
module.exports={checkWindowsPackage,checkWindowsLauncher};
