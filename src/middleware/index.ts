import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { Easse, type EasseOptions } from '../core/hub.js';
import type { SSEStream } from '../core/stream.js';

export type { EasseOptions };

declare global {
  namespace Express {
    interface Response {
      /** The SSE connection, available on routes using the `easse()` middleware. */
      sse: SSEStream;
    }
  }
}

export interface EasseMiddleware extends RequestHandler {
  /** Sends an event to every client connected through this middleware. */
  broadcast(data: unknown, event?: string): void;
}

/**
 * Creates a route middleware that turns the request into an SSE connection.
 * Each call creates an independent channel with its own clients and buffer.
 *
 * @example
 * const sse = easse();
 * app.get('/events', sse);
 * sse.broadcast({ price: 123.5 }, 'price-update');
 */
export function easse(options: EasseOptions = {}): EasseMiddleware {
  const hub = new Easse(options);

  const middleware = (req: Request, res: Response, next: NextFunction): void => {
    // `app.use` would turn every request under its path into a stream.
    if (!req.route) {
      next(new Error("easse: mount the middleware on a route, e.g. app.get('/events', sse)"));
      return;
    }

    // `app.get` also matches HEAD, which has no body to stream.
    if (req.method === 'HEAD') {
      res.status(200).type('text/event-stream').end();
      return;
    }

    res.sse = hub.handle(req, res);
    next();
  };

  return Object.assign(middleware, {
    broadcast: (data: unknown, event?: string) => hub.broadcast(data, event),
  });
}
