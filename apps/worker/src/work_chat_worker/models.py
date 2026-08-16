from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


def to_camel(value: str) -> str:
    head, *tail = value.split("_")
    return head + "".join(part.title() for part in tail)


class DomainEvent(BaseModel):
    model_config = ConfigDict(populate_by_name=True, alias_generator=to_camel)

    id: UUID
    cursor: int
    version: Literal[1]
    tenant_id: UUID
    channel_id: str | None = Field(default=None, alias="channelId")
    audience_user_ids: list[UUID]
    type: Literal[
        "message.created",
        "message.updated",
        "message.deleted",
        "reaction.added",
        "reaction.removed",
        "channel.read",
        "work_item.created",
    ]
    occurred_at: datetime
    payload: dict[str, Any]

    @classmethod
    def from_wire(cls, payload: bytes) -> "DomainEvent":
        return cls.model_validate_json(payload)
