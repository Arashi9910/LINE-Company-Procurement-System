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
  const { config, repository, identityVerifier, messenger } = dependencies;
  for (const [name, value] of Object.entries({ config, repository, identityVerifier, messenger })) {
    if (!value) throw new Error(`缺少核心相依物件：${name}`);
  }
  if (typeof repository.checkHealth !== 'function') {
    throw new Error('核心相依物件 repository 缺少 checkHealth()');
  }

  const app = express();
  app.disable('x-powered-by');

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
    createWebhookHandler({ config, repository, messenger }));
  app.use(express.json({ limit: '64kb' }));
  app.use('/jobs', createJobsRouter({ config, repository, messenger }));
  app.use('/api', createApiRouter({ config, repository, identityVerifier, messenger }));

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
