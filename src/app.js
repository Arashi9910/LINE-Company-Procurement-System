import express from 'express';
import { AppError } from './errors.js';
import { createApiRouter } from './routes/api.js';
import { createWebhookHandler } from './routes/webhook.js';
import { createJobsRouter } from './routes/jobs.js';

function deploymentMetadata(config, ok) {
  return {
    ok,
    service: config.serviceName ?? 'line-replenishment',
    version: config.appVersion ?? '0.1.0',
    commit: config.gitCommit ?? 'development',
    revision: config.serviceRevision ?? '',
    deployedAt: config.deployedAt ?? ''
  };
}

export function createApp(dependencies = {}) {
  const {
    config, repository, identityVerifier, messenger, catalogSyncRunner, writebackRunner,
    // 讀「庫存看板」分頁給 查缺貨／查庫存 用。沒給就回「尚未啟用」，不影響其他指令。
    dashboardReader = null,
    // 叫貨提醒的排程端點要直接讀 Sheets；沒給就回 skipped。
    sheets = null,
    readRecentlyOrdered = null
  } = dependencies;
  for (const [name, value] of Object.entries({ config, repository, identityVerifier, messenger })) {
    if (!value) throw new Error(`缺少核心相依物件：${name}`);
  }
  if (typeof repository.checkHealth !== 'function') {
    throw new Error('核心相依物件 repository 缺少 checkHealth()');
  }
  if (config.flyingmouseWritebackEnabled
      && (!writebackRunner || typeof writebackRunner.start !== 'function')) {
    throw new Error('啟用飛鼠庫存回寫時缺少 writebackRunner.start()');
  }

  const app = express();
  app.disable('x-powered-by');

  // Use during revision cutover so old write requests can drain before enabling a new writer.
  app.use((request, response, next) => {
    if (config.maintenanceMode && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      return response.status(503).set('Retry-After', '60').json({
        error: { code: 'MAINTENANCE', message: '系統更新中，請保留目前內容，稍後再送出' }
      });
    }
    next();
  });

  app.get('/health', (_request, response) => {
    response.json(deploymentMetadata(config, true));
  });

  app.get('/ready', async (_request, response) => {
    try {
      await repository.checkHealth();
      response.json(deploymentMetadata(config, true));
    } catch (error) {
      console.error('Readiness check failed', { message: error.message });
      response.status(503).json(deploymentMetadata(config, false));
    }
  });

  app.get('/api/config', (_request, response) => {
    response.json({ liffId: config.liffId });
  });

  app.post('/webhook', express.raw({ type: 'application/json', limit: '1mb' }),
    createWebhookHandler({ config, repository, messenger, catalogSyncRunner, dashboardReader }));
  app.use(express.json({ limit: '64kb' }));
  app.use('/jobs', createJobsRouter({
    config, repository, messenger, sheets, readRecentlyOrdered
  }));
  app.use('/api', createApiRouter({
    config, repository, identityVerifier, messenger, writebackRunner
  }));

  app.use(express.static('public', { extensions: ['html'] }));

  app.use((request, _response, next) => {
    next(new AppError(`找不到路由：${request.method} ${request.path}`, {
      code: 'NOT_FOUND',
      status: 404
    }));
  });

  app.use((error, _request, response, _next) => {
    const status = Number.isInteger(error.status) ? error.status : 500;
    if (status >= 500) console.error(error);
    response.status(status).json({
      error: {
        code: error.code ?? 'INTERNAL_ERROR',
        message: status >= 500 ? '系統暫時無法處理，請稍後再試' : error.message,
        ...(error.details ? { details: error.details } : {})
      }
    });
  });

  return app;
}
