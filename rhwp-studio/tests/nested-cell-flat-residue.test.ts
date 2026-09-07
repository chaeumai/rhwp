import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// flat 잔여 3건 (2026-09-07): 깊이 2 이상 셀에서 flat (controlIndex, cellIndex) 를 읽던 자리 셋을 경로로 옮겼다.
// 배경: E5(2026-09-04) — 캐럿 경로가 flat 을 쓰면 중첩 셀에서 바깥 문단 기준의 다른 셀을 가리킨다.
const here = dirname(fileURLToPath(import.meta.url));
function source(path: string): string {
  return readFileSync(join(here, '..', path), 'utf8');
}

test('Shift+Tab 내어쓰기는 깊이 2 이상 셀에서도 경로 API 로 동작한다 (flat 잔여 ①)', () => {
  const ih = source('src/engine/input-handler.ts');
  const fn = ih.slice(ih.indexOf('  applyHangingIndentAtCursor(): boolean {'));
  const body = fn.slice(0, fn.indexOf('\n  }\n'));
  assert.doesNotMatch(body, /unsupported nested\/textbox context/, '「unsupported nested」 무동작 가드는 폐기');
  assert.match(body, /getLineInfoByPath\(pos\.sectionIndex, pos\.parentParaIndex, pathJson, 0\)/);
  assert.match(body, /getCursorRectByPath\(pos\.sectionIndex, pos\.parentParaIndex, pathJson, firstLineInfo\.charStart\)/);
  assert.match(body, /\{ kind: 'path', sec: pos\.sectionIndex, parentPara: pos\.parentParaIndex, cellPath: /);
  // 글상자(isTextBox)는 여전히 밖 — 별건
  assert.match(body, /if \(pos\.isTextBox\) \{/);
});

test('눈금자 셀 폭은 중첩 셀에서 캐시 표 «경로» 가 같을 때만 쓴다 (flat 잔여 ②)', () => {
  const ih = source('src/engine/input-handler.ts');
  const i = ih.indexOf("this.eventBus.emit('cursor-cell-changed', {");
  const around = ih.slice(i - 1600, i);
  assert.match(around, /const nested = \(pos\.cellPath\?\.length \?\? 0\) > 1;/);
  assert.match(around, /sameTablePath\(ref\.pathJson, pos\.cellPath!\)/);
  assert.match(around, /: \(!ref\.pathJson && ref\.ci === ci\)/, 'flat 캐럿은 경로 캐시(중첩 표)를 쓰지 않는다');
  const helper = ih.slice(ih.indexOf('function sameTablePath('));
  assert.match(helper, /cached\[cellPath\.length - 1\]\.controlIndex === cellPath\[cellPath\.length - 1\]\.controlIndex/);
});

test('표/셀 속성 대화상자는 중첩 셀에서 경로 API 로 읽고 쓴다 (flat 잔여 ③)', () => {
  const dlg = source('src/ui/table-cell-props-dialog.ts');
  assert.match(dlg, /cellPath\?: CellPathEntry\[\]/);
  assert.match(dlg, /this\.wasm\.getCellPropertiesByPath\(sec, ppi, pathJson\)/);
  assert.match(dlg, /this\.wasm\.getTablePropertiesByPath\(sec, ppi, pathJson\)/);
  assert.match(dlg, /this\.wasm\.setCellPropertiesByPath\(sec, ppi, pathJson, newCellProps/);
  assert.match(dlg, /this\.wasm\.setTablePropertiesByPath\(sec, ppi, pathJson, newTableProps/);
  const nested = dlg.slice(dlg.indexOf('  private nestedPathJson(): string | null {'));
  assert.match(nested.slice(0, 400), /if \(!path \|\| path\.length < 2\) return null;/, '깊이 1 은 flat API 그대로');
  for (const f of ['src/command/commands/table.ts', 'src/command/commands/format.ts']) {
    const s = source(f);
    assert.match(s, /cellPath: (pos|ref)\.cellPath \}/, `${f}: 대화상자에 cellPath 를 넘긴다`);
  }
  const bridge = source('src/core/wasm-bridge.ts');
  assert.match(bridge, /getTablePropertiesByPath\(sec: number, parentPara: number, pathJson: string\): TableProperties/);
  assert.match(bridge, /setTablePropertiesByPath\(sec: number, parentPara: number, pathJson: string, props: Partial<TableProperties>\)/);
});
