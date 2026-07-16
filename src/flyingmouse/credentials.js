import { readFile } from 'node:fs/promises';

const REQUIRED_KEYS = Object.freeze([
  'FLYINGMOUSE_ADMIN_URL',
  'FLYINGMOUSE_PRODUCT_LIST_URL',
  'FLYINGMOUSE_USERNAME',
  'FLYINGMOUSE_PASSWORD'
]);

export function parseEnvText(text) {
  const values = {};
  for (const [index, rawLine] of String(text).split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) throw new Error(`帳密檔第 ${index + 1} 列格式錯誤`);
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (Object.hasOwn(values, key)) throw new Error(`帳密檔的 ${key} 重複設定`);
    values[key] = value;
  }
  return values;
}

function validateFlyingMouseUrl(value, key, requiredPathPrefix, options = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${key} 不是有效網址`);
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'ss-select.fslol.com' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    !url.pathname.startsWith(requiredPathPrefix)
  ) {
    throw new Error(`${key} 必須是 ss-select.fslol.com 的指定 HTTPS 後台網址`);
  }
  if (options.normalizePartList) {
    if (url.pathname === '/admin/part/list/') url.pathname = '/admin/part/list/*';
    if (url.pathname !== '/admin/part/list/*') {
      throw new Error(`${key} 必須指向飛鼠貨品列表路由 /admin/part/list/*`);
    }
  }
  return url.toString();
}

export function validateFlyingMouseConfig(values) {
  const missing = REQUIRED_KEYS.filter((key) => !String(values[key] ?? '').trim());
  if (missing.length > 0) throw new Error(`帳密檔缺少設定：${missing.join('、')}`);
  return Object.freeze({
    adminUrl: validateFlyingMouseUrl(values.FLYINGMOUSE_ADMIN_URL, 'FLYINGMOUSE_ADMIN_URL', '/admin/'),
    productListUrl: validateFlyingMouseUrl(
      values.FLYINGMOUSE_PRODUCT_LIST_URL,
      'FLYINGMOUSE_PRODUCT_LIST_URL',
      '/admin/part/list/',
      { normalizePartList: true }
    ),
    username: String(values.FLYINGMOUSE_USERNAME),
    password: String(values.FLYINGMOUSE_PASSWORD)
  });
}

export async function loadFlyingMouseConfig(filePath) {
  const text = await readFile(filePath, 'utf8');
  return validateFlyingMouseConfig(parseEnvText(text));
}

export function loadFlyingMouseConfigFromEnv(env = process.env) {
  return validateFlyingMouseConfig(env);
}
