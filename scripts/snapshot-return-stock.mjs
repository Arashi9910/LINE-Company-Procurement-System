// 觀察「待取消/退貨」（狀態 9）結案後，飛鼠會不會自動把庫存加回去。
// 全程唯讀：只送 GET，任何非 GET 的 API 請求都會被攔截。
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { loadFlyingMouseConfig, loadFlyingMouseConfigFromEnv } from '../src/flyingmouse/credentials.js';
import { withAuthenticatedFlyingMousePage } from '../src/flyingmouse/exporter.js';
import { createFlyingMousePartClient } from '../src/flyingmouse/inventory-writeback.js';
import {
  RETURN_PENDING_STATUS,
  collectReturnParts,
  buildReturnSnapshot,
  compareReturnSnapshot
} from '../src/flyingmouse/return-stock-watch.js';

const HELP = `飛鼠退貨庫存觀察（唯讀）

用法：
  node scripts/snapshot-return-stock.mjs --snapshot [選項]        先記錄基準
  node scripts/snapshot-return-stock.mjs --compare <檔案> [選項]  收到退貨後比對

選項：
  --out <path>          快照輸出路徑；預設 work/return-stock/snapshot-<時間>.json
  --credentials <path>  本機帳密檔；預設 .env.flyingmouse-login.txt
  --headed              顯示 Playwright 瀏覽器
  --help                顯示說明
`;

const STATUS_NAMES = Object.freeze({
  0: '處理中',
  2: '備貨中',
  3: '運送中',
  4: '取消',
  5: '完成',
  6: '棄單',
  7: '待付款',
  8: '退貨',
  9: '待取消/退貨'
});

const VERDICTS = Object.freeze({
  PENDING: '尚未結案',
  RESTOCKED: '有加回庫存',
  NOT_RESTOCKED: '沒有加回庫存',
  INCONCLUSIVE: '無法判定（庫存另有進出）'
});

export function parseArguments(argv) {
  const options = {
    mode: null,
    compareFile: '',
    out: '',
    credentials: '.env.flyingmouse-login.txt',
    headed: false,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} 缺少參數值`);
      index += 1;
      return value;
    };
    if (arg === '--snapshot') options.mode = 'snapshot';
    else if (arg === '--compare') {
      options.mode = 'compare';
      options.compareFile = next();
    } else if (arg === '--out') options.out = next();
    else if (arg === '--credentials') options.credentials = next();
    else if (arg === '--headed') options.headed = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`不認得的參數：${arg}`);
  }
  if (!options.help && !options.mode) throw new Error('必須指定 --snapshot 或 --compare <檔案>');
  return options;
}

export async function fetchOrders(page, { status = null, columns = ['id', 'no', 'status', 'create_time'] } = {}) {
  const all = [];
  const size = 200;
  let offset = 0;
  for (;;) {
    const query = [
      'detail=1',
      'equals[deleted]=0',
      status === null ? null : `equals[status]=${status}`,
      ...columns.map((column) => `columns[]=${encodeURIComponent(column)}`),
      `offset=${offset}`,
      `size=${size}`
    ].filter(Boolean).join('&');
    const result = await page.evaluate(async (q) => {
      const response = await fetch(`/api/admin/order?${q}`, { credentials: 'same-origin', cache: 'no-store' });
      const text = await response.text();
      let body = null;
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
      return { status: response.status, total: body?.data?.total ?? null, list: body?.data?.list ?? null };
    }, query);
    if (result.status < 200 || result.status >= 300) throw new Error(`訂單 API 回應 ${result.status}`);
    if (!Array.isArray(result.list)) throw new Error('訂單 API 回應格式不正確');
    all.push(...result.list);
    if (result.list.length === 0 || all.length >= result.total) {
      if (all.length !== result.total) throw new Error(`訂單筆數不符：取得 ${all.length}，total ${result.total}`);
      return all;
    }
    offset += size;
  }
}

async function fetchStocks(page, partNos) {
  const client = createFlyingMousePartClient(page);
  const stocks = {};
  for (const partNo of partNos) {
    try {
      const part = await client.getBySku(partNo);
      stocks[partNo] = Number(part.stock);
    } catch {
      // 查不到貨品（例如平台自帶料號）就略過，交由 unresolved 回報。
    }
  }
  return stocks;
}

async function loadConfig(options) {
  try {
    return await loadFlyingMouseConfig(resolve(options.credentials));
  } catch {
    return loadFlyingMouseConfigFromEnv();
  }
}

async function withPage(options, operation) {
  const config = await loadConfig(options);
  return withAuthenticatedFlyingMousePage(
    { config, headless: !options.headed, timeoutMs: 120_000 },
    async (page, context) => {
      await context.route('**/api/**', async (route) => {
        if (route.request().method() !== 'GET') {
          console.error(`已攔截非 GET 請求：${route.request().method()} ${route.request().url()}`);
          return route.abort();
        }
        return route.continue();
      });
      await page.goto(new URL('/admin/order/list/0', config.adminUrl).toString(), { waitUntil: 'domcontentloaded' });
      return operation(page);
    }
  );
}

async function runSnapshot(options) {
  const snapshot = await withPage(options, async (page) => {
    const orders = await fetchOrders(page, { status: RETURN_PENDING_STATUS });
    console.log(`待取消/退貨訂單：${orders.length} 筆`);
    const parts = collectReturnParts(orders);
    console.log(`涉及貨號：${parts.length} 個，正在查庫存…`);
    const stocks = await fetchStocks(page, parts.map((part) => part.partNo));
    return buildReturnSnapshot({
      orders,
      stocks,
      capturedAt: new Date().toISOString(),
      onMissingStock: 'skip'
    });
  });

  const defaultName = `work/return-stock/snapshot-${snapshot.capturedAt.replace(/[:.]/g, '-')}.json`;
  const out = resolve(options.out || defaultName);
  await mkdir(resolve(out, '..'), { recursive: true });
  await writeFile(out, JSON.stringify(snapshot, null, 2), 'utf8');

  const total = snapshot.parts.reduce((sum, part) => sum + part.qty, 0);
  console.log(`\n已記錄 ${snapshot.orders.length} 筆訂單、${snapshot.parts.length} 個貨號、共 ${total} 件`);
  if (snapshot.unresolved.length > 0) {
    console.log(`查不到貨品、未納入比對（${snapshot.unresolved.length}）：${snapshot.unresolved.join('、')}`);
  }
  console.log(`\n快照：${out}`);
  console.log('收到退貨後，請執行：');
  console.log(`  node scripts/snapshot-return-stock.mjs --compare "${out}"`);
}

async function runCompare(options) {
  const snapshot = JSON.parse(await readFile(resolve(options.compareFile), 'utf8'));
  const { result, capturedNow } = await withPage(options, async (page) => {
    const orders = await fetchOrders(page, { status: null, columns: ['id', 'no', 'status'] });
    const currentStatusByOrderNo = Object.fromEntries(
      orders.map((order) => [String(order.no), Number(order.status)])
    );
    const currentStocks = await fetchStocks(page, snapshot.parts.map((part) => part.partNo));
    return {
      result: compareReturnSnapshot({ snapshot, currentStatusByOrderNo, currentStocks }),
      capturedNow: new Date().toISOString()
    };
  });

  console.log(`基準時間：${snapshot.capturedAt}`);
  console.log(`比對時間：${capturedNow}`);
  console.log(`\n訂單：已結案 ${result.settledOrders.length} 筆、仍在待取消/退貨 ${result.pendingOrders.length} 筆`);
  const byStatus = {};
  for (const order of result.settledOrders) {
    const name = STATUS_NAMES[order.status] ?? `狀態 ${order.status}`;
    byStatus[name] = (byStatus[name] ?? 0) + 1;
  }
  for (const [name, count] of Object.entries(byStatus)) console.log(`  已轉為「${name}」：${count} 筆`);

  const decided = result.rows.filter((row) => row.verdict !== 'PENDING');
  console.log(`\n可判讀的貨號：${decided.length} / ${result.rows.length}`);
  if (decided.length > 0) {
    console.table(decided.map((row) => ({
      貨號: row.partNo,
      已結案退貨量: row.settledQty,
      基準庫存: row.baselineStock,
      目前庫存: row.currentStock,
      變化: row.delta,
      判定: VERDICTS[row.verdict],
      有未結案: row.hasPending ? '是' : ''
    })));
  }

  const tally = {};
  for (const row of decided) tally[row.verdict] = (tally[row.verdict] ?? 0) + 1;
  console.log('\n結論統計：');
  for (const [verdict, count] of Object.entries(tally)) console.log(`  ${VERDICTS[verdict]}：${count} 個貨號`);
  console.log('\n注意：期間的正常銷售與到貨回寫也會改動庫存，「無法判定」不代表異常，請人工抽查幾筆確認。');
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return;
  }
  if (options.mode === 'snapshot') await runSnapshot(options);
  else await runCompare(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
