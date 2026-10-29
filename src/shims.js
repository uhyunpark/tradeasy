import { Buffer } from 'buffer';
if (!globalThis.Buffer) globalThis.Buffer = Buffer;
export { Buffer };
export const process = globalThis.process || { env: { NODE_ENV: 'production' }, browser: true, version: '', versions: {}, nextTick: (fn, ...a) => queueMicrotask(() => fn(...a)) };
