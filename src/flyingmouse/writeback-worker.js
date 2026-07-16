import {
  FlyingMouseWritebackError,
  applyPreparedFlyingMouseWriteback,
  prepareFlyingMouseWriteback
} from './inventory-writeback.js';
import {
  completeWritebackEvent,
  listProcessableWritebacks,
  timestampInTaipei,
  transitionWritebackEvent,
  writeWritebackEventState
} from './sheets-writeback.js';

const MAX_ATTEMPTS = 5;
const RETRY_DELAYS_MINUTES = Object.freeze([5, 15, 60, 60, 60]);

function safeError(error) {
  const code = error instanceof FlyingMouseWritebackError
    ? error.code
    : 'UNEXPECTED_ERROR';
  const raw = String(error?.message ?? '未知錯誤')
    .replace(/[\r\n]+/g, ' ')
    .replace(/(password|cookie|authorization|token)\s*[:=]\s*\S+/ig, '$1=<redacted>')
    .trim();
  return Object.freeze({
    code,
    message: `${code}: ${raw}`.slice(0, 500),
    retryable: error instanceof FlyingMouseWritebackError && error.retryable === true,
    manualReview: !(error instanceof FlyingMouseWritebackError) || error.manualReview === true
  });
}

function retryTimestamp(now, attempts) {
  const minutes = RETRY_DELAYS_MINUTES[Math.min(Math.max(attempts, 1), MAX_ATTEMPTS) - 1];
  return timestampInTaipei(new Date(now.getTime() + minutes * 60_000));
}

function emptySummary(mode, found) {
  return {
    mode,
    found,
    completed: 0,
    dryRun: 0,
    retryScheduled: 0,
    manualReview: 0,
    failed: 0
  };
}

function log(logger, level, data) {
  const writer = logger?.[level];
  if (typeof writer === 'function') writer.call(logger, data);
}

async function dryRunEvent({ client, event, processedAt }) {
  let prepared = event;
  if (event.status !== '已準備') {
    const target = await prepareFlyingMouseWriteback({ client, event });
    prepared = transitionWritebackEvent(event, {
      status: '已準備',
      attempts: event.attempts + 1,
      ...target,
      nextRetryAt: '',
      lastError: '',
      processedAt
    });
  }
  return applyPreparedFlyingMouseWriteback({ client, event: prepared, mode: 'dry-run' });
}

async function liveEvent({ sheets, spreadsheetId, client, event, processedAt }) {
  let prepared = event;
  const attempts = event.attempts + 1;
  if (event.status !== '已準備') {
    const target = await prepareFlyingMouseWriteback({ client, event });
    prepared = transitionWritebackEvent(event, {
      status: '已準備',
      attempts,
      ...target,
      nextRetryAt: '',
      lastError: '',
      processedAt
    });
  } else {
    prepared = transitionWritebackEvent(event, {
      status: '已準備',
      attempts,
      lastError: '',
      processedAt
    });
  }
  await writeWritebackEventState({ sheets, spreadsheetId, event: prepared });
  try {
    const result = await applyPreparedFlyingMouseWriteback({ client, event: prepared, mode: 'live' });
    await completeWritebackEvent({
      sheets,
      spreadsheetId,
      event: prepared,
      completedAt: processedAt
    });
    return { prepared, result };
  } catch (error) {
    if (error && typeof error === 'object') error.preparedWritebackEvent = prepared;
    throw error;
  }
}

async function recordFailure({
  sheets,
  spreadsheetId,
  event,
  error,
  processedAt,
  now,
  attemptAlreadyRecorded = false
}) {
  const details = safeError(error);
  const attempts = Math.max(event.attempts, 0) + (attemptAlreadyRecorded ? 0 : 1);
  const requiresManualReview = details.manualReview || !details.retryable || attempts >= MAX_ATTEMPTS;
  const failed = transitionWritebackEvent(event, requiresManualReview
    ? {
        status: '需人工確認',
        attempts,
        nextRetryAt: '',
        lastError: details.message,
        processedAt
      }
    : {
        status: '等待重試',
        attempts,
        nextRetryAt: retryTimestamp(now, attempts),
        lastError: details.message,
        processedAt
      });
  await writeWritebackEventState({ sheets, spreadsheetId, event: failed });
  return { failed, details, requiresManualReview };
}

export async function processWritebackQueue({
  sheets,
  spreadsheetId,
  withClient,
  mode = 'dry-run',
  now = () => new Date(),
  limit = 20,
  logger = console
}) {
  if (!['dry-run', 'live'].includes(mode)) throw new Error('飛鼠庫存回寫模式不正確');
  if (typeof withClient !== 'function') throw new Error('飛鼠 client session factory 設定不完整');
  const startedAt = now();
  if (!(startedAt instanceof Date) || Number.isNaN(startedAt.getTime())) throw new Error('worker 時間不正確');
  const events = await listProcessableWritebacks({
    sheets,
    spreadsheetId,
    now: startedAt,
    limit
  });
  const summary = emptySummary(mode, events.length);
  if (events.length === 0) return summary;

  return withClient(async (client) => {
    for (const event of events) {
      const processedAt = timestampInTaipei(startedAt);
      try {
        if (mode === 'dry-run') {
          const result = await dryRunEvent({ client, event, processedAt });
          summary.dryRun += 1;
          log(logger, 'info', {
            component: 'flyingmouse-writeback',
            eventId: event.eventId,
            requestId: event.requestId,
            sku: event.sku,
            status: 'dry-run',
            action: result.action
          });
          continue;
        }
        const { result } = await liveEvent({
          sheets,
          spreadsheetId,
          client,
          event,
          processedAt
        });
        summary.completed += 1;
        log(logger, 'info', {
          component: 'flyingmouse-writeback',
          eventId: event.eventId,
          requestId: event.requestId,
          sku: event.sku,
          status: 'completed',
          action: result.action
        });
      } catch (error) {
        if (mode === 'dry-run') {
          summary.failed += 1;
          const details = safeError(error);
          log(logger, 'warn', {
            component: 'flyingmouse-writeback',
            eventId: event.eventId,
            requestId: event.requestId,
            sku: event.sku,
            status: 'dry-run-failed',
            errorCode: details.code
          });
          continue;
        }
        const preparedEvent = error?.preparedWritebackEvent;
        const failure = await recordFailure({
          sheets,
          spreadsheetId,
          event: preparedEvent ?? event,
          error,
          processedAt,
          now: startedAt,
          attemptAlreadyRecorded: Boolean(preparedEvent)
        });
        if (failure.requiresManualReview) summary.manualReview += 1;
        else summary.retryScheduled += 1;
        log(logger, failure.requiresManualReview ? 'error' : 'warn', {
          component: 'flyingmouse-writeback',
          eventId: event.eventId,
          requestId: event.requestId,
          sku: event.sku,
          status: failure.requiresManualReview ? 'manual-review' : 'retry-scheduled',
          errorCode: failure.details.code
        });
      }
    }
    return summary;
  });
}
