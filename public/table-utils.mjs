export const TABLE_MIN_COL_WIDTH = 56;

export function normalizePixelWidths(widths, totalWidth, columnCount) {
  const count = Math.max(1, Number(columnCount) || 1);
  const total = Math.max(count, Number(totalWidth) || count);
  const source = Array.isArray(widths) ? widths.slice(0, count) : [];
  while (source.length < count) source.push(total / count);
  const positive = source.map(value => Math.max(1, Number(value) || total / count));
  const sum = positive.reduce((acc, value) => acc + value, 0) || total;
  return positive.map(value => value / sum * total);
}

export function resizeColumnWidth(widths, columnIndex, delta, minWidth = TABLE_MIN_COL_WIDTH) {
  const next = Array.isArray(widths) ? widths.slice() : [];
  const index = Number(columnIndex);
  if (index < 0 || index >= next.length) return next;
  const current = Number(next[index]) || 0;
  const min = Math.max(1, Number(minWidth) || TABLE_MIN_COL_WIDTH);
  next[index] = Math.max(min, current + (Number(delta) || 0));
  return next;
}

export function equalizeWidths(totalWidth, columnCount) {
  const count = Math.max(1, Number(columnCount) || 1);
  const each = Math.max(1, Number(totalWidth) || count) / count;
  return Array.from({ length: count }, () => each);
}

export function toPercentWidths(widths) {
  const source = Array.isArray(widths) ? widths.map(value => Math.max(0, Number(value) || 0)) : [];
  const sum = source.reduce((acc, value) => acc + value, 0);
  if (!source.length || sum <= 0) return [];
  const result = source.map(value => value / sum * 100);
  const rounded = result.map(value => Number(value.toFixed(3)));
  const roundedSum = rounded.reduce((acc, value) => acc + value, 0);
  rounded[rounded.length - 1] = Number((rounded[rounded.length - 1] + 100 - roundedSum).toFixed(3));
  return rounded;
}
