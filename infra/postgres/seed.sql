INSERT INTO organizations (id, name, slug)
VALUES ('11111111-1111-4111-8111-111111111111', 'Orbit Labs', 'orbit-labs')
ON CONFLICT DO NOTHING;

INSERT INTO users (id, email, display_name) VALUES
  ('22222222-2222-4222-8222-222222222222', 'danil@example.ru', 'Данил Соколов'),
  ('22222222-2222-4222-8222-222222222223', 'marina@example.ru', 'Марина Орлова')
ON CONFLICT DO NOTHING;

INSERT INTO memberships (tenant_id, user_id, role) VALUES
  ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'owner'),
  ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222223', 'member')
ON CONFLICT DO NOTHING;

INSERT INTO spaces (id, tenant_id, name, slug)
VALUES ('33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111', 'Platform', 'platform')
ON CONFLICT DO NOTHING;

INSERT INTO channels (id, tenant_id, space_id, name, slug, description, kind, next_sequence) VALUES
  ('44444444-4444-4444-8444-444444444444', '11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333', 'Общий', 'general', 'Главные объявления команды', 'public', 0),
  ('44444444-4444-4444-8444-444444444445', '11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333', 'Backend', 'backend', 'API, архитектура и code review', 'public', 1),
  ('44444444-4444-4444-8444-444444444446', '11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333', 'Инциденты', 'incidents', 'Оперативная работа с production-инцидентами', 'private', 0)
ON CONFLICT DO NOTHING;

INSERT INTO channel_memberships (tenant_id, channel_id, user_id) VALUES
  ('11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444446', '22222222-2222-4222-8222-222222222222'),
  ('11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444446', '22222222-2222-4222-8222-222222222223')
ON CONFLICT DO NOTHING;

INSERT INTO messages (id, tenant_id, channel_id, sequence, author_id, blocks, created_at)
VALUES (
  '55555555-5555-4555-8555-555555555555',
  '11111111-1111-4111-8111-111111111111',
  '44444444-4444-4444-8444-444444444445',
  1,
  '22222222-2222-4222-8222-222222222223',
  '[{"type":"text","text":"После релиза API p95 вырос до 780 мс. Проверяю запросы к истории сообщений."}]'::jsonb,
  now() - interval '22 minutes'
)
ON CONFLICT DO NOTHING;

