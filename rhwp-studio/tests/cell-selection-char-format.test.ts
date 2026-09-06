import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  hasCharFormatTarget,
  isNestedCellPath,
  cellPathForCell,
  collectSelectedCellIndices,
  collectCellParaTargets,
  CELL_SELECTION_CHAR_FORMAT_COMMANDS,
  CELL_SELECTION_PARA_FORMAT_COMMANDS,
  CELL_SELECTION_FORMAT_DIALOG_COMMANDS,
  CELL_SELECTION_FORMAT_COMMANDS,
  CELL_SELECTION_HISTORY_COMMANDS,
  cellSelectionStillValid,
  outlineLevelOf,
  planOutlineLevelChange,
  HANCOM_MAX_OUTLINE_LEVEL,
  nestedRangeCellPaths,
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

test('셀 선택 글자 서식은 빈 문단도 (0,0) 범위로 넘기고 셀 선택 오버레이를 다시 그린다', () => {
  const ih = source('src/engine/input-handler.ts');
  // 툴바·단축키 경로: 지금의 셀 선택을 표적으로 잡아 applyCharPropsToCellSelection 에 위임
  const start = ih.indexOf('private applyCharFormatToSelectedCells(');
  assert.ok(start >= 0);
  const body = ih.slice(start, ih.indexOf('applyCharPropsToCellSelection(target: CellSelectionFormatTarget', start));
  assert.match(body, /resolveSelectedCellsTarget\(\)[\s\S]{0,200}?return this\.applyCharPropsToCellSelection\(target, props\)/);
  // 적용 본체: snapshot 한 단계 + 오버레이 갱신
  const apply = ih.slice(ih.indexOf('applyCharPropsToCellSelection(target: CellSelectionFormatTarget'));
  const applyBody = apply.slice(0, apply.indexOf('applyParaPropsToCellSelection('));
  assert.match(applyBody, /operationType:\s*'charFormatCells'/);
  assert.match(applyBody, /this\.refreshCellSelectionAfterFormat\(\)/);
  // 빈 문단(빈 셀)을 건너뛰지 않는다 — wasm 이 빈 문단의 CharShapeRef 를 통째로 바꾼다 (§7-3)
  const whole = ih.slice(ih.indexOf('private applyCharFormatToWholeCell('));
  const wholeBody = whole.slice(0, whole.indexOf('\n  }\n'));
  assert.equal(wholeBody.includes('if (len <= 0) continue;'), false, '빈 문단 건너뜀이 남아 있다');
  assert.match(wholeBody, /applyCharFormatInCell\(ctx\.sec, ctx\.ppi, ctx\.ci, cellIdx, p, 0, len, propsJson\)/);
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

test('셀 선택 유지 서식 커맨드 목록 — 글자·문단·대화상자 세 묶음과 그 합집합', () => {
  const chars = ['format:bold', 'format:italic', 'format:underline', 'format:strikethrough',
    'format:emboss', 'format:engrave', 'format:outline', 'format:superscript', 'format:subscript',
    'format:font-size-increase', 'format:font-size-decrease',
    'format:char-ratio-increase', 'format:char-ratio-decrease',
    'format:char-spacing-increase', 'format:char-spacing-decrease'];
  for (const id of chars) assert.equal(CELL_SELECTION_CHAR_FORMAT_COMMANDS.has(id), true, id);
  // 문단 서식·스타일은 getParaFormatTargetsAtCursor 가 다중 셀을 알게 되어 목록에 든다 (Finding C)
  const paras = ['format:align-left', 'format:align-center', 'format:align-right', 'format:align-justify',
    'format:align-distribute', 'format:align-split', 'format:line-spacing',
    'format:line-spacing-increase', 'format:line-spacing-decrease', 'format:apply-style',
    // 번호/글머리표 토글·개요 수준 — 첫 셀 상태로 방향을 정하고 셀 블록 전체에 적용
    'format:toggle-numbering', 'format:toggle-bullet', 'format:apply-bullet',
    'format:level-increase', 'format:level-decrease'];
  for (const id of paras) assert.equal(CELL_SELECTION_PARA_FORMAT_COMMANDS.has(id), true, id);
  // 대화상자는 열 때 표적을 잡아 두므로 목록에 든다 (Finding B)
  const dialogs = ['format:char-shape', 'format:para-shape', 'format:style-dialog'];
  for (const id of dialogs) assert.equal(CELL_SELECTION_FORMAT_DIALOG_COMMANDS.has(id), true, id);
  // 세 묶음은 서로 겹치지 않고 합집합이 키 처리용 목록이다
  for (const id of chars) {
    assert.equal(CELL_SELECTION_PARA_FORMAT_COMMANDS.has(id) || CELL_SELECTION_FORMAT_DIALOG_COMMANDS.has(id), false, id);
  }
  assert.equal(CELL_SELECTION_FORMAT_COMMANDS.size, chars.length + paras.length + dialogs.length);
  for (const id of [...chars, ...paras, ...dialogs]) assert.equal(CELL_SELECTION_FORMAT_COMMANDS.has(id), true, id);
  // 개요 수준·번호/글머리표 토글도 첫 셀 상태로 판단해 셀 블록 전체에 적용하므로 목록 안 (2026-09-03)
  for (const id of ['format:level-increase', 'format:level-decrease', 'format:toggle-numbering', 'format:toggle-bullet', 'format:apply-bullet']) {
    assert.equal(CELL_SELECTION_FORMAT_COMMANDS.has(id), true, id);
  }
});

test('셀 선택 문단 서식 대상은 선택한 모든 셀의 모든 문단이다 (빈 셀 포함)', () => {
  const table = { sec: 0, ppi: 3, ci: 1 };
  const paraCount = (cellIdx: number) => ({ 0: 2, 1: 1, 2: 0, 5: 3 } as Record<number, number>)[cellIdx] ?? 1;
  const targets = collectCellParaTargets(table, [0, 1, 5], paraCount);
  assert.deepEqual(targets, [
    { kind: 'cell', sec: 0, parentPara: 3, controlIdx: 1, cellIdx: 0, cellParaIdx: 0 },
    { kind: 'cell', sec: 0, parentPara: 3, controlIdx: 1, cellIdx: 0, cellParaIdx: 1 },
    { kind: 'cell', sec: 0, parentPara: 3, controlIdx: 1, cellIdx: 1, cellParaIdx: 0 },
    { kind: 'cell', sec: 0, parentPara: 3, controlIdx: 1, cellIdx: 5, cellParaIdx: 0 },
    { kind: 'cell', sec: 0, parentPara: 3, controlIdx: 1, cellIdx: 5, cellParaIdx: 1 },
    { kind: 'cell', sec: 0, parentPara: 3, controlIdx: 1, cellIdx: 5, cellParaIdx: 2 },
  ]);
  // 문단이 0개로 보고되는 셀은 대상이 없다 (wasm 이 빈 셀도 문단 1개로 보고하므로 실제로는 안 생긴다)
  assert.deepEqual(collectCellParaTargets(table, [2], paraCount), []);
  assert.deepEqual(collectCellParaTargets(table, [], paraCount), []);
});

test('문단 서식·스타일 대상은 셀 선택 중 선택한 셀 전체를 향한다 (Finding C)', () => {
  const ih = source('src/engine/input-handler.ts');
  const start = ih.indexOf('private getParaFormatTargetsAtCursor(): ParaFormatTarget[]');
  assert.ok(start >= 0);
  const body = ih.slice(start, ih.indexOf('private getParaFormatTargetsForRange(', start));
  assert.match(body, /isInCellSelectionMode\(\)[\s\S]{0,200}?resolveSelectedCellsTarget\(\)[\s\S]{0,120}?getParaFormatTargetsForCellSelection\(target\)/);
  assert.match(body, /collectCellParaTargets\(/);
  // 문단 서식·스타일 적용 뒤 셀 선택 오버레이를 다시 그린다 (행 높이 변화)
  const pf = ih.slice(ih.indexOf('private applyParaFormat(props'));
  assert.match(pf.slice(0, 400), /executeParaFormatCommand\(targets, props\)\) this\.refreshCellSelectionAfterFormat\(\)/);
  const st = ih.slice(ih.indexOf('  applyStyle(styleId: number): void {'));
  assert.match(st.slice(0, 1200), /operationType: 'applyStyle', operation \}\);\s*this\.refreshCellSelectionAfterFormat\(\)/);
  // 대화상자용 조회는 셀 선택 첫 셀을 따른다
  assert.match(ih, /getCharProperties\(\): CharProperties \{\s*return this\.getCharPropertiesForFormatTarget\(\);/);
  assert.match(ih, /getParaProperties\(\): ParaProperties \{\s*return this\.getParaPropertiesForFormatTarget\(\);/);
  assert.match(ih, /getCurrentStyleId\(\): number \{[\s\S]{0,120}?this\.getCurrentStyleInfo\(\)\.id/);
  assert.match(ih, /getCurrentStyleInfo\(\): \{ id: number; name: string \} \{[\s\S]{0,120}?this\.firstSelectedCell\(\)/);
});

test('글자 모양·문단 모양 대화상자는 셀 선택 표적을 열 때 잡아 두고 적용 시 그 표적에 쓴다 (Finding B)', () => {
  const fmt = source('src/command/commands/format.ts');
  const cs = fmt.slice(fmt.indexOf("id: 'format:char-shape'"), fmt.indexOf("id: 'format:para-shape'"));
  assert.match(cs, /captureCellSelectionFormatTarget\(\)/);
  assert.match(cs, /const savedSel = cellTarget \? null : ih\.getSelection\(\);/);
  assert.match(cs, /if \(!cellTarget && !savedSel\) return;/);
  assert.match(cs, /if \(cellTarget\) ih\.applyCharPropsToCellSelection\(cellTarget, mods\);/);
  assert.match(cs, /else if \(savedSel\) ih\.applyCharPropsToRange\(savedSel\.start, savedSel\.end, mods\);/);
  const ps = fmt.slice(fmt.indexOf("id: 'format:para-shape'"), fmt.indexOf("id: 'format:apply-style'"));
  assert.match(ps, /captureCellSelectionFormatTarget\(\)/);
  assert.match(ps, /if \(cellTarget\) ih\.applyParaPropsToCellSelection\(cellTarget, mods\);/);
  // 표적은 제외 셀의 사본을 품는다 — 대화상자 조작 중 선택이 바뀌어도 적용 대상이 고정된다
  const ih = source('src/engine/input-handler.ts');
  assert.match(ih, /export type CellSelectionFormatTarget = \{[\s\S]{0,200}?excluded: ReadonlySet<string>;/);
  assert.match(ih, /return \{ ctx, range, excluded: new Set\(this\.cursor\.getExcludedCells\(\)\) \};/);
  const cap = ih.slice(ih.indexOf('captureCellSelectionFormatTarget(): CellSelectionFormatTarget | null'));
  assert.match(cap.slice(0, 300), /if \(!this\.cursor\.isInCellSelectionMode\(\)\) return null;\s*return this\.resolveSelectedCellsTarget\(\);/);
});

test('서식바 적용이 거부되면 표시값을 실제 서식으로 되돌린다 (§7-4)', () => {
  const ih = source('src/engine/input-handler.ts');
  const recv = ih.slice(ih.indexOf("eventBus.on('format-char'"));
  const body = recv.slice(0, recv.indexOf('});'));
  assert.match(body, /const applied = this\.editMode !== 'form'\s*&& this\.hasCharFormatTarget\(\)\s*&& this\.applyCharFormat\(/);
  assert.match(body, /if \(!applied\) \{[\s\S]{0,400}?this\.emitCursorFormatState\(\);/);
  // applyCharFormat 은 적용 여부를 돌려준다 (셀 경로는 중첩 표에서 false)
  assert.match(ih, /private applyCharFormat\(props: Partial<CharProperties>\): boolean \{[\s\S]{0,200}?return this\.applyCharFormatToSelectedCells\(props\);/);
});

test('셀 선택 키 처리는 서식 단축키를 선택 해제 前에 그대로 dispatch 한다', () => {
  const kb = source('src/engine/input-handler-keyboard.ts');
  assert.match(kb, /import \{ CELL_SELECTION_FORMAT_COMMANDS(?:, CELL_SELECTION_HISTORY_COMMANDS)? \} from '\.\/cell-selection-format'/);
  const block = kb.slice(kb.indexOf('if (this.cursor.isInCellSelectionMode()) {'));
  const dispatch = block.indexOf('CELL_SELECTION_FORMAT_COMMANDS.has(fmtCmd)');
  // fall-through exit(그 외 키 → 셀 선택 모드 종료). block 첫 exit 은 Escape 핸들러라 앵커로 못 쓴다.
  const fallthrough = block.indexOf('그 외 키 → 셀 선택 모드 종료');
  assert.ok(dispatch >= 0, '서식 단축키 처리가 있어야 한다');
  assert.ok(fallthrough >= 0, '기존 fall-through exit 이 있어야 한다');
  assert.ok(dispatch < fallthrough, 'dispatch 가 fall-through exit 보다 앞이어야 한다');
  assert.match(block.slice(dispatch, dispatch + 200), /this\.dispatcher\?\.dispatch\(fmtCmd\)/);
});

// ─── 중첩 표 — 경로 기반 서식 API ────────────────────────────────────────
// 종전에는 cellPath 깊이 2 이상이면 "미지원" 안내 후 무동작이었다. 이제 wasm `…ByPath` 6종으로
// 같은 흐름(셀 순회 → 문단 순회 → 적용/조회)을 경로로 탄다. rhwp-cai docs/셀선택-중첩표-경로기반서식-20260903-*.md

test('cellPathForCell 은 마지막 항목의 셀·문단만 바꾼다 (앞 항목은 바깥 표 경로라 그대로)', () => {
  const base = [
    { controlIndex: 3, cellIndex: 1, cellParaIndex: 0 },
    { controlIndex: 0, cellIndex: 2, cellParaIndex: 1 },
  ];
  assert.deepEqual(cellPathForCell(base, 5), [
    { controlIndex: 3, cellIndex: 1, cellParaIndex: 0 },
    { controlIndex: 0, cellIndex: 5, cellParaIndex: 0 },
  ]);
  assert.deepEqual(cellPathForCell(base, 5, 2)[1], { controlIndex: 0, cellIndex: 5, cellParaIndex: 2 });
  // 원본 불변·새 객체
  assert.deepEqual(base[1], { controlIndex: 0, cellIndex: 2, cellParaIndex: 1 });
  assert.notEqual(cellPathForCell(base, 0)[0], base[0]);
  // 깊이 1 도 같은 규칙
  assert.deepEqual(cellPathForCell([{ controlIndex: 7, cellIndex: 0, cellParaIndex: 0 }], 3, 1), [
    { controlIndex: 7, cellIndex: 3, cellParaIndex: 1 },
  ]);
  assert.throws(() => cellPathForCell([], 0));
});

test('중첩 표의 문단 서식 대상은 셀·문단마다 경로를 가진 path 대상이다', () => {
  const cellPath = [
    { controlIndex: 3, cellIndex: 1, cellParaIndex: 0 },
    { controlIndex: 0, cellIndex: 0, cellParaIndex: 0 },
  ];
  const paraCountAt = (cellIdx: number) => (cellIdx === 2 ? 2 : 1);
  const targets = collectCellParaTargets({ sec: 0, ppi: 4, ci: 3, cellPath }, [1, 2], paraCountAt);
  assert.deepEqual(targets, [
    { kind: 'path', sec: 0, parentPara: 4, cellPath: [cellPath[0], { controlIndex: 0, cellIndex: 1, cellParaIndex: 0 }] },
    { kind: 'path', sec: 0, parentPara: 4, cellPath: [cellPath[0], { controlIndex: 0, cellIndex: 2, cellParaIndex: 0 }] },
    { kind: 'path', sec: 0, parentPara: 4, cellPath: [cellPath[0], { controlIndex: 0, cellIndex: 2, cellParaIndex: 1 }] },
  ]);
  // 깊이 1 (cellPath 1개 또는 없음) 은 종전대로 cell 대상
  const flat = collectCellParaTargets({ sec: 0, ppi: 4, ci: 3, cellPath: [cellPath[0]] }, [1], paraCountAt);
  assert.deepEqual(flat, [{ kind: 'cell', sec: 0, parentPara: 4, controlIdx: 3, cellIdx: 1, cellParaIdx: 0 }]);
  assert.deepEqual(collectCellParaTargets({ sec: 0, ppi: 4, ci: 3 }, [1], paraCountAt), flat);
});

test('셀 선택 표적 해석은 중첩 표를 거르지 않고, 셀 순회·적용·조회가 경로 기반 API 를 탄다', () => {
  const ih = source('src/engine/input-handler.ts');
  const resolve = ih.slice(ih.indexOf('private resolveSelectedCellsTarget(): CellSelectionFormatTarget | null {'));
  const resolveBody = resolve.slice(0, resolve.indexOf('\n  }\n'));
  assert.doesNotMatch(resolveBody, /isNestedCellPath|아직 지원하지 않습니다/, '중첩 표 거부가 남아 있으면 안 된다');
  // 셀 순회: 표 크기·셀 좌표를 경로로
  const sel = ih.slice(ih.indexOf('private selectedCellIndices('));
  assert.match(sel.slice(0, 700), /getTableDimensionsByPath\([\s\S]{0,200}?getCellInfoByPath\(/);
  // 글자 서식: 문단 길이·적용을 경로로
  const whole = ih.slice(ih.indexOf('private applyCharFormatToWholeCell('));
  assert.match(whole.slice(0, 900), /getCellParagraphLengthByPath\([\s\S]{0,200}?applyCharFormatInCellByPath\(/);
  // 조회 셋(글자·문단·스타일)이 경로 변형을 가진다
  assert.match(ih, /getCharPropertiesByPath\(ctx\.sec, ctx\.ppi, this\.cellPathJsonFor\(/);
  assert.match(ih, /getParaPropertiesByPath\(ctx\.sec, ctx\.ppi, this\.cellPathJsonFor\(/);
  assert.match(ih, /getStyleByPath\(ctx\.sec, ctx\.ppi, this\.cellPathJsonFor\(/);
  // 스타일 적용의 path 갈래
  assert.match(ih, /if \(target\.kind === 'path'\) \{\s*wasm\.applyStyleByPath\(/);
  // 문단 서식 커맨드의 path 갈래 (적용·조회·복원)
  const cmd = source('src/engine/command.ts');
  assert.match(cmd, /\| \{ kind: 'path'; sec: number; parentPara: number; cellPath: CellPathEntry\[\] \}/);
  assert.match(cmd, /wasm\.applyParaFormatInCellByPath\(target\.sec, target\.parentPara, JSON\.stringify\(target\.cellPath\), propsJson\)/);
  assert.match(cmd, /wasm\.setParaShapeIdByPath\(target\.sec, target\.parentPara, JSON\.stringify\(target\.cellPath\), paraShapeId\)/);
  assert.match(cmd, /wasm\.getParaPropertiesByPath\(target\.sec, target\.parentPara, JSON\.stringify\(target\.cellPath\)\)/);
});

test('번호/글머리표 토글은 셀 선택 첫 셀 상태로 판단하고 셀 블록 전체에 적용한다 (한컴 실측 2026-09-06 §3 일치)', () => {
  const ih = source('src/engine/input-handler.ts');
  // 토글 방향: getParaProperties() = 셀 선택 중 첫 셀 첫 문단
  const num = ih.slice(ih.indexOf('  toggleNumbering(): void {'));
  assert.match(num.slice(0, 400), /const props = this\.getParaProperties\(\);[\s\S]{0,200}?this\.applyParaFormat\(/);
  const bul = ih.slice(ih.indexOf('  toggleBullet(bulletChar'));
  assert.match(bul.slice(0, 400), /const props = this\.getParaProperties\(\);[\s\S]{0,200}?this\.applyParaFormat\(/);
  // 스타일 대화상자 현재값은 여전히 첫 셀
  const info = ih.slice(ih.indexOf('  private getCurrentStyleInfo():'));
  assert.match(info.slice(0, 300), /const first = this\.firstSelectedCell\(\);\s*if \(first\) return this\.cellStyleAt\(first\.ctx, first\.cellIdx, 0\);/);
});

// ─── E8 개요 수준 ▲▼ — 한컴 규칙 (2026-09-06 한컴 실측, rhwp-cai docs/E1-한컴실측-…-20260906-0128.md §2) ─────
// 첫 셀 기준이 아니라 문단마다: 개요 문단만 각자 ±1, 비개요 불변, 개요 1 ▲ 는 해제, 개요 없는 블록 ▼ 는 전부 개요(앞선 수준 계승), ▲ 무동작.

test('outlineLevelOf: 개요 스타일 이름에서 수준을 읽는다', () => {
  assert.equal(outlineLevelOf('개요 1'), 1);
  assert.equal(outlineLevelOf('개요 10'), 10);
  assert.equal(outlineLevelOf('개요2'), 2);
  assert.equal(outlineLevelOf('바탕글'), null);
  assert.equal(outlineLevelOf('본문'), null);
  assert.equal(outlineLevelOf(undefined), null);
});

test('planOutlineLevelChange: 혼합 블록 ▼ 는 개요 문단만 +1, 비개요 불변 (v2a·v2c)', () => {
  assert.deepEqual(planOutlineLevelChange([null, 2], 1, 7, null), [null, 3]);
  assert.deepEqual(planOutlineLevelChange([null, 2, 3], 1, 7, null), [null, 3, 4]);
  // 확장 방향·캐럿 셀 무관 — 입력 순서만 문서 순이면 결과 같다 (v2e)
  assert.deepEqual(planOutlineLevelChange([null, 2, 3], 1, 7, 5), [null, 3, 4]);
});

test('planOutlineLevelChange: 개요만 있는 블록은 각자 ±1 — 첫 셀 수준으로 맞추지 않는다 (v2b·v2d)', () => {
  assert.deepEqual(planOutlineLevelChange([2, 3], 1, 7, null), [3, 4]);
  assert.deepEqual(planOutlineLevelChange([null, 2, 3], -1, 7, null), [null, 1, 2]);
});

test('planOutlineLevelChange: 개요 1 ▲ 도 개요 7 ▼ 도 개요 해제 — 양 끝에서 풀린다 (w3·w4 · E9 §1)', () => {
  assert.deepEqual(planOutlineLevelChange([2], -1, 7, null), [1]);
  assert.deepEqual(planOutlineLevelChange([1], -1, 7, null), ['body']);
  // 한컴 실측(E9 §1): 개요 7 에서 한 번 더 증가하면 번호가 사라지고 바탕글이 된다. 종전 기대값은 [2, null] 이었다.
  assert.deepEqual(planOutlineLevelChange([1, 7], 1, 7, null), [2, 'body']);
  assert.deepEqual(planOutlineLevelChange([7], 1, 7, null), ['body']);
});

test('planOutlineLevelChange: 상한에서 풀린 뒤 ▼ 는 개요 1 → 2 로 재진입한다 (E9 §1 표 7·8번째)', () => {
  // 7 에서 ▼ → 해제. 그 문단은 이제 비개요이므로 다음 ▼ 는 규칙 3(개요 없는 블록)이 받는다.
  assert.deepEqual(planOutlineLevelChange([7], 1, 7, null), ['body']);
  assert.deepEqual(planOutlineLevelChange([null], 1, 7, null), [1]);   // 7번째 — 앞선 개요 없음 → 1
  assert.deepEqual(planOutlineLevelChange([1], 1, 7, null), [2]);      // 8번째 — 개요 1 → 2
});

test('HANCOM_MAX_OUTLINE_LEVEL 은 문서 스타일 목록이 아니라 한컴 고정 7 이다 (E9)', () => {
  assert.equal(HANCOM_MAX_OUTLINE_LEVEL, 7);
  // 실측 픽스처는 「개요 1」~「개요 10」 을 갖고도 7 에서 풀렸다 — 스타일 최대치를 상한으로 쓰면 8·9·10 까지 간다.
  assert.deepEqual(planOutlineLevelChange([7], 1, HANCOM_MAX_OUTLINE_LEVEL, null), ['body']);
  assert.deepEqual(planOutlineLevelChange([7], 1, 10, null), [8], '스타일 최대치를 넣으면 한컴과 갈린다(반증용)');
  const ih = source('src/engine/input-handler.ts');
  const lvl = ih.slice(ih.indexOf('  changeOutlineLevel(delta: number): void {'));
  const lvlBody = lvl.slice(0, lvl.indexOf('\n  }\n'));
  assert.match(lvlBody, /const maxLevel = HANCOM_MAX_OUTLINE_LEVEL;/);
  assert.doesNotMatch(lvlBody, /const maxLevel = Math\.max\(\.\.\.outlineByLevel\.keys\(\)\)/,
    '상한을 문서 스타일 목록에서 뽑으면 개요 10 문서에서 한컴과 갈린다 (E9 §1)');
});

test('planOutlineLevelChange: 개요 없는 블록 ▼ 는 전부 개요(앞선 개요 수준 계승, 없으면 1), ▲ 는 무동작 (w1·w2·t2b)', () => {
  assert.deepEqual(planOutlineLevelChange([null, null], 1, 7, 3), [3, 3]);
  assert.deepEqual(planOutlineLevelChange([null], 1, 7, null), [1]);
  assert.deepEqual(planOutlineLevelChange([null, null], -1, 7, 3), [null, null]);
  assert.deepEqual(planOutlineLevelChange([null], 1, 3, 9), [3]);
});

test('changeOutlineLevel 은 문단마다 스타일을 읽어 계획대로 한 스냅샷에 적용한다 (E8)', () => {
  const ih = source('src/engine/input-handler.ts');
  const lvl = ih.slice(ih.indexOf('  changeOutlineLevel(delta: number): void {'));
  const lvlBody = lvl.slice(0, lvl.indexOf('\n  }\n'));
  assert.match(lvlBody, /const targets = this\.getParaFormatTargetsAtCursor\(\);/);
  assert.match(lvlBody, /targets\.map\(\(t, i\) => this\.outlineLevelOfTarget\(t, /);
  assert.match(lvlBody, /planOutlineLevelChange\(levels, delta, maxLevel, preceding\)/);
  assert.match(lvlBody, /operationType: 'applyStyle', operation \}\);\s*this\.refreshCellSelectionAfterFormat\(\)/);
  assert.doesNotMatch(lvlBody, /getCurrentStyleInfo\(\)/, '첫 셀 규칙(UI-5)이 남아 있으면 안 된다');
  assert.doesNotMatch(lvlBody, /this\.applyStyle\(/, '문단마다 스냅샷을 나누면 되돌리기가 여러 단계가 된다');
  // E8-b 결함 2: 스타일만 바꾸면 직접 서식 문단의 para_shape 가 보존돼 head/level 이 안 바뀐다(번호 미렌더).
  // 같은 스냅샷 안에서 head 를 명시해야 한다.
  assert.match(lvlBody, /headType: 'Outline', paraLevel: entry - 1/);
  assert.match(lvlBody, /headType: 'None'/);
  assert.match(lvlBody, /applyStyleToParaTarget\(wasm, target, styleId\);\s*applyParaFormatToTarget\(wasm, target, propsJson\);/);
  // 세 갈래 조회·적용
  const st = ih.slice(ih.indexOf('  private styleOfParaTarget(target: ParaFormatTarget)'));
  assert.match(st.slice(0, 600), /getStyleAt\(target\.sec, target\.para\)[\s\S]*getStyleByPath\(target\.sec, target\.parentPara, JSON\.stringify\(target\.cellPath\)\)[\s\S]*getCellStyleAt\(target\.sec, target\.parentPara, target\.controlIdx, target\.cellIdx, target\.cellParaIdx\)/);
});

test('개요 수준 읽기는 문단 모양의 head/level 을 먼저 보고, 앞선 수준 탐색은 같은 셀의 앞 문단부터 본다 (E8-b)', () => {
  const ih = source('src/engine/input-handler.ts');
  // 결함 2: 렌더 번호는 head_type/para_level 이 정한다 — 스타일 이름은 폴백
  const lot = ih.slice(ih.indexOf('  private outlineLevelOfTarget(target: ParaFormatTarget'));
  const lotBody = lot.slice(0, lot.indexOf('\n  }\n'));
  assert.match(lotBody, /headType === 'Outline'/);
  assert.match(lotBody, /return level \+ 1;/);
  assert.match(lotBody, /return outlineLevelOf\(this\.styleOfParaTarget\(target\)\?\.name\);/);
  // 결함 1: 같은 셀의 앞 문단이 문서 순 직전이다
  const pre = ih.slice(ih.indexOf('  private precedingOutlineLevel(target: ParaFormatTarget)'));
  const preBody = pre.slice(0, pre.indexOf('\n  }\n'));
  const sameCell = preBody.indexOf('for (let p = cellParaIdx - 1; p >= 0; p--)');
  const prevCell = preBody.indexOf('for (let c = cellIdx - 1; c >= 0; c--)');
  assert.ok(sameCell >= 0 && prevCell >= 0 && sameCell < prevCell, '같은 셀 앞 문단을 앞 셀보다 먼저 본다');
  const sameCellPath = preBody.indexOf('for (let p = (last.cellParaIndex ?? 0) - 1; p >= 0; p--)');
  const prevCellPath = preBody.indexOf('for (let c = last.cellIndex - 1; c >= 0; c--)');
  assert.ok(sameCellPath >= 0 && prevCellPath >= 0 && sameCellPath < prevCellPath, '경로 대상도 같은 셀 앞 문단이 먼저다');
  assert.doesNotMatch(preBody, /const level = \(st: \{ name: string \} \| null\)/, '스타일 이름만 읽던 지역 헬퍼는 폐기');
});

// ─── E2 되돌리기/다시 실행이 셀 선택을 풀지 않는다 (한컴 실측 2026-09-06 §1: 블록→굵게→Ctrl+Z 뒤 블록 잔존) ─────

test('셀 선택 키 처리는 되돌리기/다시 실행 단축키도 선택 해제 前에 그대로 dispatch 한다 (E2)', () => {
  assert.deepEqual([...CELL_SELECTION_HISTORY_COMMANDS].sort(), ['edit:redo', 'edit:undo']);
  for (const id of CELL_SELECTION_HISTORY_COMMANDS) assert.equal(CELL_SELECTION_FORMAT_COMMANDS.has(id), false, id);
  const kb = source('src/engine/input-handler-keyboard.ts');
  assert.match(kb, /import \{ CELL_SELECTION_FORMAT_COMMANDS, CELL_SELECTION_HISTORY_COMMANDS \} from '\.\/cell-selection-format'/);
  const block = kb.slice(kb.indexOf('if (this.cursor.isInCellSelectionMode()) {'));
  const dispatch = block.indexOf('CELL_SELECTION_HISTORY_COMMANDS.has(histCmd)');
  const fallthrough = block.indexOf('그 외 키 → 셀 선택 모드 종료');
  assert.ok(dispatch >= 0 && fallthrough >= 0 && dispatch < fallthrough, 'undo/redo dispatch 가 fall-through exit 보다 앞이어야 한다');
  assert.match(block.slice(dispatch, dispatch + 200), /this\.dispatcher\?\.dispatch\(histCmd\)/);
});

test('undo/redo 뒤 셀 선택 표 문맥을 재검증하고, 유효하면 오버레이·서식바를 다시 그린다 (E2)', () => {
  const ih = source('src/engine/input-handler.ts');
  for (const fn of ['handleUndo', 'handleRedo']) {
    const body = ih.slice(ih.indexOf(`  private ${fn}(): void {`), ih.indexOf(`  private ${fn}(): void {`) + 700);
    assert.match(body, /this\.cursor\.moveTo\(newPos\);[\s\S]{0,120}?this\.afterEdit\([^)]*\);\s*this\.refreshCellSelectionAfterHistoryJump\(\);/, fn);
  }
  const rf = ih.slice(ih.indexOf('  private refreshCellSelectionAfterHistoryJump(): void {'));
  assert.match(rf.slice(0, 400), /if \(this\.cursor\.revalidateCellSelectionAfterHistoryJump\(\)\) \{\s*this\.updateCellSelection\(\);/);
  assert.match(rf.slice(0, 500), /this\.cellSelectionRenderer\?\.clear\(\);\s*this\.updateCaret\(\);/);
  const cur = source('src/engine/cursor.ts');
  const rv = cur.slice(cur.indexOf('  revalidateCellSelectionAfterHistoryJump(): boolean {'));
  assert.match(rv.slice(0, 900), /getTableDimensionsByPath\(sec, ppi, JSON\.stringify\(cellPath\)\)[\s\S]*getTableDimensions\(sec, ppi, ci\)/);
  assert.match(rv.slice(0, 900), /cellSelectionStillValid\(this\.cellTableCtx, this\.getSelectedCellRange\(\), dims\) \|\| !this\.isCaretInCellSelectionTable\(\)\) \{\s*this\.exitCellSelectionMode\(\);\s*return false;/);
});

test('cellSelectionStillValid: 표가 없거나 크기가 달라졌거나 범위가 밖이면 거부한다 (E2)', () => {
  const ctx = { rowCount: 3, colCount: 4 };
  const range = { startRow: 0, startCol: 0, endRow: 1, endCol: 1 };
  assert.equal(cellSelectionStillValid(ctx, range, { rowCount: 3, colCount: 4 }), true);
  assert.equal(cellSelectionStillValid(ctx, range, null), false, '표 삭제 되돌리기');
  assert.equal(cellSelectionStillValid(ctx, range, { rowCount: 2, colCount: 4 }), false, '행 삭제 되돌리기');
  assert.equal(cellSelectionStillValid(ctx, range, { rowCount: 3, colCount: 5 }), false, '열 추가 다시 실행');
  assert.equal(cellSelectionStillValid(ctx, null, { rowCount: 3, colCount: 4 }), false);
  assert.equal(cellSelectionStillValid({ rowCount: 2, colCount: 2 }, { startRow: 0, startCol: 0, endRow: 2, endCol: 0 }, { rowCount: 2, colCount: 2 }), false, '범위 밖');
});

// 중첩 셀 캐럿(비-F5) — 서식바가 호스트 문단을 읽고 정렬·문단 모양이 무동작이던 결함(E5, 2026-09-04 제품 표면 실측).
// 텍스트 범위가 같은 중첩 셀 안이면 문단마다 경로 표적, 셀을 넘으면 표적 없음.
const outer = { controlIndex: 2, cellIndex: 1, cellParaIndex: 3 };
const innerPath = (cellIndex: number, cellParaIndex: number) => [outer, { controlIndex: 0, cellIndex, cellParaIndex }];

test('nestedRangeCellPaths: 캐럿 하나(같은 위치)는 그 문단 경로 하나', () => {
  const p = innerPath(0, 0);
  assert.deepEqual(nestedRangeCellPaths(p, p), [innerPath(0, 0)]);
});

test('nestedRangeCellPaths: 같은 셀의 문단 2~0 범위는 순서를 정렬해 문단마다 경로', () => {
  const paths = nestedRangeCellPaths(innerPath(1, 2), innerPath(1, 0));
  assert.deepEqual(paths, [innerPath(1, 0), innerPath(1, 1), innerPath(1, 2)]);
});

test('nestedRangeCellPaths: 다른 셀·다른 표·깊이 불일치·깊이 1 은 null', () => {
  assert.equal(nestedRangeCellPaths(innerPath(0, 0), innerPath(1, 0)), null, '다른 셀');
  assert.equal(nestedRangeCellPaths(innerPath(0, 0), [outer, { controlIndex: 1, cellIndex: 0, cellParaIndex: 0 }]), null, '다른 안쪽 표');
  assert.equal(nestedRangeCellPaths(innerPath(0, 0), [{ ...outer, cellIndex: 0 }, { controlIndex: 0, cellIndex: 0, cellParaIndex: 0 }]), null, '바깥 경로가 다름');
  assert.equal(nestedRangeCellPaths(innerPath(0, 0), [outer]), null, '깊이 불일치');
  assert.equal(nestedRangeCellPaths([outer], [outer]), null, '깊이 1 은 flat 경로 몫');
  assert.equal(nestedRangeCellPaths(undefined, innerPath(0, 0)), null);
});

test('nestedRangeCellPaths: 반환 경로는 입력 배열과 객체를 공유하지 않는다', () => {
  const p = innerPath(0, 1);
  const [q] = nestedRangeCellPaths(p, p)!;
  assert.notEqual(q, p); assert.notEqual(q[0], p[0]); assert.deepEqual(q, p);
});
