import { defineConfig } from 'vite';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {createOcrService}=require('./spike/ocr-service.cjs');
const {ocrMiddleware}=require('./spike/ocr-http.cjs');
const {createLedger,ledgerMiddleware}=require('./spike/trial-ledger.cjs');
export default defineConfig({root:'prototype',base:'./',build:{outDir:'../dist',emptyOutDir:true},server:{port:5173,strictPort:true,host:'127.0.0.1',fs:{deny:['.env','.env.*','*.{crt,pem}','**/.git/**','**/.local-data/**']}},plugins:[{
 name:'stage0-local-ocr',
 configureServer(server){
  const service=createOcrService();
  const ledger=createLedger(process.env.XX_FINANCE_DATA_DIR||require('node:path').resolve('.local-data'),service);
  server.middlewares.use(ledgerMiddleware(ledger,'http://127.0.0.1:5173'));
  server.middlewares.use(ocrMiddleware(service,'http://127.0.0.1:5173'));
  server.httpServer?.once('close',()=>{service.stop();service.finished.then(()=>ledger.close());});
 },
}]});
