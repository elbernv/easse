# Changelog

## 0.1.2

### Documentation

- Added tested guidance for running behind Nginx and Apache, including Apache's limits on long-lived HTTP/2 streams. There are no code changes.

## 0.1.1

### Fixed

- Replays could crash the server. Each one was written at once as a new string, so clients reconnecting with large gaps could exhaust the Node.js heap. Replays are now sent as the client reads them, sharing their memory with the buffer. **Upgrade if you broadcast large events.**
- Clients reconnecting with more than `maxBufferedBytes` to recover were disconnected by the next event, even when they were reading fast enough, and could end up getting an `easse:reset`. A client catching up is now disconnected only if it falls `maxBufferedBytes` further behind.

## 0.1.0

### Security

- `res.sse.send()` stored events in the buffer shared by all clients, so private data could be replayed to other clients when they reconnected. It no longer stores anything. **Upgrade if you send private data with 0.0.1.**
- `event` and `id` values with line breaks, and data with a bare `\r`, could inject fields into the stream. Line breaks in data are now handled, and invalid `event` or `id` values throw a `TypeError`.

### Breaking changes

- The middleware must be mounted on a route: replace `app.use('/events', sse)` with `app.get('/events', sse)`. `app.use` used to turn every request under its path into a stream, and now results in an error.
- `res.sse.send()` events are no longer recovered after a reconnection, and they carry no ID unless you pass one.
- `res.sse.send()` no longer takes a fourth `options` argument.
- `undefined`, functions and symbols now throw a `TypeError` when sent as data.
- `ResilienceBuffer` now takes an options object and stores serialized events, and `getMissedEvents()` returns `null` for an unknown ID.
- `SSEStream.replay()` was removed.

### Added

- `maxEvents` option. The buffer used to be limited to 5 events.
- `easse:reset` event, sent when a client's gap can't be recovered. It used to get nothing and no warning.
- `res.sse.recovered` and `res.sse.lastEventId`.
- `heartbeatMs` option, with heartbeats on by default.
- `maxBufferedBytes` option: clients that stop reading are disconnected instead of growing memory without limit.

### Changed

- `retentionMs` defaults to 30 seconds, and its 10-second limit was removed.
- Events are expired on read as well, so an idle channel no longer replays expired events.
- Broadcasts are serialized once, regardless of the number of clients.
- `HEAD` requests end immediately instead of holding a connection open.

### Fixed

- `res.sse` is now typed for consumers of the package.
- Test files are no longer published.
