/**
 * ServiceOS /billing exact decimal arithmetic (WORK-011, module internal).
 *
 * Customer economics must never touch binary floating point: every
 * amount, quantity and charge is an exact decimal carried as a
 * canonical decimal STRING end to end (inputs, stores, SQL NUMERIC
 * columns, ledger entries). The helpers below parse to scaled BigInt
 * integers, so addition, subtraction and multiplication are exact.
 *
 * Canonical form (the only form accepted and produced):
 *   - optional leading '-' (margin can be negative; inputs cannot)
 *   - one or more integer digits, no redundant leading zeros ('0' allowed)
 *   - optional '.' followed by 1..MAX_SCALE significant fraction digits,
 *     no trailing zeros ('2.50' is normalized to '2.5'; '2.0' → '2')
 */
import { BillingError } from './errors.js';

export const MAX_SCALE = 12;
const DECIMAL_INPUT_PATTERN = /^\d+(\.\d{1,12})?$/;

interface ParsedDecimal {
  readonly negative: boolean;
  readonly digits: bigint;
  readonly scale: number;
}

function parseDecimal(value: string): ParsedDecimal {
  const negative = value.startsWith('-');
  const body = negative ? value.slice(1) : value;
  const [integer, fraction = ''] = body.split('.');
  const digits = BigInt(`${integer}${fraction}` || '0');
  return { negative, digits, scale: fraction.length };
}

/** Validate a non-negative decimal input string (fail closed). */
export function validateAmount(value: unknown, field: string, options: { allowZero?: boolean } = {}): string {
  if (typeof value !== 'string' || !DECIMAL_INPUT_PATTERN.test(value)) {
    throw new BillingError(
      'INVALID_INPUT',
      `${field} must be a non-negative decimal string with at most ${MAX_SCALE} fraction digits (e.g. "199.00")`,
    );
  }
  const canonical = canonicalDecimal(value);
  if (options.allowZero !== true && canonical === '0') {
    throw new BillingError('INVALID_INPUT', `${field} must be greater than zero`);
  }
  return canonical;
}

/** Render the canonical form of an already-valid decimal string. */
export function canonicalDecimal(value: string): string {
  const negative = value.startsWith('-');
  let [integer, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  integer = integer.replace(/^0+(?=\d)/, '');
  fraction = fraction.replace(/0+$/, '');
  const body = fraction.length > 0 ? `${integer}.${fraction}` : integer;
  return negative && body !== '0' ? `-${body}` : body;
}

function align(a: ParsedDecimal, b: ParsedDecimal): { scale: number; left: bigint; right: bigint } {
  const scale = Math.max(a.scale, b.scale);
  const left = a.digits * 10n ** BigInt(scale - a.scale);
  const right = b.digits * 10n ** BigInt(scale - b.scale);
  return { scale, left: a.negative ? -left : left, right: b.negative ? -right : right };
}

function render(signed: bigint, scale: number): string {
  const negative = signed < 0n;
  const abs = negative ? -signed : signed;
  const digits = abs.toString().padStart(scale + 1, '0');
  const integer = digits.slice(0, digits.length - scale);
  const fraction = scale > 0 ? digits.slice(digits.length - scale) : '';
  return canonicalDecimal(`${negative ? '-' : ''}${integer}${fraction.length > 0 ? `.${fraction}` : ''}`);
}

/** Exact addition of two canonical decimal strings. */
export function addDecimals(a: string, b: string): string {
  const { scale, left, right } = align(parseDecimal(a), parseDecimal(b));
  return render(left + right, scale);
}

/** Exact subtraction of two canonical decimal strings (may be negative). */
export function subtractDecimals(a: string, b: string): string {
  const { scale, left, right } = align(parseDecimal(a), parseDecimal(b));
  return render(left - right, scale);
}

/** Exact multiplication (scales add; never used beyond the MAX_SCALE input bound). */
export function multiplyDecimals(a: string, b: string): string {
  const left = parseDecimal(a);
  const right = parseDecimal(b);
  const negative = left.negative !== right.negative;
  const product = left.digits * right.digits;
  const rendered = render(product, left.scale + right.scale);
  return negative && rendered !== '0' ? `-${rendered}` : rendered;
}
