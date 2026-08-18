// E2E: 중첩 표 객체 선택 — 안쪽 표 경계선 클릭이 그 표를 선택한다
//
// 계약: 표 경계선 클릭 → 표 객체 선택(모서리 핸들)은 최외곽 표만 지원했다.
// isTableBorderClick 이 getTableBBox(최외곽)만 보고, Direct 진입이 cellPath 를
// 버려서 안쪽 표는 마우스로 영원히 선택되지 않았다. 수정 후:
//   - 안쪽 표 경계선 클릭 → cellPath 경로로 그 표를 객체 선택 (핸들 표시)
//   - 최외곽 경계선 클릭 → 종전대로 flat 선택 (회귀 없음)
//   - 중첩 선택 상태의 이동/복사/잘라내기는 미지원 가드 (외곽 표 오조작 차단)
//
// 실행: node e2e/nested-table-object-selection.test.mjs --mode=headless

import {
  runTest, loadHwpFile, setTestCase, screenshot, assert,
} from './helpers.mjs';

const sleep = (page, ms) => page.evaluate((t) => new Promise((r) => setTimeout(r, t)), ms);

/** 페이지 0 을 훑어 cellPath 깊이2+ 인 지점(중첩 셀)을 찾는다. */
async function probeNestedCell(page) {
  return page.evaluate(() => {
    const wasm = window.__wasm;
    for (let y = 40; y < 1100; y += 12) {
      for (let x = 40; x < 780; x += 12) {
        try {
          const hit = wasm.hitTest(0, x, y);
          if (Array.isArray(hit.cellPath) && hit.cellPath.length >= 2
              && hit.parentParaIndex !== undefined && !hit.isTextBox) {
            return { hit, x, y };
          }
        } catch { /* 계속 */ }
      }
    }
    return null;
  });
}

/** 페이지 좌표 → 브라우저 클라이언트 좌표 변환 */
async function toClientCoord(page, pageX, pageY) {
  return page.evaluate(({ px, py }) => {
    const sc = document.querySelector('#scroll-content');
    const cr = sc.getBoundingClientRect();
    const ih = window.__inputHandler;
    const zoom = ih.viewportManager.getZoom();
    const vs = ih.virtualScroll;
    const po = vs.getPageOffset(0);
    const pl = vs.getPageLeftResolved(0, sc.clientWidth);
    return { cx: cr.left + pl + px * zoom, cy: cr.top + po + py * zoom };
  }, { px: pageX, py: pageY });
}

/** 페이지 좌표를 브라우저 클라이언트 좌표로 변환해 클릭한다. */
async function clickAtPageCoord(page, pageX, pageY) {
  const pt = await toClientCoord(page, pageX, pageY);
  await page.mouse.click(pt.cx, pt.cy);
}

/** 페이지 좌표로 마우스만 이동한다 (hover 유발). */
async function hoverAtPageCoord(page, pageX, pageY) {
  const pt = await toClientCoord(page, pageX, pageY);
  await page.mouse.move(pt.cx, pt.cy);
}

async function selectionState(page) {
  return page.evaluate(() => {
    const cursor = window.__inputHandler.cursor;
    const ref = cursor.getSelectedTableRef?.() ?? null;
    const layer = document.querySelector('.table-object-layer');
    return {
      objectSelected: cursor.isInTableObjectSelection?.() ?? false,
      pathLen: ref?.cellPath?.length ?? 0,
      ref: ref ? { sec: ref.sec, ppi: ref.ppi, ci: ref.ci } : null,
      layerChildren: layer ? layer.childElementCount : 0,
    };
  });
}

runTest('중첩 표 객체 선택 (경계선 클릭)', async ({ page }) => {
  setTestCase('nested-table-object-selection');
  await loadHwpFile(page, 'hwpx/nested-table-staff-handbook.hwpx');

  // [1] 중첩 셀 탐지 → 안쪽 표 합집합 bbox
  const probe = await probeNestedCell(page);
  assert(!!probe, '깊이2+ 중첩 셀 존재');
  const inner = await page.evaluate(({ hit }) => {
    const bboxes = window.__wasm.getTableCellBboxesByPath(
      hit.sectionIndex, hit.parentParaIndex, JSON.stringify(hit.cellPath));
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const b of bboxes) {
      if (b.pageIndex !== 0) continue;
      minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h);
    }
    return { minX, minY, maxX, maxY };
  }, { hit: probe.hit });
  console.log(`  안쪽 표 bbox: (${inner.minX.toFixed(0)},${inner.minY.toFixed(0)})–(${inner.maxX.toFixed(0)},${inner.maxY.toFixed(0)})`);

  // [2] 안쪽 표 상단 경계선 클릭 → 경로 기반 객체 선택 + 핸들 렌더
  await clickAtPageCoord(page, (inner.minX + inner.maxX) / 2, inner.minY + 1);
  await sleep(page, 300);
  let st = await selectionState(page);
  console.log(`  [2] objectSelected=${st.objectSelected} pathLen=${st.pathLen} layerChildren=${st.layerChildren}`);
  assert(st.objectSelected, '안쪽 표 경계선 클릭 → 표 객체 선택 진입');
  assert(st.pathLen >= 2, `selectedTableRef.cellPath 깊이2+ (실제 ${st.pathLen})`);
  assert(st.layerChildren > 0, '선택 오버레이(핸들) 렌더됨');
  await screenshot(page, '01-inner-table-selected');

  // [3] 중첩 선택 상태에서 내부 클릭 → 이동 드래그 없이 선택 해제 (가드)
  await clickAtPageCoord(page, (inner.minX + inner.maxX) / 2, (inner.minY + inner.maxY) / 2);
  await sleep(page, 300);
  st = await selectionState(page);
  assert(!st.objectSelected, '중첩 선택 중 내부 클릭 → 선택 해제 (이동 미발동)');

  // [4] 회귀 — 최외곽 표 좌측 경계선 클릭 → flat 선택 (cellPath 없음)
  const outer = await page.evaluate(({ hit }) => window.__wasm.getTableBBox(
    hit.sectionIndex, hit.parentParaIndex, hit.controlIndex), { hit: probe.hit });
  await clickAtPageCoord(page, outer.x + 1, outer.y + outer.height / 2);
  await sleep(page, 300);
  st = await selectionState(page);
  console.log(`  [4] objectSelected=${st.objectSelected} pathLen=${st.pathLen}`);
  assert(st.objectSelected, '최외곽 경계선 클릭 → 표 객체 선택 (회귀 없음)');
  assert(st.pathLen === 0, '최외곽 선택은 flat ref (cellPath 없음)');
  await screenshot(page, '02-outer-table-selected');

  // [5] 라이브 UX 재현 — hover 로 리사이즈 캐시를 프라임한 뒤 경계선 탭.
  //     mousedown 이 리사이즈 분기로 들어가더라도 무이동 탭은 그 표를
  //     경로째 객체 선택해야 한다 (finishResizeDrag 탭 전환 / 조기 반환 통과).
  await clickAtPageCoord(page, 200, 600); // 표 밖 클릭으로 선택 해제
  await sleep(page, 200);
  await hoverAtPageCoord(page, (inner.minX + inner.maxX) / 2, inner.maxY - 1);
  await sleep(page, 250); // RAF hover → 캐시 프라임 + 마커 표시 대기
  await clickAtPageCoord(page, (inner.minX + inner.maxX) / 2, inner.maxY - 1);
  await sleep(page, 300);
  st = await selectionState(page);
  console.log(`  [5] objectSelected=${st.objectSelected} pathLen=${st.pathLen}`);
  assert(st.objectSelected, 'hover 프라임 후 하단 경계 탭 → 표 객체 선택');
  assert(st.pathLen >= 2, `hover 탭 선택도 경로 ref (실제 ${st.pathLen})`);
  await screenshot(page, '03-inner-selected-after-hover');
});
