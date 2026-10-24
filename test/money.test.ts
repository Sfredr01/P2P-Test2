import { describe, expect, it } from 'vitest';
import { fromCents, toCents } from '../src/money';

describe('money', () => {
  it.each([
    ['12.50', 1250],
    ['12.5', 1250],
    ['12', 1200],
    ['0.29', 29],
    ['0.01', 1],
    ['0', 0],
    ['100000000.00', 10_000_000_000],
    ['00.50', 50],
  ])('toCents(%s) = %i', (input, cents) => {
    expect(toCents(input)).toBe(cents);
  });

  it.each(['12.505', '-1.00', '1e3', '', '.50', 'abc', '1,000.00', '99999999999999999.00'])('toCents rejects %j', (input) => {
    expect(() => toCents(input)).toThrow();
  });

  it.each([
    [1250, '12.50'],
    [1, '0.01'],
    [0, '0.00'],
    [62500, '625.00'],
    [-375, '-3.75'],
  ])('fromCents(%i) = %s', (cents, output) => {
    expect(fromCents(cents)).toBe(output);
  });

  it('round-trips without float drift', () => {
    for (let cents = 0; cents < 2000; cents++) expect(toCents(fromCents(cents))).toBe(cents);
  });
});
