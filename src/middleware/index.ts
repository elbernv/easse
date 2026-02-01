import { Request, Response, NextFunction, RequestHandler } from 'express';
import { Easse, type EasseOptions } from '../core/hub.js';

export type { EasseOptions };

export interface EasseMiddleware extends RequestHandler {
  broadcast(data: unknown, event?: string): void;
}

/**
 * Middleware Factory.
 * Creates an internal Easse instance and attaches it to every request.
 * Returns a RequestHandler that also has the .broadcast() method.
 */
export function easse(options: EasseOptions = {}): EasseMiddleware {
  // One Easse instance (Buffer) per middleware usage
  const hub = new Easse(options);

  const middleware: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
    // Delegate creation and management to the Hub
    const stream = hub.handle(req, res);

    // Inject into response
    res.sse = stream;

    next();
  };

  // Attach the broadcast method to the middleware (Pattern: Function Object)
  (middleware as EasseMiddleware).broadcast = (data: unknown, event?: string) => {
    hub.broadcast(data, event);
  };

  return middleware as EasseMiddleware;
}