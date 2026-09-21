/**
 * Minimal runtime validation helpers shared by catalog and preflight.
 * Pure functions, no I/O. Failure style (throw vs. result value) is decided
 * by the caller module, not here.
 */

export type JsonObject = Record<string, unknown>;

export function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
 * Own-enumerable keys only, so inherited properties cannot smuggle unknown
 * fields past this check. Field reads must use {@link ownValue} so that
 * prototype-chain values never satisfy validation either.
 */
export function hasExactFields(value: JsonObject, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

/** Reads an own property only; inherited values read as absent. */
export function ownValue(obj: JsonObject, key: string): unknown {
  return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

const MAX_ECHO_CHARS = 160;

/** Bounds input values echoed in error messages; error codes/structure unchanged. */
export function truncateForMessage(value: string): string {
  return value.length > MAX_ECHO_CHARS ? `${value.slice(0, MAX_ECHO_CHARS)}…[truncated]` : value;
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
