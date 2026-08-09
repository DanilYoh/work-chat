# Work Chat

Рабочая internal-alpha корпоративного IT-мессенджера. Репозиторий реализует первый вертикальный срез продуктового плана: организация → пространство → канал → сообщение → realtime event → рабочий объект.

![Статус](https://img.shields.io/badge/status-internal_alpha-d6ff52?labelColor=11130f)

## Что уже работает

- Адаптивная React PWA с каналами, сообщениями, code blocks и панелью рабочего контекста.
- NestJS/Fastify API `/v1`, OpenAPI на `/docs` и единый error envelope.
- Idempotent message creation, последовательность сообщений, cursor pagination и `/v1/sync`.
- Преобразование сообщения в `Decision`, `Action`, `Incident`, `Release` или `CodeChange`.
- Отдельный WebSocket gateway с проверкой tenant/user audience.
- PostgreSQL-схема с tenant ID, RLS, ревизиями, audit log и transactional event log.
- JetStream events с дедупликацией, подтверждением публикации и восстановлением outbox.
- Python durable worker с идемпотентными receipts и адаптером OpenSearch.
- Локальные PostgreSQL, Redis, NATS, MinIO; профили для OpenSearch, Keycloak и LiveKit.
- OIDC/JWT validation для production и изолированный dev-auth режим.

Пока не реализованы: вложения, edit/delete/reactions API, полноценные треды, mobile/desktop shells, внешние интеграции, уведомления и звонки. Они остаются следующими инкрементами, описанными в [roadmap](docs/roadmap.md).

## Быстрый запуск без Docker

Требуются Node.js 24+ и pnpm 10+.

```powershell
pnpm install
pnpm dev
```

Откройте `http://localhost:5173`. API будет доступен на `http://localhost:3000`, realtime gateway — на `ws://localhost:3001/v1/events`. По умолчанию используется демонстрационное in-memory хранилище; при недоступности NATS клиенты восстанавливают события через `/v1/sync`.

## Запуск с production-хранилищем

```powershell
Copy-Item .env.example .env
pnpm dev:infra
$env:STORE_MODE='postgres'
$env:NATS_URL='nats://localhost:4222'
pnpm dev
```

Дополнительные локальные контуры:

```powershell
docker compose --profile search up -d opensearch
docker compose --profile identity up -d keycloak
docker compose --profile calls up -d livekit
```

Python worker:

```powershell
python -m venv apps\worker\.venv
apps\worker\.venv\Scripts\python -m pip install -e "apps/worker[dev]"
apps\worker\.venv\Scripts\python -m uvicorn work_chat_worker.main:app --port 8000
```

Для индексации задайте `OPENSEARCH_URL=http://localhost:9200`. Для durable receipts задайте `DATABASE_URL`.

## Проверки

```powershell
pnpm check
apps\worker\.venv\Scripts\python -m ruff check apps/worker
apps\worker\.venv\Scripts\python -m pytest apps/worker/tests -q
docker compose config --quiet
```

## API

- `GET /v1/bootstrap` — текущая организация и дерево навигации.
- `GET /v1/channels/:id/messages?cursor=` — сообщения канала.
- `POST /v1/channels/:id/messages` — отправка с обязательным `Idempotency-Key`.
- `POST /v1/messages/:id/work-items` — создать рабочий объект из сообщения.
- `GET /v1/work-items?channelId=` — контекст канала.
- `GET /v1/sync?cursor=` — восстановить события после offline/reconnect.
- `WS /v1/events` — realtime frames `ready` и `event`.

Dev-auth принимает `x-tenant-id` и `x-user-id`. Его нельзя включать в публичном окружении. Production использует bearer JWT с `sub`, `tenant_id`, audience `work-chat-api` и проверкой через JWKS.

## Документация

- [Архитектура и гарантии](docs/architecture.md)
- [Дорожная карта реализации](docs/roadmap.md)
- [Модель угроз](docs/threat-model.md)

