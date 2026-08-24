/**
 * 한채움 fork: AI 작성(authoring) 임베드 표면.
 *
 * 호스트(한채움)의 AI 런타임이 편집기 메모리를 **도구 호출 단위**로 읽고 쓰기
 * 위한 계층이다. 문서 전체를 통째로 주고받는 대신, 개요(outline)로 어디에
 * 무엇이 있는지만 먼저 알리고 필요한 노드만 읽어 간다.
 *
 * 왜 여기서 좌표를 문자열로 감싸는가:
 *   WASM 은 (sec, parentPara, pathJson, charOffset) 같은 다인자 좌표를 쓴다.
 *   이 좌표를 그대로 wire 에 노출하면 호출자가 인자 순서를 조립해야 하고,
 *   순서 하나가 어긋나면 엉뚱한 셀을 조용히 고친다. 하나의 문자열 주소로
 *   묶어 두면 왕복 중에 좌표가 분해되지 않는다.
 *
 * 주소 문법:
 *   본문 문단  s{sec}/p{para}
 *   표 셀      s{sec}/p{para}/c{ctrl}/cell{idx}/p{cellPara}
 *   중첩 표 셀 s{sec}/p{para}/c{ctrl}/cell{idx}/p{cellPara}/c{ctrl}/cell{idx}/p{cellPara}...
 *
 * 이 주소는 **세션 안에서만** 유효하다. 편집으로 문단이 밀리면 같은 주소가
 * 다른 곳을 가리킨다. 그래서 쓰기는 expectedText 를 반드시 함께 받고,
 * 불일치하면 고치지 않고 실패시킨다 (추측 보정 금지).
 */

/**
 * WASM 반환 형태. 필드 이름을 여기서 정확히 못 맞추면 조용히 빈 개요가 나온다
 * (실제로 겪었다 — rows/cols 로 잘못 적어 표를 하나도 못 찾았다).
 */
export interface TableDimensions {
  rowCount: number;
  colCount: number;
  cellCount: number;
}

export interface CellInfo {
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
}

/** authoring 이 쓰는 WASM 표면만 좁게 받는다. 테스트에서 대역을 넣기 쉽다. */
export interface AuthoringDocument {
  getSectionCount(): number;
  getParagraphCount(sec: number): number;
  getParagraphLength(sec: number, para: number): number;
  getTextRange(sec: number, para: number, charOffset: number, count: number): string;
  getTableDimensions(sec: number, parentPara: number, controlIdx: number): TableDimensions;
  getCellInfo(sec: number, parentPara: number, controlIdx: number, cellIdx: number): CellInfo;
  getTableControlIndices(sec: number, para: number): number[];
  getTableControlIndicesByPath(sec: number, parentPara: number, pathJson: string): number[];
  getTableDimensionsByPath(sec: number, parentPara: number, pathJson: string): TableDimensions;
  getCellInfoByPath(sec: number, parentPara: number, pathJson: string): CellInfo;
  getCellParagraphCountByPath(sec: number, parentPara: number, pathJson: string): number;
  getTextInCellByPath(sec: number, parentPara: number, pathJson: string, charOffset: number, count: number): string;
  getCellParagraphLengthByPath(sec: number, parentPara: number, pathJson: string): number;
  insertTextInCellByPath(sec: number, parentPara: number, pathJson: string, charOffset: number, text: string): string;
  deleteTextInCellByPath(sec: number, parentPara: number, pathJson: string, charOffset: number, count: number): string;
  insertText(sec: number, para: number, charOffset: number, text: string): string;
  deleteText(sec: number, para: number, charOffset: number, count: number): string;
  getParaPropertiesAt(sec: number, para: number): { checkable?: boolean; checked?: boolean };
  getParaPropertiesByPath(sec: number, parentPara: number, pathJson: string): { checkable?: boolean; checked?: boolean };
  setCheckStateByPath(
    sec: number,
    parentPara: number,
    pathJson: string,
    expectedChecked: boolean,
    checked: boolean,
  ): string;
  saveSnapshot(): number;
  restoreSnapshot(id: number): void;
  discardSnapshot(id: number): void;
  /**
   * 누름틀(가이드) 필드를 푼다. 필드와 그 안의 안내문이 함께 사라진다.
   * 본문 문단과 셀 안 문단을 한 시그니처로 받는다 (`WasmBridge.removeFieldAt`).
   *
   * optional 인 이유: 이 표면의 테스트 더블이 구현하지 않아도 되게 한다. 실제
   * 런타임 대상은 wasm 브리지이고 거기에는 항상 있다.
   */
  removeFieldAt?(pos: FieldPosition): { ok: boolean };
}

export type NodeKind = 'paragraph' | 'cell' | 'checkbox';

export interface OutlineNode {
  /** 세션 유효 주소. read/write 의 path 인자로 그대로 쓴다. */
  path: string;
  kind: NodeKind;
  /** 전체 글자 수. preview 가 잘렸는지 판단할 수 있다. */
  length: number;
  /** 앞부분 발췌. outline 이 문서 전문을 실어 나르지 않게 하는 장치. */
  preview: string;
  /** 표 셀일 때만. 0-based. */
  row?: number;
  col?: number;
  /** 네이티브 체크 글머리표 노드일 때 현재 선택 상태. */
  checked?: boolean;
}

export interface OutlineTable {
  /** 표를 담은 문단 주소. s{sec}/p{para}/c{ctrl} */
  path: string;
  rows: number;
  cols: number;
  cells: OutlineNode[];
}

export interface OutlineSection {
  section: number;
  /**
   * 구역의 전체 문단 수. paragraphs 는 내용이 있는 것만 담으므로 이 값과
   * 다르다. "문서를 열었는데 개요가 비었다"가 문단이 없어서인지 전부
   * 비어서인지 구별하려면 원래 개수를 알아야 한다.
   */
  paragraphCount: number;
  paragraphs: OutlineNode[];
  tables: OutlineTable[];
}

export interface Outline {
  schemaVersion: 1;
  sections: OutlineSection[];
  /** 내용이 있는 노드 총계. 호출자가 read 범위를 가늠하는 데 쓴다. */
  nodeCount: number;
  truncated: boolean;
}

export interface TextEditRequest {
  operation?: 'SET_TEXT';
  path: string;
  /** 현재 그 자리에 있어야 하는 텍스트. 다르면 적용하지 않는다. */
  expectedText: string;
  newText: string;
}

export interface CheckEditRequest {
  operation: 'SET_CHECKED';
  path: string;
  /** AI 응답을 기다리는 동안 사용자가 바꾼 상태를 덮지 않게 하는 기준값. */
  expectedChecked: boolean;
  checked: boolean;
}

export type EditRequest = TextEditRequest | CheckEditRequest;

export interface EditOutcome {
  path: string;
  ok: boolean;
  errorCode?: 'PATH_INVALID' | 'PATH_NOT_FOUND' | 'EXPECTED_TEXT_MISMATCH' | 'EXPECTED_CHECKED_MISMATCH' | 'NOT_CHECKABLE' | 'WRITE_FAILED';
  /** 불일치 시 실제로 있던 텍스트. 호출자가 다시 판단할 근거. */
  actualText?: string;
  actualChecked?: boolean;
}

export interface ApplyEditsResult {
  ok: boolean;
  applied: number;
  outcomes: EditOutcome[];
  /** 되돌릴 수 있는 스냅샷. revertLastBatch 가 이 값을 쓴다. */
  snapshotId: number | null;
}

const PREVIEW_LIMIT = 40;
/** outline 이 무한정 커지지 않게 하는 상한. 초과하면 truncated 로 알린다. */
const MAX_OUTLINE_NODES = 2000;
/** 비정상 문서가 순환 경로를 만들더라도 재귀가 끝나게 하는 상한. */
const MAX_TABLE_DEPTH = 8;

/** {@link AuthoringDocument.removeFieldAt} 이 받는 위치. `DocumentPosition` 의 부분집합이다. */
export interface FieldPosition {
  sectionIndex: number;
  paragraphIndex: number;
  charOffset: number;
  parentParaIndex?: number;
  controlIndex?: number;
  cellIndex?: number;
  cellParaIndex?: number;
  cellPath?: Array<{ controlIndex: number; cellIndex: number; cellParaIndex: number }>;
  isTextBox?: boolean;
}

interface ParsedPath {
  sec: number;
  para: number;
  /** 본문 문단이면 null. */
  cells: Array<{ ctrl: number; cellIndex: number; cellPara: number }> | null;
}

const PARAGRAPH_PATH = /^s(\d+)\/p(\d+)$/;
const PATH_HEAD = /^s(\d+)\/p(\d+)(.*)$/;
const CELL_SEGMENT = /^\/c(\d+)\/cell(\d+)\/p(\d+)/;

export function parsePath(path: string): ParsedPath | null {
  const paragraph = PARAGRAPH_PATH.exec(path);
  if (paragraph) {
    return { sec: Number(paragraph[1]), para: Number(paragraph[2]), cells: null };
  }
  const head = PATH_HEAD.exec(path);
  if (!head || !head[3]) return null;
  const cells: NonNullable<ParsedPath['cells']> = [];
  let remaining = head[3];
  while (remaining.length > 0) {
    const segment = CELL_SEGMENT.exec(remaining);
    if (!segment) return null;
    cells.push({ ctrl: Number(segment[1]), cellIndex: Number(segment[2]), cellPara: Number(segment[3]) });
    remaining = remaining.slice(segment[0].length);
  }
  return cells.length > 0 ? { sec: Number(head[1]), para: Number(head[2]), cells } : null;
}

export function paragraphPath(sec: number, para: number): string {
  return `s${sec}/p${para}`;
}

export function cellPath(sec: number, para: number, ctrl: number, cellIndex: number, cellPara: number): string {
  return `s${sec}/p${para}/c${ctrl}/cell${cellIndex}/p${cellPara}`;
}

function cellPathJson(parsed: ParsedPath): string {
  if (!parsed.cells) throw new Error('cellPathJson requires a cell path');
  return cellSegmentsJson(parsed.cells);
}

function cellSegmentsJson(cells: NonNullable<ParsedPath['cells']>): string {
  return JSON.stringify(cells.map((cell) => ({
    controlIndex: cell.ctrl,
    cellIndex: cell.cellIndex,
    cellParaIndex: cell.cellPara,
  })));
}

function cellSegmentsPath(sec: number, para: number, cells: NonNullable<ParsedPath['cells']>): string {
  return `s${sec}/p${para}${cells.map((cell) => `/c${cell.ctrl}/cell${cell.cellIndex}/p${cell.cellPara}`).join('')}`;
}

function preview(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= PREVIEW_LIMIT ? normalized : `${normalized.slice(0, PREVIEW_LIMIT)}…`;
}

/** 표가 아닌 문단에서 getTableDimensions 는 오류를 낸다. 존재 여부 판정에만 쓴다. */
function tryTableDimensionsByPath(
  doc: AuthoringDocument,
  sec: number,
  para: number,
  pathJson: string,
): TableDimensions | null {
  try {
    const dimensions = doc.getTableDimensionsByPath(sec, para, pathJson);
    if (!dimensions || !Number.isFinite(dimensions.cellCount) || dimensions.cellCount <= 0) return null;
    return dimensions;
  } catch {
    return null;
  }
}

/**
 * 셀의 행·열 좌표. 병합이 있으면 cellCount 가 rowCount×colCount 와 다르므로
 * 인덱스에서 좌표를 계산하지 않고 문서에 물어본다.
 */
function tryCellInfoByPath(
  doc: AuthoringDocument,
  sec: number,
  para: number,
  pathJson: string,
): CellInfo | null {
  try {
    const info = doc.getCellInfoByPath(sec, para, pathJson);
    return info && Number.isFinite(info.row) && Number.isFinite(info.col) ? info : null;
  } catch {
    return null;
  }
}

function tableControlIndices(values: unknown): number[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((value): value is number => Number.isInteger(value) && value >= 0))]
    .sort((left, right) => left - right);
}

function readCellText(doc: AuthoringDocument, sec: number, para: number, pathJson: string): string {
  try {
    const length = doc.getCellParagraphLengthByPath(sec, para, pathJson);
    if (!Number.isFinite(length) || length <= 0) return '';
    return doc.getTextInCellByPath(sec, para, pathJson, 0, length) ?? '';
  } catch {
    return '';
  }
}

interface CheckState {
  checkable: boolean;
  checked: boolean;
}

function readCheckStateAt(doc: AuthoringDocument, parsed: ParsedPath): CheckState | null {
  try {
    const properties = parsed.cells
      ? doc.getParaPropertiesByPath(parsed.sec, parsed.para, cellPathJson(parsed))
      : doc.getParaPropertiesAt(parsed.sec, parsed.para);
    return {
      checkable: properties?.checkable === true,
      checked: properties?.checked === true,
    };
  } catch {
    return null;
  }
}

/**
 * 문서 개요를 만든다.
 *
 * 본문 문단은 내용이 있는 것만, 표는 셀 단위로 전부 싣는다 — 빈 셀이야말로
 * AI 가 채워야 할 자리이므로 비어 있다고 빼면 안 된다.
 */
export function buildOutline(doc: AuthoringDocument): Outline {
  const sections: OutlineSection[] = [];
  let nodeCount = 0;
  let truncated = false;

  const sectionCount = doc.getSectionCount();
  for (let sec = 0; sec < sectionCount && !truncated; sec += 1) {
    const paragraphs: OutlineNode[] = [];
    const tables: OutlineTable[] = [];
    const paragraphCount = doc.getParagraphCount(sec);
    const visitedTables = new Set<string>();

    const visitTable = (
      para: number,
      ancestors: NonNullable<ParsedPath['cells']>,
      ctrl: number,
      depth: number,
    ): void => {
      if (truncated) return;
      if (depth > MAX_TABLE_DEPTH) {
        truncated = true;
        return;
      }
      const ancestorPath = ancestors
        .map((cell) => `/c${cell.ctrl}/cell${cell.cellIndex}/p${cell.cellPara}`)
        .join('');
      const tablePath = `s${sec}/p${para}${ancestorPath}/c${ctrl}`;
      if (visitedTables.has(tablePath)) return;
      visitedTables.add(tablePath);

      const tableLookup = [...ancestors, { ctrl, cellIndex: 0, cellPara: 0 }];
      const dimensions = tryTableDimensionsByPath(doc, sec, para, cellSegmentsJson(tableLookup));
      if (!dimensions) return;

      const cells: OutlineNode[] = [];
      const nestedTables: Array<{ ancestors: NonNullable<ParsedPath['cells']>; ctrl: number }> = [];
      for (let cellIndex = 0; cellIndex < dimensions.cellCount && !truncated; cellIndex += 1) {
        const containerPath = [...ancestors, { ctrl, cellIndex, cellPara: 0 }];
        let paragraphTotal = 1;
        try {
          paragraphTotal = doc.getCellParagraphCountByPath(sec, para, cellSegmentsJson(containerPath));
        } catch {
          paragraphTotal = 1;
        }
        if (!Number.isFinite(paragraphTotal) || paragraphTotal < 1) paragraphTotal = 1;

        for (let cellPara = 0; cellPara < paragraphTotal && !truncated; cellPara += 1) {
          const pathSegments = [...ancestors, { ctrl, cellIndex, cellPara }];
          const pathJson = cellSegmentsJson(pathSegments);
          const text = readCellText(doc, sec, para, pathJson);
          const checkState = readCheckStateAt(doc, { sec, para, cells: pathSegments });
          let nestedControls: number[] = [];
          try {
            nestedControls = tableControlIndices(doc.getTableControlIndicesByPath(sec, para, pathJson));
          } catch {
            nestedControls = [];
          }

          // 중첩 표만 담는 빈 컨테이너는 값 입력 대상이 아니다. 일반 빈 셀은
          // AI가 채울 자리이므로 남기고, 텍스트와 중첩 표가 함께 있으면 둘 다 남긴다.
          if (nestedControls.length === 0 || text.trim().length > 0) {
            if (nodeCount >= MAX_OUTLINE_NODES) {
              truncated = true;
              break;
            }
            const info = tryCellInfoByPath(doc, sec, para, pathJson);
            cells.push({
              path: cellSegmentsPath(sec, para, pathSegments),
              kind: checkState?.checkable ? 'checkbox' : 'cell',
              length: text.length,
              preview: preview(text),
              ...(checkState?.checkable ? { checked: checkState.checked } : {}),
              ...(info ? { row: info.row, col: info.col } : {}),
            });
            nodeCount += 1;
          }
          nestedControls.forEach((nestedCtrl) => nestedTables.push({ ancestors: pathSegments, ctrl: nestedCtrl }));
        }
      }

      tables.push({ path: tablePath, rows: dimensions.rowCount, cols: dimensions.colCount, cells });
      nestedTables.forEach((nested) => visitTable(para, nested.ancestors, nested.ctrl, depth + 1));
    };

    for (let para = 0; para < paragraphCount; para += 1) {
      if (nodeCount >= MAX_OUTLINE_NODES) {
        truncated = true;
        break;
      }

      let rootTableControls: number[] = [];
      try {
        rootTableControls = tableControlIndices(doc.getTableControlIndices(sec, para));
      } catch {
        rootTableControls = [];
      }
      if (rootTableControls.length > 0) {
        rootTableControls.forEach((ctrl) => visitTable(para, [], ctrl, 1));
        continue;
      }

      let length = 0;
      try {
        length = doc.getParagraphLength(sec, para);
      } catch {
        continue;
      }
      if (!Number.isFinite(length) || length <= 0) continue;
      let text = '';
      try {
        text = doc.getTextRange(sec, para, 0, length) ?? '';
      } catch {
        continue;
      }
      if (!text.trim()) continue;
      const checkState = readCheckStateAt(doc, { sec, para, cells: null });
      paragraphs.push({
        path: paragraphPath(sec, para),
        kind: checkState?.checkable ? 'checkbox' : 'paragraph',
        length: text.length,
        preview: preview(text),
        ...(checkState?.checkable ? { checked: checkState.checked } : {}),
      });
      nodeCount += 1;
    }

    sections.push({ section: sec, paragraphCount, paragraphs, tables });
  }

  return { schemaVersion: 1, sections, nodeCount, truncated };
}

/** 주소 하나의 현재 텍스트를 읽는다. 못 읽으면 null (빈 문자열과 구분한다). */
export function readPath(doc: AuthoringDocument, path: string): string | null {
  const parsed = parsePath(path);
  if (!parsed) return null;
  try {
    if (parsed.cells) {
      const pathJson = cellPathJson(parsed);
      const length = doc.getCellParagraphLengthByPath(parsed.sec, parsed.para, pathJson);
      if (!Number.isFinite(length)) return null;
      if (length <= 0) return '';
      return doc.getTextInCellByPath(parsed.sec, parsed.para, pathJson, 0, length) ?? '';
    }
    const length = doc.getParagraphLength(parsed.sec, parsed.para);
    if (!Number.isFinite(length)) return null;
    if (length <= 0) return '';
    return doc.getTextRange(parsed.sec, parsed.para, 0, length) ?? '';
  } catch {
    return null;
  }
}

export function readPaths(doc: AuthoringDocument, paths: readonly string[]): Array<{ path: string; text: string | null }> {
  return paths.map((path) => ({ path, text: readPath(doc, path) }));
}

/** 주소들의 현재 체크 상태를 읽는다. 체크 문단이 아니거나 주소가 없으면 null. */
export function readCheckStates(
  doc: AuthoringDocument,
  paths: readonly string[],
): Array<{ path: string; checked: boolean | null }> {
  return paths.map((path) => {
    const parsed = parsePath(path);
    const state = parsed ? readCheckStateAt(doc, parsed) : null;
    return { path, checked: state?.checkable ? state.checked : null };
  });
}

/** 같은 문단 안에서 뒤쪽부터 고치도록 정렬한다. 앞선 수정이 뒤쪽 좌표를 밀지 않게. */
function sortForApply(edits: readonly EditRequest[]): EditRequest[] {
  return [...edits].sort((left, right) => {
    const a = parsePath(left.path);
    const b = parsePath(right.path);
    if (!a || !b) return 0;
    if (a.sec !== b.sec) return b.sec - a.sec;
    if (a.para !== b.para) return b.para - a.para;
    const aCells = a.cells ?? [];
    const bCells = b.cells ?? [];
    const length = Math.max(aCells.length, bCells.length);
    for (let idx = 0; idx < length; idx += 1) {
      const leftCell = aCells[idx];
      const rightCell = bCells[idx];
      if (!leftCell || !rightCell) return bCells.length - aCells.length;
      if (leftCell.ctrl !== rightCell.ctrl) return rightCell.ctrl - leftCell.ctrl;
      if (leftCell.cellIndex !== rightCell.cellIndex) return rightCell.cellIndex - leftCell.cellIndex;
      if (leftCell.cellPara !== rightCell.cellPara) return rightCell.cellPara - leftCell.cellPara;
    }
    return 0;
  });
}

/**
 * 이 자리에 누름틀(가이드)이 걸려 있으면 먼저 푼다.
 *
 * <p>서식이 "여기에 학번을 쓰세요" 로 만들어 둔 칸은 누름틀이고, 안 채운 상태의
 * 본문에는 안내문이 그대로 들어 있다. 필드를 남긴 채 그 안에 값을 써 넣으면 두 가지가
 * 잘못된다 — ① 변환기가 필드 안 텍스트를 안내문으로 보고 <b>제출본에서 지운다</b>
 * (2026-08-23 실측: 신청서 9칸 중 누름틀 2칸이 제출 PDF 에서 빔) ② 글자 모양이 안내문
 * 것을 따라간다. 필드를 풀면 안내문이 함께 사라지고 값은 본문 글자로 들어간다.
 *
 * <p>실패는 삼킨다. 이 자리에 누름틀이 없는 경우가 대부분이고, 그때 wasm 은 오류를
 * 돌려준다 — 정상이다.
 *
 * <p>한계: 문단(셀) <b>시작</b>의 누름틀만 푼다. 문단 중간에 걸린 누름틀은 charOffset 0
 * 이 필드 범위 밖이라 그대로 남는다. 서식의 입력 칸은 셀 하나를 통째로 쓰는 것이
 * 보통이라 지금은 이 범위로 둔다.
 */
function releaseGuideField(doc: AuthoringDocument, parsed: ParsedPath): void {
  try {
    // 기존 removeFieldAtInCell 은 깊이 1 좌표만 받는다. 중첩 경로를 외곽 셀
    // 좌표로 축약하면 엉뚱한 누름틀을 지울 수 있으므로 중첩 셀에서는 건드리지 않는다.
    if ((parsed.cells?.length ?? 0) > 1) return;
    const pos: FieldPosition = parsed.cells
      ? {
        sectionIndex: parsed.sec,
        paragraphIndex: parsed.para,
        charOffset: 0,
        parentParaIndex: parsed.para,
        controlIndex: parsed.cells[0].ctrl,
        cellIndex: parsed.cells[0].cellIndex,
        cellParaIndex: parsed.cells[0].cellPara,
        cellPath: parsed.cells.map((cell) => ({
          controlIndex: cell.ctrl,
          cellIndex: cell.cellIndex,
          cellParaIndex: cell.cellPara,
        })),
        isTextBox: false,
      }
      : { sectionIndex: parsed.sec, paragraphIndex: parsed.para, charOffset: 0 };
    doc.removeFieldAt?.(pos);
  } catch {
    // 누름틀이 없는 자리다. 쓰기는 그대로 이어 간다.
  }
}

function writeText(doc: AuthoringDocument, parsed: ParsedPath, newText: string): boolean {
  try {
    releaseGuideField(doc, parsed);
    if (parsed.cells) {
      const pathJson = cellPathJson(parsed);
      // 누름틀을 풀면서 안내문이 함께 지워졌을 수 있다 — `current` 를 믿지 말고
      // 지금 길이를 다시 읽는다. 옛 길이로 지우면 이웃 글자를 먹는다.
      const remaining = doc.getCellParagraphLengthByPath(parsed.sec, parsed.para, pathJson);
      if (remaining > 0) {
        doc.deleteTextInCellByPath(parsed.sec, parsed.para, pathJson, 0, remaining);
      }
      if (newText.length > 0) {
        doc.insertTextInCellByPath(parsed.sec, parsed.para, pathJson, 0, newText);
      }
      return true;
    }
    const remaining = doc.getParagraphLength(parsed.sec, parsed.para);
    if (remaining > 0) {
      doc.deleteText(parsed.sec, parsed.para, 0, remaining);
    }
    if (newText.length > 0) {
      doc.insertText(parsed.sec, parsed.para, 0, newText);
    }
    return true;
  } catch {
    return false;
  }
}

function writeChecked(
  doc: AuthoringDocument,
  parsed: ParsedPath,
  expectedChecked: boolean,
  checked: boolean,
): boolean {
  try {
    doc.setCheckStateByPath(
      parsed.sec,
      parsed.para,
      parsed.cells ? cellPathJson(parsed) : '[]',
      expectedChecked,
      checked,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * 편집 묶음을 원자적으로 적용한다.
 *
 * 하나라도 실패하면 스냅샷으로 되돌리고 전체를 실패로 보고한다. 부분 적용된
 * 문서를 남기지 않는 것이 이 함수의 존재 이유다 — 절반만 반영된 문서는
 * 사용자도 AI 도 다음에 무엇을 믿어야 할지 알 수 없다.
 */
export function applyEdits(doc: AuthoringDocument, edits: readonly EditRequest[]): ApplyEditsResult {
  if (edits.length === 0) {
    return { ok: true, applied: 0, outcomes: [], snapshotId: null };
  }

  let snapshotId: number | null = null;
  try {
    snapshotId = doc.saveSnapshot();
  } catch {
    snapshotId = null;
  }

  const outcomes: EditOutcome[] = [];
  let failed = false;

  for (const edit of sortForApply(edits)) {
    const parsed = parsePath(edit.path);
    if (!parsed) {
      outcomes.push({ path: edit.path, ok: false, errorCode: 'PATH_INVALID' });
      failed = true;
      break;
    }
    if (edit.operation === 'SET_CHECKED') {
      const state = readCheckStateAt(doc, parsed);
      if (state === null) {
        outcomes.push({ path: edit.path, ok: false, errorCode: 'PATH_NOT_FOUND' });
        failed = true;
        break;
      }
      if (!state.checkable) {
        outcomes.push({ path: edit.path, ok: false, errorCode: 'NOT_CHECKABLE' });
        failed = true;
        break;
      }
      if (state.checked !== edit.expectedChecked) {
        outcomes.push({
          path: edit.path,
          ok: false,
          errorCode: 'EXPECTED_CHECKED_MISMATCH',
          actualChecked: state.checked,
        });
        failed = true;
        break;
      }
      if (!writeChecked(doc, parsed, edit.expectedChecked, edit.checked)) {
        outcomes.push({ path: edit.path, ok: false, errorCode: 'WRITE_FAILED' });
        failed = true;
        break;
      }
    } else {
      const current = readPath(doc, edit.path);
      if (current === null) {
        outcomes.push({ path: edit.path, ok: false, errorCode: 'PATH_NOT_FOUND' });
        failed = true;
        break;
      }
      if (current !== edit.expectedText) {
        outcomes.push({
          path: edit.path,
          ok: false,
          errorCode: 'EXPECTED_TEXT_MISMATCH',
          actualText: current,
        });
        failed = true;
        break;
      }
      if (!writeText(doc, parsed, edit.newText)) {
        outcomes.push({ path: edit.path, ok: false, errorCode: 'WRITE_FAILED' });
        failed = true;
        break;
      }
    }
    outcomes.push({ path: edit.path, ok: true });
  }

  if (failed) {
    if (snapshotId !== null) {
      try {
        doc.restoreSnapshot(snapshotId);
        doc.discardSnapshot(snapshotId);
      } catch {
        // 복원 실패는 삼키지 않는다 — 호출자가 ok:false 로 알고, 호스트는
        // 저장 게이트에서 다시 막는다.
      }
    }
    return { ok: false, applied: 0, outcomes, snapshotId: null };
  }

  return { ok: true, applied: outcomes.length, outcomes, snapshotId };
}
