from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict


def to_camel(value: str) -> str:
    head, *tail = value.split("_")
    return head + "".join(part.title() for part in tail)


class DomainEvent(BaseModel):
    model_config = ConfigDict(populate_by_name=True, alias_generator=to_camel)

    id: UUID
    cursor: int
    version: Literal[1]
    tenant_id: UUID
    audience_user_ids: list[UUID]
    type: Literal[
        "message.created",
        "message.updated",
        "message.deleted",
        "work_item.created",
    ]
    occurred_at: datetime
    payload: dict[str, Any]

    @classmethod
    def from_wire(cls, payload: bytes) -> "DomainEvent":
        return cls.model_validate_json(payload)
