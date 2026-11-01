import express, { type Response } from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { easse } from '../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT ?? 3000);

app.use(express.static(path.join(__dirname, 'public')));

const sse = easse({ retentionMs: 10_000, maxEvents: 20 });
const connections = new Map<string, Response>();

app.get('/events', sse, (req, res) => {
  const clientId = String(req.query.clientId ?? 'unknown');
  connections.set(clientId, res);
  console.log(`Client ${clientId} connected (recovered: ${res.sse.recovered})`);

  // Replayed events are written before this handler runs, so this marks where they end.
  res.sse.send({ recovered: res.sse.recovered }, 'ready');

  res.on('close', () => {
    if (connections.get(clientId) === res) connections.delete(clientId);
    console.log(`Client ${clientId} disconnected`);
  });
});

// Cuts the connection from the server, so the browser reconnects on its own with Last-Event-ID.
app.post('/drop/:clientId', (req, res) => {
  connections.get(req.params.clientId)?.destroy();
  res.sendStatus(204);
});

// Fast enough to miss a few events during the browser's reconnection delay.
setInterval(() => {
  sse.broadcast({ time: new Date().toLocaleTimeString() }, 'tick');
}, 1000);

app.listen(PORT, () => {
  console.log(`easse demo running at http://localhost:${PORT}`);
});
