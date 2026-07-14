import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createLineIdentityVerifier } from './line/identity.js';
import { createLineMessenger } from './line/messenger.js';
import { createGoogleSheetsClient, SheetsRepository } from './sheets/repository.js';

const config = loadConfig();
const repository = new SheetsRepository({
  sheets: createGoogleSheetsClient(),
  spreadsheetId: config.spreadsheetId
});
const identityVerifier = createLineIdentityVerifier({ channelId: config.lineChannelId });
const messenger = createLineMessenger({
  channelAccessToken: config.lineChannelAccessToken,
  liffId: config.liffId
});
const app = createApp({ config, repository, identityVerifier, messenger });

const server = app.listen(config.port, () => {
  console.log(`line-replenishment listening on :${config.port}`);
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(() => process.exit(0));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
