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
    'format:line-spacing-increase', 'format:line-spacing-decrease', 'format:apply-style'];
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
  // 커서 문단의 현재 상태로 판단하는 개요 수준·번호/글머리표 토글은 아직 밖
  for (const id of ['format:level-increase', 'format:level-decrease', 'format:toggle-numbering', 'format:toggle-bullet']) {
    assert.equal(CELL_SELECTION_FORMAT_COMMANDS.has(id), false, id);
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
  assert.match(ih, /getCurrentStyleId\(\): number \{[\s\S]{0,200}?this\.firstSelectedCell\(\)/);
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
  assert.match(kb, /import \{ CELL_SELECTION_FORMAT_COMMANDS \} from '\.\/cell-selection-format'/);
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
