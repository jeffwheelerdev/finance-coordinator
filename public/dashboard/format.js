export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
export function money(cents, options = {}) {
  if (!Number.isSafeInteger(cents)) return '—';
  const value = BigInt(cents), whole = value / 100n, fraction = (value < 0n ? -value : value) % 100n;
  const formatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: options.whole && fraction === 0n ? 0 : 2 });
  return formatter.formatToParts(value < 0n && whole === 0n ? -0 : whole)
    .map(part => part.type === 'fraction' ? fraction.toString().padStart(2, '0') : part.value).join('');
}
export function integerToDecimal(value, places = 2) {
  if (!Number.isSafeInteger(value) || !Number.isSafeInteger(places) || places < 0 || places > 4) return '';
  const number = BigInt(value), absolute = number < 0n ? -number : number, scale = 10n ** BigInt(places);
  return `${number < 0n ? '-' : ''}${absolute / scale}${places ? `.${(absolute % scale).toString().padStart(places, '0')}` : ''}`;
}
export function percentage(basisPoints) {
  if (!Number.isSafeInteger(basisPoints) || basisPoints < 0) return '—';
  return `${integerToDecimal(basisPoints).replace(/(?:\.0+|(\.\d*?)0+)$/, '$1')}%`;
}
export function count(value) { return Number.isSafeInteger(value) && value >= 0 ? String(value) : '—'; }
export function countTotal(values) {
  if (!values.every(value => Number.isSafeInteger(value) && value >= 0)) return '—';
  const total = values.reduce((sum, value) => sum + BigInt(value), 0n);
  return total <= BigInt(Number.MAX_SAFE_INTEGER) ? String(total) : '—';
}
export function decimalToInteger(value, places = 2) {
  const text = String(value).trim();
  if (!Number.isInteger(places) || places < 0 || places > 4 || !new RegExp(`^\\d+(?:\\.\\d{1,${Math.max(places, 1)}})?$`).test(text) || places === 0 && text.includes('.')) throw new Error('Enter a nonnegative number with the allowed decimal precision.');
  const [whole, fraction = ''] = text.split('.');
  const result = BigInt(whole) * 10n ** BigInt(places) + BigInt(fraction.padEnd(places, '0') || '0');
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('This amount is too large.');
  return Number(result);
}
export function dateTime(value, options = {}) {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Not recorded';
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric', ...(options.dateOnly ? {} : { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }) }).format(new Date(value));
}
export function monthName(value) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value ?? '')) return 'Upcoming cycle';
  return new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${value}-01T12:00:00Z`));
}
export function titleCase(value) {
  return String(value ?? 'Not recorded').toLowerCase().replace(/_/g, ' ').replace(/(^|\s)\S/g, match => match.toUpperCase());
}
