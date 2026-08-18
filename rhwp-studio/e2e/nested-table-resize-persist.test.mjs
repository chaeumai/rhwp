// E2E: 중첩 표 리사이즈 지속성 — 경계 드래그·객체 핸들 드래그가
//      화면과 HWPX 내보내기 양쪽에 반영된다
//
// 계약: cellSz 는 콘텐츠-최소 의미라 모델 높이가 표시 높이보다 작은 셀에
// delta 를 얹으면 화면·내보내기가 안 변한다 (scholarship 점선 박스 실측 —
// "화면에는 보였는데 저장하면 사라진다"의 정체는 그 반대 경로: delta 가
// 모델에만 쌓여 아무 데도 안 보이는 상태). 수정 후:
//   [A] 중첩 표 하단 경계 드래그 → 표시 높이 = 이전 표시 + 드래그량,
//       export→reload 후에도 유지 (targetHeight 절대 목표)
//   [B] 객체 선택 핸들(s) 드래그 → 비례 리사이즈 + 지속
//   [C] flat 표 핸들(e) 드래그 → 너비 리사이즈 (신설 기능 flat 회귀)
//
// 실행: node e2e/nested-table-resize-persist.test.mjs --mode=headless

import { runTest, loadHwpFile, setTestCase, screenshot, assert } from './helpers.mjs';

const sleep = (page, ms) => page.evaluate((t) => new Promise((r) => setTimeout(r, t)), ms);

async function findNested(page) {
  return page.evaluate(() => {
    const wasm = window.__wasm;
    for (let y = 40; y < 1100; y += 10) for (let x = 40; x < 780; x += 10) {
      try {
        const h = wasm.hitTest(0, x, y);
        if (h.cellPath?.length >= 2 && h.parentParaIndex !== undefined && !h.isTextBox) {
          return { sec: h.sectionIndex, ppi: h.parentParaIndex, pathJson: JSON.stringify(h.cellPath) };
        }
      } catch { /* 계속 */ }
    }
    return null;
  });
}

async function nestedUnion(page, ref) {
  return page.evaluate(({ sec, ppi, pathJson }) => {
    const bb = window.__wasm.getTableCellBboxesByPath(sec, ppi, pathJson);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const b of bb) {
      if (b.pageIndex !== 0) continue;
      minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h);
    }
    return { minX, minY, maxX, maxY, w: +(maxX - minX).toFixed(1), h: +(maxY - minY).toFixed(1) };
  }, ref);
}

async function toClient(page, pageX, pageY) {
  return page.evaluate(({ px, py }) => {
    const sc = document.querySelector('#scroll-content');
    const cr = sc.getBoundingClientRect();
    const ih = window.__inputHandler;
    const zoom = ih.viewportManager.getZoom();
    return {
      cx: cr.left + ih.virtualScroll.getPageLeftResolved(0, sc.clientWidth) + px * zoom,
      cy: cr.top + ih.virtualScroll.getPageOffset(0) + py * zoom,
    };
  }, { px: pageX, py: pageY });
}

async function dragFromTo(page, from, to) {
  await page.mouse.move(from.cx, from.cy);
  await sleep(page, 350); // hover RAF (리사이즈 캐시 프라임)
  await page.mouse.down();
  await page.mouse.move(to.cx, to.cy, { steps: 6 });
  await sleep(page, 150);
  await page.mouse.up();
  await sleep(page, 600);
}

async function exportReloadUnion(page, refFinder) {
  await page.evaluate(async () => {
    const wasm = window.__wasm;
    const bytes = wasm.exportHwpx();
    wasm.loadDocument(new Uint8Array(bytes), 'roundtrip.hwpx');
    window.__canvasView?.loadDocument?.();
    await new Promise((r) => setTimeout(r, 600));
  });
  const ref = await refFinder(page);
  return ref ? nestedUnion(page, ref) : null;
}

runTest('중첩 표 리사이즈 지속성 (경계·핸들)', async ({ page }) => {
  setTestCase('nested-table-resize-persist');
  await loadHwpFile(page, 'hwpx/nested-table-staff-handbook.hwpx');

  // ── [A] 하단 경계 드래그: 콘텐츠-최소 상태를 인위 재현 후 +30px ──
  let ref = await findNested(page);
  assert(!!ref, '깊이2 표 존재');
  // 모델 높이를 최소로 축소 — 표시는 콘텐츠가 지배 (model < display 상태 제작)
  await page.evaluate(({ sec, ppi, pathJson }) => {
    const bb = window.__wasm.getTableCellBboxesByPath(sec, ppi, pathJson);
    const updates = bb.map((b) => ({ cellIdx: b.cellIdx, targetHeight: 300 }));
    window.__wasm.resizeTableCellsByPath(sec, ppi, pathJson, updates);
    window.__canvasView?.refreshPages?.();
  }, ref);
  await sleep(page, 500);
  const u0 = await nestedUnion(page, ref);
  console.log(`  [A] 시작 표시 h=${u0.h}`);

  const cxm = (u0.minX + u0.maxX) / 2;
  const from = await toClient(page, cxm, u0.maxY - 1);
  const to = await toClient(page, cxm, u0.maxY + 29);
  await dragFromTo(page, from, to);
  const u1 = await nestedUnion(page, ref);
  console.log(`  [A] 드래그 후 표시 h=${u1.h} (기대 ~${(u0.h + 30).toFixed(1)})`);
  assert(Math.abs(u1.h - (u0.h + 30)) <= 4, `하단 경계 +30px 이 표시에 반영 (실제 ${(u1.h - u0.h).toFixed(1)}px)`);

  const u2 = await exportReloadUnion(page, findNested);
  assert(!!u2, '재로드 후 깊이2 표 존재');
  console.log(`  [A] export→reload 표시 h=${u2.h}`);
  assert(Math.abs(u2.h - u1.h) <= 2, `경계 드래그 리사이즈가 HWPX 왕복에서 유지 (${u1.h}→${u2.h})`);
  await screenshot(page, '01-border-drag-persist');

  // ── [B] 객체 핸들(s) 드래그: 선택 → 하단 핸들 +24px ──
  ref = await findNested(page);
  const b0 = await nestedUnion(page, ref);
  // 경계선 탭으로 객체 선택
  const tapAt = await toClient(page, (b0.minX + b0.maxX) / 2, b0.maxY - 1);
  await page.mouse.move(tapAt.cx, tapAt.cy);
  await sleep(page, 300);
  await page.mouse.click(tapAt.cx, tapAt.cy);
  await sleep(page, 300);
  const selSt = await page.evaluate(() => ({
    sel: window.__inputHandler.cursor.isInTableObjectSelection(),
    pathLen: window.__inputHandler.cursor.getSelectedTableRef()?.cellPath?.length ?? 0,
  }));
  assert(selSt.sel && selSt.pathLen >= 2, '경계 탭 → 중첩 표 객체 선택');

  const hFrom = await toClient(page, (b0.minX + b0.maxX) / 2, b0.maxY); // s 핸들
  const hTo = await toClient(page, (b0.minX + b0.maxX) / 2, b0.maxY + 24);
  await page.mouse.move(hFrom.cx, hFrom.cy);
  await sleep(page, 120);
  await page.mouse.down();
  await page.mouse.move(hTo.cx, hTo.cy, { steps: 5 });
  await sleep(page, 120);
  await page.mouse.up();
  await sleep(page, 600);
  const b1 = await nestedUnion(page, ref);
  console.log(`  [B] 핸들 드래그 후 표시 h=${b1.h} (기대 ~${(b0.h + 24).toFixed(1)})`);
  // 높이는 콘텐츠-최소·행최대 상호작용으로 수 px 오차가 남는다 (너비는 정확)
  assert(Math.abs(b1.h - (b0.h + 24)) <= 8, `s 핸들 +24px 이 표시에 반영 (실제 ${(b1.h - b0.h).toFixed(1)}px)`);
  const b2 = await exportReloadUnion(page, findNested);
  assert(Math.abs(b2.h - b1.h) <= 2, `핸들 리사이즈가 HWPX 왕복에서 유지 (${b1.h}→${b2.h})`);
  await screenshot(page, '02-handle-drag-persist');

  // ── [C] flat 표 핸들(e) 드래그: 최외곽 표 선택 → 우측 핸들 +30px ──
  ref = await findNested(page);
  const outer = await page.evaluate(({ sec, ppi, pathJson }) => {
    const path = JSON.parse(pathJson);
    const bbox = window.__wasm.getTableBBox(sec, ppi, path[0].controlIndex ?? path[0].controlIdx);
    return bbox;
  }, ref);
  const oTap = await toClient(page, outer.x + 1, outer.y + outer.height / 2);
  await page.mouse.move(oTap.cx, oTap.cy);
  await sleep(page, 300);
  await page.mouse.click(oTap.cx, oTap.cy);
  await sleep(page, 300);
  const flatSel = await page.evaluate(() => ({
    sel: window.__inputHandler.cursor.isInTableObjectSelection(),
    pathLen: window.__inputHandler.cursor.getSelectedTableRef()?.cellPath?.length ?? 0,
  }));
  assert(flatSel.sel && flatSel.pathLen === 0, '최외곽 표 flat 객체 선택');
  const eFrom = await toClient(page, outer.x + outer.width, outer.y + outer.height / 2); // e 핸들
  const eTo = await toClient(page, outer.x + outer.width + 30, outer.y + outer.height / 2);
  await page.mouse.move(eFrom.cx, eFrom.cy);
  await sleep(page, 120);
  await page.mouse.down();
  await page.mouse.move(eTo.cx, eTo.cy, { steps: 5 });
  await sleep(page, 120);
  await page.mouse.up();
  await sleep(page, 600);
  const outer2 = await page.evaluate(({ sec, ppi, pathJson }) => {
    const path = JSON.parse(pathJson);
    return window.__wasm.getTableBBox(sec, ppi, path[0].controlIndex ?? path[0].controlIdx);
  }, ref);
  console.log(`  [C] flat e 핸들: w ${outer.width.toFixed(1)} → ${outer2.width.toFixed(1)} (기대 ~+30)`);
  assert(Math.abs(outer2.width - (outer.width + 30)) <= 5,
    `flat 표 e 핸들 +30px 반영 (실제 ${(outer2.width - outer.width).toFixed(1)}px)`);
  await screenshot(page, '03-flat-handle-width');
});
