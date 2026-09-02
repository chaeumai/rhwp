/**
 * F5 셀 선택(셀 블록) 모드에서의 글자 서식 적용 — 순수 판정 함수 모음.
 *
 * `CursorState.hasSelection()` 은 텍스트 anchor 만 보고 셀 격자 선택(`cellAnchor`/`cellFocus`)을
 * 모른다. 그래서 셀을 골라 글꼴·크기·굵게·글자색을 바꾸면 서식바 숫자만 바뀌고 문서는 그대로였다.
 * 여기 있는 함수는 그 게이트와 셀 순회 규칙을 wasm 없이 단위 검증할 수 있게 뽑아 둔 것이다.
 * 진단: rhwp-cai `docs/셀선택-글자서식-무동작-진단과수리방안-20260831-2323.md`.
 */

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
 * `applyCharFormatInCell` 에 경로 기반 변형이 없어 중첩 표 셀 선택은 1차 수리 범위 밖이다
 * (모양 복사 `applyCopiedFormatToSelectedCells` 도 같은 선을 긋는다).
 */
export function isNestedCellPath(cellPath: { length: number } | null | undefined): boolean {
  return (cellPath?.length ?? 0) > 1;
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
