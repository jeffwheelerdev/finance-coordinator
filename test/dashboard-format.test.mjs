import test from 'node:test';
import assert from 'node:assert/strict';
import { decimalToInteger, integerToDecimal, percentage, count, countTotal, escapeHtml, money } from '../public/dashboard/format.js';

test('budget input converts decimal dollars and percentages to exact integers', () => {
  assert.equal(decimalToInteger('750'), 75000);
  assert.equal(decimalToInteger('850.19'), 85019);
  assert.equal(decimalToInteger('7.5'), 750);
  assert.equal(decimalToInteger('0.01'), 1);
  assert.equal(decimalToInteger('28', 0), 28);
  assert.equal(decimalToInteger('90071992547409.91'), Number.MAX_SAFE_INTEGER);
});
test('budget inputs cannot silently round cents, coerce exponents or exceed safe arithmetic', () => {
  for (const value of ['', '-1', '1.001', '1e4', 'Infinity', 'NaN', '$750', '1,000', '90071992547409.92']) {
    assert.throws(() => decimalToInteger(value), value);
  }
  assert.throws(() => decimalToInteger('1.5', 0));
});
test('absent balance stays unavailable and dynamic text cannot become markup', () => {
  assert.equal(money(null), '—');
  assert.equal(money(undefined), '—');
  assert.equal(money(0), '$0.00');
  assert.equal(escapeHtml('<img src=x onerror="alert(1)">'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
});

test('display and form values preserve every safe cent without floating point rounding', () => {
  assert.equal(money(Number.MAX_SAFE_INTEGER), '$90,071,992,547,409.91');
  assert.equal(money(-1), '-$0.01');
  assert.equal(money(-101), '-$1.01');
  assert.equal(money(100, { whole: true }), '$1');
  assert.equal(integerToDecimal(Number.MAX_SAFE_INTEGER), '90071992547409.91');
  assert.equal(decimalToInteger(integerToDecimal(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
  assert.equal(integerToDecimal(null), '');
  assert.equal(percentage(725), '7.25%');
  assert.equal(percentage(750), '7.5%');
  assert.equal(percentage(700), '7%');
  assert.equal(percentage(null), '—');
});

test('unavailable activity counts cannot be added into a manufactured zero', () => {
  assert.equal(count(null), '—');
  assert.equal(count(0), '0');
  assert.equal(countTotal([null, null]), '—');
  assert.equal(countTotal([1, null]), '—');
  assert.equal(countTotal([0, 0]), '0');
  assert.equal(countTotal([1, 2]), '3');
});
