import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadFlyingMouseConfigFromEnv,
  parseEnvText,
  validateFlyingMouseConfig
} from '../src/flyingmouse/credentials.js';

const validValues = Object.freeze({
  FLYINGMOUSE_ADMIN_URL: 'https://ss-select.fslol.com/admin/dashboard',
  FLYINGMOUSE_PRODUCT_LIST_URL: 'https://ss-select.fslol.com/admin/part/list/*',
  FLYINGMOUSE_USERNAME: 'user@example.com',
  FLYINGMOUSE_PASSWORD: 'not-a-real-password'
});

test('parseEnvText supports quoted secrets and equals signs', () => {
  assert.deepEqual(parseEnvText([
    '# local only',
    'FLYINGMOUSE_USERNAME="user@example.com"',
    "FLYINGMOUSE_PASSWORD='abc=123'"
  ].join('\n')), {
    FLYINGMOUSE_USERNAME: 'user@example.com',
    FLYINGMOUSE_PASSWORD: 'abc=123'
  });
});

test('validateFlyingMouseConfig only permits the expected HTTPS host and paths', () => {
  const result = validateFlyingMouseConfig(validValues);
  assert.equal(result.username, validValues.FLYINGMOUSE_USERNAME);
  assert.equal(result.productListUrl, 'https://ss-select.fslol.com/admin/part/list/*');

  assert.equal(validateFlyingMouseConfig({
    ...validValues,
    FLYINGMOUSE_PRODUCT_LIST_URL: 'https://ss-select.fslol.com/admin/part/list/'
  }).productListUrl, 'https://ss-select.fslol.com/admin/part/list/*');

  assert.throws(() => validateFlyingMouseConfig({
    ...validValues,
    FLYINGMOUSE_PRODUCT_LIST_URL: 'https://example.com/admin/part/list/*'
  }), /指定 HTTPS 後台網址/);
  assert.throws(() => validateFlyingMouseConfig({
    ...validValues,
    FLYINGMOUSE_PRODUCT_LIST_URL: 'https://ss-select.fslol.com/admin/product/list/*'
  }), /指定 HTTPS 後台網址/);
});

test('validateFlyingMouseConfig reports missing values without echoing secrets', () => {
  assert.throws(() => validateFlyingMouseConfig({
    ...validValues,
    FLYINGMOUSE_PASSWORD: ''
  }), /FLYINGMOUSE_PASSWORD/);
});

test('loadFlyingMouseConfigFromEnv validates Cloud Run secret environment values', () => {
  assert.deepEqual(loadFlyingMouseConfigFromEnv(validValues), {
    adminUrl: 'https://ss-select.fslol.com/admin/dashboard',
    productListUrl: 'https://ss-select.fslol.com/admin/part/list/*',
    username: 'user@example.com',
    password: 'not-a-real-password'
  });
});
