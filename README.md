# easse

**Server-Sent Events for Express, with recovery of missed events after a reconnection.**

`easse` keeps a window of recent broadcast events in memory. When a client's connection drops, the browser's `EventSource` reconnects by itself and `easse` replays what it missed. If the gap is too old to recover, the client is told so it can reload its state, instead of silently ending up out of date.

- **Recovery:** handles `Last-Event-ID` for you, with a configurable window.
- **Broadcast:** serializes each event once and writes it to every client.
- **Connection care:** heartbeats, and disconnection of clients that stop reading.
- **TypeScript:** `res.sse` is typed out of the box.
- **Small:** no runtime dependencies. Works with Express 4 and 5.

## Installation

```bash
npm install easse
```

Requires Node.js 20+ and an ESM project, since the package is ESM only. For TypeScript, also install `@types/express`.

## Quick start

### Broadcast to everyone

Use `broadcast` for events that everyone should get. These are the events that can be recovered.

```typescript
import express from 'express';
import { easse } from 'easse';

const app = express();
const sse = easse({ retentionMs: 60_000 });

app.get('/events', sse);

setInterval(() => {
  sse.broadcast({ price: 123.5 }, 'price-update');
}, 2000);

app.listen(3000);
```

### Send to one client

Use `res.sse.send` for data meant for a single connection. It is never stored, so it cannot reach anyone else, and it is **not** recovered after a reconnection.

```typescript
import express from 'express';
import { easse } from 'easse';

const app = express();

app.get('/my-stream', easse(), (req, res) => {
  res.sse.send({ status: 'connected' }, 'welcome');

  const interval = setInterval(() => {
    res.sse.send({ time: Date.now() }, 'ping');
  }, 1000);

  // Stop your own timers when the client disconnects.
  res.on('close', () => clearInterval(interval));
});

app.listen(3000);
```

### Combine both

Replayed events are delivered before anything your handler sends, so you can send the initial state only to clients that need it.

```typescript
import express from 'express';
import { easse } from 'easse';

const app = express();
const sse = easse();
let currentPrice = 123.45;

app.get('/events', sse, (req, res) => {
  if (!res.sse.recovered) {
    res.sse.send({ price: currentPrice }, 'init');
  }
});

setInterval(() => {
  currentPrice += 0.01;
  sse.broadcast({ price: currentPrice }, 'price-update');
}, 2000);

app.listen(3000);
```

### In the browser

```javascript
const source = new EventSource('/events');

source.addEventListener('price-update', (e) => {
  console.log('New price:', JSON.parse(e.data).price);
});

// The events this client missed are gone: reload the state from your API.
source.addEventListener('easse:reset', () => {
  reloadState();
});
```

## How recovery works

1. Every `broadcast` gets an ID and is stored in the channel's buffer.
2. When the connection drops, `EventSource` reconnects by itself and sends the ID of the last event it received in the `Last-Event-ID` header.
3. `easse` looks that ID up before calling your handler:

| Situation                      | What the client gets        | `res.sse.recovered` |
| :----------------------------- | :-------------------------- | :------------------ |
| First connection               | Nothing extra               | `false`             |
| ID found in the buffer         | The missed events, in order | `true`              |
| Client is already up to date   | Nothing extra               | `true`              |
| ID unknown or no longer stored | An `easse:reset` event      | `false`             |

### What can be recovered

A client can recover a gap only if it is within **both** limits:

- **`retentionMs`:** how long ago the events were sent.
- **`maxEvents`:** the buffer must still hold the client's last event, so up to `maxEvents - 1` events can be recovered.

Recovery is all or nothing: past these limits the client gets `easse:reset` rather than part of the gap.

The window is limited by whichever runs out first. At 100 events per second, the default `maxEvents` of 1000 covers about 10 seconds, whatever `retentionMs` says. Memory use is at most `maxEvents` times your event size.

### Limitations

- **The buffer lives in the memory of one process.** After a restart, clients get `easse:reset`. With several instances behind a load balancer, a client reconnecting to a different instance also gets `easse:reset`, and a broadcast only reaches the clients of the instance that sent it.
- **Only broadcasts are recovered.** Events from `res.sse.send` are not stored.

## API

### `easse(options?)`

Creates a channel with its own clients and buffer, and returns its route middleware.

| Option             | Default           | Description                                                   |
| :----------------- | :---------------- | :------------------------------------------------------------ |
| `retentionMs`      | `30000`           | How long events stay available for recovery, in milliseconds. |
| `maxEvents`        | `1000`            | Maximum number of events kept in the buffer.                  |
| `heartbeatMs`      | `25000`           | Interval between keep-alive comments. `0` disables them.      |
| `maxBufferedBytes` | `1048576` (1 MiB) | Pending bytes allowed per client, beyond its replay.          |

Mount it on a route, with any method. Using `app.use` is an error, because it would turn every request under that path into a stream. Your handler is optional.

```typescript
app.get('/events', sse);
app.get('/events', sse, (req, res) => {});
```

### `sse.broadcast(data, event?)`

Sends an event to every client on this channel and stores it for recovery. It can be called from anywhere, outside of any request.

### `res.sse.send(data, event?, id?)`

Sends an event to this connection only.

If you pass an `id`, the browser adopts it as its last event ID and sends it on the next reconnection. Use it only when you implement your own resume logic with `res.sse.lastEventId`. An ID that isn't in the buffer results in an `easse:reset` on reconnection.

### `res.sse.recovered`

`true` if the client reconnected and its gap was recovered.

### `res.sse.lastEventId`

The `Last-Event-ID` sent by the client, if any.

### Event data

Strings are sent as they are, and anything else is sent as JSON. Line breaks are handled for you.

`send` and `broadcast` throw a `TypeError` if the data has no JSON representation (such as `undefined`), or if `event` or `id` contain line breaks or NUL characters.

### `Easse`

The class behind the middleware, for when you need to manage the connection yourself. It takes the same options.

```typescript
import express from 'express';
import { Easse } from 'easse';

const app = express();
const hub = new Easse();

app.get('/events', (req, res) => {
  const stream = hub.handle(req, res);
  stream.send({ status: 'connected' }, 'welcome');
});

hub.broadcast({ price: 123.5 }, 'price-update');

app.listen(3000);
```

## Production notes

**Connection limit.** Over HTTP/1.1, browsers allow about 6 connections per site, shared across tabs. In Chrome, only 6 of 10 tabs received events, and further pages on that site couldn't even load. Serve your app over HTTP/2 to avoid this, keeping in mind the Apache caveat below.

**Slow clients.** A client that stops reading is disconnected once it has more than `maxBufferedBytes` pending. If it reconnects in time, it recovers what it missed like any other client.

**Reconnections.** A replay is sent only as fast as the client reads it, and shares its memory with the buffer, so many clients reconnecting at once don't multiply it. While catching up, a client can be as far behind as the replay requires: it is disconnected only if it falls `maxBufferedBytes` further behind.

**Authentication.** `easse` doesn't handle it. Put your auth middleware before it on the route.

### Behind a proxy

Tested on Nginx 1.28 and Apache 2.4.69, over HTTP/1.1 and HTTP/2, with real Chrome tabs and up to 5000 clients on one machine. Other proxies and CDNs, such as Cloudflare or AWS ALB, haven't been tested.

Both work with a plain reverse proxy configuration. These are the ones we recommend:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
}
```

```apache
ProxyPass / http://127.0.0.1:3000/ flushpackets=on
```

- **Buffering:** Nginx relies on the `X-Accel-Buffering: no` header sent by `easse`. With its default configuration and that header ignored, clients received nothing at all, so don't strip it or set `proxy_ignore_headers X-Accel-Buffering`.
- **Idle connections:** both proxies closed silent streams after 60 seconds by default. The default `heartbeatMs` kept them open. If you disable heartbeats or raise them, also raise the proxy's timeout.
- **Compression:** `no-transform` doesn't stop Nginx's `gzip` or Apache's `mod_deflate` if you enable them for `text/event-stream`. Events still arrived on time, so it isn't a problem, but it isn't needed either.
- **Reconnections and slow clients:** recovery and `maxBufferedBytes` work the same through both proxies. A stalled HTTP/2 stream doesn't affect others on the same connection.

**Apache and HTTP/2.** We recommend Nginx for HTTP/2. Apache can leave streams waiting forever, with no error, because of two limits that streams which never finish run into:

- **Streams per connection:** Apache starts each HTTP/2 connection with room for 6 active requests, and raises it as short requests complete. A Chrome page opening 10 `EventSource` connections got only 6, and tabs of the same site opened together sometimes got only 6. We didn't find a setting that changes this, so use one stream per page and share it.
- **Workers per process:** each stream holds an HTTP/2 worker for as long as it is open, and a connection stays on the process that accepted it. Apache doesn't start more processes when these run out, so with `H2MaxWorkers` at 150, only 300 of 1000 clients were answered.

These settings served all 5000 clients in our tests, at a cost of about 15,000 threads and 1.5 GB of memory. Adjust them to your number of clients, and test them with your own load:

```apache
ServerLimit 64
ThreadLimit 100
ThreadsPerChild 100
MaxRequestWorkers 6400
StartServers 64
H2MaxWorkers 2000
```

## Demo

```bash
npm run demo
```

Open `http://localhost:3000` and press the button to cut the connection: the events missed during the reconnection appear highlighted.

## Contributing

- `npm run build`: compile to `dist/`
- `npm test`: run the tests, on both Express 4 and 5
- `npm run typecheck`: type-check the library, tests and demo
- `npm run dev`: compile in watch mode

## License

MIT
