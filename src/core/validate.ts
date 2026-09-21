/**
 * Minimal runtime validation helpers shared by catalog and preflight.
 * Pure functions, no I/O. Failure style (throw vs. result value) is decided
 * by the caller module, not here.
 */

export type JsonObject = Record<string, unknown>;

export function isPlainObject(value: unknown): value is JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Non-empty string after trim; returns the original (untrimmed) value on success. */
export function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (value.trim().length === 0) return undefined;
  return value;
}

export function isNonEmptyStringArray(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  return value.every((entry) => asNonEmptyString(entry) !== undefined);
}

/**
 * Own property keys only (including symbols and non-enumerable keys), so
 * inherited properties cannot smuggle unknown fields past this check. Field
 * reads must use {@link ownValue} so prototype-chain values never satisfy
 * validation either.
 */
export function hasExactFields(value: JsonObject, allowed: readonly string[]): boolean {
  return Reflect.ownKeys(value).every(
    (key) => typeof key === 'string' && allowed.includes(key),
  );
}

/** Reads an own property only; inherited values read as absent. */
export function ownValue(obj: JsonObject, key: string): unknown {
  return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

const MAX_ECHO_CHARS = 160;
const TRUNCATION_SUFFIX = '…[truncated]';

/** Bounds echoed input to ≤160 UTF-16 code units without splitting a surrogate pair. */
export function truncateForMessage(value: string): string {
  if (value.length <= MAX_ECHO_CHARS) return value;
  const prefixLimit = MAX_ECHO_CHARS - TRUNCATION_SUFFIX.length;
  let prefix = '';
  for (const character of value) {
    if (prefix.length + character.length > prefixLimit) break;
    prefix += character;
  }
  return `${prefix}${TRUNCATION_SUFFIX}`;
}

/** Recursively freezes a value; used for catalog state and dispatch plans. */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}
