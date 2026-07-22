import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  parseArguments as parseCatalogArguments,
  runFlyingMouseSync
} from './flyingmouse-sync.mjs';
import {
  parseWritebackArguments,
  runFlyingMouseInventoryWriteback
} from './flyingmouse-inventory-writeback.mjs';

const CLOUD_DOWNLOAD_DIR = '/tmp/flyingmouse/downloads';
const CLOUD_OUTPUT_DIR = '/tmp/flyingmouse/previews';

const jsonLogger = Object.freeze({
  info(value) { console.log(JSON.stringify(value)); },
  error(value) { console.error(JSON.stringify(value)); }
});

export function createFlyingMouseCombinedOptions(env = process.env) {
  const catalog = parseCatalogArguments([
    '--download-dir', CLOUD_DOWNLOAD_DIR,
    '--output-dir', CLOUD_OUTPUT_DIR
  ], env);
  const writeback = parseWritebackArguments([], env);

  return Object.freeze({
    catalog: Object.freeze(catalog),
    writeback: Object.freeze({ ...writeback, ensureSheet: true })
  });
}

export async function runFlyingMouseCombinedJob(options, {
  runCatalog = runFlyingMouseSync,
  runWriteback = runFlyingMouseInventoryWriteback,
  logger = jsonLogger
} = {}) {
  logger.info({ component: 'flyingmouse-combined', phase: 'catalog', status: 'started' });
  const catalog = await runCatalog(options.catalog);
  logger.info({ component: 'flyingmouse-combined', phase: 'catalog', status: 'completed' });

  logger.info({ component: 'flyingmouse-combined', phase: 'writeback', status: 'started' });
  const writeback = await runWriteback(options.writeback);
  logger.info({ component: 'flyingmouse-combined', phase: 'writeback', status: 'completed' });

  return Object.freeze({ catalog, writeback });
}

async function main() {
  try {
    const options = createFlyingMouseCombinedOptions();
    const result = await runFlyingMouseCombinedJob(options);
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      component: 'flyingmouse-combined',
      error: String(error?.message ?? 'Unknown combined job error')
        .replace(/[\r\n]+/g, ' ')
        .slice(0, 500)
    }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
