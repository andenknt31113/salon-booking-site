import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const contracts = JSON.parse(readFileSync(new URL('./fixtures/admin-contracts.json', import.meta.url), 'utf8'));
assert.equal(contracts.version, 1);

const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

export function assertAdminContract(name, value) {
  const expected = contracts.fingerprints[name];
  assert.equal(typeof expected, 'string', `固定契約がありません: ${name}`);
  assert.match(expected, /^[a-f0-9]{64}$/, name);
  const actual = createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
  assert.equal(actual, expected, name);
}
