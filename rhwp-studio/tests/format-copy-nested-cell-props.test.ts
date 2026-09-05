import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// [E3] 모양 복사의 셀 속성(배경·테두리)이 중첩 표(cellPath 깊이 2 이상)에서도 붙는다.
// 종전에는 경로 기반 setCellProperties 가 없어 글자 서식만 붙이고 셀 속성은 건너뛰었고,
// 복사원 읽기도 flat (controlIndex, cellIndex) 라 중첩 캐럿에서는 바깥 문단 기준의 다른 셀을 읽었다.
// rhwp-cai docs/셀선택-중첩표-경로기반서식-20260903-1018.md §4 · E3

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));

function source(path: string): string {
  return readFileSync(join(rootDir, path), 'utf8');
}

test('wasm 브리지가 셀 속성 경로 API 3종을 노출한다', () => {
  const bridge = source('src/core/wasm-bridge.ts');
  assert.match(bridge, /getCellPropertiesByPath\(sec: number, parentPara: number, pathJson: string\): CellProperties/);
  assert.match(bridge, /getCellOwnPropertiesByPath\(sec: number, parentPara: number, pathJson: string\): CellProperties/);
  assert.match(bridge, /setCellPropertiesByPath\(sec: number, parentPara: number, pathJson: string, props: Partial<CellProperties>\): \{ ok: boolean \}/);
});

test('모양 복사는 중첩 셀 캐럿에서 복사원 셀 속성을 경로로 읽는다', () => {
  const ih = source('src/engine/input-handler.ts');
  const copyStart = ih.indexOf('private copyFormatAtCursor(): void {');
  assert.ok(copyStart > 0);
  const copyBody = ih.slice(copyStart, ih.indexOf('this.formatCopyState = {', copyStart));
  assert.match(copyBody, /const nestedPath = this\.nestedCaretPathJson\(pos\);/);
  assert.match(copyBody, /this\.wasm\.getCellOwnPropertiesByPath\(pos\.sectionIndex, pos\.parentParaIndex!, nestedPath\)/);
  // 깊이 1 은 flat 그대로
  assert.match(copyBody, /this\.wasm\.getCellOwnProperties\(pos\.sectionIndex, pos\.parentParaIndex, pos\.controlIndex!, pos\.cellIndex!\)/);
});

test('모양 붙여넣기는 중첩 표 셀 선택에 셀 속성을 경로로 붙이고, 더는 건너뛰지 않는다', () => {
  const ih = source('src/engine/input-handler.ts');
  const start = ih.indexOf('private applyCopiedFormatToSelectedCells(');
  assert.ok(start > 0);
  const body = ih.slice(start, ih.indexOf('/** 서식 토글 (커맨드 시스템용) */', start));
  assert.match(body, /wasm\.setCellPropertiesByPath\(ctx\.sec, ctx\.ppi, this\.cellPathJsonFor\(ctx, cellIdx\), cellPropsCopy\)/);
  assert.match(body, /wasm\.setCellProperties\(ctx\.sec, ctx\.ppi, ctx\.ci, cellIdx, cellPropsCopy\)/);
  assert.doesNotMatch(body, /셀 속성은 건너뛰고/);
  assert.doesNotMatch(body, /hasCellProps && !nested/);
  // 글자 서식과 한 snapshot(undo 한 단계)
  assert.match(body, /operationType: 'formatCopyCells'/);
});
