// Minimal 'util' for browser bundles (anchor's utf8 helper only needs TextEncoder/TextDecoder).
export const TextEncoder = globalThis.TextEncoder;
export const TextDecoder = globalThis.TextDecoder;
export const inspect = (x) => String(x);
export default { TextEncoder, TextDecoder, inspect };
