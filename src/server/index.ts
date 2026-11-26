import { existsSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { bootstrap } from './bootstrap.ts';
import { loadConfig } from './config.ts';
import { startSweeper } from './inventory.ts';

if (existsSync('.env')) process.loadEnvFile('.env');
const config = loadConfig();
const { ctx, app, mock } = bootstrap(config);
const stopSweeper = startSweeper(ctx);

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Tiketi listening on http://localhost:${info.port}`);
  console.log(`  ticket public key: ${ctx.keys.publicKeyB64url}`);
  if (!existsSync('dist/web/index.html')) console.log('  (front-end not built: run `npm run build`)');
});

function shutdown() {
  stopSweeper();
  mock.close();
  server.close(() => {
    ctx.db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
