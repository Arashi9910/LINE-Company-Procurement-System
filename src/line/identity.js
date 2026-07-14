import { AuthenticationError } from '../errors.js';

const VERIFY_URL = 'https://api.line.me/oauth2/v2.1/verify';

export function createLineIdentityVerifier({ channelId, fetchImpl = fetch }) {
  return {
    async verify(idToken) {
      if (!idToken) throw new AuthenticationError('缺少 LINE ID token');

      const body = new URLSearchParams({ id_token: idToken, client_id: channelId });
      let response;
      try {
        response = await fetchImpl(VERIFY_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body
        });
      } catch {
        throw new AuthenticationError('目前無法連線驗證 LINE 身分');
      }

      if (!response.ok) throw new AuthenticationError();
      const payload = await response.json();
      const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      if (!payload.sub || !audiences.includes(channelId)) throw new AuthenticationError();

      return {
        userId: payload.sub,
        displayName: payload.name ?? 'LINE 使用者',
        pictureUrl: payload.picture ?? ''
      };
    }
  };
}

export function bearerToken(request) {
  const authorization = request.get('authorization') ?? '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new AuthenticationError('請先使用 LINE 登入');
  return match[1];
}
