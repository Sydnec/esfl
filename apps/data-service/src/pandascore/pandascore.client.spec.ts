import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { PandascoreClient } from './pandascore.client';

function makeClient(): PandascoreClient {
  const config = {
    get: () => 'token',
    getOrThrow: () => 'token',
  } as unknown as ConfigService;
  return new PandascoreClient(config);
}

describe('PandascoreClient — throttle', () => {
  let callTimes: number[];

  beforeEach(() => {
    vi.useFakeTimers();
    callTimes = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        callTimes.push(Date.now());
        return new Response('[]', { status: 200 });
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('espace les requêtes d’au moins 4 secondes', async () => {
    const client = makeClient();
    const all = Promise.all([client.get('/a'), client.get('/b'), client.get('/c')]);
    await vi.advanceTimersByTimeAsync(15_000);
    await all;
    expect(callTimes).toHaveLength(3);
    expect(callTimes[1] - callTimes[0]).toBeGreaterThanOrEqual(4_000);
    expect(callTimes[2] - callTimes[1]).toBeGreaterThanOrEqual(4_000);
  });

  it('continue la file après une erreur', async () => {
    const client = makeClient();
    (fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      callTimes.push(Date.now());
      return new Response('boom', { status: 500 });
    });
    const first = client.get('/fail');
    const second = client.get('/ok');
    const all = Promise.allSettled([first, second]);
    await vi.advanceTimersByTimeAsync(15_000);
    const [a, b] = await all;
    expect(a.status).toBe('rejected');
    expect(b.status).toBe('fulfilled');
  });

  it('compte les requêtes de la dernière heure glissante', async () => {
    const client = makeClient();
    const all = Promise.all([client.get('/a'), client.get('/b')]);
    await vi.advanceTimersByTimeAsync(10_000);
    await all;
    expect(client.requestsLastHour).toBe(2);
    await vi.advanceTimersByTimeAsync(3_600_001);
    expect(client.requestsLastHour).toBe(0);
  });
});
