import asyncio
import logging

import nats
from nats.aio.msg import Msg

from .models import DomainEvent
from .receipts import ReceiptStore
from .search import SearchIndexer
from .settings import Settings

logger = logging.getLogger("work_chat_worker")


class EventConsumer:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._receipts = ReceiptStore(settings.database_url, settings.worker_consumer)
        self._search = SearchIndexer(
            settings.opensearch_url,
            settings.opensearch_username,
            settings.opensearch_password,
        )
        self._connection: nats.NATS | None = None
        self._subscription = None

    async def start(self) -> None:
        await self._receipts.connect()
        self._connection = await nats.connect(
            self._settings.nats_url,
            name="work-chat-python-worker",
            reconnect_time_wait=2,
            max_reconnect_attempts=-1,
        )
        jetstream = self._connection.jetstream()
        self._subscription = await jetstream.subscribe(
            "workchat.events.*",
            durable=self._settings.worker_consumer,
            queue=self._settings.worker_consumer,
            manual_ack=True,
            cb=self._handle_message,
        )

    async def close(self) -> None:
        if self._subscription:
            await self._subscription.unsubscribe()
        await self._search.close()
        await self._receipts.close()
        if self._connection:
            await self._connection.drain()

    async def _handle_message(self, message: Msg) -> None:
        try:
            event = DomainEvent.from_wire(message.data)
            async with self._receipts.process_once(event.tenant_id, event.id) as fresh:
                if fresh:
                    await self._search.handle(event)
            await message.ack()
        except Exception:
            logger.exception("event processing failed", extra={"subject": message.subject})
            await asyncio.sleep(1)
            await message.nak(delay=5)
