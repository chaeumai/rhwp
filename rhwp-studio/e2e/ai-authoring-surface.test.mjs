/**
 * AI 작성 표면 E2E — 배포된 Lab 을 실제 브라우저로 구동한다.
 *
 * 단위 테스트는 대역 문서 위에서 돌기 때문에 "WASM 이 실제로 그 인자를 받는가"
 * 를 증명하지 못한다. 여기서는 실제 HWPX 를 실제 편집기에 열고, embed RPC 로
 * outline → read → write → 검증 → 되돌리기까지 관통시킨다.
 *
 * 실행:
 *   node e2e/ai-authoring-surface.test.mjs
 *   LAB_URL=https://rhwp-ai.hdev.kr/lab.html node e2e/ai-authoring-surface.test.mjs
 */
import { existsSync, readdirSync } from 'fs';
import os from 'os';
import path from 'path';
import puppeteer from 'puppeteer-core';

const LAB_URL = process.env.LAB_URL || 'https://rhwp-ai.hdev.kr/lab.html';
const SAMPLE = process.env.SAMPLE_HWPX
  || '/home/ubuntu/storage/hanchaeum/demo/swuniv-mentor-templates/2-1.SW전공_멘토링_멘토용_회의비신청서(사용전).hwpx';

function resolveChromePath() {
  const envPath = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
  if (envPath && existsSync(envPath)) return envPath;
  const system = ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium']
    .find((candidate) => existsSync(candidate));
  if (system) return system;
  const cacheRoot = path.join(os.homedir(), '.cache', 'puppeteer');
  if (!existsSync(cacheRoot)) return '';
  const stack = [cacheRoot];
  const found = [];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(candidate);
      else if (entry.name === 'chrome' || entry.name === 'chrome-headless-shell') found.push(candidate);
    }
  }
  const sorted = found.sort().reverse();
  return sorted.find((c) => path.basename(c) === 'chrome') || sorted[0] || '';
}

const checks = [];
function check(label, condition, detail) {
  checks.push({ label, ok: !!condition, detail });
  console.log(`${condition ? '  ok  ' : '  FAIL'} ${label}${detail !== undefined && !condition ? ` — ${JSON.stringify(detail)}` : ''}`);
}

const browser = await puppeteer.launch({
  headless: 'new',
  executablePath: resolveChromePath(),
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  page.on('pageerror', (error) => console.log(`  [pageerror] ${error.message}`));

  console.log(`\n== AI 작성 표면 E2E ==\n  lab   : ${LAB_URL}\n  sample: ${path.basename(SAMPLE)}\n`);
  await page.goto(LAB_URL, { waitUntil: 'networkidle2', timeout: 120_000 });

  // 1) 연결 — capability 협상까지 끝나야 버튼이 열린다.
  await page.waitForFunction(
    () => document.getElementById('btn-outline') && !document.getElementById('btn-outline').disabled,
    { timeout: 120_000 },
  );
  const status = await page.$eval('#editor-status', (node) => node.textContent);
  check('편집기 연결과 capability 협상', status.includes('ai-authoring-v1'), status);

  // 2) 실제 HWPX 적재
  const input = await page.$('#file');
  await input.uploadFile(SAMPLE);
  await page.click('#btn-load');
  await page.waitForFunction(
    () => document.getElementById('log').textContent.includes('✓ loadFile'),
    { timeout: 180_000 },
  );
  check('실제 HWPX 적재', true);

  /**
   * 편집기는 첫 connect 한 건만 binding 으로 잡으므로 새 채널을 열 수 없다.
   * Lab 이 이미 맺어 둔 채널을 그대로 빌려 쓴다.
   */
  const rpc = async (method, params) => page.evaluate(
    (m, p) => window.__labRpc(m, p),
    method, params,
  );

  // 3) outline — 구조가 실제로 읽히는가
  const outline = await rpc('getOutline');
  const tables = outline.sections.flatMap((section) => section.tables);
  const cells = tables.flatMap((table) => table.cells);
  check('getOutline 이 구조를 반환', outline.schemaVersion === 1 && outline.sections.length > 0);
  check('표와 셀이 인식됨', tables.length > 0 && cells.length > 0, { tables: tables.length, cells: cells.length });
  console.log(`       구역 ${outline.sections.length} · 표 ${tables.length} · 셀 ${cells.length} · 노드 ${outline.nodeCount}`);

  // outline 이 문서 전문을 실어 나르지 않는지 — 이게 이 설계의 핵심 주장이다.
  const outlineBytes = new TextEncoder().encode(JSON.stringify(outline)).length;
  console.log(`       outline 직렬화 ${outlineBytes} bytes`);

  // 4) 빈 셀을 찾아 쓰기
  const target = cells.find((cell) => cell.preview === '' && cell.length === 0);
  check('채울 빈 셀이 개요에 남아 있음', !!target, target?.path);
  if (!target) throw new Error('빈 셀을 찾지 못해 쓰기 검증을 진행할 수 없다');

  const before = await rpc('getTextByPaths', { paths: [target.path] });
  check('빈 셀 읽기는 null 이 아니라 빈 문자열', before[0].text === '', before[0]);

  // 5) expectedText 불일치는 거부되어야 한다
  const rejected = await rpc('applyEdits', {
    edits: [{ path: target.path, expectedText: '있지도 않은 값', newText: '들어가면 안 됨' }],
  });
  check('불일치 편집 거부', rejected.ok === false && rejected.outcomes[0].errorCode === 'EXPECTED_TEXT_MISMATCH', rejected);
  const afterReject = await rpc('getTextByPaths', { paths: [target.path] });
  check('거부 후 문서 불변', afterReject[0].text === '', afterReject[0]);

  // 6) 정상 쓰기
  const VALUE = '정기 연구 회의';
  const applied = await rpc('applyEdits', {
    edits: [{ path: target.path, expectedText: '', newText: VALUE }],
  });
  check('정상 편집 적용', applied.ok === true && applied.applied === 1, applied);
  const afterWrite = await rpc('getTextByPaths', { paths: [target.path] });
  check('쓴 값이 문서에서 읽힘', afterWrite[0].text === VALUE, afterWrite[0]);

  // 7) 되돌리기
  const reverted = await rpc('revertLastBatch');
  check('revertLastBatch 성공', reverted.ok === true && reverted.reverted === true, reverted);
  const afterRevert = await rpc('getTextByPaths', { paths: [target.path] });
  check('되돌린 뒤 원래 값으로 복귀', afterRevert[0].text === '', afterRevert[0]);

  // 8) 원자성 — 두 건 중 뒤엣것이 실패하면 앞엣것도 남지 않아야 한다
  const filled = cells.filter((cell) => cell.length > 0);
  if (filled.length > 0 && target) {
    const partner = filled[0];
    const partnerText = (await rpc('getTextByPaths', { paths: [partner.path] }))[0].text;
    const batch = await rpc('applyEdits', {
      edits: [
        { path: target.path, expectedText: '', newText: '먼저 성공할 값' },
        { path: partner.path, expectedText: '틀린 기대값', newText: '실패해야 함' },
      ],
    });
    check('배치 실패 보고', batch.ok === false, batch.outcomes);
    const rolled = await rpc('getTextByPaths', { paths: [target.path, partner.path] });
    check('부분 적용 없이 전부 원복', rolled[0].text === '' && rolled[1].text === partnerText, rolled);
  }

  // 9) 입력 잠금 — 실제 키 입력이 문서에 닿지 않아야 한다
  const lockOn = await rpc('setInputLocked', { locked: true });
  check('입력 잠금 설정', lockOn.locked === true, lockOn);
  const frame = page.frames().find((f) => f !== page.mainFrame() && !f.url().includes('lab.html'));
  if (frame) {
    await frame.click('canvas').catch(() => {});
    await page.keyboard.type('침입시도');
    await new Promise((resolve) => setTimeout(resolve, 500));
    const afterTyping = await rpc('getTextByPaths', { paths: [target.path] });
    check('잠금 중 타이핑이 문서에 반영되지 않음', afterTyping[0].text === '', afterTyping[0]);
  } else {
    check('편집기 프레임 확보', false, page.frames().map((f) => f.url()));
  }
  const lockOff = await rpc('setInputLocked', { locked: false });
  check('입력 잠금 해제', lockOff.locked === false, lockOff);

  // 10) 저장 경로가 살아 있는가 — 작성 결과를 HWPX 로 뽑을 수 있어야 한다.
  // 바이트는 페이지 밖으로 직렬화되지 않으므로 크기만 페이지 안에서 잰다.
  const size = await page.evaluate(async () => {
    const result = await window.__labRpc('exportHwpx');
    if (result instanceof ArrayBuffer) return result.byteLength;
    if (ArrayBuffer.isView(result)) return result.byteLength;
    if (Array.isArray(result)) return result.length;
    return 0;
  });
  check('exportHwpx 가 바이트를 반환', size > 1000, { size });
} finally {
  await browser.close();
}

const failed = checks.filter((entry) => !entry.ok);
console.log(`\n== 결과: ${checks.length - failed.length}/${checks.length} 통과 ==`);
if (failed.length) {
  console.log(failed.map((entry) => `  FAIL ${entry.label}`).join('\n'));
  process.exit(1);
}
