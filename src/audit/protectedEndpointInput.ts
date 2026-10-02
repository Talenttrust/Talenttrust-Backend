import { isSensitiveHeader, isSensitiveKey, maskEmail, REDACTED } from './redact';

/** Bounds apply to audit copies only; they never reject the HTTP request. */
export const PROTECTED_AUDIT_LIMITS = Object.freeze({
  path: 4096, identifier: 128, depth: 5, keys: 50, items: 200,
  string: 4096, nodes: 1000, bytes: 8192,
});
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/;

export function auditIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 &&
    value.length <= PROTECTED_AUDIT_LIMITS.identifier && value.trim().length > 0 &&
    !CONTROLS.test(value) ? value : undefined;
}

export function auditPath(value: unknown): string {
  if (typeof value !== 'string') return '[INVALID]';
  // originalUrl retains router mount prefixes. Never persist its query/fragment.
  const path = value.split(/[?#]/, 1)[0];
  return path.length <= PROTECTED_AUDIT_LIMITS.path && path.startsWith('/') &&
    !CONTROLS.test(path) ? path : '[INVALID]';
}

export function auditMethod(value: unknown): string {
  return typeof value === 'string' && /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,32}$/.test(value)
    ? value.toUpperCase() : 'UNKNOWN';
}

/**
 * Copy plain JSON data without invoking getters or toJSON. Redact before
 * traversing sensitive fields, bound work, and freeze every retained container.
 * Reject a whole section rather than persisting an ambiguous partial payload.
 */
export function auditPayload(value: unknown, headers = false): { value: unknown; rejected: boolean } {
  if (value === undefined || value === null) return headers
    ? { value: '[OMITTED]', rejected: true } : { value: null, rejected: false };
  let nodes = 0;
  const ancestors = new WeakSet<object>();
  function copy(input: unknown, depth: number): unknown {
    if (++nodes > PROTECTED_AUDIT_LIMITS.nodes) throw new Error('nodes');
    if (input === null) {
      if (headers) throw new Error('header');
      return null;
    }
    if (typeof input === 'string') {
      if (input.length > PROTECTED_AUDIT_LIMITS.string) throw new Error('string');
      return headers ? input : maskEmail(input);
    }
    if (headers && typeof input !== 'object') throw new Error('header');
    if (typeof input === 'boolean') return input;
    if (typeof input === 'number' && Number.isFinite(input) && Math.abs(input) <= Number.MAX_SAFE_INTEGER) return input;
    if (typeof input !== 'object' || depth > PROTECTED_AUDIT_LIMITS.depth || ancestors.has(input)) throw new Error('shape');
    const array = Array.isArray(input);
    if (headers && ((array && depth !== 2) || (!array && depth !== 1))) throw new Error('header');
    const proto = Object.getPrototypeOf(input);
    // Node request objects can cross VM realms (e.g. Jest); compare the plain
    // prototype shape rather than realm-specific Object.prototype identity.
    if (!array && proto !== null && Object.getPrototypeOf(proto) !== null) throw new Error('prototype');
    ancestors.add(input);
    try {
      if (array) {
        if (input.length > PROTECTED_AUDIT_LIMITS.items) throw new Error('items');
        const result = [];
        for (let i = 0; i < input.length; i++) {
          const descriptor = Object.getOwnPropertyDescriptor(input, String(i));
          if (!descriptor || !('value' in descriptor)) throw new Error('accessor');
          result.push(copy(descriptor.value, depth + 1));
        }
        return Object.freeze(result);
      }
      const keys = Object.keys(input);
      if (keys.length > PROTECTED_AUDIT_LIMITS.keys) throw new Error('keys');
      const result: Record<string, unknown> = {};
      for (const key of keys) {
        if (key.length > 64 || CONTROLS.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('key');
        if (headers ? isSensitiveHeader(key) : isSensitiveKey(key)) {
          result[key] = REDACTED;
          continue;
        }
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (!descriptor || !('value' in descriptor)) throw new Error('accessor');
        result[key] = copy(descriptor.value, depth + 1);
      }
      return Object.freeze(result);
    } finally {
      ancestors.delete(input);
    }
  }
  try {
    if (headers && (typeof value !== 'object' || Array.isArray(value))) throw new Error('headers');
    const result = copy(value, 1);
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > PROTECTED_AUDIT_LIMITS.bytes) throw new Error('bytes');
    return { value: result, rejected: false };
  } catch {
    return { value: '[OMITTED]', rejected: true };
  }
}
