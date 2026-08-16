import json
from uuid import uuid4

import httpx
import pytest

from work_chat_worker.models import DomainEvent
from work_chat_worker.search import SearchIndexer


def message_event(
    event_type: str = "message.updated", *, revision: int = 3, deleted_at: str | None = None
) -> DomainEvent:
    channel_id = uuid4()
    return DomainEvent.model_validate(
        {
            "id": uuid4(),
            "cursor": 10,
            "version": 1,
            "tenantId": uuid4(),
            "channelId": str(channel_id),
            "audienceUserIds": [uuid4()],
            "type": event_type,
            "occurredAt": "2026-08-16T10:00:00Z",
            "payload": {
                "message": {
                    "id": str(uuid4()),
                    "channelId": str(channel_id),
                    "author": {"id": str(uuid4())},
                    "blocks": [{"type": "text", "text": "Current content"}],
                    "revision": revision,
                    "createdAt": "2026-08-16T09:00:00Z",
                    "deletedAt": deleted_at,
                }
            },
        }
    )


async def indexer_for_status(status_code: int) -> tuple[SearchIndexer, list[httpx.Request]]:
    requests: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(status_code, request=request)

    indexer = SearchIndexer("https://search.example", None, None)
    await indexer._client.aclose()
    indexer._client = httpx.AsyncClient(transport=httpx.MockTransport(respond))
    return indexer, requests


async def test_message_put_uses_revision_as_external_gte_version() -> None:
    indexer, requests = await indexer_for_status(200)
    event = message_event(revision=7)
    try:
        await indexer.handle(event)
    finally:
        await indexer.close()

    assert len(requests) == 1
    request = requests[0]
    assert request.method == "PUT"
    assert request.url.params["version"] == "7"
    assert request.url.params["version_type"] == "external_gte"
    assert request.headers["x-opaque-id"] == str(event.id)


@pytest.mark.parametrize("event_type", ["message.created", "message.updated", "message.deleted"])
async def test_deleted_snapshot_writes_minimal_versioned_tombstone(
    event_type: str,
) -> None:
    indexer, requests = await indexer_for_status(200)
    event = message_event(event_type, revision=8, deleted_at="2026-08-16T10:01:00Z")
    try:
        await indexer.handle(event)
    finally:
        await indexer.close()

    assert len(requests) == 1
    request = requests[0]
    assert request.method == "PUT"
    assert request.url.params["version"] == "8"
    assert request.url.params["version_type"] == "external_gte"
    assert request.headers["x-opaque-id"] == str(event.id)
    document = json.loads(request.content)
    assert document == {
        "tenant_id": str(event.tenant_id),
        "channel_id": event.payload["message"]["channelId"],
        "deleted_at": "2026-08-16T10:01:00Z",
    }
    assert "blocks" not in document
    assert "content" not in document


@pytest.mark.parametrize(
    ("event", "expected_method"),
    [
        (message_event(revision=2), "PUT"),
        (
            message_event("message.deleted", revision=3, deleted_at="2026-08-16T10:01:00Z"),
            "PUT",
        ),
    ],
)
async def test_stale_message_write_is_idempotent(event: DomainEvent, expected_method: str) -> None:
    indexer, requests = await indexer_for_status(409)
    try:
        await indexer.handle(event)
    finally:
        await indexer.close()

    assert [request.method for request in requests] == [expected_method]


@pytest.mark.parametrize("status_code", [400, 404, 500])
@pytest.mark.parametrize(
    "event",
    [
        message_event(revision=4),
        message_event("message.deleted", revision=5, deleted_at="2026-08-16T10:01:00Z"),
    ],
)
async def test_non_idempotent_opensearch_errors_are_retried(
    event: DomainEvent, status_code: int
) -> None:
    indexer, _ = await indexer_for_status(status_code)
    try:
        with pytest.raises(httpx.HTTPStatusError):
            await indexer.handle(event)
    finally:
        await indexer.close()
