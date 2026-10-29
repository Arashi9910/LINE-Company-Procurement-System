import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createLineIdentityVerifier } from './line/identity.js';
import { createLineMessenger } from './line/messenger.js';
import {
  FlyingmouseCatalogJobRunner,
  FlyingmouseWritebackJobRunner
} from './services/flyingmouse-catalog-job.js';
import { createDashboardReader } from './sheets/inventory-dashboard.js';
import { createGoogleSheetsClient, SheetsRepository } from './sheets/repository.js';

const config = loadConfig();
const sheets = createGoogleSheetsClient();
const repository = new SheetsRepository({
  sheets,
  spreadsheetId: config.spreadsheetId,
  flyingmouseWritebackEnabled: config.flyingmouseWritebackEnabled,
  dailyTodosEnabled: config.dailyTodosEnabled,
  purchaseDraftsEnabled: config.purchaseDraftsEnabled
});
const identityVerifier = createLineIdentityVerifier({ channelId: config.lineLoginChannelId });
const messenger = createLineMessenger({
  channelAccessToken: config.lineChannelAccessToken,
  liffId: config.liffId
});
const catalogSyncRunner = config.googleCloudProject
  ? new FlyingmouseCatalogJobRunner({
      projectId: config.googleCloudProject,
      region: config.googleCloudRegion,
      jobName: config.flyingmouseCatalogJobName
    })
  : undefined;
const writebackRunner = config.googleCloudProject && config.flyingmouseWritebackEnabled
  ? new FlyingmouseWritebackJobRunner({
      projectId: config.googleCloudProject,
      region: config.googleCloudRegion,
      jobName: config.flyingmouseWritebackJobName
    })
  : undefined;
// 查缺貨／查庫存 讀的是「庫存看板」分頁。開關關閉時不接，指令會回「尚未啟用」。
const dashboardReader = createDashboardReader({
  sheets,
  spreadsheetId: config.spreadsheetId,
  enabled: config.inventoryDashboardEnabled
});
const app = createApp({
  config,
  repository,
  identityVerifier,
  messenger,
  catalogSyncRunner,
  writebackRunner,
  dashboardReader,
  sheets
});

const server = app.listen(config.port, () => {
  console.log(`line-replenishment listening on :${config.port}`);
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(() => process.exit(0));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
