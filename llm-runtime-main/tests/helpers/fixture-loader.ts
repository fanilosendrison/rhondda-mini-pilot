// NIB-T §27.5 — synchronous JSON fixture loader rooted at tests/fixtures/.
// Test-time utility (not production code).

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Anchor relative paths to tests/fixtures/ (this file lives at tests/helpers/).
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = resolve(HERE, '..', 'fixtures');

export function loadFixture(relativePath: string): string {
  const full = resolve(FIXTURES_ROOT, relativePath);
  return readFileSync(full, 'utf8');
}

export function loadJsonFixture<T = unknown>(relativePath: string): T {
  return JSON.parse(loadFixture(relativePath)) as T;
}
