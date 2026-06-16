// NIB-T §15/§16/§17 + §25 property tests — deep-freeze helper.
// Test-time utility (not production code). Recursively freezes an object so that
// any runtime mutation attempted by the engine on the input request throws in
// strict mode, surfacing I-10 (LLMRequest immutability) violations.

export function deepFreeze<T>(value: T): Readonly<T> {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value as Readonly<T>;
  Object.freeze(value);
  for (const key of Reflect.ownKeys(value)) {
    const child = (value as Record<string | symbol, unknown>)[key];
    if (child !== null && typeof child === 'object' && !Object.isFrozen(child)) {
      deepFreeze(child);
    }
  }
  return value as Readonly<T>;
}
