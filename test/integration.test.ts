import express5, { type Express, type Response } from 'express';
import express4 from 'express4';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { easse, RESET_EVENT } from '../src/index.js';

interface Client {
  status: number;
  contentType: string | undefined;
  raw: () => string;
  dataLines: () => string[];
  lastId: () => string | undefined;
  close: () => void;
}

describe.each([
  ['Express 5', express5],
  ['Express 4', express4],
])('%s', (_name, express) => {
  const servers: http.Server[] = [];

  afterEach(() => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      server.close();
    }
  });

  async function listen(app: Express): Promise<number> {
    const server = http.createServer(app);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    return (server.address() as AddressInfo).port;
  }

  function connect(
    port: number,
    path = '/events',
    { lastEventId, method = 'GET' }: { lastEventId?: string; method?: string } = {},
  ): Promise<Client> {
    return new Promise((resolve, reject) => {
      const headers = lastEventId ? { 'last-event-id': lastEventId } : undefined;
      const req = http.request({ port, path, method, headers }, (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (raw += chunk));
        res.on('error', () => {});
        resolve({
          status: res.statusCode ?? 0,
          contentType: res.headers['content-type'],
          raw: () => raw,
          dataLines: () => [...raw.matchAll(/^data: (.*)$/gm)].map((m) => m[1]),
          lastId: () => [...raw.matchAll(/^id: (.*)$/gm)].at(-1)?.[1],
          close: () => req.destroy(),
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  /** Connects, receives one broadcast and disconnects, returning its ID. */
  async function connectAndDrop(port: number, broadcast: (data: string) => void): Promise<string> {
    const client = await connect(port);
    broadcast('anchor');
    await vi.waitFor(() => expect(client.lastId()).toBeDefined());
    const id = client.lastId() as string;
    client.close();
    await sleep(20);
    return id;
  }

  describe('connection', () => {
    it('opens the stream with the SSE headers', async () => {
      const app = express();
      app.get('/events', easse());
      const port = await listen(app);

      const client = await connect(port);

      expect(client.status).toBe(200);
      expect(client.contentType).toBe('text/event-stream');
    });

    it('keeps the connection open with no handler after the middleware', async () => {
      const app = express();
      const sse = easse();
      app.get('/events', sse);
      const port = await listen(app);

      const client = await connect(port);
      await sleep(30);
      sse.broadcast('still-open');

      await vi.waitFor(() => expect(client.dataLines()).toEqual(['still-open']));
    });

    it('ends HEAD requests instead of holding them open', async () => {
      const app = express();
      app.get('/events', easse());
      const port = await listen(app);

      const client = await connect(port, '/events', { method: 'HEAD' });

      expect(client.status).toBe(200);
      expect(client.contentType).toContain('text/event-stream');
    });

    it('supports routes using other methods', async () => {
      const app = express();
      app.post('/stream', easse(), (_req, res) => res.sse.send('from-post'));
      const port = await listen(app);

      const client = await connect(port, '/stream', { method: 'POST' });

      await vi.waitFor(() => expect(client.dataLines()).toEqual(['from-post']));
    });

    it('fails with a clear error when mounted with app.use', async () => {
      const app = express();
      app.use(easse());
      app.use(
        (err: Error, _req: unknown, res: Response, _next: unknown) =>
          void res.status(500).json({ error: err.message }),
      );
      const port = await listen(app);

      const client = await connect(port, '/anything');
      await vi.waitFor(() => expect(client.raw()).toContain('mount the middleware on a route'));

      expect(client.status).toBe(500);
    });

    it('leaves other routes untouched', async () => {
      const app = express();
      app.get('/events', easse());
      app.get('/health', (_req, res) => void res.json({ ok: true }));
      const port = await listen(app);

      const client = await connect(port, '/health');

      expect(client.contentType).toContain('application/json');
      await vi.waitFor(() => expect(client.raw()).toBe('{"ok":true}'));
    });

    it('stops delivering to disconnected clients without crashing', async () => {
      const app = express();
      const sse = easse();
      let closed = false;
      app.get('/events', sse, (_req, res) => void res.on('close', () => (closed = true)));
      const port = await listen(app);

      const client = await connect(port);
      client.close();
      await vi.waitFor(() => expect(closed).toBe(true));

      expect(() => sse.broadcast('after')).not.toThrow();
    });
  });

  describe('send', () => {
    it('reaches only its own connection', async () => {
      const app = express();
      const sse = easse();
      app.get('/events', sse, (req, res) => {
        if (req.query.user === 'alice') res.sse.send('for-alice');
      });
      const port = await listen(app);

      const alice = await connect(port, '/events?user=alice');
      const bob = await connect(port, '/events?user=bob');
      await vi.waitFor(() => expect(alice.dataLines()).toEqual(['for-alice']));

      expect(bob.dataLines()).toEqual([]);
    });

    it('is never replayed to another client', async () => {
      const app = express();
      const sse = easse();
      app.get('/events', sse, (req, res) => {
        if (req.query.user === 'alice') res.sse.send({ secret: 'alice-token' }, 'private');
      });
      const port = await listen(app);

      const anchor = await connectAndDrop(port, sse.broadcast);
      const alice = await connect(port, '/events?user=alice');
      await vi.waitFor(() => expect(alice.raw()).toContain('alice-token'));

      const bob = await connect(port, '/events?user=bob', { lastEventId: anchor });
      await sleep(30);

      expect(bob.raw()).not.toContain('alice-token');
    });

    it('does not move the recovery position of the client', async () => {
      const app = express();
      const sse = easse();
      app.get('/events', sse, (_req, res) => res.sse.send('welcome'));
      const port = await listen(app);

      const client = await connect(port);
      await vi.waitFor(() => expect(client.dataLines()).toEqual(['welcome']));

      expect(client.lastId()).toBeUndefined();
    });
  });

  describe('broadcast', () => {
    it('sends the same event and ID to every client', async () => {
      const app = express();
      const sse = easse();
      app.get('/events', sse);
      const port = await listen(app);

      const a = await connect(port);
      const b = await connect(port);
      sse.broadcast({ price: 1 }, 'update');
      await vi.waitFor(() => expect(a.lastId()).toBeDefined());
      await vi.waitFor(() => expect(b.lastId()).toBeDefined());

      expect(a.raw()).toContain('event: update\n');
      expect(a.dataLines()).toEqual(['{"price":1}']);
      expect(b.dataLines()).toEqual(['{"price":1}']);
      expect(a.lastId()).toBe(b.lastId());
    });

    it('serializes the event once regardless of the number of clients', async () => {
      const app = express();
      const sse = easse();
      app.get('/events', sse);
      const port = await listen(app);

      const clients = await Promise.all(Array.from({ length: 5 }, () => connect(port)));
      await sleep(20);
      const toJSON = vi.fn(() => ({ x: 1 }));
      sse.broadcast({ toJSON });
      await vi.waitFor(() => {
        for (const client of clients) expect(client.dataLines()).toEqual(['{"x":1}']);
      });

      expect(toJSON).toHaveBeenCalledTimes(1);
    });
  });

  describe('recovery', () => {
    it('replays missed events in order and flags the stream as recovered', async () => {
      const app = express();
      const sse = easse();
      const recovered: boolean[] = [];
      app.get('/events', sse, (_req, res) => void recovered.push(res.sse.recovered));
      const port = await listen(app);

      const anchor = await connectAndDrop(port, sse.broadcast);
      sse.broadcast('one');
      sse.broadcast('two');
      const client = await connect(port, '/events', { lastEventId: anchor });

      await vi.waitFor(() => expect(client.dataLines()).toEqual(['one', 'two']));
      expect(recovered).toEqual([false, true]);
    });

    it('replays the events before anything sent by the route handler', async () => {
      const app = express();
      const sse = easse();
      app.get('/events', sse, (_req, res) => res.sse.send('from-handler'));
      const port = await listen(app);

      const anchor = await connectAndDrop(port, sse.broadcast);
      sse.broadcast('missed');
      const client = await connect(port, '/events', { lastEventId: anchor });

      await vi.waitFor(() => expect(client.dataLines()).toEqual(['missed', 'from-handler']));
    });

    it('recovers up to maxEvents - 1 missed events', async () => {
      const app = express();
      const sse = easse({ maxEvents: 3 });
      app.get('/events', sse);
      const port = await listen(app);

      const anchor = await connectAndDrop(port, sse.broadcast);
      sse.broadcast('one');
      sse.broadcast('two');
      const client = await connect(port, '/events', { lastEventId: anchor });

      await vi.waitFor(() => expect(client.dataLines()).toEqual(['one', 'two']));
    });

    it('sends a reset carrying the current ID when the gap cannot be recovered', async () => {
      const app = express();
      const sse = easse({ maxEvents: 3 });
      const recovered: boolean[] = [];
      app.get('/events', sse, (_req, res) => void recovered.push(res.sse.recovered));
      const port = await listen(app);

      const anchor = await connectAndDrop(port, sse.broadcast);
      for (const data of ['one', 'two', 'three']) sse.broadcast(data);
      const watcher = await connect(port);
      sse.broadcast('four');
      await vi.waitFor(() => expect(watcher.lastId()).toBeDefined());
      const client = await connect(port, '/events', { lastEventId: anchor });

      await vi.waitFor(() => expect(client.raw()).toContain(`event: ${RESET_EVENT}\n`));
      expect(client.lastId()).toBe(watcher.lastId());
      expect(client.dataLines()).toEqual(['{}']);
      expect(recovered.at(-1)).toBe(false);
    });

    it('does not reset a client that missed nothing after the last event expired', async () => {
      const app = express();
      const sse = easse({ retentionMs: 20 });
      const recovered: boolean[] = [];
      app.get('/events', sse, (_req, res) => void recovered.push(res.sse.recovered));
      const port = await listen(app);

      const anchor = await connectAndDrop(port, sse.broadcast);
      await sleep(40);
      const client = await connect(port, '/events', { lastEventId: anchor });
      await sleep(20);

      expect(client.raw()).not.toContain(RESET_EVENT);
      expect(recovered.at(-1)).toBe(true);
    });

    it('does not replay or reset a client connecting for the first time', async () => {
      const app = express();
      const sse = easse();
      app.get('/events', sse);
      const port = await listen(app);

      sse.broadcast('old');
      const client = await connect(port);
      await sleep(20);

      expect(client.raw()).toBe(': connected\n\n');
    });

    it('exposes the Last-Event-ID to the route handler', async () => {
      const app = express();
      let seen: string | undefined;
      app.get('/events', easse(), (_req, res) => void (seen = res.sse.lastEventId));
      const port = await listen(app);

      await connect(port, '/events', { lastEventId: 'my-own-id' });

      expect(seen).toBe('my-own-id');
    });
  });

  describe('connection health', () => {
    it('sends heartbeats while idle', async () => {
      const app = express();
      app.get('/events', easse({ heartbeatMs: 10 }));
      const port = await listen(app);

      const client = await connect(port);

      await vi.waitFor(() => expect(client.raw()).toContain(': heartbeat\n\n'));
    });

    it('can disable heartbeats', async () => {
      const app = express();
      app.get('/events', easse({ heartbeatMs: 0 }));
      const port = await listen(app);

      const client = await connect(port);
      await sleep(30);

      expect(client.raw()).toBe(': connected\n\n');
    });

    it('disconnects a client that stopped reading, sparing the others', async () => {
      const app = express();
      const sse = easse({ maxBufferedBytes: 1024, maxEvents: 1, heartbeatMs: 0 });
      const closes: string[] = [];
      app.get('/events', sse, (req, res) => {
        res.on('close', () => closes.push(String(req.query.name)));
      });
      const port = await listen(app);

      const stalled = net.connect(port);
      stalled.on('error', () => {});
      stalled.write('GET /events?name=stalled HTTP/1.1\r\nHost: test\r\n\r\n');
      stalled.pause();
      const healthy = await connect(port, '/events?name=healthy');
      await sleep(30);

      const chunk = 'x'.repeat(1024 * 1024);
      for (let i = 0; i < 64 && closes.length === 0; i++) {
        sse.broadcast(chunk);
        await sleep(5);
      }

      expect(closes).toEqual(['stalled']);
      expect(healthy.raw().length).toBeGreaterThan(0);
      stalled.destroy();
    });
  });

  it('rejects event names that could inject fields', async () => {
    const app = express();
    const sse = easse();
    app.get('/events', sse);
    await listen(app);

    expect(() => sse.broadcast('x', 'a\ndata: injected')).toThrow(TypeError);
  });
});

describe('options', () => {
  it.each([{ heartbeatMs: -1 }, { maxBufferedBytes: 0 }, { retentionMs: 0 }, { maxEvents: 0 }])(
    'rejects %j',
    (options) => {
      expect(() => easse(options)).toThrow(RangeError);
    },
  );
});
