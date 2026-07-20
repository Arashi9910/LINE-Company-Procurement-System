import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hasLineReauthMarker,
  idTokenNeedsRefresh,
  withLineReauthMarker,
  withoutLineReauthMarker
} from '../public/line-session.js';

test('LINE session refreshes missing, expired, or nearly expired ID tokens', () => {
  const now = 1_000_000;
  assert.equal(idTokenNeedsRefresh(null, now), true);
  assert.equal(idTokenNeedsRefresh({}, now), true);
  assert.equal(idTokenNeedsRefresh({ exp: 999 }, now), true);
  assert.equal(idTokenNeedsRefresh({ exp: 1_025 }, now), true);
  assert.equal(idTokenNeedsRefresh({ exp: 1_031 }, now), false);
  assert.equal(idTokenNeedsRefresh({ exp: '1100' }, now), false);
});

test('LINE reauthentication marker survives workflow parameters and can be removed', () => {
  const original = 'https://example.com/?mode=detail&requestId=RQ-1';
  const marked = withLineReauthMarker(original);

  assert.equal(hasLineReauthMarker(original), false);
  assert.equal(hasLineReauthMarker(marked), true);
  assert.equal(new URL(marked).searchParams.get('mode'), 'detail');
  assert.equal(new URL(marked).searchParams.get('requestId'), 'RQ-1');
  assert.equal(withoutLineReauthMarker(marked), original);
});
