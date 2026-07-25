import { Router } from 'express';
import { bearerToken } from '../line/identity.js';
import { verifyGroupContext } from '../line/context.js';
import { listSearchableSkus, submitRequest } from '../services/requests.js';
import { confirmOrder, confirmReceipt, getRequestDetails } from '../services/workflow.js';

function lineErrorStatus(error) {
  return Number(error?.status ?? error?.statusCode) || null;
}

function lineErrorBodyMessage(error) {
  if (typeof error?.body !== 'string') return '';
  try {
    return String(JSON.parse(error.body)?.message ?? '');
  } catch {
    return '';
  }
}

function notificationFailure(error) {
  const status = lineErrorStatus(error);
  const bodyMessage = lineErrorBodyMessage(error);
  if (status === 429 && /monthly limit/i.test(bodyMessage)) {
    return { sent: false, reason: 'quota_exceeded' };
  }
  if (status === 429) return { sent: false, reason: 'rate_limited' };
  return { sent: false, reason: 'delivery_failed' };
}

async function deliverNotification({ kind, requestId, target, send }) {
  if (!target) return { sent: false, reason: 'group_unavailable' };
  try {
    await send();
    return { sent: true };
  } catch (error) {
    const result = notificationFailure(error);
    console.warn(JSON.stringify({
      event: 'line_notification_failed',
      kind,
      requestId,
      status: lineErrorStatus(error),
      reason: result.reason,
      message: error.message
    }));
    return result;
  }
}

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

      const notification = await deliverNotification({
        kind: 'request_created',
        requestId: result.requestId,
        target: groupId,
        send: () => messenger.pushRequestCreated(groupId, result, request.actor)
      });

      response.status(result.idempotentReplay ? 200 : 201).json({ ...result, notification });
    } catch (error) {
      next(error);
    }
  });

  router.get('/requests/:requestId', async (request, response, next) => {
    try {
      response.json(await getRequestDetails({
        actor: request.actor,
        requestId: request.params.requestId
      }, repository));
    } catch (error) {
      next(error);
    }
  });

  router.post('/requests/:requestId/order', async (request, response, next) => {
    try {
      const result = await confirmOrder({
        actor: request.actor,
        requestId: request.params.requestId,
        items: request.body?.items,
        idempotencyKey: request.body?.idempotencyKey
      }, repository);
      const notification = await deliverNotification({
        kind: 'order_confirmed',
        requestId: result.requestId,
        target: result.groupId,
        send: () => messenger.pushOrderConfirmed(result.groupId, result, request.actor)
      });
      response.status(result.idempotentReplay ? 200 : 201).json({ ...result, notification });
    } catch (error) {
      next(error);
    }
  });

  router.post('/requests/:requestId/receipt', async (request, response, next) => {
    try {
      const result = await confirmReceipt({
        actor: request.actor,
        requestId: request.params.requestId,
        items: request.body?.items,
        idempotencyKey: request.body?.idempotencyKey
      }, repository);
      const notification = await deliverNotification({
        kind: 'receipt_confirmed',
        requestId: result.requestId,
        target: result.groupId,
        send: () => messenger.pushReceiptConfirmed(result.groupId, result, request.actor)
      });
      response.status(result.idempotentReplay ? 200 : 201).json({ ...result, notification });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
