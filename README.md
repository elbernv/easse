# easse (Easy Server-Sent Events)

**Professional, Resilient, and Type-Safe Server-Sent Events (SSE) library for Express.js.**

`easse` is a lightweight implementation of the SSE protocol focused on **connection resilience**. It implements a server-side "Sliding Window Buffer" that caches recent events, allowing clients to automatically recover missed messages after temporary network partitions (WiFi drops, switching networks, etc.) without losing data.

---

## ⚡ Key Features

- **🛡️ Resilience by Design:** Built-in `ResilienceBuffer` handles `Last-Event-ID` negotiation automatically.
- **📢 Native Broadcast:** Efficiently multicast events to thousands of connected clients with a single call.
- **📦 TypeScript & ESM:** Built for modern Node.js (20+) using native ESM and strictly typed interfaces.
- **🚀 Performance:** Zero-copy broadcasting (events are serialized once and piped to all active streams).
- **🔌 Express Integration:** Drop-in middleware that injects `res.sse` context.

---

## 📥 Installation

```bash
npm install easse
```

_Requirements: Node.js 20+ (ESM support required)_

---

## 🚀 Quick Start

### 1. Simple Stream (Unicast)

Use this pattern for user-specific streams (e.g., notifications, user data updates).

```typescript
import express from 'express';
import { easse } from 'easse';

const app = express();

// Middleware injection
app.use(easse({ retentionMs: 10000 }));

app.get('/my-stream', (req, res) => {
  // Send an immediate event to THIS specific connection
  res.sse.send({ status: 'connected' }, 'welcome');

  // Simulate async events
  const interval = setInterval(() => {
    res.sse.send({ time: Date.now() }, 'ping');
  }, 1000);

  // Clean up on disconnect to prevent leaks
  req.on('close', () => clearInterval(interval));
});

app.listen(3000);
```

### 2. Broadcast (Multicast)

Use this pattern for global events (e.g., stock prices, chat rooms, system alerts). The middleware instance exposes the broadcast method.

```typescript
import express from 'express';
import { easse } from 'easse';

const app = express();

// 1. Create the middleware instance
const sse = easse({ retentionMs: 30000 });

// 2. Mount it
app.use('/events', sse);

// 3. Handle connection (Optional but Recommended)
// The middleware has already established the connection.
// Use this handler to send the "Initial State" or "Welcome Message".
app.get('/events', (req, res) => {
  // Example: Send the current data immediately so the UI isn't empty
  res.sse.send(
    {
      msg: 'Welcome! Connection established.',
      currentPrice: 123.45, // Send current state instantly
    },
    'init',
  );

  console.log(`Client ${req.ip} connected and received initial state.`);
});

// 4. Global Broadcast
// Later, updates are sent to everyone...
setInterval(() => {
  sse.broadcast({ price: 123.5 }, 'price-update');
}, 2000);

app.listen(3000);
```

---

## 📢 Understanding Broadcast vs Unicast

### When to use which?

| Feature       | Unicast (One-to-One)                               | Broadcast (One-to-Many)                                |
| :------------ | :------------------------------------------------- | :----------------------------------------------------- |
| **Target**    | Specific User                                      | All Connected Users                                    |
| **Data**      | Private / Personalized                             | Public / Global                                        |
| **Method**    | `res.sse.send()`                                   | `sse.broadcast()`                                      |
| **Use Cases** | User Notifications, Task Progress, Direct Messages | Stock Prices, Sports Scores, System Alerts, Chat Rooms |

### The Middleware Logic

When you mount `app.use(easse())`, the library intercepts the request before it even reaches your route handler. It:

1.  **Handshakes:** Sets `Content-Type: text/event-stream` and other essential headers.
2.  **Registers:** Adds the connection to an internal `Set` of active clients.
3.  **Recovers:** Checks for `Last-Event-ID` and replays missed messages from the buffer.
4.  **Injects:** Attaches the `res.sse` object so you can send private messages if needed.

### Decoupled Broadcasting

The `sse.broadcast()` method is attached to the middleware function itself. This allows you to trigger events **outside the request-response cycle**.

If you have 5,000 clients connected, calling `broadcast()`:

- **CPU Efficient:** Serializes your JSON object once.
- **Memory Efficient:** Stores a single reference in the `ResilienceBuffer`.
- **Atomic:** Every client receives the exact same `id` for that event, ensuring consistent state across your entire user base.

---

## 🧠 Technical Architecture

### Resilience & Recovery Mechanism

The core differentiator of `easse` is its handling of connection drops. The SSE spec defines a `Last-Event-ID` header.

1.  **Server Buffer:** Each `easse` instance maintains a circular buffer of recent events.
2.  **Disconnection:** If a client drops (e.g., user enters an elevator), the TCP connection closes.
3.  **Reconnection:** The browser's `EventSource` automatically reconnects, sending the `Last-Event-ID` of the last successful message it received.
4.  **Recovery:** `easse` intercepts this header, looks up the ID in its buffer, and immediately "replays" all subsequent missed messages before sending new ones.

### Configuration (`EasseOptions`)

```typescript
interface EasseOptions {
  /**
   * Time in milliseconds to keep events in memory for recovery.
   * Events older than this are evicted.
   * @default 5000 (5 seconds)
   * @max 10000 (10 seconds - hard limit for safety)
   */
  retentionMs?: number;
}
```

---

## ⚠️ Production Considerations

### 1. HTTP/1.1 vs HTTP/2

Server-Sent Events (SSE) keep a persistent connection open.

- **HTTP/1.1:** Browsers have a limit of **6 concurrent connections** per domain. If you open more than 6 tabs listening to SSE on `http://localhost`, the 7th tab will hang forever waiting for a socket.
- **HTTP/2:** Multiplexes multiple streams over a single TCP connection, effectively removing this limit.

**Recommendation:** For production deployment, ensure your application is served behind an **HTTP/2 compliant reverse proxy** (Nginx, Cloudflare, AWS ALB, etc.).

### 2. Proxy Buffering (Nginx/Apache)

Many proxies default to buffering responses to optimize throughput, which breaks real-time streaming (clients receive events in chunks or only when the buffer is full).

`easse` automatically sets the following header to prevent this:

```http
X-Accel-Buffering: no
```

This ensures Nginx (and compatible proxies) flushes events immediately to the client.

---

## 📚 API Reference

### `res.sse` (Context)

Injected into the Express Response object. Represents the **current individual connection**.

#### `res.sse.send(data: unknown, event?: string, id?: string)`

Sends a single event frame to the client.

- **data**: Automatically serialized. Objects are `JSON.stringify`'d. Strings are sent as-is.
- **event**: (Optional) The event name (e.g., `addEventListener('price', ...)`).
- **id**: (Optional) Unique ID. If omitted, a UUID v4 is generated automatically.

---

### `middleware` (Broadcast Controller)

The function returned by `easse()` acts as both an Express RequestHandler and a Broadcast Controller.

#### `sse.broadcast(data: unknown, event?: string)`

Sends an event to **all** currently connected clients served by this middleware instance.

- **Optimization:** The event is formatted and stored in the resilience buffer **once**, then written to all open writable streams.

---

## 💻 Client-Side Implementation

`easse` is fully compatible with the native browser `EventSource` API.

```javascript
const source = new EventSource('/events');

// Handle named events
source.addEventListener('price-update', (e) => {
  const data = JSON.parse(e.data);
  console.log('New Price:', data.price);
});

// Handle connection status
source.onopen = () => console.log('Connected');
source.onerror = (err) => console.error('Disconnected, attempting reconnect...');
```

---

## 🤝 Contributing

This project is Native ESM.

- **Build:** `npm run build`
- **Test:** `npm test` (Vitest)
- **Dev:** `npm run dev`

License: MIT
