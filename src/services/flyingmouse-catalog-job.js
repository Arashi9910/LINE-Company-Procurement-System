import { google } from 'googleapis';
import { ConflictError } from '../errors.js';

const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const EXECUTION_VISIBILITY_GUARD_MS = 30_000;

function shortResourceName(value) {
  return String(value ?? '').split('/').filter(Boolean).at(-1) ?? '';
}

function completedCondition(execution) {
  return execution?.conditions?.find((condition) => condition?.type === 'Completed');
}

export function normalizeCatalogExecution(execution) {
  if (!execution) {
    return { state: 'never' };
  }

  const completed = completedCondition(execution);
  const failed = Number(execution.failedCount ?? 0) > 0
    || Number(execution.cancelledCount ?? 0) > 0
    || completed?.state === 'CONDITION_FAILED'
    || completed?.status === 'False';
  const succeeded = Number(execution.succeededCount ?? 0) > 0
    || completed?.state === 'CONDITION_SUCCEEDED'
    || completed?.status === 'True';
  const hasCompleted = Boolean(execution.completionTime || completed);

  return {
    state: hasCompleted ? (failed || !succeeded ? 'failed' : 'succeeded') : 'running',
    execution: shortResourceName(execution.name),
    createdAt: String(execution.createTime ?? ''),
    startedAt: String(execution.startTime ?? ''),
    completedAt: String(execution.completionTime ?? '')
  };
}

export function createCloudRunJobsClient() {
  const auth = new google.auth.GoogleAuth({ scopes: [CLOUD_PLATFORM_SCOPE] });
  return google.run({ version: 'v2', auth });
}

export class FlyingmouseCatalogJobRunner {
  constructor({
    runClient = createCloudRunJobsClient(),
    projectId,
    region = 'asia-east1',
    jobName = 'flyingmouse-catalog-sync',
    now = Date.now
  }) {
    if (!projectId) {
      throw new Error('GOOGLE_CLOUD_PROJECT 未設定，無法控制飛鼠商品同步 Job');
    }

    this.runClient = runClient;
    this.now = now;
    this.jobResource = `projects/${projectId}/locations/${region}/jobs/${jobName}`;
    this.startQueue = Promise.resolve();
    this.recentStartUntil = 0;
  }

  async status() {
    const response = await this.runClient.projects.locations.jobs.executions.list({
      parent: this.jobResource,
      pageSize: 1
    });
    return normalizeCatalogExecution(response.data.executions?.[0] ?? null);
  }

  start() {
    const result = this.startQueue.then(
      () => this.#start(),
      () => this.#start()
    );
    this.startQueue = result.catch(() => undefined);
    return result;
  }

  async #start() {
    if (this.recentStartUntil > this.now()) {
      throw new ConflictError('已有飛鼠商品同步正在執行，請稍後輸入「查飛鼠同步」。');
    }
    const latest = await this.status();
    if (latest.state === 'running') {
      throw new ConflictError('已有飛鼠商品同步正在執行，請稍後輸入「查飛鼠同步」。');
    }

    const response = await this.runClient.projects.locations.jobs.run({
      name: this.jobResource,
      requestBody: {}
    });
    this.recentStartUntil = this.now() + EXECUTION_VISIBILITY_GUARD_MS;

    return {
      state: 'accepted',
      operation: shortResourceName(response.data?.name),
      execution: shortResourceName(response.data?.metadata?.target)
    };
  }
}
