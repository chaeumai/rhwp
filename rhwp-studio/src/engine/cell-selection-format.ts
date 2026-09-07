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
 * 번호/글머리표 토글은 "지금 상태" 를 **선택 범위 첫 셀의 첫 문단**으로 판단하고(`getParaProperties`) 셀 블록 전체에
 * 같은 결과를 준다 — 한컴 실측(2026-09-06 E1 §3)과 일치. 개요 수준 ▲▼ 는 다르다: 한컴은 문단마다 개요면 ±1, 비개요면
 * 그대로 둔다(`planOutlineLevelChange`, E8). 이 다섯은 지금 단축키가 없어(툴바·메뉴만) 키 처리에는 안 걸리지만, 계약으로 목록에 둔다.
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

/**
 * F5 셀 선택을 유지한 채 실행하는 되돌리기/다시 실행 커맨드 id (E2).
 * 한컴 실측(2026-09-06, rhwp-cai `docs/E1-한컴실측-…-20260906-0128.md` §1): 셀 블록에 굵게를 걸고 Ctrl+Z 를 눌러도
 * 블록이 그대로 남고 캐럿도 블록 안에 있다. 종전에는 키 처리 fall-through 가 선택을 풀고 나서 undo 를 돌렸다.
 * 히스토리 점프는 표 구조를 되돌릴 수 있으므로 점프 뒤 표 문맥 재검증(`cellSelectionStillValid`)이 반드시 따른다.
 */
export const CELL_SELECTION_HISTORY_COMMANDS: ReadonlySet<string> = new Set(['edit:undo', 'edit:redo']);

/**
 * 히스토리 점프(undo/redo) 뒤 셀 선택이 여전히 유효한가 — 순수 판정 (E2).
 * `dims` 는 점프 뒤 같은 (sec, ppi, ci[, cellPath]) 에서 다시 읽은 표 크기, 표가 없으면 null.
 * 표가 사라졌거나(null) 행·열 수가 달라졌거나 선택 범위가 새 크기 밖이면 false — 그대로 두면 다음 서식이 다른 셀에 들어간다
 * (UI-1 이 고친 종류의 오적용, 선례 `exitObjectSelectionAfterHistoryJump` #2303).
 */
export function cellSelectionStillValid(
  ctx: { rowCount: number; colCount: number },
  range: CellGridRange | null,
  dims: { rowCount: number; colCount: number } | null,
): boolean {
  if (!dims || !range) return false;
  if (dims.rowCount !== ctx.rowCount || dims.colCount !== ctx.colCount) return false;
  return range.startRow >= 0 && range.startCol >= 0
    && range.endRow < dims.rowCount && range.endCol < dims.colCount;
}

/** 스타일 이름에서 개요 수준을 읽는다 (`개요 1`~`개요 10`). 개요 스타일이 아니면 null. */
export const OUTLINE_STYLE_RE = /^개요\s*(\d{1,2})$/;
export function outlineLevelOf(styleName: string | null | undefined): number | null {
  const m = styleName?.match(OUTLINE_STYLE_RE);
  return m ? parseInt(m[1], 10) : null;
}

/** 개요 수준 변경 계획의 항목 — 새 수준, `'body'`(개요 해제 → 바탕글), `null`(불변). */
export type OutlineLevelPlanEntry = number | 'body' | null;

/**
 * 한컴의 개요 수준 상한 — **10·클램프** (E11 CRD 재측정 2026-09-07, `docs/E11-한컴재측정-…-20260907-1110.md`).
 * 「개요 N」 스타일이 하나도 없는 실문서 3편(pr-1674·36384689 화재보고서·3-09월 교육)에서 ▼ 12회 뒤 저장본이
 * `hp:switch/case[2016/paragraph] OUTLINE level=9`(0-based) 였고 11·12회는 불변이었다 — 상한에서 풀리지 않는다.
 * E9 의 「고정 7·해제」(2026-09-06)는 명령 상한이 아니었다: 그 픽스처(e1-cellblock)의 「개요 8」 스타일 paraPr 이
 * heading 을 `hp:case hp:required-namespace="…/2021/metatag"` 안에 두고 default 는 NONE 이라, 한글 2024 가 그 스타일을
 * 적용하면서 번호가 사라진 것이다(문서 특수). 상한은 문서의 스타일 목록·번호 정의에서도 오지 않는다(E9 의 그 결론은 유효).
 */
export const HANCOM_MAX_OUTLINE_LEVEL = 10;

/**
 * 개요 수준 ▲▼ 를 문단마다 어떻게 바꿀지 정한다 — 한컴 규칙 (E8, 한컴 실측 2026-09-06 E1 판정 §2 · E11 2026-09-07).
 * `levels` 는 대상 문단들의 현재 개요 수준(비개요는 null), `delta` 는 -1(▲ = 한컴 Ctrl+Num−) 또는 +1(▼ = Ctrl+Num+).
 *  1. 개요 문단이 하나라도 있으면 **개요 문단만 각자 ±1**, 비개요 문단은 불변. 첫 셀·캐럿 셀·확장 방향은 결과에 안 들어간다.
 *  2. 개요 1 에서 ▲ 는 개요 해제(`'body'`, E1 실측). **상한(10)에서 ▼ 는 불변 — 클램프**(`null`):
 *     E11 실측 2026-09-07, 실문서 3편 모두 12회 뒤 `level=9`(0-based) 그대로, 11·12회 불변. E9 의 「7 에서 해제」는
 *     그 픽스처의 「개요 8」 스타일이 NONE 으로 읽힌 문서 특수라 폐기했다. 풀린 뒤 다시 ▼ 하면 규칙 3 이 받아 개요 1 로 재진입한다.
 *  3. 개요 문단이 하나도 없으면 ▼ 는 전부 개요로(수준 = 문서 순 앞선 개요 문단의 수준 `precedingLevel`, 없으면 1), ▲ 는 무동작.
 *     계승 뒤 클램프(E11: 9 를 계승한 문단에 ▼ 8회 → 10).
 * 종전(UI-5)의 「첫 셀 첫 문단이 개요가 아니면 무동작」은 한컴에 대한 반례로 확인돼 폐기했다.
 */
export function planOutlineLevelChange(
  levels: readonly (number | null)[],
  delta: number,
  maxLevel: number,
  precedingLevel: number | null,
): OutlineLevelPlanEntry[] {
  const hasOutline = levels.some((l) => l !== null);
  if (!hasOutline) {
    if (delta <= 0) return levels.map(() => null);
    const level = Math.max(1, Math.min(maxLevel, precedingLevel ?? 1));
    return levels.map(() => level);
  }
  return levels.map((l) => {
    if (l === null) return null;
    const next = l + delta;
    if (next < 1) return 'body';
    // 상한에서 ▼ 는 클램프 — 무동작(E11). 한컴은 여기서 개요를 풀지 않는다.
    if (next > maxLevel) return null;
    return next;
  });
}

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

/**
 * 텍스트 범위(캐럿 하나 또는 드래그 선택)가 **같은 중첩 셀** 안에 있으면 그 범위의 문단마다 cellPath 를 만든다.
 * 같은 셀 = 마지막 항목의 cellParaIndex 를 뺀 나머지가 전부 같다. 다른 셀·다른 표·깊이가 다르면 null —
 * 셀을 넘는 텍스트 범위에 문단 서식을 거는 것은 F5 셀 블록의 몫이다.
 * 캐럿(비-F5)이 중첩 셀에 있을 때 정렬·줄 간격·문단 모양이 그 문단에 들어가게 하는 표적이다.
 */
export function nestedRangeCellPaths(
  startPath: readonly CellPathEntry[] | null | undefined,
  endPath: readonly CellPathEntry[] | null | undefined,
): CellPathEntry[][] | null {
  if (!isNestedCellPath(startPath) || !isNestedCellPath(endPath)) return null;
  const a = startPath!, b = endPath!;
  if (a.length !== b.length) return null;
  const last = a.length - 1;
  for (let i = 0; i < last; i++) {
    if (a[i].controlIndex !== b[i].controlIndex || a[i].cellIndex !== b[i].cellIndex || a[i].cellParaIndex !== b[i].cellParaIndex) return null;
  }
  if (a[last].controlIndex !== b[last].controlIndex || a[last].cellIndex !== b[last].cellIndex) return null;
  const from = Math.min(a[last].cellParaIndex, b[last].cellParaIndex);
  const to = Math.max(a[last].cellParaIndex, b[last].cellParaIndex);
  const paths: CellPathEntry[][] = [];
  for (let cellParaIndex = from; cellParaIndex <= to; cellParaIndex++) {
    paths.push(a.map((entry, i) => i === last ? { ...entry, cellParaIndex } : { ...entry }));
  }
  return paths;
}
