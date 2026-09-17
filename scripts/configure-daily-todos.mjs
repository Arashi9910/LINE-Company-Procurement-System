import { parseArgs } from 'node:util';
import { google } from 'googleapis';

const { values } = parseArgs({ options: {
  apply: { type: 'boolean', default: false }, project: { type: 'string' },
  region: { type: 'string', default: 'asia-east1' }, service: { type: 'string', default: 'line-replenishment' }
} });
const schedules = [{ slot: 'noon', schedule: '0 12 * * 1-5' }, { slot: 'evening', schedule: '30 19 * * 1-5' }];
if (!values.apply) {
  console.log(JSON.stringify({ mode: 'preview', timeZone: 'Asia/Taipei', schedules, note: '未連線或啟用排程。確認後使用 --apply --project <ID>。' }, null, 2));
} else {
  if (!values.project) throw new Error('缺少 --project');
  const auth = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const run = google.run({ version: 'v2', auth });
  const scheduler = google.cloudscheduler({ version: 'v1', auth });
  const parent = `projects/${values.project}/locations/${values.region}`;
  const { data: service } = await run.projects.locations.services.get({ name: `${parent}/services/${values.service}` });
  const enabled = service.template?.containers?.[0]?.env?.some((item) => item.name === 'DAILY_TODOS_ENABLED' && item.value === 'true');
  if (!enabled) throw new Error('請先部署已啟用 DAILY_TODOS_ENABLED 的版本。');
  if (service.template?.scaling?.maxInstanceCount !== 1) throw new Error('待辦 Sheets 序列寫入需要 Cloud Run max instances = 1。');
  const health = await fetch(`${service.uri}/ready`);
  if (!health.ok) throw new Error('服務尚未通過 readiness 檢查，不建立排程。');
  const secrets = google.secretmanager({ version: 'v1', auth });
  const secret = await secrets.projects.secrets.versions.access({ name: `projects/${values.project}/secrets/line-job-token/versions/latest` });
  const token = Buffer.from(secret.data.payload.data, 'base64').toString('utf8').trim();
  if (!token) throw new Error('排程驗證密鑰為空。');
  for (const { slot, schedule } of schedules) {
    const name = `${parent}/jobs/${values.service}-todos-${slot}`;
    const job = {
      name, schedule, timeZone: 'Asia/Taipei', description: `每日待辦 ${slot}`,
      httpTarget: { uri: `${service.uri}/jobs/daily-todos/${slot}`, httpMethod: 'POST', headers: { Authorization: `Bearer ${token}` } },
      attemptDeadline: '180s', retryConfig: { retryCount: 5, maxRetryDuration: '7200s', minBackoffDuration: '60s', maxBackoffDuration: '1800s', maxDoublings: 5 }
    };
    let existing;
    try { existing = await scheduler.projects.locations.jobs.get({ name }); }
    catch (error) { if (Number(error.code) !== 404) throw error; }
    if (existing) {
      await scheduler.projects.locations.jobs.patch({ name, updateMask: 'schedule,timeZone,description,httpTarget,attemptDeadline,retryConfig', requestBody: job });
      if (existing.data.state === 'PAUSED') await scheduler.projects.locations.jobs.resume({ name, requestBody: {} });
    } else await scheduler.projects.locations.jobs.create({ parent, requestBody: job });
    console.log(`已設定 ${slot} 排程（Asia/Taipei）。`);
  }
}
