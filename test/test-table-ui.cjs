const path = require('path');
const { app, BrowserWindow } = require('electron');

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log('✓ ' + name);
  } else {
    failed++;
    console.error('✗ ' + name + (detail ? ' — ' + detail : ''));
  }
}

async function run() {
  const win = new BrowserWindow({
    show: false,
    width: 1100,
    height: 800,
    webPreferences: { contextIsolation: false, sandbox: false }
  });
  await win.loadFile(path.join(__dirname, 'table-ui-fixture.html'));
  await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (window.testReady) { clearInterval(timer); resolve(); }
      else if (Date.now() - started > 5000) { clearInterval(timer); reject(new Error('Editor module timeout')); }
    }, 20);
  })`);

  const result = await win.webContents.executeJavaScript(`(async () => {
    const editor = window.testEditor;
    editor.setHTML('<p><br></p>');
    editor.insertTable(3, 3);
    await new Promise(resolve => setTimeout(resolve, 30));
    const table = document.querySelector('#editor table');
    const initial = {
      rows: table.rows.length,
      cols: table.querySelectorAll(':scope > colgroup > col').length
    };

    const first = table.rows[0].cells[0];
    const second = table.rows[0].cells[1];
    editor._setActiveTableCell(first, false);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const handles = document.querySelectorAll('.table-col-resizer').length;
    const beforeResize = Array.from(table.querySelectorAll(':scope > colgroup > col')).map(col => parseFloat(col.style.width));
    const beforeRendered = Array.from(table.rows[0].cells).map(cell => cell.getBoundingClientRect().width);
    const resizeHandleStub = {
      setPointerCapture() {}, hasPointerCapture() { return false; }, releasePointerCapture() {},
      addEventListener() {}, removeEventListener() {},
      classList: { add() {}, remove() {} }
    };
    editor._startTableColumnResize({
      preventDefault() {}, stopPropagation() {}, currentTarget: resizeHandleStub,
      clientX: 300, pointerId: 7
    }, table, 0);
    editor._moveTableColumnResize({ clientX: 340, pointerId: 7 });
    editor._endTableColumnResize({ pointerId: 7 });
    const afterResize = Array.from(table.querySelectorAll(':scope > colgroup > col')).map(col => parseFloat(col.style.width));
    const afterRendered = Array.from(table.rows[0].cells).map(cell => cell.getBoundingClientRect().width);
    const resizeResult = {
      firstChanged: afterResize[0] > beforeResize[0],
      rightUnchanged: afterResize.slice(1).every((value, index) => Math.abs(value - beforeResize[index + 1]) <= 0.02),
      renderedRightUnchanged: afterRendered.slice(1).every((value, index) => Math.abs(value - beforeRendered[index + 1]) <= 0.5),
      beforeTotal: beforeResize.reduce((sum, value) => sum + value, 0),
      afterTotal: afterResize.reduce((sum, value) => sum + value, 0),
      tableWidth: parseFloat(table.style.width)
    };
    const beforeRightEdge = Array.from(table.querySelectorAll(':scope > colgroup > col')).map(col => parseFloat(col.style.width));
    editor._startTableColumnResize({
      preventDefault() {}, stopPropagation() {}, currentTarget: resizeHandleStub,
      clientX: 700, pointerId: 8
    }, table, 2);
    editor._moveTableColumnResize({ clientX: 725, pointerId: 8, altKey: true });
    editor._endTableColumnResize({ pointerId: 8 });
    const afterRightEdge = Array.from(table.querySelectorAll(':scope > colgroup > col')).map(col => parseFloat(col.style.width));
    const rightEdgeResult = {
      earlierUnchanged: afterRightEdge.slice(0, 2).every((value, index) => Math.abs(value - beforeRightEdge[index]) <= 0.02),
      lastChanged: afterRightEdge[2] > beforeRightEdge[2],
      tableWidth: parseFloat(table.style.width)
    };
    editor._setActiveTableCell(second, true);
    const selected = editor.getTableState().selectedCount;
    const mergedOk = editor.tableCommand('merge');
    const mergedCell = table.rows[0].cells[0];
    const merged = { colspan: mergedCell.colSpan, cells: table.rows[0].cells.length };

    const undoOk = editor.undo();
    const undoCells = document.querySelector('#editor table').rows[0].cells.length;
    const redoOk = editor.redo();
    const redoColspan = document.querySelector('#editor table').rows[0].cells[0].colSpan;

    const liveTable = document.querySelector('#editor table');
    const liveMerged = liveTable.rows[0].cells[0];
    editor._setActiveTableCell(liveMerged, false);
    const splitOk = editor.tableCommand('split');
    const splitCells = liveTable.rows[0].cells.length;

    editor._setActiveTableCell(liveTable.rows[1].cells[0], false);
    editor._setActiveTableCell(liveTable.rows[1].cells[1], true);
    editor.setTableCellBackground('#ffeeaa');
    const colors = Array.from(liveTable.rows[1].cells).slice(0, 2).map(cell => cell.style.backgroundColor);
    editor.tableCommand('equalize');
    const widths = Array.from(liveTable.querySelectorAll(':scope > colgroup > col')).map(col => col.style.width);
    const serialized = editor.getHTML();

    editor.setHTML('<table><tbody><tr><td>A</td><td>B</td></tr></tbody></table>');
    const pasted = document.querySelector('#editor table');
    const normalizedPaste = {
      cols: pasted.querySelectorAll(':scope > colgroup > col').length,
      marker: pasted.getAttribute('data-pm-table')
    };

    return { initial, handles, resizeResult, rightEdgeResult, selected, mergedOk, merged, undoOk, undoCells, redoOk, redoColspan,
      splitOk, splitCells, colors, widths, serialized, normalizedPaste };
  })()`);

  check('插入 3×3 表格', result.initial.rows === 3 && result.initial.cols === 3, JSON.stringify(result.initial));
  check('激活表格后每一列右边界都有拖拽柄', result.handles === 3, 'handles=' + result.handles);
  check('飞书式拖动只改变目标列，右侧列宽不变且表格总宽随之变化',
    result.resizeResult.firstChanged && result.resizeResult.rightUnchanged &&
    result.resizeResult.renderedRightUnchanged &&
    result.resizeResult.afterTotal > result.resizeResult.beforeTotal && Math.abs(result.resizeResult.tableWidth - result.resizeResult.afterTotal) <= 0.02,
    JSON.stringify(result.resizeResult));
  check('最右边界可拖动且不会改动前面的列宽', result.rightEdgeResult.earlierUnchanged && result.rightEdgeResult.lastChanged,
    JSON.stringify(result.rightEdgeResult));
  check('Shift 连续选中两个单元格', result.selected === 2, 'selected=' + result.selected);
  check('合并单元格', result.mergedOk && result.merged.colspan === 2 && result.merged.cells === 2, JSON.stringify(result.merged));
  check('撤销合并', result.undoOk && result.undoCells === 3, 'cells=' + result.undoCells);
  check('重做合并', result.redoOk && result.redoColspan === 2, 'colspan=' + result.redoColspan);
  check('拆分单元格', result.splitOk && result.splitCells === 3, 'cells=' + result.splitCells);
  check('批量设置背景色', result.colors.every(color => color === 'rgb(255, 238, 170)'), JSON.stringify(result.colors));
  const numericWidths = result.widths.map(value => parseFloat(value));
  check('均分列宽', Math.max(...numericWidths) - Math.min(...numericWidths) <= 0.002, JSON.stringify(result.widths));
  check('序列化不保存临时选中类', !/pm-table-cell-(?:active|selected)/.test(result.serialized));
  check('外部表格载入后立即标准化', result.normalizedPaste.cols === 2 && result.normalizedPaste.marker === '1', JSON.stringify(result.normalizedPaste));

  win.destroy();
  console.log(`\n表格 DOM 集成测试：通过 ${passed}，失败 ${failed}`);
  app.exit(failed ? 1 : 0);
}

app.whenReady().then(run).catch(error => {
  console.error(error && error.stack || error);
  app.exit(1);
});
