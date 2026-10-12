/**
 * snake_case -> camelCase for API payloads.
 *
 * The API speaks snake_case (it is generated from Postgres column
 * names); the domain types in `types/domain.ts` are camelCase. Doing the
 * rename once, here, is what stops `display_name` leaking into
 * components and becoming a second spelling of a field that already has
 * one.
 *
 * Deliberately NOT a generic deep-clone utility:
 *
 *  * `before` and `after` in an audit row are free-form snapshots of
 *    whatever was written. Their keys are data, not field names -- the
 *    audit screen renders them as a diff of literal key/value pairs, so
 *    renaming `valid_until` to `validUntil` inside one would be
 *    rewriting the record. `camelKeys` therefore takes an explicit list
 *    of keys whose VALUES are passed through untouched.
 *  * Dates stay strings. The API sends ISO-8601 and every consumer here
 *    either formats or compares it as a string.
 */

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** `display_name` -> `displayName`. Leaves an already-camel key alone. */
export function camelCase(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Recursively rename object keys to camelCase.
 *
 * `opaque` names keys whose values are returned as-is (no recursion).
 * Pass the keys that hold caller-supplied JSON.
 */
export function camelKeys(value: unknown, opaque: readonly string[] = []): unknown {
  if (Array.isArray(value)) return value.map((item) => camelKeys(item, opaque));
  if (!isRecord(value)) return value;

  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    out[camelCase(key)] = opaque.includes(key) ? raw : camelKeys(raw, opaque);
  }
  return out;
}
