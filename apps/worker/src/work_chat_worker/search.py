from typing import Any

import httpx

from .models import DomainEvent


class SearchIndexer:
    def __init__(self, url: str | None, username: str | None, password: str | None) -> None:
        self._url = url.rstrip("/") if url else None
        self._auth = (username, password) if username and password else None
        self._client = httpx.AsyncClient(timeout=10, auth=self._auth)

    async def close(self) -> None:
        await self._client.aclose()

    async def handle(self, event: DomainEvent) -> None:
        if not self._url:
            return
        if event.type in {"message.created", "message.updated"}:
            await self._index_message(str(event.tenant_id), event.payload["message"])
        elif event.type == "message.deleted":
            message = event.payload["message"]
            await self._client.delete(
                f"{self._url}/work-chat-messages/_doc/{message['id']}",
                headers={"x-opaque-id": str(event.id)},
            )
        elif event.type == "work_item.created":
            await self._index_work_item(str(event.tenant_id), event.payload["workItem"])

    async def _index_message(self, tenant_id: str, message: dict[str, Any]) -> None:
        document = {
            "tenant_id": tenant_id,
            "channel_id": message["channelId"],
            "author_id": message["author"]["id"],
            "blocks": message["blocks"],
            "created_at": message["createdAt"],
            "deleted_at": message.get("deletedAt"),
        }
        response = await self._client.put(
            f"{self._url}/work-chat-messages/_doc/{message['id']}", json=document
        )
        response.raise_for_status()

    async def _index_work_item(self, tenant_id: str, item: dict[str, Any]) -> None:
        document = {**item, "tenant_id": tenant_id}
        response = await self._client.put(
            f"{self._url}/work-chat-work-items/_doc/{item['id']}", json=document
        )
        response.raise_for_status()
