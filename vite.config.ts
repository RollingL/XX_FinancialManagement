import { defineConfig } from 'vite';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createOcrService } = require('./spike/ocr-service.cjs');
const { ocrMiddleware } = require('./spike/ocr-http.cjs');
const { createLedger, ledgerMiddleware } = require('./spike/trial-ledger.cjs');
let disposeLedger: (() => Promise<void>) | undefined;
export default defineConfig({
  root: 'prototype',
  base: './',
  build: { outDir: '../dist', emptyOutDir: true },
  server: {
    port: 5173,
    strictPort: true,
    host: '127.0.0.1',
    fs: {
      deny: [
        '.env',
        '.env.*',
        '*.{crt,pem}',
        '**/.git/**',
        '**/.local-data/**',
        '**/trial.sqlite*',
        '**/managed-ledger.json',
        '**/reset-journal.json',
        '**/.writer-lock/**',
        '**/attachments/**',
      ],
    },
  },
  plugins: [
    {
      name: 'stage0-local-ocr',
      configureServer(server) {
        const service = createOcrService();
        const managed = process.env.XX_FINANCE_MANAGED_TRIAL === '1';
        const dataDir = process.env.XX_FINANCE_DATA_DIR;
        if (managed && (!dataDir || !require('node:path').isAbsolute(dataDir)))
          throw Error('受管隔离试用须显式指定绝对数据目录，不使用默认账本');
        const backupDestination = process.env.XX_FINANCE_BACKUP_DIR;
        if (backupDestination && !require('node:path').isAbsolute(backupDestination))
          throw Error('备份目的地须由本机启动配置明确指定为绝对目录');
        const ledger = managed
          ? require('./spike/managed-ledger.cjs').createManagedLedger(dataDir, service, {
              backupDestination,
            })
          : createLedger(dataDir || require('node:path').resolve('.local-data'), service);
        server.middlewares.use(ledgerMiddleware(ledger, 'http://127.0.0.1:5173'));
        server.middlewares.use(ocrMiddleware(service, 'http://127.0.0.1:5173'));
        let disposal: Promise<void> | undefined;
        disposeLedger = () =>
          (disposal ??= (async () => {
            service.stop();
            await service.finished;
            await ledger.close();
          })());
      },
      closeBundle() {
        return disposeLedger?.();
      },
    },
  ],
});
