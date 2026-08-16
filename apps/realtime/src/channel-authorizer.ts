import type { DomainEvent } from '@work-chat/contracts';
import { Pool } from 'pg';

export interface AudienceAuthorizer {
  authorize(event: DomainEvent, candidateUserIds: string[]): Promise<Set<string>>;
  close(): Promise<void>;
}

export class PostgresAudienceAuthorizer implements AudienceAuthorizer {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 5,
      connectionTimeoutMillis: 1_500,
      query_timeout: 2_500,
      statement_timeout: 2_000,
    });
  }

  async authorize(event: DomainEvent, candidateUserIds: string[]): Promise<Set<string>> {
    if (!event.channelId || candidateUserIds.length === 0) return new Set();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [event.tenantId]);
      await client.query(`SELECT set_config('app.user_id', $1, true)`, [candidateUserIds[0]]);
      const result = await client.query<{ user_id: string }>(
        `
        SELECT member.user_id
        FROM channels channel
        JOIN memberships member ON member.tenant_id = channel.tenant_id
        WHERE channel.tenant_id = $1
          AND channel.id = $2
          AND member.user_id = ANY($3::uuid[])
          AND (
            channel.kind = 'public'
            OR EXISTS (
              SELECT 1
              FROM channel_memberships channel_member
              WHERE channel_member.tenant_id = channel.tenant_id
                AND channel_member.channel_id = channel.id
                AND channel_member.user_id = member.user_id
            )
          )
      `,
        [event.tenantId, event.channelId, candidateUserIds],
      );
      await client.query('COMMIT');
      return new Set(result.rows.map((row) => row.user_id));
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
