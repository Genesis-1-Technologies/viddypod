import { describe, test, expect, vi, beforeAll, afterAll } from 'vitest';
import { createServer } from '../src/index.js';
import type { FastifyInstance } from 'fastify';
import { createTestToken } from './setup.js';

// Mock the DB and queue so we don't need real infrastructure
vi.mock('../src/db/client.js', () => {
  function createChainableMock() {
    const chain: any = {};
    const methods = ['select', 'insert', 'update', 'delete', 'from', 'where', 'limit',
      'set', 'values', 'returning', 'orderBy', 'innerJoin', 'leftJoin'];
    for (const method of methods) {
      chain[method] = vi.fn().mockReturnValue(chain);
    }
    chain.limit = vi.fn().mockResolvedValue([]);
    chain.returning = vi.fn().mockResolvedValue([]);
    return chain;
  }

  const mockDb = createChainableMock();
  return { getDb: vi.fn(() => mockDb) };
});

vi.mock('../src/processing/jobs.js', () => ({
  PROCESSING_QUEUE: 'test-queue',
  getProcessingQueue: vi.fn(),
  enqueueProcessingJob: vi.fn().mockResolvedValue({ id: 'test-job-id' }),
  processAsset: vi.fn(),
}));

vi.mock('../src/shared/logger.js', () => ({
  logger: { child: vi.fn().mockReturnValue({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }) },
  createChildLogger: vi.fn(() => ({
    info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(),
    child: vi.fn().mockReturnValue({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
  })),
}));

let app: FastifyInstance;
let stopScheduler: () => void;
let token: string;

const ASSET_ID = '11111111-1111-1111-1111-111111111111';
const url = `/api/v1/agent/failed/${ASSET_ID}`;

beforeAll(async () => {
  token = await createTestToken('test-user-id', 'editor');
  const server = await createServer();
  app = server.app;
  stopScheduler = server.stopScheduler;
  await app.ready();
});

afterAll(async () => {
  stopScheduler();
  await app.close();
});

describe('POST /api/v1/agent/failed/:assetId', () => {
  test('rejects request without auth', async () => {
    const res = await app.inject({ method: 'POST', url, payload: { error: 'nope' } });
    expect(res.statusCode).toBe(401);
  });

  test('marks a pending asset failed so it stops being polled forever', async () => {
    const { getDb } = await import('../src/db/client.js');
    const mockDb = (getDb as any)();
    // The scoped UPDATE matched a row -> asset belonged to caller and was pending
    mockDb.returning.mockResolvedValueOnce([{ id: ASSET_ID }]);

    const res = await app.inject({
      method: 'POST',
      url,
      headers: { authorization: `Bearer ${token}` },
      payload: { error: 'Private video' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, status: 'failed' });
    // Must write the terminal state, or the agent loops on this asset forever
    expect(mockDb.set).toHaveBeenCalledWith(
      expect.objectContaining({ processingStatus: 'failed', processingStage: 'failed' }),
    );
  });

  test('404s when the scoped update matches nothing (other user, or not pending)', async () => {
    const { getDb } = await import('../src/db/client.js');
    const mockDb = (getDb as any)();
    mockDb.returning.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url,
      headers: { authorization: `Bearer ${token}` },
      payload: { error: 'boom' },
    });

    expect(res.statusCode).toBe(404);
  });

  test('accepts a missing body — error detail is optional', async () => {
    const { getDb } = await import('../src/db/client.js');
    const mockDb = (getDb as any)();
    mockDb.returning.mockResolvedValueOnce([{ id: ASSET_ID }]);

    const res = await app.inject({
      method: 'POST',
      url,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
  });

  test('rejects a non-UUID assetId with 400 rather than a Postgres 500', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/agent/failed/not-a-uuid',
      headers: { authorization: `Bearer ${token}` },
      payload: { error: 'boom' },
    });

    expect(res.statusCode).toBe(400);
  });

  test('rejects an oversized error string rather than logging it', async () => {
    const res = await app.inject({
      method: 'POST',
      url,
      headers: { authorization: `Bearer ${token}` },
      payload: { error: 'x'.repeat(501) },
    });

    expect(res.statusCode).toBe(400);
  });
});
