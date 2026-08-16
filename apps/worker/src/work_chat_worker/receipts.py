from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from uuid import UUID

import asyncpg


class ReceiptStore:
    def __init__(self, database_url: str | None, consumer_name: str) -> None:
        self._database_url = database_url
        self._consumer_name = consumer_name
        self._pool: asyncpg.Pool | None = None
        self._memory: set[UUID] = set()

    async def connect(self) -> None:
        if self._database_url:
            self._pool = await asyncpg.create_pool(self._database_url, min_size=1, max_size=5)

    async def close(self) -> None:
        if self._pool:
            await self._pool.close()

    @asynccontextmanager
    async def process_once(self, tenant_id: UUID, event_id: UUID) -> AsyncIterator[bool]:
        if not self._pool:
            fresh = event_id not in self._memory
            if not fresh:
                yield False
                return

            self._memory.add(event_id)
            succeeded = False
            try:
                yield True
                succeeded = True
            finally:
                if not succeeded:
                    self._memory.discard(event_id)
            return

        async with self._pool.acquire() as connection, connection.transaction():
            await connection.execute("SELECT set_config('app.tenant_id', $1, true)", str(tenant_id))
            result = await connection.fetchrow(
                """
                INSERT INTO worker_receipts (tenant_id, consumer_name, event_id)
                VALUES ($1, $2, $3)
                ON CONFLICT DO NOTHING
                RETURNING event_id
                """,
                tenant_id,
                self._consumer_name,
                event_id,
            )
            yield result is not None
