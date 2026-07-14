import express from 'express';
import { AppError } from './errors.js';
import { createApiRouter } from './routes/api.js';
import { createWebhookHandler } from './routes/webhook.js';
import { createJobsRouter } from './routes/jobs.js';

export function createApp({ config, repository, identityVerifier, messenger }) {
  const app = express();
  app.disable('x-powered-by');

  app.get('/healthz', (_request, response) => {
    response.json({ ok: true, service: 'line-replenishment', version: '0.1.0' });
  });

  app.get('/api/config', (_request, response) => {
    response.json({ liffId: config.liffId });
  });

  if (repository && identityVerifier && messenger) {
    app.post('/webhook', express.raw({ type: 'application/json', limit: '1mb' }),
      createWebhookHandler({ config, repository, messenger }));
    app.use(express.json({ limit: '64kb' }));
    app.use('/jobs', createJobsRouter({ config, repository, messenger }));
    app.use('/api', createApiRouter({ config, repository, identityVerifier, messenger }));
  }

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
