import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyEdits,
  buildOutline,
  cellPath,
  paragraphPath,
  parsePath,
  readPath,
  readPaths,
  type AuthoringDocument,
} from '../src/embed/authoring.ts';

/**
 * 문서 대역.
 *
 * 본문 문단은 문자열 배열, 표는 (문단 인덱스 → 셀 텍스트 배열)로 둔다.
 * WASM 호출 순서를 검사할 수 있게 mutation 로그를 남기고, 스냅샷은 전체
 * 상태를 깊은 복사해 실제 restoreSnapshot 과 같은 의미를 갖게 한다.
 */
class FakeDocument implements AuthoringDocument {
  paragraphs: string[][];
  tables: Map<string, { rows: number; cols: number; cells: string[] }>;
  snapshots = new Map<number, { paragraphs: string[][]; tables: Map<string, { rows: number; cols: number; cells: string[] }> }>();
  nextSnapshotId = 1;
  log: string[] = [];
  failWriteOnCellIndex: number | null = null;
  /** 표가 붙어 있는 컨트롤 인덱스. 실문서에서 0이 아닌 경우가 실제로 있다. */
  tableControlIndex = 0;

  constructor(
    paragraphs: string[][],
    tables: Record<string, { rows: number; cols: number; cells: string[] }> = {},
  ) {
    this.paragraphs = paragraphs;
    this.tables = new Map(Object.entries(tables).map(([key, value]) => [key, { ...value, cells: [...value.cells] }]));
  }

  private tableKey(sec: number, para: number): string {
    return `${sec}:${para}`;
  }

  getSectionCount(): number {
    return this.paragraphs.length;
  }

  getParagraphCount(sec: number): number {
    return this.paragraphs[sec]?.length ?? 0;
  }

  getParagraphLength(sec: number, para: number): number {
    const text = this.paragraphs[sec]?.[para];
    if (text === undefined) throw new Error('no such paragraph');
    return text.length;
  }

  getTextRange(sec: number, para: number, charOffset: number, count: number): string {
    const text = this.paragraphs[sec]?.[para];
    if (text === undefined) throw new Error('no such paragraph');
    return text.slice(charOffset, charOffset + count);
  }

  // 실제 WASM 은 rowCount/colCount/cellCount 로 돌려준다. 대역이 실물과
  // 다른 이름을 쓰면 단위 테스트는 통과하고 배포본만 조용히 비어 버린다.
  getTableDimensions(sec: number, parentPara: number, controlIdx: number): {
    rowCount: number; colCount: number; cellCount: number;
  } {
    const table = this.tables.get(this.tableKey(sec, parentPara));
    if (!table || controlIdx !== this.tableControlIndex) throw new Error('no table here');
    return { rowCount: table.rows, colCount: table.cols, cellCount: table.cells.length };
  }

  getCellInfo(sec: number, parentPara: number, controlIdx: number, cellIdx: number): {
    row: number; col: number; rowSpan: number; colSpan: number;
  } {
    const table = this.tables.get(this.tableKey(sec, parentPara));
    if (!table || controlIdx !== this.tableControlIndex) throw new Error('no table here');
    if (cellIdx >= table.cells.length) throw new Error('no such cell');
    return { row: Math.floor(cellIdx / table.cols), col: cellIdx % table.cols, rowSpan: 1, colSpan: 1 };
  }

  private cellIndexFromPath(pathJson: string): number {
    const parsed = JSON.parse(pathJson) as Array<{ cellIndex: number }>;
    return parsed[0].cellIndex;
  }

  getTextInCellByPath(sec: number, parentPara: number, pathJson: string, charOffset: number, count: number): string {
    const table = this.tables.get(this.tableKey(sec, parentPara));
    if (!table) throw new Error('no table here');
    const text = table.cells[this.cellIndexFromPath(pathJson)];
    if (text === undefined) throw new Error('no such cell');
    return text.slice(charOffset, charOffset + count);
  }

  getCellParagraphLengthByPath(sec: number, parentPara: number, pathJson: string): number {
    const table = this.tables.get(this.tableKey(sec, parentPara));
    if (!table) throw new Error('no table here');
    const text = table.cells[this.cellIndexFromPath(pathJson)];
    if (text === undefined) throw new Error('no such cell');
    return text.length;
  }

  insertTextInCellByPath(sec: number, parentPara: number, pathJson: string, charOffset: number, text: string): string {
    const table = this.tables.get(this.tableKey(sec, parentPara));
    if (!table) throw new Error('no table here');
    const index = this.cellIndexFromPath(pathJson);
    if (this.failWriteOnCellIndex === index) throw new Error('write failed');
    const current = table.cells[index];
    table.cells[index] = current.slice(0, charOffset) + text + current.slice(charOffset);
    this.log.push(`insertCell(${index},"${text}")`);
    return '{"ok":true}';
  }

  deleteTextInCellByPath(sec: number, parentPara: number, pathJson: string, charOffset: number, count: number): string {
    const table = this.tables.get(this.tableKey(sec, parentPara));
    if (!table) throw new Error('no table here');
    const index = this.cellIndexFromPath(pathJson);
    const current = table.cells[index];
    table.cells[index] = current.slice(0, charOffset) + current.slice(charOffset + count);
    this.log.push(`deleteCell(${index},${count})`);
    return '{"ok":true}';
  }

  insertText(sec: number, para: number, charOffset: number, text: string): string {
    const current = this.paragraphs[sec][para];
    this.paragraphs[sec][para] = current.slice(0, charOffset) + text + current.slice(charOffset);
    this.log.push(`insertPara(${para},"${text}")`);
    return '{"ok":true}';
  }

  deleteText(sec: number, para: number, charOffset: number, count: number): string {
    const current = this.paragraphs[sec][para];
    this.paragraphs[sec][para] = current.slice(0, charOffset) + current.slice(charOffset + count);
    this.log.push(`deletePara(${para},${count})`);
    return '{"ok":true}';
  }

  saveSnapshot(): number {
    const id = this.nextSnapshotId++;
    this.snapshots.set(id, {
      paragraphs: this.paragraphs.map((section) => [...section]),
      tables: new Map(Array.from(this.tables, ([key, value]) => [key, { ...value, cells: [...value.cells] }])),
    });
    this.log.push(`saveSnapshot(${id})`);
    return id;
  }

  restoreSnapshot(id: number): void {
    const snapshot = this.snapshots.get(id);
    if (!snapshot) throw new Error('no such snapshot');
    this.paragraphs = snapshot.paragraphs.map((section) => [...section]);
    this.tables = new Map(Array.from(snapshot.tables, ([key, value]) => [key, { ...value, cells: [...value.cells] }]));
    this.log.push(`restoreSnapshot(${id})`);
  }

  discardSnapshot(id: number): void {
    this.snapshots.delete(id);
    this.log.push(`discardSnapshot(${id})`);
  }
}

function sampleDocument(): FakeDocument {
  return new FakeDocument(
    [['회의비 사전 신청서', '', '아래와 같이 신청합니다.']],
    { '0:1': { rows: 2, cols: 2, cells: ['항목', '내용', '회의 목적', ''] } },
  );
}

test('경로 문법은 본문 문단과 표 셀을 구분해 왕복한다', () => {
  assert.deepEqual(parsePath('s0/p3'), { sec: 0, para: 3, cell: null });
  assert.deepEqual(parsePath('s1/p2/c0/cell5/p0'), {
    sec: 1, para: 2, cell: { ctrl: 0, cellIndex: 5, cellPara: 0 },
  });
  assert.equal(paragraphPath(0, 3), 's0/p3');
  assert.equal(cellPath(1, 2, 0, 5, 0), 's1/p2/c0/cell5/p0');

  // 형식을 벗어난 주소는 조용히 0번으로 해석하지 않고 거부한다.
  assert.equal(parsePath('s0'), null);
  assert.equal(parsePath('p0'), null);
  assert.equal(parsePath('s0/p1/c0/cell2'), null);
  assert.equal(parsePath(''), null);
});

test('outline은 빈 본문 문단은 빼되 빈 표 셀은 남긴다', () => {
  const outline = buildOutline(sampleDocument());
  assert.equal(outline.schemaVersion, 1);
  assert.equal(outline.truncated, false);
  assert.equal(outline.sections.length, 1);

  // 본문: 빈 문단(p1)은 표로 대체되고, 내용 없는 문단은 실리지 않는다.
  assert.deepEqual(outline.sections[0].paragraphs.map((node) => node.path), ['s0/p0', 's0/p2']);

  // 표 셀은 비어 있어도 전부 실린다 — 채워야 할 자리가 바로 그곳이다.
  const table = outline.sections[0].tables[0];
  assert.equal(table.path, 's0/p1/c0');
  assert.deepEqual({ rows: table.rows, cols: table.cols }, { rows: 2, cols: 2 });
  assert.deepEqual(table.cells.map((cell) => cell.path), [
    's0/p1/c0/cell0/p0', 's0/p1/c0/cell1/p0', 's0/p1/c0/cell2/p0', 's0/p1/c0/cell3/p0',
  ]);
  assert.deepEqual(table.cells.map((cell) => cell.preview), ['항목', '내용', '회의 목적', '']);
  assert.deepEqual(table.cells[2], {
    path: 's0/p1/c0/cell2/p0', kind: 'cell', length: 5, preview: '회의 목적', row: 1, col: 0,
  });
});

test('표가 컨트롤 0이 아닌 곳에 있어도 찾는다', () => {
  // 실측 회귀: swuniv 회의비신청서의 표는 컨트롤 2에 있었다. 컨트롤 0만
  // 보던 초기 구현은 개요를 조용히 비워 반환했고, 단위 테스트는 대역이
  // 컨트롤 0을 쓰는 바람에 통과했다.
  const doc = sampleDocument();
  doc.tableControlIndex = 2;

  const outline = buildOutline(doc);
  const table = outline.sections[0].tables[0];
  assert.ok(table, '컨트롤 0이 아니어도 표를 찾아야 한다');
  assert.equal(table.path, 's0/p1/c2');
  assert.deepEqual(table.cells.map((cell) => cell.path), [
    's0/p1/c2/cell0/p0', 's0/p1/c2/cell1/p0', 's0/p1/c2/cell2/p0', 's0/p1/c2/cell3/p0',
  ]);
  // 그 주소로 읽기·쓰기까지 이어져야 의미가 있다.
  assert.equal(readPath(doc, 's0/p1/c2/cell2/p0'), '회의 목적');
});

test('구역은 전체 문단 수를 함께 알려 빈 개요의 원인을 구분한다', () => {
  const outline = buildOutline(sampleDocument());
  // 문단 3개 중 내용 있는 것은 2개. 개요가 비었을 때 "문단이 없어서"인지
  // "전부 비어서"인지 호출자가 알 수 있어야 한다.
  assert.equal(outline.sections[0].paragraphCount, 3);
  assert.equal(outline.sections[0].paragraphs.length, 2);
});

test('outline preview는 길이를 잘라도 원본 길이를 함께 알린다', () => {
  const long = '가'.repeat(120);
  const outline = buildOutline(new FakeDocument([[long]]));
  const node = outline.sections[0].paragraphs[0];
  assert.equal(node.length, 120);
  assert.equal(node.preview.endsWith('…'), true);
  assert.ok(node.preview.length < 60, 'preview는 문서 전문을 실어 나르지 않는다');
});

test('read는 없는 경로와 빈 내용을 구분한다', () => {
  const doc = sampleDocument();
  assert.equal(readPath(doc, 's0/p0'), '회의비 사전 신청서');
  assert.equal(readPath(doc, 's0/p1/c0/cell2/p0'), '회의 목적');
  // 빈 셀은 '' 이고, 존재하지 않는 곳은 null 이다. 둘을 같게 만들면
  // 호출자가 "비었으니 채우자"와 "주소가 틀렸다"를 구별할 수 없다.
  assert.equal(readPath(doc, 's0/p1/c0/cell3/p0'), '');
  assert.equal(readPath(doc, 's0/p99'), null);
  assert.equal(readPath(doc, 'nonsense'), null);

  assert.deepEqual(readPaths(doc, ['s0/p0', 's0/p99']), [
    { path: 's0/p0', text: '회의비 사전 신청서' },
    { path: 's0/p99', text: null },
  ]);
});

test('applyEdits는 expectedText가 맞을 때만 쓰고 결과를 반영한다', () => {
  const doc = sampleDocument();
  const result = applyEdits(doc, [
    { path: 's0/p1/c0/cell3/p0', expectedText: '', newText: '정기 회의' },
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.applied, 1);
  assert.deepEqual(result.outcomes, [{ path: 's0/p1/c0/cell3/p0', ok: true }]);
  assert.equal(readPath(doc, 's0/p1/c0/cell3/p0'), '정기 회의');
  assert.notEqual(result.snapshotId, null);
});

test('expectedText가 어긋나면 고치지 않고 실제 값을 돌려준다', () => {
  const doc = sampleDocument();
  const result = applyEdits(doc, [
    { path: 's0/p1/c0/cell2/p0', expectedText: '다른 값', newText: '덮어쓰기' },
  ]);

  assert.equal(result.ok, false);
  assert.equal(result.applied, 0);
  assert.deepEqual(result.outcomes, [{
    path: 's0/p1/c0/cell2/p0',
    ok: false,
    errorCode: 'EXPECTED_TEXT_MISMATCH',
    actualText: '회의 목적',
  }]);
  // 추측 보정 금지 — 문서는 그대로다.
  assert.equal(readPath(doc, 's0/p1/c0/cell2/p0'), '회의 목적');
});

test('배치 중 하나라도 실패하면 전체가 원상 복구된다', () => {
  const doc = sampleDocument();
  const result = applyEdits(doc, [
    { path: 's0/p1/c0/cell1/p0', expectedText: '내용', newText: '바뀐 내용' },
    { path: 's0/p1/c0/cell3/p0', expectedText: '틀린 기대값', newText: '들어가면 안 됨' },
  ]);

  assert.equal(result.ok, false);
  assert.equal(result.applied, 0);
  assert.equal(result.snapshotId, null);

  // 먼저 성공했던 수정까지 되돌아간다. 부분 적용된 문서를 남기지 않는 것이
  // 이 동작의 핵심이다.
  assert.equal(readPath(doc, 's0/p1/c0/cell1/p0'), '내용');
  assert.equal(readPath(doc, 's0/p1/c0/cell3/p0'), '');
  assert.ok(doc.log.some((entry) => entry.startsWith('restoreSnapshot')));
});

test('쓰기 자체가 실패해도 원상 복구된다', () => {
  const doc = sampleDocument();
  doc.failWriteOnCellIndex = 3;
  const result = applyEdits(doc, [
    { path: 's0/p1/c0/cell1/p0', expectedText: '내용', newText: '바뀐 내용' },
    { path: 's0/p1/c0/cell3/p0', expectedText: '', newText: '실패할 쓰기' },
  ]);

  assert.equal(result.ok, false);
  assert.equal(result.outcomes.at(-1)?.errorCode, 'WRITE_FAILED');
  assert.equal(readPath(doc, 's0/p1/c0/cell1/p0'), '내용');
});

test('같은 문단의 편집은 뒤에서 앞으로 적용해 좌표가 밀리지 않는다', () => {
  const doc = new FakeDocument([['첫째', '둘째', '셋째']]);
  const result = applyEdits(doc, [
    { path: 's0/p0', expectedText: '첫째', newText: '1번' },
    { path: 's0/p2', expectedText: '셋째', newText: '3번' },
    { path: 's0/p1', expectedText: '둘째', newText: '2번' },
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.applied, 3);
  assert.deepEqual(doc.paragraphs[0], ['1번', '2번', '3번']);

  const order = doc.log.filter((entry) => entry.startsWith('insertPara'));
  assert.deepEqual(order, ['insertPara(2,"3번")', 'insertPara(1,"2번")', 'insertPara(0,"1번")']);
});

test('잘못된 주소는 문서를 건드리기 전에 걸러진다', () => {
  const doc = sampleDocument();
  const result = applyEdits(doc, [{ path: '엉뚱한 주소', expectedText: '', newText: 'x' }]);

  assert.equal(result.ok, false);
  assert.deepEqual(result.outcomes, [{ path: '엉뚱한 주소', ok: false, errorCode: 'PATH_INVALID' }]);
  assert.equal(doc.log.some((entry) => entry.startsWith('insert')), false);
});

test('빈 편집 묶음은 스냅샷도 만들지 않는다', () => {
  const doc = sampleDocument();
  const result = applyEdits(doc, []);
  assert.deepEqual(result, { ok: true, applied: 0, outcomes: [], snapshotId: null });
  assert.deepEqual(doc.log, []);
});

/**
 * 누름틀(가이드) 자리에 쓸 때는 <b>필드를 먼저 푼다</b>.
 *
 * 2026-08-23 실측 회귀: 필드를 남긴 채 그 안에 값을 써 넣었더니 변환기가 그것을
 * 안내문으로 보고 제출본에서 지웠다 — 신청서 9칸 중 누름틀 2칸(학번·수혜인력 성명)이
 * 담당자가 받는 PDF 에서 빈칸이었다. 글자 모양도 안내문 것을 따라간다.
 */
test('누름틀 자리에 쓰면 필드를 먼저 푼다 — 본문 문단', () => {
  const doc = sampleDocument();
  const released: unknown[] = [];
  (doc as any).removeFieldAt = (pos: unknown) => {
    released.push(pos);
    return { ok: true };
  };

  const path = paragraphPath(0, 0);
  const before = readPath(doc, path);
  const result = applyEdits(doc, [{ path, expectedText: before ?? '', newText: '채움테스트' }]);

  assert.equal(result.ok, true);
  assert.deepEqual(released, [{ sectionIndex: 0, paragraphIndex: 0, charOffset: 0 }]);
  assert.equal(readPath(doc, path), '채움테스트');
});

test('누름틀 자리에 쓰면 필드를 먼저 푼다 — 표 셀', () => {
  const doc = sampleDocument();
  const released: any[] = [];
  (doc as any).removeFieldAt = (pos: unknown) => {
    released.push(pos);
    return { ok: true };
  };

  const path = cellPath(0, 1, doc.tableControlIndex, 0, 0);
  const before = readPath(doc, path);
  const result = applyEdits(doc, [{ path, expectedText: before ?? '', newText: '20260823' }]);

  assert.equal(result.ok, true);
  assert.equal(released.length, 1);
  assert.equal(released[0].parentParaIndex, 1);
  assert.equal(released[0].controlIndex, doc.tableControlIndex);
  assert.equal(released[0].cellIndex, 0);
  assert.equal(released[0].cellParaIndex, 0);
  assert.equal(readPath(doc, path), '20260823');
});

test('누름틀 해제를 구현하지 않은 문서에서도 쓰기는 그대로 된다', () => {
  // removeFieldAt 은 optional 이다 — 없다고 쓰기가 막히면 안 된다.
  const doc = sampleDocument();
  const path = paragraphPath(0, 0);
  const before = readPath(doc, path);
  const result = applyEdits(doc, [{ path, expectedText: before ?? '', newText: '그대로' }]);

  assert.equal(result.ok, true);
  assert.equal(readPath(doc, path), '그대로');
});
