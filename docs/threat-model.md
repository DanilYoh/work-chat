# Модель угроз v1

## Активы

- Содержимое сообщений и файлов, рабочие объекты и внешние ссылки.
- Identity, membership, channel ACL, service tokens и OAuth secrets.
- Event log, search index, audit trail и резервные копии.

## Основные угрозы и меры

| Угроза | Обязательная мера |
|---|---|
| Cross-tenant чтение | `tenant_id`, PostgreSQL RLS, negative isolation tests, audience filtering |
| Доступ к приватному каналу | Проверка membership на каждой операции; audience фиксируется сервером |
| Replay/duplicate mutation | `Idempotency-Key`, уникальный DB constraint, JetStream `msgID`, worker receipts |
| Подмена JWT | JWKS, issuer и audience validation; короткие access tokens; отзыв sessions в Keycloak |
| Утечка через логи/push | Запрет message blocks, filenames, tokens и search query content в telemetry |
| Вредоносное вложение | Quarantine, MIME sniffing, size/quota limits, ClamAV до публикации |
| SSRF через preview/webhook | DNS/IP validation, egress allowlist, redirect limit и network policy |
| Утечка OAuth secret | Envelope encryption через KMS/Vault; secrets никогда не возвращаются клиенту |
| WebSocket subscription spoofing | Identity только из проверенного JWT; серверный audience, не client channel list |
| Потеря событий | Transactional event log, JetStream ack и автоматическая outbox recovery |

## Запрещённые production-настройки

- `AUTH_MODE=dev`.
- PostgreSQL API-role с `SUPERUSER`, table ownership или `BYPASSRLS`.
- OpenSearch без TLS и document-level tenant policy.
- Push payload с текстом сообщения.
- Public MinIO/S3 bucket или долгоживущие upload URL.
- Default Keycloak/LiveKit/MinIO credentials из local compose.

