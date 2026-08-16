from uuid import uuid4

import pytest

from work_chat_worker.receipts import ReceiptStore


async def test_memory_receipt_is_discarded_when_processing_fails() -> None:
    store = ReceiptStore(None, "test-consumer")
    tenant_id = uuid4()
    event_id = uuid4()

    with pytest.raises(RuntimeError, match="temporary failure"):
        async with store.process_once(tenant_id, event_id) as fresh:
            assert fresh is True
            raise RuntimeError("temporary failure")

    async with store.process_once(tenant_id, event_id) as fresh:
        assert fresh is True


async def test_memory_receipt_is_preserved_after_success() -> None:
    store = ReceiptStore(None, "test-consumer")
    tenant_id = uuid4()
    event_id = uuid4()

    async with store.process_once(tenant_id, event_id) as fresh:
        assert fresh is True

    async with store.process_once(tenant_id, event_id) as fresh:
        assert fresh is False
