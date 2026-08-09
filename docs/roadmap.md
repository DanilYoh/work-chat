# Дорожная карта реализации

## Инкремент 1 — internal alpha (текущее состояние)

- [x] Monorepo, contracts, CI, API, PWA и realtime gateway.
- [x] Organization/space/channel/message model, RLS и audit log.
- [x] Idempotency, cursor sync, JetStream event log и Python worker.
- [x] Decision/action/incident/release/code-change objects.
- [x] Keycloak и LiveKit local profiles.
- [ ] Message edit/delete/reactions, полноценные thread views и read state.
- [ ] Attachments: presigned upload, quota, ClamAV, thumbnails.

Gate: двухнедельное внутреннее использование без потери сообщений и cross-tenant доступа.

## Инкремент 2 — private beta

1. React Native shell: generated API client, encrypted local cache, push без содержимого сообщений.
2. Tauri shell: deep links, системные уведомления, auto-update и secure token storage.
3. Server-side OpenSearch API с tenant/channel authorization и русско-английским mapping.
4. GitHub/GitLab, Jira/YouTrack: OAuth connections, signed webhooks, deduplication и retry/DLQ UI.
5. Inbox, notification preferences, quiet hours и incident priority.
6. LiveKit audio room, screen share, ephemeral room tokens и TURN connectivity test.
7. Admin: invitations, channel policies, retention, audit export и SAML/OIDC setup.

Gate: 10 пилотных организаций и четыре недели стабильного использования.

## Инкремент 3 — paid beta

1. Sentry/Grafana normalization, alert grouping и incident room template.
2. Usage metering, subscriptions, quotas и tenant feature flags.
3. Multi-zone deployment, autoscaling, backup/restore automation и DR drill.
4. SAST/SCA/secret scanning, external pentest и remediation.
5. Desktop/mobile distribution, crash reporting без message content и support workflow.

Gate: пять платящих организаций, SLO dashboards и отсутствие critical/high findings.

## Инкремент 4 — GA

1. 99.9% SLO, capacity gate 50 000 WebSockets и graceful degradation.
2. Helm install в независимом Kubernetes-кластере для проверки portability.
3. Production runbooks, on-call, incident review и quarterly restore test.
4. Activation/retention analytics без сбора содержимого сообщений.

После GA: on-prem, SCIM/CMK, гости/shared spaces, AI с источниками, workflow builder и запись звонков.

