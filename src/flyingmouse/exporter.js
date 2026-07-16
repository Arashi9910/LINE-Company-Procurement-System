import { mkdir, rename, rm } from 'node:fs/promises';
import { basename, extname, join, parse, resolve } from 'node:path';
import { chromium } from 'playwright';

const DOWNLOAD_NAME = /^ss-select_Part-List_\d{4}-\d{2}-\d{2}\.xlsx$/i;
const LOGIN_CHALLENGE = /驗證碼|圖形驗證|一次性密碼|\bOTP\b|captcha|recaptcha/i;

function timestamp(now) {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

async function firstVisible(page, selectors) {
  for (const selector of selectors) {
    const candidates = page.locator(selector);
    const count = await candidates.count();
    for (let index = 0; index < count; index += 1) {
      const candidate = candidates.nth(index);
      if (await candidate.isVisible()) return candidate;
    }
  }
  return null;
}

async function visibleCount(locator) {
  const count = await locator.count();
  let visible = 0;
  for (let index = 0; index < count; index += 1) {
    if (await locator.nth(index).isVisible()) visible += 1;
  }
  return visible;
}

async function loginIfRequired(page, config, timeoutMs) {
  const password = await firstVisible(page, [
    'input[type="password"]',
    'input[name="password"]',
    'input[autocomplete="current-password"]'
  ]);
  if (!password) return false;

  const challenge = page.getByText(LOGIN_CHALLENGE);
  if (await visibleCount(challenge)) {
    throw new Error('飛鼠登入頁出現驗證碼或 OTP，需要人工處理');
  }

  const username = await firstVisible(page, [
    'input[autocomplete="username"]',
    'input[name="username"]',
    'input[name="account"]',
    'input[name="email"]',
    'input[type="email"]',
    'input[type="text"]'
  ]);
  if (!username) throw new Error('找不到飛鼠登入帳號欄位');

  await username.fill(config.username);
  await password.fill(config.password);

  let submit = await firstVisible(page, [
    'form button',
    'button.btn-primary',
    'button[type="submit"]',
    'input[type="submit"]'
  ]);
  if (!submit) {
    const candidates = page.getByRole('button', { name: /登入|登錄|Login/i });
    const count = await candidates.count();
    for (let index = 0; index < count; index += 1) {
      if (await candidates.nth(index).isVisible()) {
        submit = candidates.nth(index);
        break;
      }
    }
  }
  if (!submit) throw new Error('找不到飛鼠登入按鈕');

  await submit.click();
  await password.waitFor({
    state: 'hidden',
    timeout: Math.min(timeoutMs, 15_000)
  }).catch(() => {});

  const remainingPassword = await firstVisible(page, ['input[type="password"]']);
  if (remainingPassword) {
    const challengeAfterSubmit = page.getByText(LOGIN_CHALLENGE);
    if (await visibleCount(challengeAfterSubmit)) {
      throw new Error('飛鼠要求驗證碼或 OTP，需要人工處理');
    }
    throw new Error('飛鼠登入失敗，請確認帳號、密碼與帳號狀態');
  }
  const authenticatedNavigation = page.locator('a[href="/admin/dashboard"]');
  await authenticatedNavigation.first().waitFor({
    state: 'visible',
    timeout: timeoutMs
  }).catch(() => {});
  if (await visibleCount(authenticatedNavigation) < 1) {
    throw new Error('飛鼠登入狀態尚未完成初始化');
  }
  return true;
}

async function downloadOfficialWorkbook(page, config, timeoutMs) {
  await page.goto(config.productListUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  const currentPath = new URL(page.url()).pathname;
  if (!currentPath.startsWith('/admin/part/list/')) {
    throw new Error(`飛鼠貨品列表未載入或目前帳號沒有權限（目前路徑：${currentPath}）`);
  }
  const listHeading = page.locator('h1,h2,h3').filter({ hasText: '貨品列表' });
  await listHeading.first().waitFor({ state: 'visible', timeout: timeoutMs }).catch(() => {});
  if (await visibleCount(listHeading) !== 1) {
    const headings = (await page.locator('h1,h2,h3').allTextContents())
      .map((text) => text.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 5);
    throw new Error(`飛鼠貨品列表標題不符，實際標題：${headings.join('｜') || '無'}`);
  }

  const exportButtons = page.getByRole('button', { name: /匯出/ });
  await exportButtons.first().waitFor({ state: 'visible', timeout: timeoutMs }).catch(() => {});
  if (await visibleCount(exportButtons) !== 1) {
    throw new Error('找不到唯一的飛鼠匯出按鈕');
  }
  const exportButton = (await exportButtons.count()) === 1
    ? exportButtons
    : (await firstVisible(page, ['button:has-text("匯出")']));
  if (!exportButton) throw new Error('找不到飛鼠匯出按鈕');
  await exportButton.click();

  const officialExport = page.getByText('貨品資料 Excel 匯出', { exact: true });
  await officialExport.waitFor({ state: 'visible', timeout: timeoutMs }).catch(() => {});
  if (await visibleCount(officialExport) !== 1) {
    throw new Error('找不到唯一的官方貨品 Excel 匯出選項');
  }

  const downloadPromise = page.waitForEvent('download', { timeout: timeoutMs });
  await officialExport.click();
  return downloadPromise;
}

async function saveDownload(download, downloadDir, now) {
  const suggestedFilename = basename(download.suggestedFilename());
  if (!DOWNLOAD_NAME.test(suggestedFilename)) {
    throw new Error(`飛鼠下載檔名不符預期：${suggestedFilename}`);
  }
  await mkdir(downloadDir, { recursive: true });
  const parsed = parse(suggestedFilename);
  const finalPath = join(downloadDir, `${parsed.name}_${timestamp(now)}${parsed.ext.toLowerCase()}`);
  const partialPath = `${finalPath}.partial`;
  try {
    await download.saveAs(partialPath);
    const failure = await download.failure();
    if (failure) throw new Error(`飛鼠 Excel 下載失敗：${failure}`);
    await rename(partialPath, finalPath);
  } catch (error) {
    await rm(partialPath, { force: true });
    throw error;
  }
  return finalPath;
}

export async function exportFlyingMouseWorkbook({
  config,
  downloadDir = 'work/flyingmouse/downloads',
  headless = true,
  timeoutMs = 45_000,
  now = () => new Date(),
  launch = (options) => chromium.launch(options)
}) {
  return withAuthenticatedFlyingMousePage({
    config,
    headless,
    timeoutMs,
    launch
  }, async (page) => {
    const absoluteDownloadDir = resolve(downloadDir);
    const download = await downloadOfficialWorkbook(page, config, timeoutMs);
    return saveDownload(download, absoluteDownloadDir, now());
  });
}

export async function withAuthenticatedFlyingMousePage({
  config,
  headless = true,
  timeoutMs = 45_000,
  launch = (options) => chromium.launch(options)
}, operation) {
  if (!config?.adminUrl || !config?.productListUrl || !config?.username || !config?.password) {
    throw new Error('飛鼠匯出設定不完整');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 5_000) {
    throw new Error('飛鼠匯出 timeoutMs 必須至少為 5000');
  }
  if (typeof operation !== 'function') throw new Error('飛鼠瀏覽器操作未設定');

  const browser = await launch({ headless });
  try {
    const context = await browser.newContext({
      acceptDownloads: true,
      locale: 'zh-TW',
      timezoneId: 'Asia/Taipei'
    });
    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);
    await page.goto(config.adminUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await loginIfRequired(page, config, timeoutMs);
    return await operation(page, context);
  } finally {
    await browser.close();
  }
}

export function isOfficialFlyingMouseDownloadName(filename) {
  return DOWNLOAD_NAME.test(basename(filename)) && extname(filename).toLowerCase() === '.xlsx';
}
