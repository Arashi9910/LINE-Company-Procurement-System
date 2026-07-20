const REAUTH_PARAMETER = 'line_reauth';
const TOKEN_EXPIRY_SKEW_SECONDS = 30;

export function idTokenNeedsRefresh(decodedToken, nowMilliseconds = Date.now()) {
  const expiresAt = Number(decodedToken?.exp);
  if (!Number.isFinite(expiresAt)) return true;
  const nowSeconds = Math.floor(nowMilliseconds / 1000);
  return expiresAt <= nowSeconds + TOKEN_EXPIRY_SKEW_SECONDS;
}

export function hasLineReauthMarker(value) {
  return new URL(value).searchParams.get(REAUTH_PARAMETER) === '1';
}

export function withLineReauthMarker(value) {
  const url = new URL(value);
  url.searchParams.set(REAUTH_PARAMETER, '1');
  return url.toString();
}

export function withoutLineReauthMarker(value) {
  const url = new URL(value);
  url.searchParams.delete(REAUTH_PARAMETER);
  return url.toString();
}
