import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { AuthenticationError } from '../errors.js';
import { runReminders } from '../services/reminders.js';

function validJobToken(request, expected) {
  const match = (request.get('authorization') ?? '').match(/^Bearer\s+(.+)$/i);
  const provided = request.get('x-job-token') ?? match?.[1];
  if (!provided || !expected) return false;
  const actual = Buffer.from(provided);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

export function createJobsRouter({ config, repository, messenger }) {
  const router = Router();
  router.post('/reminders', async (request, response, next) => {
    try {
      if (!validJobToken(request, config.jobToken)) throw new AuthenticationError('排程驗證失敗');
      response.json(await runReminders({ repository, messenger }));
    } catch (error) {
      next(error);
    }
  });
  router.post('/flyingmouse-approved-imports', async (request, response, next) => {
    try {
      if (!validJobToken(request, config.jobToken)) throw new AuthenticationError('排程驗證失敗');
      response.json(await repository.importApprovedCatalogSnapshots());
    } catch (error) {
      next(error);
    }
  });
  return router;
}
