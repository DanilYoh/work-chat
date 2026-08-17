import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  MAX_DOMAIN_EVENT_JSON_BYTES,
  MAX_MESSAGE_REACTION_MEMBERSHIPS,
} from '@work-chat/contracts';
import { randomUUID } from 'node:crypto';
import type { AppContext } from '../src/common/context.js';
import { DEMO_IDS, MemoryStore } from '../src/store/memory.store.js';

process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'dev';
process.env.DEV_TENANT_ID = DEMO_IDS.tenant;
process.env.DEV_USER_ID = DEMO_IDS.user;

describe('messaging vertical slice', () => {
  let app: NestFastifyApplication;

  const sendMessage = (
    text: string,
    options: {
      channelId?: string;
      idempotencyKey?: string;
      threadRootId?: string;
      userId?: string;
    } = {},
  ) =>
    app.inject({
      method: 'POST',
      url: `/v1/channels/${options.channelId ?? DEMO_IDS.channelBackend}/messages`,
      headers: {
        'idempotency-key': options.idempotencyKey ?? randomUUID(),
        'x-user-id': options.userId ?? DEMO_IDS.user,
      },
      payload: {
        clientId: randomUUID(),
        ...(options.threadRootId ? { threadRootId: options.threadRootId } : {}),
        blocks: [{ type: 'text', text }],
      },
    });

  beforeAll(async () => {
    const { createApplication } = await import('../src/main.js');
    app = await createApplication();
  });

  afterAll(async () => {
    await app.close();
  });

  it('boots an organization and lists a channel', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/bootstrap' });
    expect(response.statusCode).toBe(200);
    expect(response.json().spaces[0].channels).toHaveLength(3);
    expect(response.json().spaces[0].channels[0]).toEqual(
      expect.objectContaining({
        latestSequence: expect.any(Number),
        lastReadSequence: expect.any(Number),
        unreadCount: expect.any(Number),
      }),
    );
  });

  it('creates an idempotent message and exposes its event through sync', async () => {
    const payload = {
      clientId: '77777777-7777-4777-8777-777777777777',
      blocks: [{ type: 'text', text: 'Transactional outbox is ready for review.' }],
    };
    const first = await app.inject({
      method: 'POST',
      url: `/v1/channels/${DEMO_IDS.channelBackend}/messages`,
      headers: { 'idempotency-key': 'e2e-message-1' },
      payload,
    });
    const second = await app.inject({
      method: 'POST',
      url: `/v1/channels/${DEMO_IDS.channelBackend}/messages`,
      headers: { 'idempotency-key': 'e2e-message-1' },
      payload,
    });
    expect(first.statusCode).toBe(201);
    expect(second.json().id).toBe(first.json().id);

    const mismatch = await app.inject({
      method: 'POST',
      url: `/v1/channels/${DEMO_IDS.channelBackend}/messages`,
      headers: { 'idempotency-key': 'e2e-message-1' },
      payload: { ...payload, blocks: [{ type: 'text', text: 'A different request.' }] },
    });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    const sync = await app.inject({ method: 'GET', url: '/v1/sync' });
    expect(sync.json().items).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'message.created' })]),
    );
  });

  it('promotes a message to an incident', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages/55555555-5555-4555-8555-555555555555/work-items',
      payload: {
        type: 'incident',
        title: 'Investigate p95 latency',
        severity: 'sev2',
        externalReferences: [],
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ type: 'incident', severity: 'sev2', status: 'open' });
  });

  it('edits a message idempotently and rejects stale revisions', async () => {
    const created = await sendMessage('Original content');
    expect(created.statusCode).toBe(201);
    const message = created.json();
    const payload = { blocks: [{ type: 'text', text: 'Edited content' }], expectedRevision: 1 };
    const first = await app.inject({
      method: 'PATCH',
      url: `/v1/messages/${message.id}`,
      headers: { 'idempotency-key': 'edit-message-1' },
      payload,
    });
    const replay = await app.inject({
      method: 'PATCH',
      url: `/v1/messages/${message.id}`,
      headers: { 'idempotency-key': 'edit-message-1' },
      payload,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      id: message.id,
      blocks: payload.blocks,
      revision: 2,
      editedAt: expect.any(String),
    });
    expect(replay.json()).toEqual(first.json());

    const keyMismatch = await app.inject({
      method: 'PATCH',
      url: `/v1/messages/${message.id}`,
      headers: { 'idempotency-key': 'edit-message-1' },
      payload: { blocks: [{ type: 'text', text: 'Different content' }], expectedRevision: 1 },
    });
    expect(keyMismatch.statusCode).toBe(409);
    expect(keyMismatch.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    const stale = await app.inject({
      method: 'PATCH',
      url: `/v1/messages/${message.id}`,
      headers: { 'idempotency-key': 'edit-message-stale' },
      payload,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('MESSAGE_REVISION_CONFLICT');

    const sync = await app.inject({ method: 'GET', url: '/v1/sync' });
    const updates = sync
      .json()
      .items.filter(
        (event: any) => event.type === 'message.updated' && event.payload.message.id === message.id,
      );
    expect(updates).toHaveLength(1);
    expect(updates[0].payload.message.revision).toBe(2);
    const creation = sync
      .json()
      .items.find(
        (event: any) => event.type === 'message.created' && event.payload.message.id === message.id,
      );
    expect(creation.payload.message).toMatchObject({
      revision: 1,
      blocks: [{ text: 'Original content' }],
    });
  });

  it('allows only the author to edit a message', async () => {
    const created = await sendMessage('Author-only edit');
    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/messages/${created.json().id}`,
      headers: {
        'idempotency-key': 'foreign-edit-1',
        'x-user-id': DEMO_IDS.userTwo,
      },
      payload: { blocks: [{ type: 'text', text: 'Unauthorized edit' }], expectedRevision: 1 },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('MESSAGE_EDIT_FORBIDDEN');
  });

  it('soft-deletes a message idempotently and rejects further interactions', async () => {
    const created = await sendMessage('Delete me');
    const messageId = created.json().id;
    await app.inject({
      method: 'PUT',
      url: `/v1/messages/${messageId}/reactions`,
      payload: { emoji: '🔥' },
    });
    const payload = { expectedRevision: 1 };
    const first = await app.inject({
      method: 'DELETE',
      url: `/v1/messages/${messageId}`,
      headers: { 'idempotency-key': 'delete-message-1' },
      payload,
    });
    const replay = await app.inject({
      method: 'DELETE',
      url: `/v1/messages/${messageId}`,
      headers: { 'idempotency-key': 'delete-message-1' },
      payload,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      id: messageId,
      blocks: [],
      reactions: {},
      revision: 2,
      deletedAt: expect.any(String),
    });
    expect(replay.json()).toEqual(first.json());

    const secondDelete = await app.inject({
      method: 'DELETE',
      url: `/v1/messages/${messageId}`,
      headers: { 'idempotency-key': 'delete-message-2' },
      payload: { expectedRevision: 2 },
    });
    expect(secondDelete.statusCode).toBe(409);
    expect(secondDelete.json().error.code).toBe('MESSAGE_DELETED');

    const reaction = await app.inject({
      method: 'PUT',
      url: `/v1/messages/${messageId}/reactions`,
      payload: { emoji: '👀' },
    });
    expect(reaction.statusCode).toBe(409);
    expect(reaction.json().error.code).toBe('MESSAGE_DELETED');

    const sync = await app.inject({ method: 'GET', url: '/v1/sync' });
    const deletions = sync
      .json()
      .items.filter(
        (event: any) => event.type === 'message.deleted' && event.payload.message.id === messageId,
      );
    expect(deletions).toHaveLength(1);
    expect(deletions[0].payload.message.blocks).toEqual([]);
  });

  it('redacts deleted content from historical events and idempotency replays', async () => {
    const createKey = `history-create-${randomUUID()}`;
    const createPayload = {
      clientId: randomUUID(),
      blocks: [{ type: 'text', text: 'Content that must be redacted' }],
    };
    const created = await app.inject({
      method: 'POST',
      url: `/v1/channels/${DEMO_IDS.channelBackend}/messages`,
      headers: { 'idempotency-key': createKey },
      payload: createPayload,
    });
    const messageId = created.json().id;
    await sendMessage('Reply with a root snapshot', { threadRootId: messageId });

    const updateKey = `history-update-${randomUUID()}`;
    const updatePayload = {
      expectedRevision: 1,
      blocks: [{ type: 'text', text: 'Edited content that must also be redacted' }],
    };
    await app.inject({
      method: 'PATCH',
      url: `/v1/messages/${messageId}`,
      headers: { 'idempotency-key': updateKey },
      payload: updatePayload,
    });
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/messages/${messageId}`,
      headers: { 'idempotency-key': `history-delete-${randomUUID()}` },
      payload: { expectedRevision: 2 },
    });
    expect(deleted.statusCode).toBe(200);

    const sync = await app.inject({ method: 'GET', url: '/v1/sync?limit=500' });
    const snapshots = sync
      .json()
      .items.flatMap((event: any) => [event.payload.message, event.payload.threadRoot])
      .filter((snapshot: any) => snapshot?.id === messageId);
    expect(snapshots.length).toBeGreaterThanOrEqual(4);
    for (const snapshot of snapshots) {
      expect(snapshot.blocks).toEqual([]);
      expect(snapshot.deletedAt).toEqual(expect.any(String));
    }

    const createReplay = await app.inject({
      method: 'POST',
      url: `/v1/channels/${DEMO_IDS.channelBackend}/messages`,
      headers: { 'idempotency-key': createKey },
      payload: createPayload,
    });
    const updateReplay = await app.inject({
      method: 'PATCH',
      url: `/v1/messages/${messageId}`,
      headers: { 'idempotency-key': updateKey },
      payload: updatePayload,
    });
    for (const replay of [createReplay, updateReplay]) {
      expect(replay.json()).toMatchObject({
        id: messageId,
        blocks: [],
        deletedAt: expect.any(String),
      });
    }
  });

  it('allows an owner to delete another author message but rejects an ordinary member', async () => {
    const marinaMessage = await sendMessage('Owner may moderate this', {
      userId: DEMO_IDS.userTwo,
    });
    const moderated = await app.inject({
      method: 'DELETE',
      url: `/v1/messages/${marinaMessage.json().id}`,
      headers: { 'idempotency-key': 'owner-delete-1' },
      payload: { expectedRevision: 1 },
    });
    expect(moderated.statusCode).toBe(200);

    const ownerMessage = await sendMessage('Member may not moderate this');
    const forbidden = await app.inject({
      method: 'DELETE',
      url: `/v1/messages/${ownerMessage.json().id}`,
      headers: {
        'idempotency-key': 'member-delete-1',
        'x-user-id': DEMO_IDS.userTwo,
      },
      payload: { expectedRevision: 1 },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error.code).toBe('MESSAGE_DELETE_FORBIDDEN');
  });

  it('adds and removes reactions idempotently without changing content revision', async () => {
    const created = await sendMessage('React to me');
    const messageId = created.json().id;
    const add = await app.inject({
      method: 'PUT',
      url: `/v1/messages/${messageId}/reactions`,
      payload: { emoji: '  👍  ' },
    });
    const repeatedAdd = await app.inject({
      method: 'PUT',
      url: `/v1/messages/${messageId}/reactions`,
      payload: { emoji: '👍' },
    });
    const secondUser = await app.inject({
      method: 'PUT',
      url: `/v1/messages/${messageId}/reactions`,
      headers: { 'x-user-id': DEMO_IDS.userTwo },
      payload: { emoji: '👍' },
    });
    const remove = await app.inject({
      method: 'DELETE',
      url: `/v1/messages/${messageId}/reactions`,
      payload: { emoji: '👍' },
    });
    const repeatedRemove = await app.inject({
      method: 'DELETE',
      url: `/v1/messages/${messageId}/reactions`,
      payload: { emoji: '👍' },
    });
    expect(add.json()).toMatchObject({ revision: 1, reactions: { '👍': [DEMO_IDS.user] } });
    expect(repeatedAdd.json()).toEqual(add.json());
    expect(secondUser.json().reactions['👍']).toEqual([DEMO_IDS.user, DEMO_IDS.userTwo]);
    expect(remove.json().reactions['👍']).toEqual([DEMO_IDS.userTwo]);
    expect(repeatedRemove.json()).toEqual(remove.json());

    const sync = await app.inject({ method: 'GET', url: '/v1/sync' });
    const events = sync
      .json()
      .items.filter(
        (event: any) =>
          ['reaction.added', 'reaction.removed'].includes(event.type) &&
          event.payload.message.id === messageId,
      );
    expect(events.map((event: any) => event.type)).toEqual([
      'reaction.added',
      'reaction.added',
      'reaction.removed',
    ]);
  });

  it('keeps replies out of the channel timeline and returns an absolute thread root', async () => {
    const root = await sendMessage('Thread root');
    const rootId = root.json().id;
    const firstReply = await sendMessage('First reply', { threadRootId: rootId });
    const secondReply = await sendMessage('Second reply', { threadRootId: rootId });
    expect(firstReply.statusCode).toBe(201);
    expect(secondReply.statusCode).toBe(201);

    const timeline = await app.inject({
      method: 'GET',
      url: `/v1/channels/${DEMO_IDS.channelBackend}/messages?limit=100`,
    });
    expect(timeline.json().items.some((item: any) => item.id === rootId)).toBe(true);
    expect(timeline.json().items.some((item: any) => item.id === firstReply.json().id)).toBe(false);

    const firstPage = await app.inject({
      method: 'GET',
      url: `/v1/messages/${rootId}/thread?limit=1`,
    });
    expect(firstPage.statusCode).toBe(200);
    expect(firstPage.json().root).toMatchObject({ id: rootId, replyCount: 2 });
    expect(firstPage.json().replies.map((reply: any) => reply.id)).toEqual([firstReply.json().id]);
    const secondPage = await app.inject({
      method: 'GET',
      url: `/v1/messages/${rootId}/thread?limit=1&cursor=${encodeURIComponent(firstPage.json().nextCursor)}`,
    });
    expect(secondPage.json().replies.map((reply: any) => reply.id)).toEqual([
      secondReply.json().id,
    ]);

    const nested = await sendMessage('Nested replies are invalid', {
      threadRootId: firstReply.json().id,
    });
    expect(nested.statusCode).toBe(400);
    expect(nested.json().error.code).toBe('INVALID_THREAD_ROOT');
    const crossChannel = await sendMessage('Cross-channel reply', {
      channelId: DEMO_IDS.channelGeneral,
      threadRootId: rootId,
    });
    expect(crossChannel.statusCode).toBe(400);

    const sync = await app.inject({ method: 'GET', url: '/v1/sync' });
    const replyEvents = sync
      .json()
      .items.filter(
        (event: any) =>
          event.type === 'message.created' &&
          [firstReply.json().id, secondReply.json().id].includes(event.payload.message.id),
      );
    expect(replyEvents[0].payload.threadRoot).toMatchObject({ id: rootId, replyCount: 1 });
    expect(replyEvents[1].payload.threadRoot).toMatchObject({ id: rootId, replyCount: 2 });
  });

  it('starts channel history from the newest roots and paginates backwards', async () => {
    const oldestRoot = await sendMessage('Backward page: oldest root');
    const secondOldestRoot = await sendMessage('Backward page: second oldest root');
    const reply = await sendMessage('Backward page: reply between roots', {
      threadRootId: secondOldestRoot.json().id,
    });
    const recentRoot = await sendMessage('Backward page: recent root');
    const newestRoot = await sendMessage('Backward page: newest root');
    const newUserHeaders = { 'x-user-id': DEMO_IDS.userRestricted };

    const firstPage = await app.inject({
      method: 'GET',
      url: `/v1/channels/${DEMO_IDS.channelBackend}/messages?limit=2`,
      headers: newUserHeaders,
    });
    expect(firstPage.statusCode).toBe(200);
    expect(firstPage.json().items.map((message: any) => message.id)).toEqual([
      recentRoot.json().id,
      newestRoot.json().id,
    ]);
    expect(firstPage.json().nextCursor).toEqual(expect.any(String));

    const arrivedAfterFirstPage = await sendMessage('Backward page: arrived after cursor');
    const secondPage = await app.inject({
      method: 'GET',
      url: `/v1/channels/${DEMO_IDS.channelBackend}/messages?limit=2&cursor=${encodeURIComponent(firstPage.json().nextCursor)}`,
      headers: newUserHeaders,
    });
    expect(secondPage.statusCode).toBe(200);
    expect(secondPage.json().items.map((message: any) => message.id)).toEqual([
      oldestRoot.json().id,
      secondOldestRoot.json().id,
    ]);
    expect(secondPage.json().items.map((message: any) => message.id)).not.toContain(
      reply.json().id,
    );
    expect(secondPage.json().items.map((message: any) => message.id)).not.toContain(
      arrivedAfterFirstPage.json().id,
    );
  });

  it('does not allow replies to a deleted root', async () => {
    const root = await sendMessage('Closing thread');
    await app.inject({
      method: 'DELETE',
      url: `/v1/messages/${root.json().id}`,
      headers: { 'idempotency-key': 'delete-thread-root' },
      payload: { expectedRevision: 1 },
    });
    const reply = await sendMessage('Too late', { threadRootId: root.json().id });
    expect(reply.statusCode).toBe(400);
    expect(reply.json().error.code).toBe('INVALID_THREAD_ROOT');
  });

  it('advances read state monotonically and excludes own messages from unread count', async () => {
    await sendMessage('Unread one', {
      channelId: DEMO_IDS.channelGeneral,
      userId: DEMO_IDS.userTwo,
    });
    await sendMessage('Unread two', {
      channelId: DEMO_IDS.channelGeneral,
      userId: DEMO_IDS.userTwo,
    });
    const before = await app.inject({ method: 'GET', url: '/v1/bootstrap' });
    const beforeChannel = before
      .json()
      .spaces[0].channels.find((channel: any) => channel.id === DEMO_IDS.channelGeneral);
    expect(beforeChannel).toMatchObject({ latestSequence: 2, lastReadSequence: 0, unreadCount: 2 });

    const first = await app.inject({
      method: 'PUT',
      url: `/v1/channels/${DEMO_IDS.channelGeneral}/read-state`,
      payload: { lastReadSequence: 1 },
    });
    expect(first.json()).toMatchObject({ lastReadSequence: 1, unreadCount: 1 });

    await sendMessage('My own message', { channelId: DEMO_IDS.channelGeneral });
    const afterOwnMessage = await app.inject({ method: 'GET', url: '/v1/bootstrap' });
    const afterOwnChannel = afterOwnMessage
      .json()
      .spaces[0].channels.find((channel: any) => channel.id === DEMO_IDS.channelGeneral);
    expect(afterOwnChannel).toMatchObject({
      latestSequence: 3,
      lastReadSequence: 1,
      unreadCount: 1,
    });

    const stale = await app.inject({
      method: 'PUT',
      url: `/v1/channels/${DEMO_IDS.channelGeneral}/read-state`,
      payload: { lastReadSequence: 0 },
    });
    expect(stale.json()).toMatchObject({ lastReadSequence: 1, unreadCount: 1 });
    const latest = await app.inject({
      method: 'PUT',
      url: `/v1/channels/${DEMO_IDS.channelGeneral}/read-state`,
      payload: { lastReadSequence: 3 },
    });
    expect(latest.json()).toMatchObject({ lastReadSequence: 3, unreadCount: 0 });
    const future = await app.inject({
      method: 'PUT',
      url: `/v1/channels/${DEMO_IDS.channelGeneral}/read-state`,
      payload: { lastReadSequence: 4 },
    });
    expect(future.statusCode).toBe(400);
    expect(future.json().error.code).toBe('READ_SEQUENCE_OUT_OF_RANGE');

    const ownSync = await app.inject({ method: 'GET', url: '/v1/sync' });
    expect(ownSync.json().items.filter((event: any) => event.type === 'channel.read')).toHaveLength(
      2,
    );
    const otherSync = await app.inject({
      method: 'GET',
      url: '/v1/sync',
      headers: { 'x-user-id': DEMO_IDS.userTwo },
    });
    expect(
      otherSync.json().items.filter((event: any) => event.type === 'channel.read'),
    ).toHaveLength(0);
  });

  it('rejects promotion of a deleted message', async () => {
    const created = await sendMessage('Do not promote after deletion');
    await app.inject({
      method: 'DELETE',
      url: `/v1/messages/${created.json().id}`,
      headers: { 'idempotency-key': 'delete-before-promote' },
      payload: { expectedRevision: 1 },
    });
    const response = await app.inject({
      method: 'POST',
      url: `/v1/messages/${created.json().id}/work-items`,
      payload: { type: 'action', title: 'Should fail', externalReferences: [] },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('MESSAGE_DELETED');
  });

  it('validates a work item owner against organization membership', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages/55555555-5555-4555-8555-555555555555/work-items',
      payload: {
        type: 'action',
        title: 'Invalid owner',
        ownerId: '99999999-9999-4999-8999-999999999998',
        externalReferences: [],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_WORK_ITEM_OWNER');
  });

  it('masks private message resources and events from non-channel members', async () => {
    const privateMessage = await sendMessage('Private incident details', {
      channelId: DEMO_IDS.channelIncident,
    });
    expect(privateMessage.statusCode).toBe(201);
    const restrictedHeaders = { 'x-user-id': DEMO_IDS.userRestricted };

    const thread = await app.inject({
      method: 'GET',
      url: `/v1/messages/${privateMessage.json().id}/thread`,
      headers: restrictedHeaders,
    });
    const reaction = await app.inject({
      method: 'PUT',
      url: `/v1/messages/${privateMessage.json().id}/reactions`,
      headers: restrictedHeaders,
      payload: { emoji: '👀' },
    });
    const promotion = await app.inject({
      method: 'POST',
      url: `/v1/messages/${privateMessage.json().id}/work-items`,
      headers: restrictedHeaders,
      payload: { type: 'incident', title: 'Hidden incident', externalReferences: [] },
    });
    for (const response of [thread, reaction, promotion]) {
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('MESSAGE_NOT_FOUND');
    }

    const sync = await app.inject({
      method: 'GET',
      url: '/v1/sync',
      headers: restrictedHeaders,
    });
    expect(sync.statusCode).toBe(200);
    expect(
      sync
        .json()
        .items.some((event: any) => event.payload.message?.id === privateMessage.json().id),
    ).toBe(false);
  });

  it('validates identifiers, limits, mutation inputs, and idempotency headers', async () => {
    const invalidId = await app.inject({ method: 'GET', url: '/v1/channels/not-a-uuid/messages' });
    expect(invalidId.statusCode).toBe(400);
    expect(invalidId.json().error.code).toBe('VALIDATION_ERROR');
    const invalidLimit = await app.inject({
      method: 'GET',
      url: `/v1/channels/${DEMO_IDS.channelBackend}/messages?limit=nope`,
    });
    expect(invalidLimit.statusCode).toBe(400);

    const created = await sendMessage('Validate mutations');
    const missingKey = await app.inject({
      method: 'PATCH',
      url: `/v1/messages/${created.json().id}`,
      payload: { blocks: [{ type: 'text', text: 'No key' }], expectedRevision: 1 },
    });
    expect(missingKey.statusCode).toBe(400);
    expect(missingKey.json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const blankReaction = await app.inject({
      method: 'PUT',
      url: `/v1/messages/${created.json().id}/reactions`,
      payload: { emoji: '   ' },
    });
    expect(blankReaction.statusCode).toBe(400);
    expect(blankReaction.json().error.code).toBe('VALIDATION_ERROR');

    const oversizedBlocks = [
      ...Array.from({ length: 5 }, () => ({ type: 'code', code: 'x'.repeat(50_000) })),
      { type: 'code', code: 'x'.repeat(10_000) },
    ];
    const oversizedMessage = await app.inject({
      method: 'POST',
      url: `/v1/channels/${DEMO_IDS.channelBackend}/messages`,
      headers: { 'idempotency-key': randomUUID() },
      payload: { clientId: randomUUID(), blocks: oversizedBlocks },
    });
    expect(oversizedMessage.statusCode).toBe(400);
    expect(oversizedMessage.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('tracks unpublished memory events per tenant and marks them exactly once', async () => {
    const store = new MemoryStore();
    const owner: AppContext = {
      tenantId: DEMO_IDS.tenant,
      userId: DEMO_IDS.user,
      roles: ['owner'],
      requestId: 'memory-outbox-test',
    };
    const created = await store.createMessage(owner, DEMO_IDS.channelBackend, randomUUID(), {
      clientId: randomUUID(),
      blocks: [{ type: 'text', text: 'Pending outbox event' }],
    });
    const next = await store.createMessage(owner, DEMO_IDS.channelBackend, randomUUID(), {
      clientId: randomUUID(),
      blocks: [{ type: 'text', text: 'Event after quarantine' }],
    });

    expect(created.event.channelId).toBe(DEMO_IDS.channelBackend);
    expect(await store.recoverUnpublishedEvents(10, randomUUID())).toEqual([]);
    expect(
      (await store.recoverUnpublishedEvents(10, DEMO_IDS.tenant)).map((event) => event.id),
    ).toEqual([created.event.id, next.event.id]);
    await expect(store.markEventPublished(randomUUID(), created.event.id)).rejects.toMatchObject({
      status: 403,
    });
    await store.quarantineEvent(DEMO_IDS.tenant, created.event.id, 'legacy oversized event');
    expect((await store.sync(owner, 0, 10)).items.map((event) => event.id)).toContain(
      created.event.id,
    );
    expect(
      (await store.recoverUnpublishedEvents(10, DEMO_IDS.tenant)).map((event) => event.id),
    ).toEqual([next.event.id]);
    await store.markEventPublished(DEMO_IDS.tenant, next.event.id);
    await store.markEventPublished(DEMO_IDS.tenant, next.event.id);
    expect(await store.recoverUnpublishedEvents(10, DEMO_IDS.tenant)).toEqual([]);
  });

  it('caps memory reaction memberships while preserving duplicate and remove semantics', async () => {
    const store = new MemoryStore();
    const owner: AppContext = {
      tenantId: DEMO_IDS.tenant,
      userId: DEMO_IDS.user,
      roles: ['owner'],
      requestId: 'memory-reaction-cap-test',
    };
    const created = await store.createMessage(owner, DEMO_IDS.channelBackend, randomUUID(), {
      clientId: randomUUID(),
      blocks: [{ type: 'text', text: 'Bound reactions' }],
    });
    for (let index = 0; index < MAX_MESSAGE_REACTION_MEMBERSHIPS; index += 1) {
      await store.setReaction(owner, created.message.id, { emoji: `cap-${index}` }, true);
    }

    const duplicate = await store.setReaction(owner, created.message.id, { emoji: 'cap-0' }, true);
    expect(duplicate.event).toBeNull();
    await expect(
      store.setReaction(owner, created.message.id, { emoji: 'overflow' }, true),
    ).rejects.toMatchObject({
      status: 400,
      response: expect.objectContaining({ code: 'REACTION_LIMIT_REACHED' }),
    });
    const removed = await store.setReaction(owner, created.message.id, { emoji: 'cap-0' }, false);
    expect(removed.event?.type).toBe('reaction.removed');
    const replacement = await store.setReaction(
      owner,
      created.message.id,
      { emoji: 'overflow' },
      true,
    );
    expect(replacement.event?.type).toBe('reaction.added');
  });

  it('rejects oversized memory events without partially mutating messages or channel state', async () => {
    const store = new MemoryStore();
    const owner: AppContext = {
      tenantId: DEMO_IDS.tenant,
      userId: DEMO_IDS.user,
      roles: ['owner'],
      requestId: 'memory-event-size-test',
    };
    const target = await store.createMessage(owner, DEMO_IDS.channelBackend, randomUUID(), {
      clientId: randomUUID(),
      blocks: [{ type: 'text', text: 'Must stay unchanged' }],
    });
    const beforeChannel = (await store.bootstrap(owner)).spaces
      .flatMap((space) => space.channels)
      .find((channel) => channel.id === DEMO_IDS.channelBackend)!;
    const beforeMessages = await store.listMessages(owner, DEMO_IDS.channelBackend, null, 500);
    const beforeEvents = await store.recoverUnpublishedEvents(500, DEMO_IDS.tenant);
    const memberships = (
      store as unknown as {
        memberships: Map<string, 'owner' | 'admin' | 'member'>;
      }
    ).memberships;
    const oversizedAudienceEntries = Math.ceil(MAX_DOMAIN_EVENT_JSON_BYTES / 39) + 500;
    for (let index = 0; index < oversizedAudienceEntries; index += 1) {
      memberships.set(`00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`, 'member');
    }

    await expect(
      store.createMessage(owner, DEMO_IDS.channelBackend, randomUUID(), {
        clientId: randomUUID(),
        blocks: [{ type: 'text', text: 'Must not be committed' }],
      }),
    ).rejects.toMatchObject({
      status: 413,
      response: expect.objectContaining({ code: 'EVENT_TOO_LARGE' }),
    });
    await expect(
      store.updateMessage(owner, target.message.id, randomUUID(), {
        expectedRevision: 1,
        blocks: [{ type: 'text', text: 'Must not replace the original' }],
      }),
    ).rejects.toMatchObject({ status: 413 });
    await expect(
      store.setReaction(owner, target.message.id, { emoji: 'oversized' }, true),
    ).rejects.toMatchObject({ status: 413 });

    const afterChannel = (await store.bootstrap(owner)).spaces
      .flatMap((space) => space.channels)
      .find((channel) => channel.id === DEMO_IDS.channelBackend)!;
    const afterMessages = await store.listMessages(owner, DEMO_IDS.channelBackend, null, 500);
    const afterTarget = afterMessages.items.find((message) => message.id === target.message.id)!;
    expect(afterChannel.latestSequence).toBe(beforeChannel.latestSequence);
    expect(afterMessages.items).toHaveLength(beforeMessages.items.length);
    expect(afterTarget).toMatchObject({
      revision: 1,
      blocks: [{ type: 'text', text: 'Must stay unchanged' }],
      reactions: {},
    });
    expect(await store.recoverUnpublishedEvents(500, DEMO_IDS.tenant)).toEqual(beforeEvents);
  });

  it('rejects sync for a user without organization membership', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/sync',
      headers: { 'x-user-id': '99999999-9999-4999-8999-999999999998' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('rejects a request from another tenant with the standard error envelope', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/bootstrap',
      headers: { 'x-tenant-id': '99999999-9999-4999-8999-999999999999' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: { code: 'REQUEST_FAILED', message: 'Organization access denied' },
    });
    expect(response.json().error.requestId).toEqual(expect.any(String));
  });
});
