/**
 * rhwp AI 작성 표면 Lab.
 *
 * embed RPC 의 authoring 메서드(getOutline / getTextByPaths / applyEdits /
 * revertLastBatch / setInputLocked)를 사람이 직접 눌러 확인하는 하네스다.
 * 백엔드·AI 없이 편집기 표면만 떼어 시험한다 — 왕복 경로에 문제가 생겼을 때
 * "편집기가 잘못했나, 서버가 잘못했나"를 먼저 갈라내기 위해서다.
 *
 * 편집기와 같은 origin 에서 서빙되며, 호스트(한채움)가 쓰는 것과 똑같은
 * MessagePort 프로토콜로 붙는다.
 */

const PROTOCOL_VERSION = 1;
const SESSION_ID = `lab-${Math.random().toString(36).slice(2, 10)}`;
const REQUIRED_CAPABILITY = 'ai-authoring-v1';

/*
 * Lab 은 편집기의 PWA Service Worker 스코프 안에 있고, 빌드가 lab.html/lab.js
 * 를 precache 에 넣는다. 그래서 Lab 을 고쳐 배포해도 이전에 방문한 브라우저는
 * 옛 파일을 계속 받는다 — 실제로 "샘플이 눌리지 않는다"로 나타났다.
 *
 * Lab 은 검증용 하네스라 오프라인 동작이 필요 없다. 등록된 SW 와 캐시를
 * 걷어내 항상 최신 배포본이 뜨게 한다.
 */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations()
    .then((regs) => Promise.all(regs.map((r) => r.unregister())))
    .catch(() => {});
}
if (typeof caches !== 'undefined') {
  caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))).catch(() => {});
}

const el = {
  status: document.getElementById('editor-status'),
  frame: document.getElementById('editor'),
  file: document.getElementById('file'),
  load: document.getElementById('btn-load'),
  outline: document.getElementById('btn-outline'),
  revert: document.getElementById('btn-revert'),
  lock: document.getElementById('btn-lock'),
  export: document.getElementById('btn-export'),
  apply: document.getElementById('btn-apply'),
  read: document.getElementById('btn-read'),
  mismatch: document.getElementById('btn-mismatch'),
  path: document.getElementById('edit-path'),
  expected: document.getElementById('edit-expected'),
  newText: document.getElementById('edit-new'),
  outlineView: document.getElementById('outline'),
  log: document.getElementById('log'),
  aiContext: document.getElementById('ai-context'),
  aiInstruction: document.getElementById('ai-instruction'),
  ai: document.getElementById('btn-ai'),
  aiApply: document.getElementById('btn-ai-apply'),
  aiDiscard: document.getElementById('btn-ai-discard'),
  aiStatus: document.getElementById('ai-status'),
  aiDiff: document.getElementById('ai-diff'),
  samples: document.getElementById('samples'),
  tabEditor: document.getElementById('tab-editor'),
  tabCompare: document.getElementById('tab-compare'),
  viewEditor: document.getElementById('view-editor'),
  viewCompare: document.getElementById('view-compare'),
  compare: document.getElementById('btn-compare'),
  compareStatus: document.getElementById('compare-status'),
  pdfA: document.getElementById('pdf-a'),
  pdfB: document.getElementById('pdf-b'),
  pdfAMeta: document.getElementById('pdf-a-meta'),
  pdfBMeta: document.getElementById('pdf-b-meta'),
  plan: document.getElementById('btn-plan'),
  planView: document.getElementById('btn-plan-view'),
  planStatus: document.getElementById('plan-status'),
  planList: document.getElementById('plan-list'),
};

/** 현재 서식의 채움서식(계획). 사용자 작성 단계가 이걸 기준으로 돈다. */
let currentPlan = null;

/** 지금 열려 있는 문서의 출처. PDF 비교에서 "원본"을 무엇으로 잡을지 결정한다. */
let loadedSampleId = null;

let port = null;
let nextId = 0;
const pending = new Map();
let locked = false;

function log(label, payload, kind = 'meta') {
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  const head = document.createElement('span');
  head.className = kind;
  head.textContent = `${new Date().toLocaleTimeString('ko-KR', { hour12: false })}  ${label}`;
  entry.appendChild(head);
  if (payload !== undefined) {
    const body = document.createElement('div');
    body.textContent = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
    entry.appendChild(body);
  }
  el.log.appendChild(entry);
  el.log.scrollTop = el.log.scrollHeight;
}

function request(method, params) {
  if (!port) return Promise.reject(new Error('편집기에 연결되지 않았습니다.'));
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`응답 없음 (${method})`));
    }, 120_000);
    pending.set(id, { resolve, reject, timer });
    port.postMessage({ type: 'rhwp-request', version: PROTOCOL_VERSION, sessionId: SESSION_ID, id, method, params });
  });
}

/** 호출 한 건을 로그에 남기며 실행한다. 실패도 화면에 남겨야 시험이 된다. */
async function call(method, params) {
  log(`→ ${method}`, params === undefined ? undefined : params);
  try {
    const result = await request(method, params);
    log(`✓ ${method}`, result, 'ok');
    return result;
  } catch (error) {
    log(`✗ ${method}`, error instanceof Error ? error.message : String(error), 'fail');
    throw error;
  }
}

function setReady(ready, message) {
  el.status.textContent = message;
  for (const button of [el.load, el.outline, el.revert, el.lock, el.export, el.apply, el.read, el.mismatch, el.compare, el.plan]) {
    button.disabled = !ready;
  }
  for (const button of el.samples.querySelectorAll('button')) button.disabled = !ready;
  // 사용자 작성은 채움서식이 있어야 시작할 수 있다.
  el.ai.disabled = !ready || !currentPlan?.items?.length;
  el.planView.disabled = !currentPlan?.items?.length;
}

function connect() {
  const channel = new MessageChannel();
  channel.port1.onmessage = ({ data }) => {
    if (data?.type === 'rhwp-connected') {
      const capabilities = Array.isArray(data.capabilities) ? data.capabilities : [];
      if (!capabilities.includes(REQUIRED_CAPABILITY)) {
        // 조용히 기능을 감추지 않는다. 구버전 배포본과 붙었다는 사실 자체가
        // 알아야 할 정보다.
        setReady(false, `편집기가 ${REQUIRED_CAPABILITY} 를 제공하지 않습니다 — 구버전 배포본입니다.`);
        log('연결 거부', { capabilities }, 'fail');
        return;
      }
      setReady(true, `연결됨 · ${capabilities.join(', ')}`);
      log('연결됨', { sessionId: SESSION_ID, capabilities }, 'ok');
      // 편집기는 첫 connect 한 건만 binding 으로 잡는다. E2E 가 따로 붙을 수
      // 없으므로 이 채널을 그대로 빌려준다. Lab 은 검증용 하네스이고 편집기
      // 배포본이 아니므로 노출해도 되는 표면이다.
      window.__labRpc = request;
      window.__labReady = true;
      return;
    }
    if (data?.type === 'rhwp-connect-error') {
      setReady(false, `연결 실패: ${data.error?.message ?? '알 수 없는 오류'}`);
      log('연결 실패', data.error, 'fail');
      return;
    }
    if (data?.type !== 'rhwp-response' || typeof data.id !== 'number') return;
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    clearTimeout(entry.timer);
    if (data.error) {
      entry.reject(new Error(data.error?.message ?? String(data.error)));
      return;
    }
    entry.resolve(data.result);
  };
  channel.port1.start();
  port = channel.port1;

  el.frame.contentWindow.postMessage({
    type: 'rhwp-connect',
    version: PROTOCOL_VERSION,
    sessionId: SESSION_ID,
    capabilities: ['transferable-array-buffer'],
  }, window.location.origin, [channel.port2]);
}

el.frame.addEventListener('load', () => {
  setReady(false, '편집기 초기화를 기다리는 중…');
  connect();
});

async function loadBytesIntoEditor(bytes, fileName, sampleId) {
  log('→ loadFile', { fileName, byteLength: bytes.byteLength });
  try {
    const result = await request('loadFile', { data: bytes, fileName, skipUnsavedGuard: true });
    loadedSampleId = sampleId ?? null;
    // 문서가 바뀌면 이전 비교 결과는 더 이상 이 문서의 것이 아니다.
    resetCompare(sampleId ? '문서를 열었습니다. [PDF 비교 생성]을 누르세요.' : '직접 연 파일은 원본 PDF 기준선이 없습니다.');
    clearProposal('문서를 열었습니다.');
    void loadPlan(sampleId);
    log('✓ loadFile', result, 'ok');
    const pages = result && typeof result.pageCount === 'number' ? ` · ${result.pageCount}쪽` : '';
    // 상태를 여기서 확정한다. 호출부가 "여는 중…" 을 그대로 되돌려 놓으면
    // 문서가 실제로 열렸는데도 실패한 것처럼 보인다.
    setReady(true, `열림: ${fileName}${pages}`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log('✗ loadFile', message, 'fail');
    setReady(true, `열기 실패: ${message}`);
    return false;
  }
}

el.load.addEventListener('click', async () => {
  const file = el.file.files?.[0];
  if (!file) {
    log('파일이 선택되지 않았습니다.', undefined, 'fail');
    return;
  }
  await loadBytesIntoEditor(await file.arrayBuffer(), file.name, null);
});

/** 샘플 목록. 서버가 파일을 들고 있으므로 목록만 받아 버튼으로 만든다. */
async function loadSampleList() {
  try {
    const response = await fetch('/api/samples');
    const payload = await response.json();
    if (!payload.ok) throw new Error(payload.message ?? '목록을 받지 못했습니다');
    el.samples.replaceChildren();
    for (const sample of payload.samples) {
      const button = document.createElement('button');
      button.className = 'sample';
      button.disabled = !port;
      const title = document.createElement('span');
      title.textContent = sample.title;
      const note = document.createElement('span');
      note.className = 'note';
      note.textContent = sample.note;
      button.append(title, note);
      button.addEventListener('click', async () => {
        for (const other of el.samples.querySelectorAll('.sample')) other.classList.remove('active');
        button.classList.add('active');
        setReady(false, `${sample.title} 여는 중…`);
        try {
          const res = await fetch(`/api/samples/${encodeURIComponent(sample.id)}`);
          if (!res.ok) throw new Error(`샘플 수신 실패 (${res.status})`);
          const bytes = await res.arrayBuffer();
          // 성공·실패 모두 loadBytesIntoEditor 가 상태를 확정한다.
          await loadBytesIntoEditor(bytes, sample.fileName, sample.id);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log('✗ 샘플 열기', message, 'fail');
          button.classList.remove('active');
          setReady(true, `샘플 열기 실패: ${message}`);
        }
      });
      el.samples.appendChild(button);
    }
  } catch (error) {
    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent = `샘플 목록을 불러오지 못했습니다: ${error instanceof Error ? error.message : error}`;
    el.samples.replaceChildren(note);
  }
}
void loadSampleList();

/*
 * 탭 — 두 보기를 항상 렌더해 두고 활성만 표시한다.
 * 편집기 iframe 을 떼었다 붙이면 세션이 끊겨 문서가 날아간다.
 */
function selectPane(which) {
  const editor = which === 'editor';
  el.viewEditor.dataset.active = String(editor);
  el.viewCompare.dataset.active = String(!editor);
  el.tabEditor.classList.toggle('active', editor);
  el.tabCompare.classList.toggle('active', !editor);
  el.tabEditor.setAttribute('aria-selected', String(editor));
  el.tabCompare.setAttribute('aria-selected', String(!editor));
}
el.tabEditor.addEventListener('click', () => selectPane('editor'));
el.tabCompare.addEventListener('click', () => selectPane('compare'));
selectPane('editor');

let pdfUrls = [];
function resetCompare(message) {
  for (const url of pdfUrls) URL.revokeObjectURL(url);
  pdfUrls = [];
  el.pdfA.removeAttribute('src');
  el.pdfB.removeAttribute('src');
  el.pdfAMeta.textContent = '';
  el.pdfBMeta.textContent = '';
  el.compareStatus.textContent = message;
}

/**
 * 원본 PDF vs 현재 문서 PDF.
 *
 * 양쪽 모두 hwpAgent 로 변환한다. 한쪽만 다른 변환기를 쓰면 차이가 편집
 * 때문인지 변환기 때문인지 구분할 수 없다.
 */
el.compare.addEventListener('click', async () => {
  if (!loadedSampleId) {
    el.compareStatus.textContent = '샘플로 연 문서만 원본과 비교할 수 있습니다.';
    return;
  }
  el.compare.disabled = true;
  resetCompare('현재 문서를 내보내는 중…');
  try {
    const exported = await request('exportHwpx');
    const bytes = exported instanceof ArrayBuffer ? new Uint8Array(exported)
      : ArrayBuffer.isView(exported) ? new Uint8Array(exported.buffer, exported.byteOffset, exported.byteLength)
      : Uint8Array.from(exported);

    el.compareStatus.textContent = 'PDF 변환 중… (양쪽 모두 hwpAgent)';
    const started = Date.now();
    const [originalRes, editedRes] = await Promise.all([
      fetch(`/api/pdf/sample/${encodeURIComponent(loadedSampleId)}`),
      fetch('/api/pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: bytes,
      }),
    ]);
    if (!originalRes.ok) throw new Error(`원본 PDF 실패 (${originalRes.status})`);
    if (!editedRes.ok) {
      const detail = await editedRes.json().catch(() => null);
      throw new Error(detail?.message ?? `편집본 PDF 실패 (${editedRes.status})`);
    }

    const [originalPdf, editedPdf] = await Promise.all([originalRes.blob(), editedRes.blob()]);
    const urlA = URL.createObjectURL(originalPdf);
    const urlB = URL.createObjectURL(editedPdf);
    pdfUrls = [urlA, urlB];
    el.pdfA.src = urlA;
    el.pdfB.src = urlB;
    el.pdfAMeta.textContent = `${Math.round(originalPdf.size / 1024)}KB`;
    el.pdfBMeta.textContent = `${Math.round(editedPdf.size / 1024)}KB · HWPX ${Math.round(bytes.byteLength / 1024)}KB`;
    el.compareStatus.textContent = `변환 완료 (${((Date.now() - started) / 1000).toFixed(1)}s)`;
    log('✓ PDF 비교', {
      original: originalPdf.size, edited: editedPdf.size, ms: Date.now() - started,
    }, 'ok');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    resetCompare(`실패: ${message}`);
    log('✗ PDF 비교', message, 'fail');
  } finally {
    el.compare.disabled = !port;
  }
});

function nodeButton(node) {
  const button = document.createElement('button');
  button.className = 'node';
  const path = document.createElement('code');
  path.textContent = node.path;
  const preview = document.createElement('span');
  preview.className = node.preview ? 'preview' : 'preview blank';
  preview.textContent = node.preview || '(빈 칸)';
  button.append(path, preview);
  button.addEventListener('click', async () => {
    el.path.value = node.path;
    // 개요의 preview 는 잘린 값이다. 편집 폼에는 실제 전문을 넣어야
    // expectedText 가 맞는다.
    const rows = await call('getTextByPaths', { paths: [node.path] });
    const text = Array.isArray(rows) && rows[0] ? rows[0].text : null;
    el.expected.value = text ?? '';
  });
  return button;
}

function renderOutline(outline) {
  el.outlineView.replaceChildren();
  if (!outline?.sections?.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = '문서에 노드가 없습니다.';
    el.outlineView.appendChild(empty);
    return;
  }
  const summary = document.createElement('div');
  summary.className = 'group';
  summary.textContent = `노드 ${outline.nodeCount}개${outline.truncated ? ' (상한 초과로 잘림)' : ''}`;
  el.outlineView.appendChild(summary);

  for (const section of outline.sections) {
    if (section.paragraphs.length) {
      const head = document.createElement('div');
      head.className = 'group';
      head.textContent = `구역 ${section.section} · 본문 문단 ${section.paragraphs.length}`;
      el.outlineView.appendChild(head);
      for (const node of section.paragraphs) el.outlineView.appendChild(nodeButton(node));
    }
    for (const table of section.tables) {
      const head = document.createElement('div');
      head.className = 'group';
      head.textContent = `표 ${table.path} · ${table.rows}행 × ${table.cols}열`;
      el.outlineView.appendChild(head);
      for (const cell of table.cells) el.outlineView.appendChild(nodeButton(cell));
    }
  }
}

el.outline.addEventListener('click', async () => {
  try {
    renderOutline(await call('getOutline'));
  } catch {
    // 로그에 이미 남았다.
  }
});

el.read.addEventListener('click', async () => {
  const path = el.path.value.trim();
  if (!path) return;
  const rows = await call('getTextByPaths', { paths: [path] }).catch(() => null);
  if (Array.isArray(rows) && rows[0]) el.expected.value = rows[0].text ?? '';
});

el.apply.addEventListener('click', async () => {
  const path = el.path.value.trim();
  if (!path) return;
  const result = await call('applyEdits', {
    edits: [{ path, expectedText: el.expected.value, newText: el.newText.value }],
  }).catch(() => null);
  if (result?.ok) {
    // 적용에 성공하면 다음 편집의 기준값이 방금 넣은 값이다.
    el.expected.value = el.newText.value;
  }
});

el.mismatch.addEventListener('click', async () => {
  const path = el.path.value.trim();
  if (!path) return;
  await call('applyEdits', {
    edits: [{ path, expectedText: `${el.expected.value}__틀린기대값__`, newText: '들어가면 안 되는 값' }],
  }).catch(() => null);
});

el.revert.addEventListener('click', () => { void call('revertLastBatch'); });

el.lock.addEventListener('click', async () => {
  const result = await call('setInputLocked', { locked: !locked }).catch(() => null);
  if (!result) return;
  locked = result.locked === true;
  el.lock.textContent = `입력 잠금: ${locked ? '잠김' : '해제됨'}`;
  el.lock.classList.toggle('primary', locked);
});

/*
 * 채움서식(계획) — 서식 등록 시점에 1회 만든다.
 *
 * "어느 칸에 무엇이 들어가는가"를 미리 판정해 저장한다. 사용자 작성 단계는
 * 이 계획을 기준으로 값만 만든다. 판정과 채움을 분리하는 이유:
 *   - 판정을 사람이 검토·수정할 수 있다
 *   - 같은 서식을 여러 번 써도 판정은 한 번이면 된다
 *   - 사진·서명 영역이 애초에 목록에서 빠진다
 */
function renderPlan(items, bindings) {
  el.planList.replaceChildren();
  for (const item of items) {
    const bind = bindings?.get(item.path);
    const row = document.createElement('div');
    row.className = bind && !bind.ok ? 'plan-row unbound' : 'plan-row';

    const content = document.createElement('span');
    content.className = 'content';
    content.textContent = item.content || item.label || item.path;
    const src = document.createElement('span');
    src.className = 'src';
    src.dataset.s = item.source || '';
    src.textContent = item.source || '';
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = bind && !bind.ok
      ? `${item.path} — ${bind.why}`
      : `${item.path}${item.label ? ` · ${item.label}` : ''}${bind?.current ? ` · 현재 "${bind.current.slice(0, 20)}"` : ''}`;

    row.append(content, src, meta);
    el.planList.appendChild(row);
  }
}

/**
 * 계획이 현재 문서에 여전히 맞는지 확인한다.
 *
 * 사용자가 표 행을 늘리거나 줄이면 셀 인덱스가 밀려 계획의 path 가 다른 칸을
 * 가리킨다. 값이 둘 다 비어 있으면 expectedText 검증으로도 안 잡히므로,
 * 여기서 문서 구조와 대조해 어긋난 항목을 unbound 로 표면화한다.
 * 추측해서 다시 맞추지 않는다 — 틀린 자리에 값이 들어가는 것보다 낫다.
 */
async function resolvePlanBindings(items) {
  const outline = await call('getOutline');
  const cells = outline.sections.flatMap((s) => s.tables).flatMap((t) => t.cells);
  const byPath = new Map(cells.map((c) => [c.path, c]));
  const tableOf = (p) => p.replace(/\/cell\d+\/p\d+$/, '');

  const bindings = new Map();
  for (const item of items) {
    const cell = byPath.get(item.path);
    if (!cell) {
      bindings.set(item.path, { ok: false, why: '문서에 없는 주소 (구조가 바뀌었을 수 있습니다)' });
      continue;
    }
    /*
     * 계획이 기억한 라벨이 아직 그 자리를 설명하는지 본다.
     *
     * 라벨은 두 곳 중 하나에 있다:
     *   - 같은 행 (「성명 | ___」 형태)
     *   - 같은 열의 헤더 행 (「구분 | 학과(전공) | 학번」 아래 데이터 행)
     * 둘 다 봐야 한다. 같은 행만 보면 명단 표가 통째로 어긋난 것으로 나온다.
     */
    if (item.label) {
      const table = tableOf(item.path);
      const same = cells.filter((c) => tableOf(c.path) === table);
      const rowLabels = same.filter((c) => c.row === cell.row && c.preview).map((c) => c.preview);
      const colHeaders = same.filter((c) => c.col === cell.col && c.row < cell.row && c.preview).map((c) => c.preview);
      const nearby = [...rowLabels, ...colHeaders].map((t) => t.replace(/\s+/g, ''));
      const want = item.label.replace(/\s+/g, '');
      if (nearby.length > 0 && !nearby.some((l) => l.includes(want) || want.includes(l))) {
        bindings.set(item.path, {
          ok: false,
          why: `라벨 불일치 — 계획 "${item.label}", 주변 [${nearby.slice(0, 4).join(', ')}]`,
          current: cell.preview,
        });
        continue;
      }
    }
    bindings.set(item.path, { ok: true, current: cell.preview });
  }
  return bindings;
}

async function loadPlan(sampleId) {
  currentPlan = null;
  el.planList.replaceChildren();
  if (!sampleId) {
    el.planStatus.textContent = '직접 연 파일은 채움서식을 만들 수 없습니다(샘플만 지원).';
    setReady(true, el.status.textContent);
    return;
  }
  try {
    const response = await fetch(`/api/plan/${encodeURIComponent(sampleId)}`);
    const payload = await response.json();
    if (payload.ok && payload.exists) {
      currentPlan = payload.plan;
      const n = payload.plan.items.length;
      el.planStatus.textContent = `채움서식 있음 — ${n}개 항목 (${payload.plan.promptKey} v${payload.plan.promptVersion}, ${payload.plan.createdAt.slice(0, 16).replace('T', ' ')})`;
    } else {
      el.planStatus.textContent = '채움서식이 없습니다. [채움서식 만들기]를 먼저 누르세요.';
    }
  } catch (error) {
    el.planStatus.textContent = `채움서식 조회 실패: ${error instanceof Error ? error.message : error}`;
  }
  setReady(true, el.status.textContent);
}

el.plan.addEventListener('click', async () => {
  if (!loadedSampleId) {
    el.planStatus.textContent = '샘플로 연 서식만 채움서식을 만들 수 있습니다.';
    return;
  }
  setReady(false, '채움서식 판정 중…');
  el.planStatus.textContent = '문서 구조를 읽고 각 칸의 의미를 판정하는 중… (서식당 1회, 오래 걸립니다)';
  try {
    const outline = await call('getOutline');
    const nodes = [];
    for (const section of outline.sections) {
      for (const node of section.paragraphs) nodes.push({ path: node.path, text: node.preview });
      for (const table of section.tables) {
        for (const cell of table.cells) {
          nodes.push({ path: cell.path, row: cell.row, col: cell.col, text: cell.preview });
        }
      }
    }
    const response = await fetch(`/api/plan/${encodeURIComponent(loadedSampleId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodes }),
    });
    const payload = await response.json();
    if (!payload.ok) throw new Error(payload.message ?? `HTTP ${response.status}`);
    currentPlan = payload.plan;
    const bySource = payload.plan.items.reduce((m, i) => {
      m[i.source] = (m[i.source] || 0) + 1;
      return m;
    }, {});
    el.planStatus.textContent = `채움서식 생성 — ${payload.plan.items.length}개 항목 `
      + `(${Object.entries(bySource).map(([k, v]) => `${k} ${v}`).join(' · ')}) · ${(payload.elapsedMs / 1000).toFixed(1)}s`;
    log('✓ 채움서식', {
      items: payload.plan.items.length, bySource, ms: payload.elapsedMs, usage: payload.usage,
    }, 'ok');
    renderPlan(payload.plan.items);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    el.planStatus.textContent = `판정 실패: ${message}`;
    log('✗ 채움서식', message, 'fail');
  } finally {
    setReady(true, el.status.textContent);
  }
});

el.planView.addEventListener('click', async () => {
  if (!currentPlan?.items?.length) return;
  el.planStatus.textContent = '문서와 대조하는 중…';
  try {
    const bindings = await resolvePlanBindings(currentPlan.items);
    const broken = [...bindings.values()].filter((b) => !b.ok).length;
    renderPlan(currentPlan.items, bindings);
    el.planStatus.textContent = broken === 0
      ? `${currentPlan.items.length}개 항목 · 문서와 모두 일치`
      : `${currentPlan.items.length}개 항목 · ${broken}개가 문서와 어긋남 (구조가 바뀌었습니다)`;
  } catch (error) {
    el.planStatus.textContent = `대조 실패: ${error instanceof Error ? error.message : error}`;
  }
});

/*
 * 사용자 작성 — 채움서식을 기준으로 값만 만든다.
 *
 * 흐름: 계획 → 문서와 대조 → 프록시(LLM) → 제안 diff → 승인 → applyEdits.
 * 승인 단계를 두는 이유는 문서가 사용자의 제출물이기 때문이다. 무엇이
 * 바뀌는지 보이지 않는 채로 반영하지 않는다.
 */
let pendingEdits = null;

function setAiBusy(busy, message) {
  el.ai.disabled = busy || !port;
  el.aiStatus.textContent = message;
  el.aiApply.disabled = busy || !pendingEdits?.length;
  el.aiDiscard.disabled = busy || !pendingEdits?.length;
}

function clearProposal(message) {
  pendingEdits = null;
  el.aiDiff.replaceChildren();
  setAiBusy(false, message);
}

function renderProposal(rows) {
  el.aiDiff.replaceChildren();
  for (const row of rows) {
    const item = document.createElement('div');
    item.className = row.ok ? 'diff-row' : 'diff-row bad';
    const path = document.createElement('code');
    path.textContent = row.path;
    const to = document.createElement('div');
    if (row.ok) {
      if (row.from) {
        const from = document.createElement('div');
        from.className = 'from';
        from.textContent = row.from;
        item.append(path, from);
      } else {
        item.append(path);
      }
      to.className = 'to';
      to.textContent = row.to;
    } else {
      to.textContent = row.error;
      item.append(path);
    }
    item.append(to);
    el.aiDiff.appendChild(item);
  }
}

el.ai.addEventListener('click', async () => {
  if (!currentPlan?.items?.length) {
    clearProposal('채움서식이 없습니다. 2단계에서 먼저 만드세요.');
    return;
  }
  clearProposal('채움서식을 문서와 대조하는 중…');
  setAiBusy(true, '채움서식을 문서와 대조하는 중…');
  try {
    // 계획이 현재 문서에 맞는지 먼저 확인한다. 어긋난 항목은 채우지 않는다.
    const bindings = await resolvePlanBindings(currentPlan.items);
    const boundItems = currentPlan.items.filter((i) => bindings.get(i.path)?.ok);
    const broken = currentPlan.items.length - boundItems.length;
    if (broken > 0) {
      renderPlan(currentPlan.items, bindings);
      log('채움서식 대조', { 일치: boundItems.length, 어긋남: broken }, 'fail');
    }
    if (boundItems.length === 0) {
      clearProposal(`채움서식이 문서와 전부 어긋났습니다. 서식을 다시 열거나 채움서식을 새로 만드세요.`);
      return;
    }

    // 현재 값을 붙여 보낸다 — 이미 채워진 칸을 덮어쓰지 않기 위한 근거다.
    const items = boundItems.map((i) => ({
      path: i.path,
      label: i.label,
      content: i.content,
      source: i.source,
      current: bindings.get(i.path)?.current ?? '',
    }));

    setAiBusy(true, `AI 호출 중… (계획 ${items.length}개${broken ? `, 어긋남 ${broken}개 제외` : ''})`);
    log('→ AI fill', { items: items.length, broken, instruction: el.aiInstruction.value || '(계획 전체)' });
    const response = await fetch('/api/fill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items,
        context: el.aiContext.value,
        instruction: el.aiInstruction.value,
      }),
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      log('✗ AI fill', payload.message ?? `HTTP ${response.status}`, 'fail');
      clearProposal(`AI 호출 실패: ${payload.message ?? response.status}`);
      return;
    }
    log('✓ AI fill', {
      model: payload.model,
      edits: payload.edits.length,
      ms: payload.elapsedMs,
      usage: payload.usage,
      message: payload.message,
    }, 'ok');

    if (payload.edits.length === 0) {
      clearProposal(`AI가 제안한 변경이 없습니다. ${payload.message || ''}`.trim());
      return;
    }

    // expectedText 는 모델이 아니라 문서에서 읽은 실제 값으로 채운다. 모델이
    // 본 것은 preview(공백 정규화·절단)라 원문을 그대로 되뇔 수 없다.
    const rows = await call('getTextByPaths', { paths: payload.edits.map((e) => e.path) });
    const byPath = new Map(rows.map((r) => [r.path, r.text]));

    const preview = [];
    const usable = [];
    for (const edit of payload.edits) {
      const current = byPath.get(edit.path);
      if (current === null || current === undefined) {
        preview.push({ path: edit.path, ok: false, error: '문서에 없는 경로 — 건너뜁니다' });
        continue;
      }
      usable.push({ path: edit.path, expectedText: current, newText: edit.newText });
      preview.push({ path: edit.path, ok: true, from: current, to: edit.newText });
    }

    pendingEdits = usable;
    renderProposal(preview);
    setAiBusy(false, `제안 ${usable.length}건. 확인 후 반영하세요.${payload.message ? ` — ${payload.message}` : ''}`);
  } catch (error) {
    clearProposal(`실패: ${error instanceof Error ? error.message : String(error)}`);
  }
});

el.aiApply.addEventListener('click', async () => {
  if (!pendingEdits?.length) return;
  setAiBusy(true, '반영 중…');
  const result = await call('applyEdits', { edits: pendingEdits }).catch(() => null);
  if (result?.ok) {
    clearProposal(`반영 완료 — ${result.applied}건. 되돌리려면 revertLastBatch.`);
  } else {
    const failed = result?.outcomes?.find((o) => !o.ok);
    clearProposal(`반영 실패${failed ? ` — ${failed.errorCode} (${failed.path})` : ''}`);
  }
});

el.aiDiscard.addEventListener('click', () => clearProposal('제안을 버렸습니다.'));

el.export.addEventListener('click', async () => {
  const result = await request('exportHwpx').catch((error) => {
    log('✗ exportHwpx', error.message, 'fail');
    return null;
  });
  if (!result) return;
  const bytes = result instanceof ArrayBuffer ? new Uint8Array(result)
    : ArrayBuffer.isView(result) ? new Uint8Array(result.buffer, result.byteOffset, result.byteLength)
    : Array.isArray(result) ? Uint8Array.from(result) : null;
  if (!bytes) {
    log('✗ exportHwpx', '바이트를 해석하지 못했습니다.', 'fail');
    return;
  }
  log('✓ exportHwpx', `${bytes.byteLength} bytes`, 'ok');
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/hwp+zip' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'lab-export.hwpx';
  anchor.click();
  URL.revokeObjectURL(url);
});
