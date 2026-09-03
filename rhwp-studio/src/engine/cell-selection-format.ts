/**
 * F5 셀 선택(셀 블록) 모드에서의 글자·문단 서식 적용 — 순수 판정 함수 모음.
 *
 * `CursorState.hasSelection()` 은 텍스트 anchor 만 보고 셀 격자 선택(`cellAnchor`/`cellFocus`)을
 * 모른다. 그래서 셀을 골라 글꼴·크기·굵게·글자색을 바꾸면 서식바 숫자만 바뀌고 문서는 그대로였다.
 * 여기 있는 함수는 그 게이트와 셀 순회 규칙을 wasm 없이 단위 검증할 수 있게 뽑아 둔 것이다.
 * 진단: rhwp-cai `docs/셀선택-글자서식-무동작-진단과수리방안-20260831-2323.md`.
 * 후속(글자 모양·문단 모양 대화상자, 문단 서식 다중 셀, 빈 셀, 표시값 되돌림):
 * rhwp-cai `docs/셀선택-서식-후속-B-C-빈셀-표시값-20260902-1845.md`.
 * 중첩 표(경로 기반 wasm API `…ByPath` 6종으로 깊이 2 이상도 같은 흐름):
 * rhwp-cai `docs/셀선택-중첩표-경로기반서식-20260903-*.md`.
 */

import type { CellPathEntry } from '@/core/types';

export interface CharFormatTargetContext {
  /** 텍스트 범위 선택(anchor)이 있는가 */
  hasSelection: boolean;
  /** F5 셀 선택 모드인가 */
  inCellSelectionMode: boolean;
}

/** 글자 서식을 적용할 대상이 있는가 — 텍스트 범위 또는 셀 격자 선택. */
export function hasCharFormatTarget(ctx: CharFormatTargetContext): boolean {
  return ctx.hasSelection || ctx.inCellSelectionMode;
}

export interface CellGridRange {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

export interface CellGridPos {
  row: number;
  col: number;
}

/**
 * 중첩 표(cellPath 깊이 2 이상)인가.
 * 깊이 1 은 flat API(`applyCharFormatInCell` 등), 깊이 2 이상은 경로 기반 API(`…ByPath`)를 탄다 —
 * 두 갈래의 wasm 동작은 같고(네이티브가 깊이 1 을 flat 에 위임) 호출 형식만 다르다.
 */
export function isNestedCellPath(cellPath: { length: number } | null | undefined): boolean {
  return (cellPath?.length ?? 0) > 1;
}

/**
 * 셀 선택이 걸린 표의 cellPath(캐럿 셀 기준)에서 다른 셀·문단을 가리키는 경로를 만든다 —
 * 마지막 항목의 cellIndex·cellParaIndex 만 바꾼다(앞 항목은 바깥 표들을 지나는 경로라 그대로).
 * 경로 기반 wasm API 는 이 경로의 마지막 항목을 대상 표·셀·문단으로 읽는다.
 */
export function cellPathForCell(
  basePath: readonly CellPathEntry[],
  cellIdx: number,
  cellParaIdx = 0,
): CellPathEntry[] {
  if (basePath.length === 0) throw new Error('cellPathForCell: 빈 경로');
  return basePath.map((entry, i) =>
    i === basePath.length - 1 ? { ...entry, cellIndex: cellIdx, cellParaIndex: cellParaIdx } : { ...entry },
  );
}

/**
 * 표의 셀 가운데 선택 범위에 들고 Ctrl+클릭으로 제외되지 않은 셀 인덱스를 셀 순서대로 돌려준다.
 * 병합 셀은 `getCellInfo` 가 주는 시작 좌표(row/col)로 판정한다 — 모양 복사와 같은 규칙.
 */
export function collectSelectedCellIndices(
  cellCount: number,
  cellAt: (cellIdx: number) => CellGridPos,
  range: CellGridRange,
  excluded: ReadonlySet<string>,
): number[] {
  const picked: number[] = [];
  for (let cellIdx = 0; cellIdx < cellCount; cellIdx++) {
    const { row, col } = cellAt(cellIdx);
    if (row < range.startRow || row > range.endRow || col < range.startCol || col > range.endCol) continue;
    if (excluded.has(`${row},${col}`)) continue;
    picked.push(cellIdx);
  }
  return picked;
}

/**
 * F5 셀 선택을 유지한 채 적용해야 하는 글자 서식 커맨드 id.
 * 이 커맨드들은 toggleFormat·adjustFontSize/CharRatio/CharSpacing 로 라우팅되며 셀 선택을 안다.
 * 셀 선택 키 처리가 이 목록의 단축키(Ctrl+B/I/U·Ctrl+]/[ 등)를 만나면 선택을 해제하지 말고
 * 그대로 dispatch 한다 — 안 그러면 셀 선택만 풀리고 무동작이 되어 툴바 버튼과 어긋난다.
 */
export const CELL_SELECTION_CHAR_FORMAT_COMMANDS: ReadonlySet<string> = new Set([
  'format:bold', 'format:italic', 'format:underline', 'format:strikethrough',
  'format:emboss', 'format:engrave', 'format:outline',
  'format:superscript', 'format:subscript',
  'format:font-size-increase', 'format:font-size-decrease',
  'format:char-ratio-increase', 'format:char-ratio-decrease',
  'format:char-spacing-increase', 'format:char-spacing-decrease',
]);

/**
 * F5 셀 선택을 유지한 채 적용해야 하는 문단 서식·스타일 커맨드 id.
 * `getParaFormatTargetsAtCursor` 가 셀 선택 중에는 선택한 모든 셀의 모든 문단을 대상으로 잡으므로
 * 정렬·줄 간격·스타일이 캐럿 셀 하나가 아니라 셀 블록 전체에 적용된다(한컴 정합).
 * 번호/글머리표 토글·개요 수준도 같은 규칙이다 — "지금 상태" 는 **선택 범위 첫 셀의 첫 문단**으로 판단하고
 * (`getParaProperties`·`getCurrentStyleInfo`), 적용은 셀 블록 전체. 한컴도 블록의 첫 문단 상태로 토글 방향을 정한다.
 * 이 넷은 지금 단축키가 없어(툴바·메뉴만) 키 처리에는 안 걸리지만, 계약으로 목록에 둔다.
 */
export const CELL_SELECTION_PARA_FORMAT_COMMANDS: ReadonlySet<string> = new Set([
  'format:align-left', 'format:align-center', 'format:align-right',
  'format:align-justify', 'format:align-distribute', 'format:align-split',
  'format:line-spacing', 'format:line-spacing-increase', 'format:line-spacing-decrease',
  'format:apply-style',
  'format:toggle-numbering', 'format:toggle-bullet', 'format:apply-bullet',
  'format:level-increase', 'format:level-decrease',
]);

/**
 * F5 셀 선택을 유지한 채 열어야 하는 서식 대화상자 커맨드 id (글자 모양 Alt+L · 문단 모양 Alt+T · 스타일 F6).
 * 대화상자는 열 때 셀 선택 표적을 잡아 두고(`captureCellSelectionFormatTarget`) 적용 시 그 표적에 쓴다.
 */
export const CELL_SELECTION_FORMAT_DIALOG_COMMANDS: ReadonlySet<string> = new Set([
  'format:char-shape', 'format:para-shape', 'format:style-dialog',
]);

/** 셀 선택 키 처리가 선택을 해제하지 않고 그대로 dispatch 하는 커맨드 전체 (글자 + 문단 + 대화상자). */
export const CELL_SELECTION_FORMAT_COMMANDS: ReadonlySet<string> = new Set([
  ...CELL_SELECTION_CHAR_FORMAT_COMMANDS,
  ...CELL_SELECTION_PARA_FORMAT_COMMANDS,
  ...CELL_SELECTION_FORMAT_DIALOG_COMMANDS,
]);

/** 표 문맥 (셀 선택이 걸린 표의 위치). `cellPath` 깊이 2 이상이면 중첩 표 — 경로 기반 API 대상. */
export interface CellTableRef {
  sec: number;
  ppi: number;
  ci: number;
  cellPath?: readonly CellPathEntry[];
}

/**
 * 셀 안 문단 하나를 가리키는 문단 서식 대상 — `ParaFormatTarget` 의 `cell`·`path` 변형과 구조가 같다.
 * `cell` 은 깊이 1 표(flat API), `path` 는 중첩 표(경로 기반 API).
 */
export type CellParaFormatTarget =
  | { kind: 'cell'; sec: number; parentPara: number; controlIdx: number; cellIdx: number; cellParaIdx: number }
  | { kind: 'path'; sec: number; parentPara: number; cellPath: CellPathEntry[] };

/**
 * 선택한 셀들의 모든 문단을 문단 서식 대상으로 편다 (셀 순서 → 문단 순서).
 * 빈 셀도 문단이 하나는 있으므로 대상에 든다 — 한컴은 셀 블록 정렬을 빈 셀에도 적용한다.
 * 중첩 표면 셀·문단마다 경로를 만들어 `path` 대상으로 낸다.
 */
export function collectCellParaTargets(
  table: CellTableRef,
  cellIndices: readonly number[],
  paraCountAt: (cellIdx: number) => number,
): CellParaFormatTarget[] {
  const targets: CellParaFormatTarget[] = [];
  const nested = isNestedCellPath(table.cellPath);
  for (const cellIdx of cellIndices) {
    const count = paraCountAt(cellIdx);
    for (let cellParaIdx = 0; cellParaIdx < count; cellParaIdx++) {
      targets.push(nested
        ? { kind: 'path', sec: table.sec, parentPara: table.ppi, cellPath: cellPathForCell(table.cellPath!, cellIdx, cellParaIdx) }
        : { kind: 'cell', sec: table.sec, parentPara: table.ppi, controlIdx: table.ci, cellIdx, cellParaIdx });
    }
  }
  return targets;
}
