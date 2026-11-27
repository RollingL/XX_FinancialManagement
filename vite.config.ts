import { defineConfig } from 'vite';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { ledgerMiddleware } = require('./src/main/ledger.cjs');
let disposeLedger: (() => Promise<void>) | undefined;
export default defineConfig({
  root: 'src/renderer',
  base: './',
  build: { outDir: '../../dist', emptyOutDir: true },
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
        '**/*.sqlite*',
        '**/数据/**',
        '**/备份/**',
        '**/运行记录/**',
      ],
    },
  },
  plugins: [
    {
      name: 'local-ledger',
      configureServer(server) {
        // Development only: QIANLAI_HOME (an absolute folder) or .local-data/ in the project.
        const { resolveHome } = require('./src/main/app-paths.cjs');
        const { home } = resolveHome({
          packaged: false,
          platform: process.platform,
          resourcesPath: '',
          env: process.env,
          projectRoot: path.resolve('.'),
        });
        const ledger = require('./src/main/ledger-service.cjs').openLedgerService(home);
        server.middlewares.use(ledgerMiddleware(ledger, 'http://127.0.0.1:5173'));
        let disposal: Promise<void> | undefined;
        disposeLedger = () => (disposal ??= ledger.close());
      },
      closeBundle() {
        return disposeLedger?.();
      },
    },
  ],
});
