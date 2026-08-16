from uuid import uuid4

import pytest
from pydantic import ValidationError

from work_chat_worker.models import DomainEvent


def test_event_parses_camel_case_wire_shape() -> None:
    event_id = uuid4()
    tenant_id = uuid4()
    user_id = uuid4()
    event = DomainEvent.from_wire(
        f'''{{
          "id":"{event_id}","cursor":1,"version":1,"tenantId":"{tenant_id}",
          "channelId":null,
          "audienceUserIds":["{user_id}"],"type":"message.created",
          "occurredAt":"2026-08-09T10:00:00Z","payload":{{"message":{{}}}}
        }}'''.encode()
    )
    assert event.tenant_id == tenant_id


def test_event_accepts_legacy_v1_without_channel_id() -> None:
    event = DomainEvent.from_wire(
        f'''{{
          "id":"{uuid4()}","cursor":1,"version":1,"tenantId":"{uuid4()}",
          "audienceUserIds":[],"type":"message.created",
          "occurredAt":"2026-08-09T10:00:00Z","payload":{{"message":{{}}}}
        }}'''.encode()
    )
    assert event.channel_id is None


def test_event_rejects_unknown_version() -> None:
    with pytest.raises(ValidationError):
        DomainEvent.model_validate(
            {
                "id": uuid4(),
                "cursor": 1,
                "version": 2,
                "tenantId": uuid4(),
                "channelId": None,
                "audienceUserIds": [],
                "type": "message.created",
                "occurredAt": "2026-08-09T10:00:00Z",
                "payload": {},
            }
        )


@pytest.mark.parametrize("event_type", ["reaction.added", "reaction.removed", "channel.read"])
def test_event_accepts_message_interaction_types(event_type: str) -> None:
    event = DomainEvent.model_validate(
        {
            "id": uuid4(),
            "cursor": 2,
            "version": 1,
            "tenantId": uuid4(),
            "channelId": str(uuid4()),
            "audienceUserIds": [uuid4()],
            "type": event_type,
            "occurredAt": "2026-08-09T10:00:00Z",
            "payload": {},
        }
    )
    assert event.type == event_type
