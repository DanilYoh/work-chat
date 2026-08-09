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
          "audienceUserIds":["{user_id}"],"type":"message.created",
          "occurredAt":"2026-08-09T10:00:00Z","payload":{{"message":{{}}}}
        }}'''.encode()
    )
    assert event.tenant_id == tenant_id


def test_event_rejects_unknown_version() -> None:
    with pytest.raises(ValidationError):
        DomainEvent.model_validate(
            {
                "id": uuid4(),
                "cursor": 1,
                "version": 2,
                "tenantId": uuid4(),
                "audienceUserIds": [],
                "type": "message.created",
                "occurredAt": "2026-08-09T10:00:00Z",
                "payload": {},
            }
        )
