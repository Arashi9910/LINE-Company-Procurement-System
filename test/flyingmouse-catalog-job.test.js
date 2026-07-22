import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FlyingmouseCatalogJobRunner,
  normalizeCatalogExecution
} from '../src/services/flyingmouse-catalog-job.js';

const JOB = 'projects/project-1/locations/asia-east1/jobs/flyingmouse-catalog-sync';

function runClient({ executions = [], operation = {} } = {}) {
  const calls = { list: [], run: [] };
  return {
    calls,
    client: {
      projects: {
        locations: {
          jobs: {
            executions: {
              async list(input) {
                calls.list.push(input);
                return { data: { executions } };
              }
            },
            async run(input) {
              calls.run.push(input);
              return { data: operation };
            }
          }
        }
      }
    }
  };
}

test('normalizeCatalogExecution maps absent, pending, successful, and failed executions', () => {
  assert.deepEqual(normalizeCatalogExecution(null), { state: 'never' });
  assert.deepEqual(normalizeCatalogExecution({
    name: `${JOB}/executions/run-1`,
    createTime: '2026-07-22T10:00:00Z',
    startTime: '2026-07-22T10:00:05Z',
    runningCount: 1
  }), {
    state: 'running',
    execution: 'run-1',
    createdAt: '2026-07-22T10:00:00Z',
    startedAt: '2026-07-22T10:00:05Z',
    completedAt: ''
  });
  assert.equal(normalizeCatalogExecution({
    name: `${JOB}/executions/run-2`,
    completionTime: '2026-07-22T10:00:40Z',
    succeededCount: 1
  }).state, 'succeeded');
  assert.equal(normalizeCatalogExecution({
    name: `${JOB}/executions/run-3`,
    completionTime: '2026-07-22T10:00:40Z',
    failedCount: 1
  }).state, 'failed');
});

test('FlyingmouseCatalogJobRunner returns the latest execution status', async () => {
  const fixture = runClient({
    executions: [{
      name: `${JOB}/executions/latest-run`,
      createTime: '2026-07-22T10:00:00Z',
      completionTime: '2026-07-22T10:00:40Z',
      succeededCount: 1
    }]
  });
  const runner = new FlyingmouseCatalogJobRunner({
    runClient: fixture.client,
    projectId: 'project-1'
  });

  const status = await runner.status();

  assert.equal(status.state, 'succeeded');
  assert.equal(status.execution, 'latest-run');
  assert.deepEqual(fixture.calls.list, [{ parent: JOB, pageSize: 1 }]);
});

test('FlyingmouseCatalogJobRunner starts one execution and returns a safe operation id', async () => {
  const fixture = runClient({
    operation: {
      name: 'projects/project-1/locations/asia-east1/operations/operation-123',
      metadata: { target: `${JOB}/executions/new-run` }
    }
  });
  const runner = new FlyingmouseCatalogJobRunner({
    runClient: fixture.client,
    projectId: 'project-1'
  });

  const result = await runner.start();

  assert.deepEqual(result, {
    state: 'accepted',
    operation: 'operation-123',
    execution: 'new-run'
  });
  assert.deepEqual(fixture.calls.run, [{ name: JOB, requestBody: {} }]);
});

test('FlyingmouseCatalogJobRunner refuses to start while an execution is active', async () => {
  const fixture = runClient({
    executions: [{ name: `${JOB}/executions/active-run`, runningCount: 1 }]
  });
  const runner = new FlyingmouseCatalogJobRunner({
    runClient: fixture.client,
    projectId: 'project-1'
  });

  await assert.rejects(runner.start(), /已有飛鼠商品同步正在執行/);
  assert.equal(fixture.calls.run.length, 0);
});
