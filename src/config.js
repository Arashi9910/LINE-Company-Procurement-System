const REQUIRED_SECRETS = [
  'LINE_LOGIN_CHANNEL_ID',
  'LINE_CHANNEL_SECRET',
  'LINE_CHANNEL_ACCESS_TOKEN',
  'LIFF_ID',
  'LINK_SIGNING_SECRET',
  'JOB_TOKEN'
];

function booleanFlag(value, key, defaultValue = false) {
  if (value == null || value === '') return defaultValue;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${key} 必須是 true 或 false`);
}

export function loadConfig(env = process.env, options = {}) {
  const allowMissingSecrets = options.allowMissingSecrets ?? env.NODE_ENV === 'test';
  const missing = [];

  if (!env.SPREADSHEET_ID) missing.push('SPREADSHEET_ID');
  if (!allowMissingSecrets) {
    missing.push(...REQUIRED_SECRETS.filter((key) => !env[key]));
  }

  if (missing.length > 0) {
    throw new Error(`缺少必要環境變數：${missing.join(', ')}`);
  }

  const port = Number.parseInt(env.PORT ?? '8080', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT 必須是 1 到 65535 的整數');
  }

  return Object.freeze({
    nodeEnv: env.NODE_ENV ?? 'development',
    port,
    appVersion: env.APP_VERSION ?? '0.1.0',
    gitCommit: env.GIT_COMMIT ?? 'development',
    deployedAt: env.DEPLOYED_AT ?? '',
    serviceName: env.K_SERVICE ?? 'line-replenishment',
    serviceRevision: env.K_REVISION ?? '',
    spreadsheetId: env.SPREADSHEET_ID,
    lineLoginChannelId: env.LINE_LOGIN_CHANNEL_ID ?? '',
    lineChannelSecret: env.LINE_CHANNEL_SECRET ?? '',
    lineChannelAccessToken: env.LINE_CHANNEL_ACCESS_TOKEN ?? '',
    liffId: env.LIFF_ID ?? '',
    linkSigningSecret: env.LINK_SIGNING_SECRET ?? env.LINE_CHANNEL_SECRET ?? '',
    jobToken: env.JOB_TOKEN ?? '',
    googleCloudProject: env.GOOGLE_CLOUD_PROJECT ?? '',
    flyingmouseWritebackEnabled: booleanFlag(
      env.FLYINGMOUSE_WRITEBACK_ENABLED,
      'FLYINGMOUSE_WRITEBACK_ENABLED'
    )
  });
}
