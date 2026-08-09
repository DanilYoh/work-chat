import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyRequest } from 'fastify';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { randomUUID } from 'node:crypto';

function rolesFrom(payload: JWTPayload): string[] {
  const direct = payload.roles;
  if (Array.isArray(direct)) return direct.filter((role): role is string => typeof role === 'string');
  const realm = payload.realm_access;
  if (typeof realm === 'object' && realm && 'roles' in realm && Array.isArray(realm.roles)) {
    return realm.roles.filter((role): role is string => typeof role === 'string');
  }
  return [];
}

@Injectable()
export class AuthGuard implements CanActivate {
  private readonly jwks?: ReturnType<typeof createRemoteJWKSet>;

  constructor(@Inject(ConfigService) private readonly config: ConfigService) {
    const jwksUrl = this.config.get<string>('JWKS_URL');
    if (jwksUrl) this.jwks = createRemoteJWKSet(new URL(jwksUrl));
  }

  async canActivate(executionContext: ExecutionContext): Promise<boolean> {
    const request = executionContext.switchToHttp().getRequest<FastifyRequest>();
    const requestId = String(request.headers['x-request-id'] ?? randomUUID());
    if (this.config.get('AUTH_MODE', 'dev') === 'dev') {
      request.appContext = {
        tenantId: String(request.headers['x-tenant-id'] ?? this.config.get('DEV_TENANT_ID')),
        userId: String(request.headers['x-user-id'] ?? this.config.get('DEV_USER_ID')),
        roles: ['owner'],
        requestId,
      };
      return true;
    }

    const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (!token || !this.jwks) throw new UnauthorizedException('Bearer token is required');
    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: this.config.getOrThrow<string>('JWT_ISSUER'),
        audience: this.config.getOrThrow<string>('JWT_AUDIENCE'),
      });
      const tenantId = payload.tenant_id;
      if (!payload.sub || typeof tenantId !== 'string') {
        throw new UnauthorizedException('Token has no tenant context');
      }
      request.appContext = {
        tenantId,
        userId: payload.sub,
        roles: rolesFrom(payload),
        requestId,
      };
      return true;
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new UnauthorizedException('Token validation failed');
    }
  }
}
