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
 *
 * 이 주소는 **세션 안에서만** 유효하다. 편집으로 문단이 밀리면 같은 주소가
 * 다른 곳을 가리킨다. 그래서 쓰기는 expectedText 를 반드시 함께 받고,
 * 불일치하면 고치지 않고 실패시킨다 (추측 보정 금지).
 */

/** authoring 이 쓰는 WASM 표면만 좁게 받는다. 테스트에서 대역을 넣기 쉽다. */
export interface AuthoringDocument {
  getSectionCount(): number;
  getParagraphCount(sec: number): number;
  getParagraphLength(sec: number, para: number): number;
  getTextRange(sec: number, para: number, charOffset: number, count: number): string;
  getTableDimensions(sec: number, parentPara: number, controlIdx: number): { rows: number; cols: number };
  getTextInCellByPath(sec: number, parentPara: number, pathJson: string, charOffset: number, count: number): string;
  getCellParagraphLengthByPath(sec: number, parentPara: number, pathJson: string): number;
  insertTextInCellByPath(sec: number, parentPara: number, pathJson: string, charOffset: number, text: string): string;
  deleteTextInCellByPath(sec: number, parentPara: number, pathJson: string, charOffset: number, count: number): string;
  insertText(sec: number, para: number, charOffset: number, text: string): string;
  deleteText(sec: number, para: number, charOffset: number, count: number): string;
  saveSnapshot(): number;
  restoreSnapshot(id: number): void;
  discardSnapshot(id: number): void;
}

export type NodeKind = 'paragraph' | 'cell';

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

export interface EditRequest {
  path: string;
  /** 현재 그 자리에 있어야 하는 텍스트. 다르면 적용하지 않는다. */
  expectedText: string;
  newText: string;
}

export interface EditOutcome {
  path: string;
  ok: boolean;
  errorCode?: 'PATH_INVALID' | 'PATH_NOT_FOUND' | 'EXPECTED_TEXT_MISMATCH' | 'WRITE_FAILED';
  /** 불일치 시 실제로 있던 텍스트. 호출자가 다시 판단할 근거. */
  actualText?: string;
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

interface ParsedPath {
  sec: number;
  para: number;
  /** 본문 문단이면 null. */
  cell: { ctrl: number; cellIndex: number; cellPara: number } | null;
}

const PARAGRAPH_PATH = /^s(\d+)\/p(\d+)$/;
const CELL_PATH = /^s(\d+)\/p(\d+)\/c(\d+)\/cell(\d+)\/p(\d+)$/;

export function parsePath(path: string): ParsedPath | null {
  const cell = CELL_PATH.exec(path);
  if (cell) {
    return {
      sec: Number(cell[1]),
      para: Number(cell[2]),
      cell: { ctrl: Number(cell[3]), cellIndex: Number(cell[4]), cellPara: Number(cell[5]) },
    };
  }
  const paragraph = PARAGRAPH_PATH.exec(path);
  if (paragraph) {
    return { sec: Number(paragraph[1]), para: Number(paragraph[2]), cell: null };
  }
  return null;
}

export function paragraphPath(sec: number, para: number): string {
  return `s${sec}/p${para}`;
}

export function cellPath(sec: number, para: number, ctrl: number, cellIndex: number, cellPara: number): string {
  return `s${sec}/p${para}/c${ctrl}/cell${cellIndex}/p${cellPara}`;
}

function cellPathJson(parsed: ParsedPath): string {
  const cell = parsed.cell;
  if (!cell) throw new Error('cellPathJson requires a cell path');
  return JSON.stringify([
    { controlIndex: cell.ctrl, cellIndex: cell.cellIndex, cellParaIndex: cell.cellPara },
  ]);
}

function preview(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= PREVIEW_LIMIT ? normalized : `${normalized.slice(0, PREVIEW_LIMIT)}…`;
}

/** 표가 아닌 문단에서 getTableDimensions 는 오류를 낸다. 존재 여부 판정에만 쓴다. */
function tryTableDimensions(
  doc: AuthoringDocument,
  sec: number,
  para: number,
  ctrl: number,
): { rows: number; cols: number } | null {
  try {
    const dimensions = doc.getTableDimensions(sec, para, ctrl);
    if (!dimensions || !Number.isFinite(dimensions.rows) || !Number.isFinite(dimensions.cols)) return null;
    if (dimensions.rows <= 0 || dimensions.cols <= 0) return null;
    return dimensions;
  } catch {
    return null;
  }
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

    for (let para = 0; para < paragraphCount; para += 1) {
      if (nodeCount >= MAX_OUTLINE_NODES) {
        truncated = true;
        break;
      }

      const dimensions = tryTableDimensions(doc, sec, para, 0);
      if (dimensions) {
        const cells: OutlineNode[] = [];
        for (let row = 0; row < dimensions.rows; row += 1) {
          for (let col = 0; col < dimensions.cols; col += 1) {
            if (nodeCount >= MAX_OUTLINE_NODES) {
              truncated = true;
              break;
            }
            const cellIndex = row * dimensions.cols + col;
            const path = cellPath(sec, para, 0, cellIndex, 0);
            const parsed = parsePath(path);
            const text = parsed ? readCellText(doc, sec, para, cellPathJson(parsed)) : '';
            cells.push({ path, kind: 'cell', length: text.length, preview: preview(text), row, col });
            nodeCount += 1;
          }
          if (truncated) break;
        }
        tables.push({ path: `s${sec}/p${para}/c0`, rows: dimensions.rows, cols: dimensions.cols, cells });
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
      paragraphs.push({
        path: paragraphPath(sec, para),
        kind: 'paragraph',
        length: text.length,
        preview: preview(text),
      });
      nodeCount += 1;
    }

    sections.push({ section: sec, paragraphs, tables });
  }

  return { schemaVersion: 1, sections, nodeCount, truncated };
}

/** 주소 하나의 현재 텍스트를 읽는다. 못 읽으면 null (빈 문자열과 구분한다). */
export function readPath(doc: AuthoringDocument, path: string): string | null {
  const parsed = parsePath(path);
  if (!parsed) return null;
  try {
    if (parsed.cell) {
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

/** 같은 문단 안에서 뒤쪽부터 고치도록 정렬한다. 앞선 수정이 뒤쪽 좌표를 밀지 않게. */
function sortForApply(edits: readonly EditRequest[]): EditRequest[] {
  return [...edits].sort((left, right) => {
    const a = parsePath(left.path);
    const b = parsePath(right.path);
    if (!a || !b) return 0;
    if (a.sec !== b.sec) return b.sec - a.sec;
    if (a.para !== b.para) return b.para - a.para;
    const aCell = a.cell?.cellIndex ?? -1;
    const bCell = b.cell?.cellIndex ?? -1;
    if (aCell !== bCell) return bCell - aCell;
    return (b.cell?.cellPara ?? 0) - (a.cell?.cellPara ?? 0);
  });
}

function writeText(doc: AuthoringDocument, parsed: ParsedPath, current: string, newText: string): boolean {
  try {
    if (parsed.cell) {
      const pathJson = cellPathJson(parsed);
      if (current.length > 0) {
        doc.deleteTextInCellByPath(parsed.sec, parsed.para, pathJson, 0, current.length);
      }
      if (newText.length > 0) {
        doc.insertTextInCellByPath(parsed.sec, parsed.para, pathJson, 0, newText);
      }
      return true;
    }
    if (current.length > 0) {
      doc.deleteText(parsed.sec, parsed.para, 0, current.length);
    }
    if (newText.length > 0) {
      doc.insertText(parsed.sec, parsed.para, 0, newText);
    }
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
    if (!writeText(doc, parsed, current, edit.newText)) {
      outcomes.push({ path: edit.path, ok: false, errorCode: 'WRITE_FAILED' });
      failed = true;
      break;
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
