import assert from 'node:assert/strict';
import {
  TABLE_MIN_COL_WIDTH,
  equalizeWidths,
  normalizePixelWidths,
  resizeColumnWidth,
  toPercentWidths
} from '../public/table-utils.mjs';

let passed = 0;

function test(name, fn) {
  fn();
  passed++;
  console.log('✓ ' + name);
}

test('均分列宽保持总宽', () => {
  const widths = equalizeWidths(900, 3);
  assert.deepEqual(widths, [300, 300, 300]);
});

test('飞书式拖动只改变目标列，右侧列宽保持不变', () => {
  const widths = resizeColumnWidth([200, 300, 400], 0, 50);
  assert.deepEqual(widths, [250, 300, 400]);
  assert.equal(widths.reduce((sum, value) => sum + value, 0), 950);
});

test('列宽拖动遵守最小宽度', () => {
  const widths = resizeColumnWidth([100, 100], 0, -200, TABLE_MIN_COL_WIDTH);
  assert.deepEqual(widths, [56, 100]);
});

test('无效边界不会修改列宽', () => {
  assert.deepEqual(resizeColumnWidth([100, 200], 2, 50), [100, 200]);
});

test('像素列宽会被归一到当前表格宽度', () => {
  const widths = normalizePixelWidths([100, 200, 300], 1200, 3);
  assert.deepEqual(widths.map(Math.round), [200, 400, 600]);
});

test('百分比列宽总和稳定为 100', () => {
  const percentages = toPercentWidths([123, 234, 345, 456]);
  assert.equal(Number(percentages.reduce((sum, value) => sum + value, 0).toFixed(3)), 100);
});

console.log(`\n表格模型测试通过：${passed} 项`);
