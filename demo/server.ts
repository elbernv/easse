/// <reference path="../src/types/express.d.ts" />
import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { easse } from '../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3000;
const HOST = '0.0.0.0';

app.use(express.static(path.join(__dirname, 'public')));

// 1. Create the middleware
const sse = easse({ retentionMs: 10000 });

// 2. Use it in the route
app.use('/events', sse);

// 3. Simple Endpoint
app.get('/events', (req, res) => {
  const clientId = req.query.clientId || 'unknown';
  console.log(`[${new Date().toISOString()}] Client connected: ${clientId} - IP: ${req.ip}`);

  // We NO LONGER need a setInterval per client!
  // Just register disconnection for logging
  req.on('close', () => {
    console.log(`[${new Date().toISOString()}] Client disconnected: ${clientId}`);
  });
});

// 4. GLOBAL EMISSION (BROADCAST)
// A single "clock" for everyone. If there are 1000 clients, this runs 1 time, not 1000.
setInterval(() => {
  const time = new Date().toLocaleTimeString();

  // Use the broadcast method attached to the middleware
  sse.broadcast({ time, message: `📢 Global Message (Broadcast)` }, 'ping');
}, 2000);

app.listen(PORT, HOST, () => {
  console.log(`\n🚀 BROADCAST Demo running at http://${HOST}:${PORT}`);
  console.log(`   - Access from your IP: http://192.168.0.102:${PORT}`);
  console.log(`   - Open MULTIPLE tabs/devices.`);
  console.log(`   - Everyone will receive the SAME event at the same time.`);
  console.log(`   - Try disconnecting one, wait, and see it recover global events.\n`);
});