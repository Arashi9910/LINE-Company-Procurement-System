import { Router } from 'express';
import { bearerToken } from '../line/identity.js';
import { verifyGroupContext } from '../line/context.js';
import { listSearchableSkus, submitRequest } from '../services/requests.js';

export function createApiRouter({ config, repository, identityVerifier, messenger }) {
  const router = Router();

  router.use(async (request, _response, next) => {
    try {
      request.actor = await identityVerifier.verify(bearerToken(request));
      next();
    } catch (error) {
      next(error);
    }
  });

  router.get('/skus', async (_request, response, next) => {
    try {
      response.json({ items: await listSearchableSkus(repository) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/requests', async (request, response, next) => {
    try {
      const contextToken = String(request.body?.contextToken ?? '');
      const groupId = contextToken
        ? verifyGroupContext(contextToken, config.linkSigningSecret).groupId
        : await repository.getNotificationGroupId();
      const result = await submitRequest({
        actor: request.actor,
        items: request.body?.items,
        note: request.body?.note,
        idempotencyKey: request.body?.idempotencyKey,
        groupId
      }, repository);

      if (groupId) {
        try {
          await messenger.pushRequestCreated(groupId, result, request.actor);
        } catch (error) {
          console.warn('LINE request notification failed', {
            requestId: result.requestId,
            message: error.message
          });
        }
      }

      response.status(result.idempotentReplay ? 200 : 201).json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
