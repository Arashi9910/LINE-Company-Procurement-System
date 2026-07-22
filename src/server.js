import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createLineIdentityVerifier } from './line/identity.js';
import { createLineMessenger } from './line/messenger.js';
import { FlyingmouseCatalogJobRunner } from './services/flyingmouse-catalog-job.js';
import { createGoogleSheetsClient, SheetsRepository } from './sheets/repository.js';

const config = loadConfig();
const repository = new SheetsRepository({
  sheets: createGoogleSheetsClient(),
  spreadsheetId: config.spreadsheetId,
  flyingmouseWritebackEnabled: config.flyingmouseWritebackEnabled
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
const app = createApp({ config, repository, identityVerifier, messenger, catalogSyncRunner });

const server = app.listen(config.port, () => {
  console.log(`line-replenishment listening on :${config.port}`);
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(() => process.exit(0));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
