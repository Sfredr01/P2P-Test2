// Money is integer cents everywhere inside the system. These two functions are the only
// conversion points: toCents at the API input boundary (zod schema), fromCents in response mappers.
// String arithmetic only — never parseFloat, so "0.29" can't become 28.999... cents.

const MONEY_PATTERN = /^(\d+)(?:\.(\d{1,2}))?$/;

export function toCents(amount: string): number {
  const match = MONEY_PATTERN.exec(amount);
  if (!match) throw new Error(`Invalid money amount: "${amount}"`);
  const [, whole = '0', fraction = ''] = match;
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) throw new Error(`Money amount out of range: "${amount}"`);
  return cents;
}

export function fromCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
