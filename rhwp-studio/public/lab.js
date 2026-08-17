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
};

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
  for (const button of [el.load, el.outline, el.revert, el.lock, el.export, el.apply, el.read, el.mismatch, el.ai]) {
    button.disabled = !ready;
  }
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

el.load.addEventListener('click', async () => {
  const file = el.file.files?.[0];
  if (!file) {
    log('파일이 선택되지 않았습니다.', undefined, 'fail');
    return;
  }
  const bytes = await file.arrayBuffer();
  log('→ loadFile', { fileName: file.name, byteLength: bytes.byteLength });
  try {
    const result = await request('loadFile', { data: bytes, fileName: file.name, skipUnsavedGuard: true });
    log('✓ loadFile', result, 'ok');
  } catch (error) {
    log('✗ loadFile', error instanceof Error ? error.message : String(error), 'fail');
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
 * AI 채움·수정.
 *
 * 흐름: getOutline → 프록시(LLM) → 제안 diff → 사용자 승인 → applyEdits.
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
  clearProposal('개요를 읽는 중…');
  setAiBusy(true, '개요를 읽는 중…');
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
    if (nodes.length === 0) {
      clearProposal('문서에 읽을 노드가 없습니다. 문서를 먼저 여세요.');
      return;
    }

    setAiBusy(true, `AI 호출 중… (노드 ${nodes.length}개)`);
    log('→ AI fill', { nodes: nodes.length, instruction: el.aiInstruction.value || '(전체 채움)' });
    const response = await fetch('/api/fill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nodes,
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
