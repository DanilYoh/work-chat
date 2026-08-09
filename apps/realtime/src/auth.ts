import type { IncomingMessage } from 'node:http';
import { createRemoteJWKSet, jwtVerify } from 'jose';

export interface SocketIdentity {
  tenantId: string;
  userId: string;
}

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

function bearerSubprotocol(request: IncomingMessage): string | undefined {
  const protocols = request.headers['sec-websocket-protocol']
    ?.split(',')
    .map((value) => value.trim());
  const encoded = protocols?.find((value) => value.startsWith('bearer.'))?.slice('bearer.'.length);
  if (!encoded) return undefined;
  return Buffer.from(encoded, 'base64url').toString('utf8');
}

export async function authenticate(request: IncomingMessage): Promise<SocketIdentity | null> {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if ((process.env.AUTH_MODE ?? 'dev') === 'dev') {
    return {
      tenantId: url.searchParams.get('tenantId') ?? process.env.DEV_TENANT_ID ?? '',
      userId: url.searchParams.get('userId') ?? process.env.DEV_USER_ID ?? '',
    };
  }
  const token = bearerSubprotocol(request);
  if (!token || !process.env.JWKS_URL || !process.env.JWT_ISSUER || !process.env.JWT_AUDIENCE) {
    return null;
  }
  jwks ??= createRemoteJWKSet(new URL(process.env.JWKS_URL));
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: process.env.JWT_ISSUER,
      audience: process.env.JWT_AUDIENCE,
    });
    return payload.sub && typeof payload.tenant_id === 'string'
      ? { userId: payload.sub, tenantId: payload.tenant_id }
      : null;
  } catch {
    return null;
  }
}

