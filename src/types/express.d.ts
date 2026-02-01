import { SSEStream } from '../core/stream.js';

declare global {
  namespace Express {
    interface Response {
      sse: SSEStream;
    }
  }
}
