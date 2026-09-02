import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  hasCharFormatTarget,
  isNestedCellPath,
  collectSelectedCellIndices,
  CELL_SELECTION_CHAR_FORMAT_COMMANDS,
} from '../src/engine/cell-selection-format.ts';

// 배경: F5 로 셀을 고르고 글꼴·크기·굵게를 바꾸면 서식바 숫자만 바뀌고 문서는 그대로였다.
// hasSelection() 이 셀 격자 선택을 모르는 것이 원인 — rhwp-cai
// docs/셀선택-글자서식-무동작-진단과수리방안-20260831-2323.md

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));

function source(path: string): string {
  return readFileSync(join(rootDir, path), 'utf8');
}

test('글자 서식 대상은 텍스트 선택 또는 F5 셀 선택이다', () => {
  assert.equal(hasCharFormatTarget({ hasSelection: true, inCellSelectionMode: false }), true);
  assert.equal(hasCharFormatTarget({ hasSelection: false, inCellSelectionMode: true }), true);
  assert.equal(hasCharFormatTarget({ hasSelection: true, inCellSelectionMode: true }), true);
  assert.equal(hasCharFormatTarget({ hasSelection: false, inCellSelectionMode: false }), false);
});

test('중첩 표는 cellPath 깊이 2 이상이다', () => {
  assert.equal(isNestedCellPath(undefined), false);
  assert.equal(isNestedCellPath(null), false);
  assert.equal(isNestedCellPath([]), false);
  assert.equal(isNestedCellPath([{}]), false);
  assert.equal(isNestedCellPath([{}, {}]), true);
});

test('셀 순회는 범위 안·제외 아닌 셀만 셀 순서대로 고른다', () => {
  // 3×3 표, 셀 인덱스 = row*3+col
  const cellAt = (i: number) => ({ row: Math.floor(i / 3), col: i % 3 });
  const range = { startRow: 0, startCol: 1, endRow: 1, endCol: 2 };
  assert.deepEqual(collectSelectedCellIndices(9, cellAt, range, new Set()), [1, 2, 4, 5]);
  // Ctrl+클릭 제외
  assert.deepEqual(collectSelectedCellIndices(9, cellAt, range, new Set(['1,1'])), [1, 2, 5]);
  // 1셀 선택
  assert.deepEqual(
    collectSelectedCellIndices(9, cellAt, { startRow: 2, startCol: 2, endRow: 2, endCol: 2 }, new Set()),
    [8],
  );
  // 빈 표
  assert.deepEqual(collectSelectedCellIndices(0, cellAt, range, new Set()), []);
});

test('병합 셀은 시작 좌표로 판정한다 (모양 복사와 같은 규칙)', () => {
  // 2×2 표에서 셀 0 이 (0,0)~(0,1) 가로 병합: 셀 목록은 (0,0), (1,0), (1,1)
  const cells = [{ row: 0, col: 0 }, { row: 1, col: 0 }, { row: 1, col: 1 }];
  const cellAt = (i: number) => cells[i];
  // 둘째 열만 고르면 시작 좌표가 (0,0)인 병합 셀은 들지 않는다
  assert.deepEqual(
    collectSelectedCellIndices(3, cellAt, { startRow: 0, startCol: 1, endRow: 1, endCol: 1 }, new Set()),
    [2],
  );
  // 첫째 열을 고르면 병합 셀이 든다
  assert.deepEqual(
    collectSelectedCellIndices(3, cellAt, { startRow: 0, startCol: 0, endRow: 1, endCol: 0 }, new Set()),
    [0, 1],
  );
});

test('F5 진입은 텍스트 선택을 지운 뒤 셀 선택 모드로 들어간다 (옛 범위 오적용 차단)', () => {
  const keyboard = source('src/engine/input-handler-keyboard.ts');
  const f5 = keyboard.slice(keyboard.indexOf("e.key === 'F5'"));
  const enter = f5.indexOf('this.cursor.enterCellSelectionMode()');
  const clear = f5.indexOf('this.cursor.clearSelection()');
  const rendererClear = f5.indexOf('this.selectionRenderer.clear()');
  assert.ok(enter >= 0 && clear >= 0 && rendererClear >= 0, 'F5 분기에 세 호출이 모두 있어야 한다');
  assert.ok(
    enter < clear && clear < rendererClear,
    'enterCellSelectionMode → cursor.clearSelection → selectionRenderer.clear 순서',
  );
});

test('글자 서식 수신부·토글·증감은 셀 선택을 대상으로 인정한다', () => {
  const ih = source('src/engine/input-handler.ts');
  // 서식바 format-char 수신부
  assert.match(ih, /eventBus\.on\('format-char'[\s\S]{0,500}?this\.hasCharFormatTarget\(\)/);
  // applyCharFormat 이 셀 선택 분기를 갖는다
  assert.match(
    ih,
    /private applyCharFormat\(props[\s\S]{0,300}?isInCellSelectionMode\(\)[\s\S]{0,120}?applyCharFormatToSelectedCells\(props\)/,
  );
  // 토글·크기·장평·자간이 같은 게이트와 같은 현재값 기준을 쓴다
  for (const name of ['applyToggleFormat', 'adjustFontSize', 'adjustCharRatio', 'adjustCharSpacing']) {
    const re = new RegExp(
      `${name}\\([^)]*\\)[^{]*\\{\\s*if \\(!this\\.hasCharFormatTarget\\(\\)\\) return;\\s*const current = this\\.getCharPropertiesForFormatTarget\\(\\);`,
    );
    assert.match(ih, re, name);
  }
  // hasSelection 단독 게이트는 남아 있지 않다
  assert.equal(
    (ih.match(/if \(!this\.cursor\.hasSelection\(\)\) return;\s*const current = this\.getCharPropertiesAtCursor\(\);/g) ?? []).length,
    0,
  );
});

test('셀 선택 글자 서식은 빈 문단을 건너뛰고 셀 선택 오버레이를 다시 그린다', () => {
  const ih = source('src/engine/input-handler.ts');
  const start = ih.indexOf('private applyCharFormatToSelectedCells(');
  assert.ok(start >= 0);
  const body = ih.slice(start, ih.indexOf('private resolveSelectedCellsTarget(', start));
  assert.match(body, /operationType:\s*'charFormatCells'/);
  assert.match(body, /this\.updateCellSelection\(\)/);
  const whole = ih.slice(ih.indexOf('private applyCharFormatToWholeCell('));
  assert.match(
    whole,
    /if \(len <= 0\) continue;[\s\S]{0,80}?applyCharFormatInCell\(ctx\.sec, ctx\.ppi, ctx\.ci, cellIdx, p, 0, len, propsJson\)/,
  );
});

test('모양 붙여넣기는 셀 선택에서 글자 서식도 함께 적용한다', () => {
  const ih = source('src/engine/input-handler.ts');
  assert.match(ih, /isInCellSelectionMode\(\)\)\s*\{[\s\S]{0,300}?applyCopiedFormatToSelectedCells\(cellProps, charProps\)/);
  const start = ih.indexOf('private applyCopiedFormatToSelectedCells(');
  assert.ok(start >= 0);
  const body = ih.slice(start, ih.indexOf('/** 서식 토글 (커맨드 시스템용) */', start));
  assert.match(body, /setCellProperties\(/);
  assert.match(body, /applyCharFormatToWholeCell\(/);
  assert.equal(ih.includes('applyCopiedCellPropsToSelection('), false);
});

test('서식바 동기화는 셀 선택 중 선택 범위 첫 셀을 따르고, 셀 선택 갱신마다 다시 알린다', () => {
  const ih = source('src/engine/input-handler.ts');
  // 서식바 ▲▼ 는 표시값 ±1pt 절대값을 보낸다 — 표시값이 캐럿 셀을 따라가면 범위 밖 캐럿에서 증감이 누적되지 않는다
  const emit = ih.slice(ih.indexOf('private emitCursorFormatState(): void'));
  assert.match(emit.slice(0, 400), /const props = this\.getCharPropertiesForFormatTarget\(\);/);
  const start = ih.indexOf('private updateCellSelection(): void');
  const body = ih.slice(start, ih.indexOf('/** 선택 영역 하이라이트를 갱신한다 */', start));
  assert.match(body, /cellSelectionRenderer\.render\([\s\S]{0,200}?this\.emitCursorFormatState\(\)/);
});

test('셀 선택 유지 서식 커맨드 목록은 글자 서식만 담고 문단·스타일·대화상자는 뺀다', () => {
  const included = ['format:bold', 'format:italic', 'format:underline', 'format:strikethrough',
    'format:emboss', 'format:engrave', 'format:outline', 'format:superscript', 'format:subscript',
    'format:font-size-increase', 'format:font-size-decrease',
    'format:char-ratio-increase', 'format:char-ratio-decrease',
    'format:char-spacing-increase', 'format:char-spacing-decrease'];
  for (const id of included) assert.equal(CELL_SELECTION_CHAR_FORMAT_COMMANDS.has(id), true, id);
  // 문단 서식·스타일·대화상자는 아직 다중 셀을 모르므로 목록 밖 (Finding B·C)
  for (const id of ['format:char-shape', 'format:para-shape', 'format:apply-style',
    'format:align-left', 'format:line-spacing-increase', 'format:style-dialog']) {
    assert.equal(CELL_SELECTION_CHAR_FORMAT_COMMANDS.has(id), false, id);
  }
});

test('셀 선택 키 처리는 서식 단축키를 선택 해제 前에 그대로 dispatch 한다', () => {
  const kb = source('src/engine/input-handler-keyboard.ts');
  assert.match(kb, /import \{ CELL_SELECTION_CHAR_FORMAT_COMMANDS \} from '\.\/cell-selection-format'/);
  const block = kb.slice(kb.indexOf('if (this.cursor.isInCellSelectionMode()) {'));
  const dispatch = block.indexOf('CELL_SELECTION_CHAR_FORMAT_COMMANDS.has(fmtCmd)');
  // fall-through exit(그 외 키 → 셀 선택 모드 종료). block 첫 exit 은 Escape 핸들러라 앵커로 못 쓴다.
  const fallthrough = block.indexOf('그 외 키 → 셀 선택 모드 종료');
  assert.ok(dispatch >= 0, '서식 단축키 처리가 있어야 한다');
  assert.ok(fallthrough >= 0, '기존 fall-through exit 이 있어야 한다');
  assert.ok(dispatch < fallthrough, 'dispatch 가 fall-through exit 보다 앞이어야 한다');
  assert.match(block.slice(dispatch, dispatch + 200), /this\.dispatcher\?\.dispatch\(fmtCmd\)/);
});
