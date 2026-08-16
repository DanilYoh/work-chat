# Модель угроз v1

## Активы

- Содержимое сообщений и файлов, рабочие объекты и внешние ссылки.
- Identity, membership, channel ACL, service tokens и OAuth secrets.
- Event log, search index, audit trail и резервные копии.

## Основные угрозы и меры

| Угроза                                              | Обязательная мера                                                                                        |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Cross-tenant чтение                                 | `tenant_id`, PostgreSQL RLS, negative isolation tests, audience filtering                                |
| Доступ к приватному каналу                          | Проверка membership на каждой операции; realtime повторно проверяет актуальный ACL                       |
| Replay/duplicate mutation                           | `Idempotency-Key` вместе с hash запроса, уникальный DB constraint, JetStream `msgID`, worker receipts    |
| Lost update или восстановление удалённого сообщения | `expectedRevision`, row lock, terminal tombstone и неизменяемая revision history                         |
| Подмена JWT                                         | JWKS, issuer и audience validation; короткие access tokens; отзыв sessions в Keycloak                    |
| Утечка через логи/push                              | Запрет message blocks, filenames, tokens и search query content в telemetry                              |
| Вредоносное вложение                                | Quarantine, MIME sniffing, size/quota limits, ClamAV до публикации                                       |
| SSRF через preview/webhook                          | DNS/IP validation, egress allowlist, redirect limit и network policy                                     |
| Утечка OAuth secret                                 | Envelope encryption через KMS/Vault; secrets никогда не возвращаются клиенту                             |
| WebSocket subscription spoofing                     | Identity только из проверенного JWT; серверный audience, не client channel list                          |
| Потеря или перестановка событий                     | Transactional event log, tenant-ordered outbox, JetStream ack, consumer revision guard и recovery        |
| Блокировка outbox слишком большим событием          | Лимит полного encoded event; legacy oversize переводится в наблюдаемый quarantine без блокировки очереди |

## Запрещённые production-настройки

- `AUTH_MODE=dev`.
- PostgreSQL API-role с `SUPERUSER`, table ownership или `BYPASSRLS`.
- OpenSearch без TLS и document-level tenant policy.
- Push payload с текстом сообщения.
- Public MinIO/S3 bucket или долгоживущие upload URL.
- Default Keycloak/LiveKit/MinIO credentials из local compose.
