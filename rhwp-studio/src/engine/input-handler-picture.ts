/** input-handler picture/shape methods — extracted from InputHandler class */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { MovePictureCommand, MoveShapeCommand, ResizeObjectCommand } from './command';
import type { ObjectResizeTarget } from './command';
import { computeArrowResize, MIN_SIZE_HWP, type ArrowKey } from './picture-resize';
import { moveOffsetDelta, horzOffsetDelta, vertOffsetDelta } from './object-offset-axis';
import { getGridViewSettings } from '@/view/grid-settings';
import { showToast } from '@/ui/toast';
import type { CellPathLike } from '@/core/types';

type PictureObjectRef = {
  sec: number;
  ppi: number;
  ci: number;
  type: 'image' | 'shape' | 'equation' | 'group' | 'line' | 'ole';
  cellIdx?: number;
  cellParaIdx?: number;
  outerTableControlIdx?: number;
  cellPath?: CellPathLike;
  noteRef?: any;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  headerFooter?: { kind: 'header' | 'footer'; outerParaIdx: number; outerControlIdx: number };
  /** [Task #2230] 그림 미지정 placeholder — 더블클릭 시 그림 지정 진입. */
  missing?: boolean;
};

function hasCellPath(ref: { cellPath?: CellPathLike } | null | undefined): ref is { cellPath: CellPathLike } {
  return Array.isArray(ref?.cellPath) && ref.cellPath.length > 0;
}

function cellPathEntryKey(entry: any): string {
  const control = entry?.controlIndex ?? entry?.controlIdx ?? 0;
  const cell = entry?.cellIndex ?? entry?.cellIdx ?? 0;
  const para = entry?.cellParaIndex ?? entry?.cellParaIdx ?? 0;
  return `${control}:${cell}:${para}`;
}

function sameCellPath(a: unknown, b: unknown): boolean {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((entry, idx) => cellPathEntryKey(entry) === cellPathEntryKey((b as any[])[idx]));
}

function matchesControlRef(ctrl: any, ref: PictureObjectRef, layoutType: string): boolean {
  if (ctrl.type !== layoutType ||
      ctrl.secIdx !== ref.sec ||
      ctrl.paraIdx !== ref.ppi ||
      ctrl.controlIdx !== ref.ci) {
    return false;
  }
  if (hasCellPath(ref)) {
    return sameCellPath(ctrl.cellPath, ref.cellPath);
  }
  if (Array.isArray(ctrl.cellPath) && ctrl.cellPath.length > 0 &&
      ref.cellIdx === undefined && ref.cellParaIdx === undefined) {
    return false;
  }
  return true;
}

function syncOleObjectCaret(this: any, ref: PictureObjectRef, zoom: number): void {
  if (ref.type !== 'ole' || ref.cellPath || ref.noteRef || ref.headerFooter) return;
  try {
    const rect = this.wasm.getCursorRect(ref.sec, ref.ppi, 0);
    if (rect) this.caret.show(rect, zoom);
    scheduleOleSelectionLayerStabilize.call(this, ref);
  } catch (err) {
    console.warn('[InputHandler] OLE 캐럿 표시 실패:', err);
  }
}

function scheduleOleSelectionLayerStabilize(this: any, ref: PictureObjectRef): void {
  const key = `${ref.sec}:${ref.ppi}:${ref.ci}`;
  if (this._oleSelectionLayerStabilizeKey === key) return;
  this._oleSelectionLayerStabilizeKey = key;
  const stabilize = (finalPass: boolean) => {
    try {
      const current = this.cursor.getSelectedPictureRef?.();
      const stillSelected = current?.type === 'ole' &&
        current.sec === ref.sec &&
        current.ppi === ref.ppi &&
        current.ci === ref.ci;
      if (stillSelected && !this.pictureObjectRenderer?.layer?.parentElement) {
        this.renderPictureObjectSelection();
      }
    } finally {
      if (finalPass && this._oleSelectionLayerStabilizeKey === key) {
        this._oleSelectionLayerStabilizeKey = undefined;
      }
    }
  };
  window.setTimeout(() => stabilize(false), 80);
  window.setTimeout(() => stabilize(false), 240);
  window.setTimeout(() => stabilize(true), 500);
}

/**
 * [Task #1280 v2] 렌더 정렬키 (plane, zOrder, stableIndex). Rust `paper_node_sort_key`
 * (layout.rs)와 단일 진실 원천. 사전식으로 클수록 위(최상단). layer 필드 부재 시
 * 렌더 폴백 (plane=2, z=0, stable=0)과 동일하게 처리한다.
 */
function controlTopKey(ctrl: any): [number, number, number] {
  return [ctrl.plane ?? 2, ctrl.zOrder ?? 0, ctrl.stableIndex ?? 0];
}

/** a가 b보다 위(최상단)인가? 정렬키 사전식 비교. 동률이면 false(기존 emit 순서 유지). */
function isAboveControl(a: any, b: any): boolean {
  const ka = controlTopKey(a);
  const kb = controlTopKey(b);
  if (ka[0] !== kb[0]) return ka[0] > kb[0];
  if (ka[1] !== kb[1]) return ka[1] > kb[1];
  return ka[2] > kb[2];
}

/** 적중한 layout 컨트롤에서 PictureObjectRef 를 구성한다(line 은 끝점 포함). */
function controlToRef(ctrl: any): PictureObjectRef {
  if (ctrl.type === 'line') {
    return { sec: ctrl.secIdx, ppi: ctrl.paraIdx, ci: ctrl.controlIdx, type: 'line',
      x1: ctrl.x1, y1: ctrl.y1, x2: ctrl.x2, y2: ctrl.y2 };
  }
  return { sec: ctrl.secIdx, ppi: ctrl.paraIdx, ci: ctrl.controlIdx, type: ctrl.type,
    cellIdx: ctrl.cellIdx, cellParaIdx: ctrl.cellParaIdx, outerTableControlIdx: ctrl.outerTableControlIdx,
    cellPath: ctrl.cellPath, noteRef: ctrl.noteRef, headerFooter: ctrl.headerFooter, missing: ctrl.missing };
}

/** 클릭 좌표에서 그림, 글상자, 수식, OLE 개체를 찾는다. */
/** 점과 선분 사이 최소 거리 (px) */
function pointToSegmentDist(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1, dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/**
 * [Task #2230] 그림 미지정 placeholder 에 그림 지정 — 파일 선택 후
 * assignPictureImage 커맨드를 스냅샷(Undo 지원)으로 실행한다.
 * 개체 틀 크기는 유지된다 (한컴 placeholder 는 틀에 그림을 맞춤).
 */
export function promptAssignPictureImage(this: any, ref: PictureObjectRef): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/png,image/jpeg,image/gif,image/bmp,image/webp';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    let objectUrl = '';
    try {
      const data = new Uint8Array(await file.arrayBuffer());
      const ext = file.name.split('.').pop()?.toLowerCase() || 'png';
      const img = new Image();
      objectUrl = URL.createObjectURL(file);
      await new Promise<void>((resolve, reject) => {
        img.onload = () => {
          if (img.naturalWidth <= 0 || img.naturalHeight <= 0) {
            reject(new Error('이미지 크기를 확인할 수 없습니다.'));
            return;
          }
          resolve();
        };
        img.onerror = () => reject(new Error('브라우저가 이 이미지 파일을 읽지 못했습니다.'));
        img.src = objectUrl;
      });
      const cellPathJson = hasCellPath(ref) ? JSON.stringify(ref.cellPath) : '';
      // 지정 후에는 실그림이므로 placeholder 선택 상태를 먼저 해제한다
      // (스냅샷 실행의 full refresh 가 stale 선택 표시를 남기지 않도록).
      this.cursor.exitPictureObjectSelection();
      this.pictureObjectRenderer?.clear();
      this.eventBus.emit('picture-object-selection-changed', false);
      // 스냅샷 경로의 refreshAfterOperation('full') 이 전면 재렌더를 수행한다.
      this.executeOperation({ kind: 'snapshot', operationType: 'assignPictureImage', operation: (wasm: any) => {
        wasm.assignPictureImage(
          ref.sec, ref.ppi, cellPathJson, ref.ci,
          data, img.naturalWidth, img.naturalHeight, ext,
        );
        return this.cursor.getPosition();
      }});
      this.textarea.focus();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[promptAssignPictureImage] 그림 지정 실패:', err);
      showToast({
        message: `그림을 지정할 수 없습니다.\n${msg}`,
        durationMs: 6000,
      });
    } finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    }
  };
  input.click();
}

export function findPictureAtClick(this: any,
  pageIdx: number, pageX: number, pageY: number,
): PictureObjectRef | null {
  try {
    const layout = this.wasm.getPageControlLayout(pageIdx);
    // [Task #1171] picture 우선: 클릭이 컨테이너 Shape(글상자) 와 그 안의 nested picture
    // (cellPath 동반 image/equation) 둘 다에 들어가면 picture 를 우선 선택한다.
    // collect_controls 가 Shape 를 자식 picture 보다 먼저 방출하므로, 이 우선 패스가 없으면
    // 아래 1차 패스가 Shape 를 먼저 hit 한다(이슈의 핵심 결함). Shape 와 picture 가 함께
    // hit 될 때만 동작하므로, 겹치는 Shape 가 없는 표 셀 picture 는 영향 없음.
    // BehindText 는 기존 2차 패스 정책 유지로 제외.
    {
      let shapeHit = false;
      let nestedPic: any = null;
      for (const ctrl of layout.controls) {
        if (ctrl.secIdx === undefined || ctrl.wrap === 'behindText') continue;
        const inBox = pageX >= ctrl.x && pageX <= ctrl.x + ctrl.w &&
          pageY >= ctrl.y && pageY <= ctrl.y + ctrl.h;
        if (!inBox) continue;
        if (ctrl.type === 'shape') shapeHit = true;
        else if ((ctrl.type === 'image' || ctrl.type === 'equation') && ctrl.cellPath && !nestedPic) {
          nestedPic = ctrl;
        }
      }
      if (shapeHit && nestedPic) {
        return { sec: nestedPic.secIdx, ppi: nestedPic.paraIdx, ci: nestedPic.controlIdx, type: nestedPic.type, cellIdx: nestedPic.cellIdx, cellParaIdx: nestedPic.cellParaIdx, outerTableControlIdx: nestedPic.outerTableControlIdx, cellPath: nestedPic.cellPath, noteRef: nestedPic.noteRef, headerFooter: nestedPic.headerFooter, missing: nestedPic.missing };
      }
    }
    // Task #516 결함 3 (옵션 3-C): BehindText 그림은 텍스트 영역 위에서는 후순위.
    // 1차 패스: BehindText 가 아닌 그림 우선 hit-test.
    // 2차 패스: BehindText 그림은 텍스트 hit-test 결과가 비어 있을 때만 hit.
    // [Task #1280 v2] 겹침 클릭 = "최상단 개체" 선택. 첫-적중-반환 대신 적중 후보 전부를
    // 돌며 (plane, zOrder, stableIndex) 최댓값(렌더 정렬키, Stage1 노출)을 고른다.
    // 이로써 "보이는 것 = 클릭되는 것"(WYSIWYG) 정합. 단일 적중 시 결과 불변(회귀 0).
    const behindCtrls: any[] = [];
    let topHit: any = null;
    for (const ctrl of layout.controls) {
      if (ctrl.type !== 'image' && ctrl.type !== 'shape' && ctrl.type !== 'equation' && ctrl.type !== 'group' && ctrl.type !== 'line' && ctrl.type !== 'ole') continue;
      if (ctrl.secIdx === undefined || ctrl.paraIdx === undefined || ctrl.controlIdx === undefined) continue;
      // [Task #825] 머리말/꼬리말 그림: headerFooter marker 가 함께 있어야 lookup 가능.
      // (없으면 본문 picture 동작 그대로.)

      // BehindText 그림은 1차 패스 건너뛰고 2차 패스로 보류
      if (ctrl.wrap === 'behindText') {
        behindCtrls.push(ctrl);
        continue;
      }

      let hit = false;
      if (ctrl.type === 'line') {
        // 직선: 점-선분 거리, 연결선: 곡선 경로 샘플링으로 히트 판정
        const threshold = 6;
        const dist1 = pointToSegmentDist(pageX, pageY, ctrl.x1, ctrl.y1, ctrl.x2, ctrl.y2);
        hit = dist1 <= threshold;
        if (!hit && ctrl.w > 2 && ctrl.h > 2) {
          const sx = ctrl.x1, sy = ctrl.y1, ex = ctrl.x2, ey = ctrl.y2;
          const mx = ctrl.x + ctrl.w / 2, my = ctrl.y + ctrl.h / 2;
          // 꺽인 연결선: 가능한 모든 직각 경로 검사
          const segs: [number,number,number,number][] = [
            // 수평→수직→수평 (S자 꺽임)
            [sx,sy, mx,sy], [mx,sy, mx,ey], [mx,ey, ex,ey],
            // 수직→수평→수직 (S자 꺽임)
            [sx,sy, sx,my], [sx,my, ex,my], [ex,my, ex,ey],
            // L자 꺽임
            [sx,sy, ex,sy], [ex,sy, ex,ey],
            [sx,sy, sx,ey], [sx,ey, ex,ey],
          ];
          for (const [ax,ay,bx,by] of segs) {
            if (pointToSegmentDist(pageX, pageY, ax, ay, bx, by) <= threshold) {
              hit = true; break;
            }
          }
          // 곡선 연결선: 베지어 곡선 — 8세그먼트 샘플링
          if (!hit) {
            const c1x = mx, c1y = sy, c2x = mx, c2y = ey;
            const N = 8;
            let prevX = sx, prevY = sy;
            for (let k = 1; k <= N; k++) {
              const t = k / N;
              const u = 1 - t;
              const bx = u*u*u*sx + 3*u*u*t*c1x + 3*u*t*t*c2x + t*t*t*ex;
              const by = u*u*u*sy + 3*u*u*t*c1y + 3*u*t*t*c2y + t*t*t*ey;
              if (pointToSegmentDist(pageX, pageY, prevX, prevY, bx, by) <= threshold) {
                hit = true; break;
              }
              prevX = bx; prevY = by;
            }
          }
        }
      } else {
        // bbox 히트 판정
        hit = pageX >= ctrl.x && pageX <= ctrl.x + ctrl.w &&
          pageY >= ctrl.y && pageY <= ctrl.y + ctrl.h;
      }

      if (hit && (topHit === null || isAboveControl(ctrl, topHit))) {
        topHit = ctrl;
      }
    }
    if (topHit) {
      return controlToRef(topHit);
    }
    // 2차 패스: BehindText 그림 hit-test (옵션 3-C, Task #516).
    // 텍스트 hit-test 결과를 확인하여 텍스트가 있는 위치면 그림 hit 무시.
    // 텍스트가 없는 영역 (예: 빈 줄, 페이지 여백) 에서는 BehindText 그림 hit 허용.
    if (behindCtrls.length > 0) {
      let textHit = false;
      try {
        const ht = this.wasm.hitTest(pageIdx, pageX, pageY);
        // ht 가 유효하고 charOffset 이 텍스트 영역 안 (charOffset > 0 또는 paragraphIndex 가
        // 그림이 attach 된 빈 문단이 아님) 이면 텍스트 hit 으로 간주.
        // 보수적: ht 가 null/undefined 가 아니면 텍스트 영역으로 간주.
        if (ht && typeof ht.charOffset === 'number' && ht.charOffset > 0) {
          textHit = true;
        }
      } catch { /* hitTest 실패 시 그림 hit 허용 */ }

      if (!textHit) {
        for (const ctrl of behindCtrls) {
          if (pageX >= ctrl.x && pageX <= ctrl.x + ctrl.w &&
              pageY >= ctrl.y && pageY <= ctrl.y + ctrl.h) {
            return { sec: ctrl.secIdx, ppi: ctrl.paraIdx, ci: ctrl.controlIdx, type: ctrl.type, cellIdx: ctrl.cellIdx, cellParaIdx: ctrl.cellParaIdx, outerTableControlIdx: ctrl.outerTableControlIdx, cellPath: ctrl.cellPath, noteRef: ctrl.noteRef, headerFooter: ctrl.headerFooter, missing: ctrl.missing };
          }
        }
      }
    }
  } catch { /* ignore */ }
  return null;
}

/** 선택된 개체의 bbox를 페이지 레이아웃에서 찾는다. */
export function findPictureBbox(this: any,
  ref: { sec: number; ppi: number; ci: number; type?: 'image' | 'shape' | 'equation' | 'group' | 'line' | 'ole'; cellIdx?: number; cellParaIdx?: number; cellPath?: CellPathLike; noteRef?: any },
  preferPage?: number,
): { pageIndex: number; x: number; y: number; w: number; h: number; x1?: number; y1?: number; x2?: number; y2?: number } | null {
  const matchType = ref.type ?? 'image';
  // line은 shape의 하위 타입 → layout에서 'line'으로 반환됨
  const layoutType = matchType === 'line' ? 'line' : matchType;
  try {
    const pageCount = this.wasm.pageCount;
    // preferPage 가 있으면 그 쪽을 먼저 본다 — 드래그 중 매 프레임 호출되므로 뒤쪽 쪽에
    // 있는 개체에서 0..p 전수 스캔이 프레임마다 반복되는 것을 막는다.
    const order: number[] = [];
    if (preferPage !== undefined && preferPage >= 0 && preferPage < pageCount) order.push(preferPage);
    for (let p = 0; p < pageCount; p++) if (p !== preferPage) order.push(p);
    for (const p of order) {
      const layout = this.wasm.getPageControlLayout(p);
      for (const ctrl of layout.controls) {
        if (matchesControlRef(ctrl, { ...ref, type: matchType } as PictureObjectRef, layoutType)) {
          // 표 셀 내 수식: cellIdx/cellParaIdx도 매칭
          if (matchType === 'equation' && ref.cellIdx !== undefined) {
            if (ctrl.cellIdx !== ref.cellIdx || ctrl.cellParaIdx !== ref.cellParaIdx) continue;
          }
          if (matchType === 'equation' && ref.noteRef) {
            const nr = ctrl.noteRef;
            if (!nr ||
                nr.kind !== ref.noteRef.kind ||
                nr.sectionIdx !== ref.noteRef.sectionIdx ||
                nr.paraIdx !== ref.noteRef.paraIdx ||
                nr.controlIdx !== ref.noteRef.controlIdx ||
                nr.noteParaIdx !== ref.noteRef.noteParaIdx ||
                nr.innerControlIdx !== ref.noteRef.innerControlIdx) continue;
          }
          return { pageIndex: p, x: ctrl.x, y: ctrl.y, w: ctrl.w, h: ctrl.h,
            x1: ctrl.x1, y1: ctrl.y1, x2: ctrl.x2, y2: ctrl.y2 };
        }
      }
    }
  } catch { /* ignore */ }
  return null;
}

/** 개체 선택 시 외곽선 + 핸들을 렌더링한다. */
export function renderPictureObjectSelection(this: any): void {
  if (!this.pictureObjectRenderer) return;

  // 다중 선택: 합산 bbox로 핸들 표시
  if (this.cursor.isMultiPictureSelection()) {
    const refs = this.cursor.getSelectedPictureRefs();
    try {
      const zoom = this.viewportManager.getZoom();
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      let pageIndex = 0;
      for (const r of refs) {
        const bbox = this.findPictureBbox(r);
        if (bbox) {
          pageIndex = bbox.pageIndex;
          minX = Math.min(minX, bbox.x);
          minY = Math.min(minY, bbox.y);
          maxX = Math.max(maxX, bbox.x + bbox.w);
          maxY = Math.max(maxY, bbox.y + bbox.h);
        }
      }
      if (minX < Infinity) {
        const locked = refs.some((r: PictureObjectRef) => isObjectSizeProtected.call(this, r));
        this.pictureObjectRenderer.render(
          { pageIndex, x: minX, y: minY, width: maxX - minX, height: maxY - minY },
          zoom,
          0,
          locked,
        );
      } else {
        this.pictureObjectRenderer.clear();
      }
    } catch {
      this.pictureObjectRenderer.clear();
    }
    return;
  }

  const ref = this.cursor.getSelectedPictureRef();
  if (!ref) {
    this.pictureObjectRenderer.clear();
    showObjectReadout.call(this, null);
    return;
  }
  showObjectReadout.call(this, ref);
  const matchType = ref.type ?? 'image';
  const layoutType = matchType === 'line' ? 'line' : matchType;
  try {
    const zoom = this.viewportManager.getZoom();
    const pageCount = this.wasm.pageCount;
    for (let p = 0; p < pageCount; p++) {
      const layout = this.wasm.getPageControlLayout(p);
      for (const ctrl of layout.controls) {
        if (matchesControlRef(ctrl, ref as PictureObjectRef, layoutType)) {
          // 표 셀 내 수식: cellIdx/cellParaIdx도 매칭
          if (matchType === 'equation' && ref.cellIdx !== undefined) {
            if (ctrl.cellIdx !== ref.cellIdx || ctrl.cellParaIdx !== ref.cellParaIdx) continue;
          }
          if (matchType === 'equation' && ref.noteRef) {
            const nr = ctrl.noteRef;
            if (!nr ||
                nr.kind !== ref.noteRef.kind ||
                nr.sectionIdx !== ref.noteRef.sectionIdx ||
                nr.paraIdx !== ref.noteRef.paraIdx ||
                nr.controlIdx !== ref.noteRef.controlIdx ||
                nr.noteParaIdx !== ref.noteRef.noteParaIdx ||
                nr.innerControlIdx !== ref.noteRef.innerControlIdx) continue;
          }

          if (matchType === 'line') {
            // 직선/연결선: 시작점/끝점 핸들 (꺽인/곡선 연결선은 중간점 추가)
            let midPoint: { x: number; y: number } | undefined;
            try {
              const props = this.wasm.getShapeProperties(ref.sec, ref.ppi, ref.ci);
              // connectorType >= 3: 꺽인(3~5) 또는 곡선(6~8)
              if (props.connectorType !== undefined && props.connectorType >= 3) {
                if (props.connectorMidX !== undefined && props.connectorMidY !== undefined) {
                  // 실제 꺽임/곡선 제어점 좌표 (HWPUNIT → page px)
                  const PX = 96 / 7200;
                  midPoint = {
                    x: ctrl.x + props.connectorMidX * PX,
                    y: ctrl.y + props.connectorMidY * PX,
                  };
                } else {
                  midPoint = { x: (ctrl.x1 + ctrl.x2) / 2, y: (ctrl.y1 + ctrl.y2) / 2 };
                }
              }
            } catch { /* 일반 선 */ }
            this.pictureObjectRenderer.renderLine(
              { pageIndex: p, x1: ctrl.x1, y1: ctrl.y1, x2: ctrl.x2, y2: ctrl.y2,
                x: ctrl.x, y: ctrl.y, width: ctrl.w, height: ctrl.h },
              zoom,
              midPoint,
            );
            return;
          }

          const bx = ctrl.x, by = ctrl.y, bw = ctrl.w, bh = ctrl.h;

          // 회전각 조회 (shape + image)
          let rotAngle = 0;
          let locked = false;
          if (ref.type !== 'equation') {
            try {
              const props = getObjectProperties.call(this, ref);
              rotAngle = (props.rotationAngle as number) ?? 0;
              locked = !!props.sizeProtect;
            } catch { /* ignore */ }
          }

          this.pictureObjectRenderer.render(
            { pageIndex: p, x: bx, y: by, width: bw, height: bh },
            zoom,
            rotAngle,
            locked,
          );
          syncOleObjectCaret.call(this, ref as PictureObjectRef, zoom);
          return;
        }
      }
    }
    this.pictureObjectRenderer.clear();
  } catch (e) {
    console.warn('[InputHandler] renderPictureObjectSelection 실패:', e);
    this.pictureObjectRenderer.clear();
  }
}

export function exitPictureObjectSelectionIfNeeded(this: any): void {
  if (this.cursor.isInPictureObjectSelection()) {
    this.cursor.exitPictureObjectSelection();
    this.pictureObjectRenderer?.clear();
    showObjectReadout.call(this, null);
    this.eventBus.emit('picture-object-selection-changed', false);
  }
}

/**
 * 선택·드래그 중인 개체의 위치·크기를 상태 표시줄에 mm 로 보여 준다.
 *
 * 종전에는 «지금 개체가 어디에 얼마나 있는지»를 숫자로 보여 주는 곳이 한 군데도 없었다
 * (상태표시줄·드래그 툴팁·선택 오버레이 전부 무언). 눈대중만으로는 «정확히» 놓을 수 없다.
 * 정렬 기준을 함께 적는 것은 offset 의 부호·기준점이 거기 달렸기 때문이다(object-offset-axis).
 */
export function showObjectReadout(this: any, ref: PictureObjectRef | null | undefined): void {
  const el = document.getElementById('sb-object');
  if (!el) return;
  const hide = () => { el.style.display = 'none'; el.textContent = ''; };
  if (!ref) { hide(); return; }
  try {
    const p = getObjectProperties.call(this, ref);
    if (!p) { hide(); return; }
    const mm = (hu: number) => (Number(hu) * 25.4 / 7200).toFixed(1);
    const H: Record<string, string> = { Left: '왼쪽', Center: '가운데', Right: '오른쪽', Inside: '안쪽', Outside: '바깥쪽' };
    const V: Record<string, string> = { Top: '위', Center: '가운데', Bottom: '아래', Inside: '안쪽', Outside: '바깥쪽' };
    if (p.treatAsChar) {
      el.textContent = `개체 ${mm(p.width)}×${mm(p.height)}mm · 글자처럼 취급`;
    } else {
      const h = `${H[p.horzAlign] ?? p.horzAlign} ${mm(p.horzOffset)}`;
      const v = `${V[p.vertAlign] ?? p.vertAlign} ${mm(p.vertOffset)}`;
      el.textContent = `개체 ${mm(p.width)}×${mm(p.height)}mm · 가로 ${h} · 세로 ${v}mm`;
    }
    el.style.display = '';
  } catch {
    hide();
  }
}

/** 클릭 좌표가 글상자의 경계선 위인지 판정한다. */
export function isShapeBorderClick(this: any,
  pageX: number, pageY: number,
  shape: { sec: number; ppi: number; ci: number },
): boolean {
  const THRESHOLD = 3; // px
  const bbox = findPictureBbox.call(this, { ...shape, type: 'shape' as const });
  if (!bbox) return false;
  const dx = Math.min(pageX - bbox.x, bbox.x + bbox.w - pageX);
  const dy = Math.min(pageY - bbox.y, bbox.y + bbox.h - pageY);
  return dx <= THRESHOLD || dy <= THRESHOLD;
}

// ─── 개체 속성 조회 헬퍼 (그림/글상자 분기) ──────────────

/** 개체 속성을 타입에 따라 조회한다. */
export function getObjectProperties(this: any, ref: PictureObjectRef): any {
  if (ref.type === 'shape' || ref.type === 'line' || ref.type === 'group' || ref.type === 'ole') {
    if (hasCellPath(ref)) {
      return this.wasm.getCellShapePropertiesByPath(ref.sec, ref.ppi, ref.cellPath, ref.ci);
    }
    return this.wasm.getShapeProperties(ref.sec, ref.ppi, ref.ci);
  }
  if (ref.type === 'image' && ref.headerFooter) {
    return this.wasm.getHeaderFooterPictureProperties(
      ref.sec,
      ref.headerFooter.outerParaIdx,
      ref.headerFooter.outerControlIdx,
      ref.ppi,
      ref.ci,
    );
  }
  if (ref.type === 'image' && hasCellPath(ref)) {
    return this.wasm.getCellPicturePropertiesByPath(ref.sec, ref.ppi, ref.cellPath, ref.ci);
  }
  return this.wasm.getPictureProperties(ref.sec, ref.ppi, ref.ci);
}

/** 개체 속성을 타입에 따라 변경한다. */
export function setObjectProperties(this: any, ref: PictureObjectRef, props: Record<string, unknown>): void {
  if (ref.type === 'shape' || ref.type === 'line' || ref.type === 'group' || ref.type === 'ole') {
    if (hasCellPath(ref)) {
      this.wasm.setCellShapePropertiesByPath(ref.sec, ref.ppi, ref.cellPath, ref.ci, props);
      return;
    }
    this.wasm.setShapeProperties(ref.sec, ref.ppi, ref.ci, props);
  } else {
    if (ref.type === 'image' && ref.headerFooter) {
      this.wasm.setHeaderFooterPictureProperties(
        ref.sec,
        ref.headerFooter.outerParaIdx,
        ref.headerFooter.outerControlIdx,
        ref.ppi,
        ref.ci,
        props,
      );
      return;
    }
    if (ref.type === 'image' && hasCellPath(ref)) {
      this.wasm.setCellPicturePropertiesByPath(ref.sec, ref.ppi, ref.cellPath, ref.ci, props);
      return;
    }
    this.wasm.setPictureProperties(ref.sec, ref.ppi, ref.ci, props);
  }
}

/**
 * 「글자처럼 취급」 개체를 옮기려 했을 때의 안내.
 *
 * 이 개체는 자유 배치가 아니라 «문자 사이»에 놓이므로 offset 이동이 화면에 나타나지 않는다.
 * 종전에는 드래그·방향키가 조용히 무동작이라(진입 게이트 input-handler-mouse.ts, 방향키
 * input-handler-table.ts) 사용자가 «편집기가 멈췄나» 로 읽었다 — 크기 조절 핸들은 잡히니 더 헷갈렸다.
 * 코퍼스 HWPX 251편 그림 1383개 중 **1141개(82.5%)** 가 이 상태다.
 *
 * ⚠ 한컴 실측(2026-09-10, 한글 2024): 한컴은 이 개체를 끌면 «드롭 지점의 문자 위치로 재삽입»한다
 * (속성은 그대로, 문단 안 위치만 바뀐다). 그 재삽입은 Rust 쪽 문자 위치 재배치가 필요한 별도 단위이고,
 * 여기서는 그때까지 «왜 안 움직이는지»와 «빠져나갈 길»을 준다.
 */
export function notifyTreatAsCharBlocked(this: any, ref: PictureObjectRef): void {
  const now = Date.now();
  if (this._tacBlockToastAt && now - this._tacBlockToastAt < 4000) return; // 연타 억제
  this._tacBlockToastAt = now;
  try {
    this.container.style.cursor = 'not-allowed';
    setTimeout(() => { try { this.container.style.cursor = ''; } catch { /* ignore */ } }, 700);
  } catch { /* ignore */ }
  showToast({
    message: '「글자처럼 취급」 개체는 글자처럼 문자 사이에 놓여서 마우스·방향키로 옮길 수 없습니다.\n자유롭게 배치하려면 「글자처럼 취급」을 끄세요.',
    durationMs: 6000,
    action: {
      label: '글자처럼 취급 끄기',
      onClick: () => {
        try {
          this.executeOperation({
            kind: 'snapshot',
            operationType: 'clearTreatAsChar',
            operation: () => {
              setObjectProperties.call(this, ref, { treatAsChar: false });
              return this.cursor.getPosition();
            },
          });
          this.eventBus.emit('document-changed');
          this.renderPictureObjectSelection();
        } catch (err) {
          console.warn('[InputHandler] 글자처럼 취급 해제 실패:', err);
        }
      },
    },
  });
}

/** 크기 고정 개체인지 조회한다. 조회 실패 시 기존 조작 흐름을 막지 않는다. */
export function isObjectSizeProtected(this: any, ref: PictureObjectRef | null | undefined): boolean {
  if (!ref) return false;
  try {
    const props = getObjectProperties.call(this, ref);
    return !!props?.sizeProtect;
  } catch {
    return false;
  }
}

/** 개체를 타입에 따라 삭제한다. */
export function deleteObjectControl(this: any, ref: PictureObjectRef): void {
  if (ref.type === 'shape' || ref.type === 'group' || ref.type === 'line' || ref.type === 'ole') {
    this.wasm.deleteShapeControl(ref.sec, ref.ppi, ref.ci);
  } else if (ref.type === 'equation') {
    this.wasm.deleteEquationControl(ref.sec, ref.ppi, ref.ci);
  } else {
    if (hasCellPath(ref)) {
      this.wasm.deleteCellPictureControlByPath(ref.sec, ref.ppi, ref.cellPath, ref.ci);
      return;
    }
    this.wasm.deletePictureControl(ref.sec, ref.ppi, ref.ci);
  }
}

// ─── Shift+방향키 크기 조절 (#1231) ─────────────────────

/**
 * 그림 객체 선택 모드에서 Shift+방향키로 개체 크기를 단계 조절한다 (한컴 정합).
 * 이동(moveSelectedPicture)과 동일한 격자 단계를 쓰고, 드래그 리사이즈와 동일하게
 * ResizeObjectCommand 로 Undo/Redo 를 기록한다. 셀/글상자/머리말 내 개체는
 * get/setObjectProperties 의 경로 분기를 그대로 탄다.
 */
export function resizeSelectedPicture(this: any, key: ArrowKey): void {
  const refs = this.cursor.getSelectedPictureRefs();
  const ref = this.cursor.getSelectedPictureRef();
  if (!ref) return;

  const step = Math.round(this.gridStepMm * 7200 / 25.4); // mm → HWPUNIT
  const targets = refs.length > 1 ? refs : [ref];
  try {
    // 1단계: 조회/계산만 먼저 전부 수행 — 일부 개체 조회가 실패해도 문서는 무변경
    const pending: { r: PictureObjectRef; target: ObjectResizeTarget }[] = [];
    for (const r of targets) {
      const props = getObjectProperties.call(this, r);
      if (props.sizeProtect) continue;
      const resized = computeArrowResize(key, props.width, props.height, step);
      if (!resized) continue;
      pending.push({
        r,
        target: {
          sec: r.sec,
          ppi: r.ppi,
          ci: r.ci,
          type: r.type,
          cellPath: r.cellPath,
          before: resized.before,
          after: resized.after,
        },
      });
    }
    if (pending.length === 0) return;
    // 2단계: 적용 후 Undo 기록 (드래그 리사이즈와 동일 순서; 원본 ref 로 적용해
    // headerFooter 등 dispatch 필드를 보존한다)
    for (const { r, target } of pending) {
      setObjectProperties.call(this, r, target.after);
    }
    this.executeOperation({
      kind: 'record',
      command: new ResizeObjectCommand(pending.map((p) => p.target)),
    });
    this.eventBus.emit('document-changed');
    this.renderPictureObjectSelection();
  } catch (err) {
    console.warn('[InputHandler] 개체 크기 조절 실패:', err);
  }
}

// ─── 핸들 드래그 리사이즈 ─────────────────────────

/** 1 page px = 7200/96 = 75 HWPUNIT */
const PX_TO_HWP = 7200 / 96;
// MIN_SIZE_HWP 는 picture-resize.ts 에서 import (드래그/키보드 리사이즈 공용 하한)

function isCornerResizeDir(dir: string): boolean {
  return dir === 'nw' || dir === 'ne' || dir === 'sw' || dir === 'se';
}

function isRotatedImageCornerResize(state: any, angleDeg: number): boolean {
  const normalized = ((angleDeg % 360) + 360) % 360;
  return state.ref?.type === 'image' && isCornerResizeDir(state.dir) && normalized !== 0;
}

function usesRotatedPictureFrame(state: any, angleDeg: number): boolean {
  const normalized = ((angleDeg % 360) + 360) % 360;
  return state.ref?.type === 'image' && normalized !== 0;
}

function frameFromActualPictureBbox(
  bbox: { x: number; y: number; width: number; height: number },
  angleDeg: number,
  rotatedFrame: boolean,
): { width: number; height: number; frameX: number; frameY: number } {
  const actualW = Math.max(bbox.width, 1);
  const actualH = Math.max(bbox.height, 1);
  let frameW = actualW;
  let frameH = actualH;

  if (rotatedFrame) {
    const rad = angleDeg * Math.PI / 180;
    const cosA = Math.abs(Math.cos(rad));
    const sinA = Math.abs(Math.sin(rad));
    frameW = actualW * cosA + actualH * sinA;
    frameH = actualW * sinA + actualH * cosA;
  }

  return {
    width: Math.max(Math.round(frameW * PX_TO_HWP), MIN_SIZE_HWP),
    height: Math.max(Math.round(frameH * PX_TO_HWP), MIN_SIZE_HWP),
    frameX: bbox.x - Math.max(0, frameW - actualW) / 2,
    frameY: bbox.y - Math.max(0, frameH - actualH) / 2,
  };
}

function originalFrameTopLeftFromState(
  state: any,
  rotatedFrame: boolean,
): { frameX: number; frameY: number } {
  if (!rotatedFrame) return { frameX: state.bbox.x, frameY: state.bbox.y };

  const frameW = Math.max((state.origWidth ?? 0) / PX_TO_HWP, state.bbox.w);
  const frameH = Math.max((state.origHeight ?? 0) / PX_TO_HWP, state.bbox.h);
  return {
    frameX: state.bbox.x - Math.max(0, frameW - state.bbox.w) / 2,
    frameY: state.bbox.y - Math.max(0, frameH - state.bbox.h) / 2,
  };
}

/**
 * 회전각을 반영하여 리사이즈 후 새 bbox(비회전 기준)를 계산한다.
 * - 마우스 delta를 도형 로컬 좌표계로 역변환한다.
 * - 반대편 꼭짓점(pivot)이 page 좌표에서 고정되도록 중심을 재계산한다.
 */
function calcResizedBboxRotated(
  state: any,
  e: MouseEvent,
  zoom: number,
): { x: number; y: number; width: number; height: number } {
  const angleDeg = (state.rotationAngle ?? 0) as number;
  const rad = angleDeg * Math.PI / 180;
  const cosA = Math.cos(rad);
  const sinA = Math.sin(rad);

  const dx = (e.clientX - state.startClientX) / zoom;
  const dy = (e.clientY - state.startClientY) / zoom;

  // 화면 좌표 delta → 도형 로컬 좌표계로 역변환
  const localDx = dx * cosA + dy * sinA;
  const localDy = -dx * sinA + dy * cosA;

  const w0 = state.bbox.w;
  const h0 = state.bbox.h;
  const cx0 = state.bbox.x + w0 / 2;
  const cy0 = state.bbox.y + h0 / 2;
  const dir: string = state.dir;

  // 크기 제한 없이 마우스 이동 반영 (반대편으로 넘어가면 음수 발생 가능)
  let valW = w0;
  let valH = h0;
  if (dir.includes('e')) valW = w0 + localDx;
  if (dir.includes('w')) valW = w0 - localDx;
  if (dir.includes('s')) valH = h0 + localDy;
  if (dir.includes('n')) valH = h0 - localDy;

  // 최종 출력용 크기는 절대값 사용 (최소 크기는 아주 작게만 제한)
  const MIN = 1; 
  if (isRotatedImageCornerResize(state, angleDeg)) {
    const signX = dir.includes('e') ? 1 : -1;
    const signY = dir.includes('s') ? 1 : -1;
    const diagonal = Math.hypot(w0, h0) || 1;
    const deltaAlongDiagonal = (signX * localDx * w0 + signY * localDy * h0) / diagonal;
    const minScale = MIN / Math.max(w0, h0, MIN);
    const scale = Math.max((diagonal + deltaAlongDiagonal) / diagonal, minScale);
    valW = w0 * scale;
    valH = h0 * scale;
  }
  const newW = Math.max(Math.abs(valW), MIN);
  const newH = Math.max(Math.abs(valH), MIN);

  // pivot: 드래그하지 않는 반대쪽 로컬 좌표 (원본 크기 기준)
  const pivotLocalX = dir.includes('e') ? -w0 / 2 : (dir.includes('w') ? w0 / 2 : 0);
  const pivotLocalY = dir.includes('s') ? -h0 / 2 : (dir.includes('n') ? h0 / 2 : 0);

  // pivot의 page 좌표 (고정)
  const pivotPageX = cx0 + pivotLocalX * cosA - pivotLocalY * sinA;
  const pivotPageY = cy0 + pivotLocalX * sinA + pivotLocalY * cosA;

  // 새 크기에서 pivot의 로컬 좌표 (valW/valH가 음수면 pivot 방향이 반전됨)
  const newPivotLocalX = dir.includes('e') ? -valW / 2 : (dir.includes('w') ? valW / 2 : 0);
  const newPivotLocalY = dir.includes('s') ? -valH / 2 : (dir.includes('n') ? valH / 2 : 0);

  // pivot 고정 조건으로 새 중심 계산
  const newCx = pivotPageX - (newPivotLocalX * cosA - newPivotLocalY * sinA);
  const newCy = pivotPageY - (newPivotLocalX * sinA + newPivotLocalY * cosA);

  return { x: newCx - newW / 2, y: newCy - newH / 2, width: newW, height: newH };
}

export function updatePictureResizeDrag(this: any, e: MouseEvent): void {
  if (!this.pictureResizeState || !this.pictureObjectRenderer) return;
  const zoom = this.viewportManager.getZoom();
  const state = this.pictureResizeState;
  if (isObjectSizeProtected.call(this, state.ref)) {
    this.cleanupPictureResizeDrag();
    this.renderPictureObjectSelection();
    return;
  }

  // 핸들은 고정, 예비 테두리만 갱신
  const rotAngle = (state.rotationAngle ?? 0) as number;
  const newBbox = state.multiRefs
    ? this.calcResizedBbox(e, zoom)
    : calcResizedBboxRotated(state, e, zoom);

  // 모든 경우에 점선 프리뷰만 갱신하여 앵커는 제자리에 머물게 함
  this.pictureObjectRenderer.renderDragPreview(
    { pageIndex: state.pageIndex, ...newBbox },
    zoom,
    rotAngle,
  );

  // 다중 선택: 드래그 중 실시간으로 개체 크기/위치 반영
  if (state.multiRefs && state.multiRefs.length > 0) {
    if (state.multiRefs.some((r: PictureObjectRef) => isObjectSizeProtected.call(this, r))) {
      this.cleanupPictureResizeDrag();
      this.renderPictureObjectSelection();
      return;
    }
    const scaleX = newBbox.width / state.bbox.w;
    const scaleY = newBbox.height / state.bbox.h;
    const origX = state.bbox.x;
    const origY = state.bbox.y;
    const newOrigX = newBbox.x;
    const newOrigY = newBbox.y;
    const PX2HWP = PX_TO_HWP;
    const isCorner = ['nw', 'ne', 'sw', 'se'].includes(state.dir);
    try {
      for (const r of state.multiRefs) {
        const relX = r.bboxX - origX;
        const relY = r.bboxY - origY;
        // 코너: 자유 리사이즈 (scaleX, scaleY 독립 반영), 측면: 해당 축만
        const sx = (isCorner || state.dir === 'e' || state.dir === 'w') ? scaleX : 1;
        const sy = (isCorner || state.dir === 'n' || state.dir === 's') ? scaleY : 1;
        const newPx = newOrigX + relX * scaleX;
        const newPy = newOrigY + relY * scaleY;
        const deltaH = Math.round((newPx - r.bboxX) * PX2HWP);
        const deltaV = Math.round((newPy - r.bboxY) * PX2HWP);
        const newW = Math.max(Math.round(r.origWidth * sx), MIN_SIZE_HWP);
        const newH = Math.max(Math.round(r.origHeight * sy), MIN_SIZE_HWP);
        const updated: Record<string, unknown> = { width: newW, height: newH };
        // 좌상단 델타 + 크기 델타를 정렬 기준으로 환산한다 — 오른쪽/가운데 기준 개체는
        // 폭이 바뀌기만 해도 렌더 x 가 움직이므로 좌상단 델타만 더하면 어긋난다.
        const offH = horzOffsetDelta(r.horzAlign, deltaH, newW - r.origWidth);
        const offV = vertOffsetDelta(r.vertAlign, deltaV, newH - r.origHeight);
        if (offH !== 0) updated['horzOffset'] = r.origHorzOffset + offH;
        if (offV !== 0) updated['vertOffset'] = r.origVertOffset + offV;
        setObjectProperties.call(this, r, updated);
      }
      this.eventBus.emit('document-changed');
    } catch { /* ignore */ }
  }

  // 단일 선택 (그룹/shape/image 등): 드래그 중 실시간 크기/위치 반영
  if (!state.multiRefs && state.ref.type !== 'line') {
    const rotatedFrame = usesRotatedPictureFrame(state, rotAngle);
    const resizedFrame = frameFromActualPictureBbox(newBbox, rotAngle, rotatedFrame);
    const originalFrame = originalFrameTopLeftFromState(state, rotatedFrame);
    const newW = resizedFrame.width;
    const newH = resizedFrame.height;
    // offset 은 페이지 절대값이 아니라 "저장 offset + 페이지좌표 델타"로 적용한다.
    // (중첩 picture 의 offset 은 컨테이너 상대 — 페이지 절대값이면 라이브 드래그 중
    //  이미지가 예비 테두리에서 벗어나 어긋난다. finishPictureResizeDrag 와 동일 방식.)
    const newHorzOffset = Math.round(resizedFrame.frameX * PX_TO_HWP);
    const newVertOffset = Math.round(resizedFrame.frameY * PX_TO_HWP);
    const origHorzOffset = Math.round(originalFrame.frameX * PX_TO_HWP);
    const origVertOffset = Math.round(originalFrame.frameY * PX_TO_HWP);
    const beforeHorzOffset = state.origHorzOffset ?? origHorzOffset;
    const beforeVertOffset = state.origVertOffset ?? origVertOffset;
    try {
      setObjectProperties.call(this, state.ref, {
        width: newW,
        height: newH,
        horzOffset: beforeHorzOffset
          + horzOffsetDelta(state.horzAlign, newHorzOffset - origHorzOffset, newW - state.origWidth),
        vertOffset: beforeVertOffset
          + vertOffsetDelta(state.vertAlign, newVertOffset - origVertOffset, newH - state.origHeight),
      });
      this.eventBus.emit('document-changed');
    } catch { /* ignore */ }
  }
}

export function finishPictureResizeDrag(this: any, e: MouseEvent): void {
  const state = this.pictureResizeState;
  if (!state) { this.cleanupPictureResizeDrag(); return; }
  if (isObjectSizeProtected.call(this, state.ref) ||
      state.multiRefs?.some((r: PictureObjectRef) => isObjectSizeProtected.call(this, r))) {
    this.cleanupPictureResizeDrag();
    this.renderPictureObjectSelection();
    return;
  }

  const zoom = this.viewportManager.getZoom();
  const PX2HWP = PX_TO_HWP;

  // 다중 선택 리사이즈: 드래그 중 실시간 반영 완료 → 최종 확정만
  if (state.multiRefs && state.multiRefs.length > 0) {
    const newBbox = this.calcResizedBbox(e, zoom);
    const scaleX = newBbox.width / state.bbox.w;
    const scaleY = newBbox.height / state.bbox.h;
    const origX = state.bbox.x;
    const origY = state.bbox.y;
    const newOrigX = newBbox.x;
    const newOrigY = newBbox.y;
    const isCorner = ['nw', 'ne', 'sw', 'se'].includes(state.dir);

    try {
      const historyTargets = [];
      for (const r of state.multiRefs) {
        const relX = r.bboxX - origX;
        const relY = r.bboxY - origY;
        const sx = isCorner ? scaleX : (state.dir === 'n' || state.dir === 's' ? 1 : scaleX);
        const sy = isCorner ? scaleX : (state.dir === 'e' || state.dir === 'w' ? 1 : scaleY);
        const newPx = newOrigX + relX * sx;
        const newPy = newOrigY + relY * sy;
        const deltaH = Math.round((newPx - r.bboxX) * PX2HWP);
        const deltaV = Math.round((newPy - r.bboxY) * PX2HWP);
        const newW = Math.max(Math.round(r.origWidth * sx), MIN_SIZE_HWP);
        const newH = Math.max(Math.round(r.origHeight * sy), MIN_SIZE_HWP);
        const updated: Record<string, unknown> = { width: newW, height: newH };
        const before: Record<string, unknown> = { width: r.origWidth, height: r.origHeight };
        // 좌상단 델타 + 크기 델타 → 정렬 기준의 offset 증감 (object-offset-axis)
        const offH = horzOffsetDelta(r.horzAlign, deltaH, newW - r.origWidth);
        const offV = vertOffsetDelta(r.vertAlign, deltaV, newH - r.origHeight);
        if (offH !== 0) {
          updated['horzOffset'] = r.origHorzOffset + offH;
          before['horzOffset'] = r.origHorzOffset;
        }
        if (offV !== 0) {
          updated['vertOffset'] = r.origVertOffset + offV;
          before['vertOffset'] = r.origVertOffset;
        }
        const changed = Object.keys(updated).some(key => updated[key] !== before[key]);
        if (!changed) continue;
        setObjectProperties.call(this, r, updated);
        historyTargets.push({ sec: r.sec, ppi: r.ppi, ci: r.ci, type: r.type, cellPath: r.cellPath, before, after: updated });
      }
      if (historyTargets.length > 0) {
        this.executeOperation({ kind: 'record', command: new ResizeObjectCommand(historyTargets) });
      }
      this.eventBus.emit('document-changed');
    } catch (err) {
      console.warn('[InputHandler] 다중 개체 리사이즈 실패:', err);
    }
    this.cleanupPictureResizeDrag();
    this.renderPictureObjectSelection();
    return;
  }

  // 단일 선택 리사이즈 (회전 반영: pivot 고정, 위치도 갱신)
  const newBbox = calcResizedBboxRotated(state, e, zoom);
  const rotAngle = (state.rotationAngle ?? 0) as number;
  const rotatedFrame = usesRotatedPictureFrame(state, rotAngle);
  const resizedFrame = frameFromActualPictureBbox(newBbox, rotAngle, rotatedFrame);
  const originalFrame = originalFrameTopLeftFromState(state, rotatedFrame);
  const newW = resizedFrame.width;
  const newH = resizedFrame.height;
  const newHorzOffset = Math.round(resizedFrame.frameX * PX2HWP);
  const newVertOffset = Math.round(resizedFrame.frameY * PX2HWP);
  const origHorzOffset = Math.round(originalFrame.frameX * PX2HWP);
  const origVertOffset = Math.round(originalFrame.frameY * PX2HWP);

  try {
    const updated: Record<string, unknown> = {};
    const before: Record<string, unknown> = {};
    if (newW !== state.origWidth) {
      updated['width'] = newW;
      before['width'] = state.origWidth;
    }
    if (newH !== state.origHeight) {
      updated['height'] = newH;
      before['height'] = state.origHeight;
    }
    const beforeHorzOffset = state.origHorzOffset ?? origHorzOffset;
    const beforeVertOffset = state.origVertOffset ?? origVertOffset;
    // offset 은 페이지 절대값이 아니라 "저장된 offset + 페이지좌표 델타"로 적용한다.
    // (글상자/셀 중첩 picture 는 offset 이 컨테이너 상대라, 페이지 절대값을 쓰면 밖으로 튕김.
    //  다중 선택 리사이즈 경로와 동일한 델타 방식 — 본문 그림은 before≈orig 이므로 동작 불변.)
    // 좌상단 델타 + 크기 델타 → 정렬 기준의 offset 증감 (object-offset-axis).
    // Left/Top 기준(코퍼스 91%/99%)에서는 종전과 같은 값이다.
    const deltaHorz = horzOffsetDelta(state.horzAlign, newHorzOffset - origHorzOffset, newW - state.origWidth);
    const deltaVert = vertOffsetDelta(state.vertAlign, newVertOffset - origVertOffset, newH - state.origHeight);
    if (deltaHorz !== 0) {
      updated['horzOffset'] = beforeHorzOffset + deltaHorz;
      before['horzOffset'] = beforeHorzOffset;
    }
    if (deltaVert !== 0) {
      updated['vertOffset'] = beforeVertOffset + deltaVert;
      before['vertOffset'] = beforeVertOffset;
    }
    if (Object.keys(updated).length > 0) {
      setObjectProperties.call(this, state.ref, updated);
      this.executeOperation({
        kind: 'record',
        command: new ResizeObjectCommand([{ sec: state.ref.sec, ppi: state.ref.ppi, ci: state.ref.ci, type: state.ref.type, cellPath: state.ref.cellPath, before, after: updated }]),
      });
      this.eventBus.emit('document-changed');
    }
  } catch (err) {
    console.warn('[InputHandler] 개체 리사이즈 실패:', err);
  }
  this.cleanupPictureResizeDrag();
  this.renderPictureObjectSelection();
}

export function calcResizedBbox(this: any, e: MouseEvent, zoom: number): { x: number; y: number; width: number; height: number } {
  const s = this.pictureResizeState!;
  const dx = (e.clientX - s.startClientX) / zoom; // page px
  const dy = (e.clientY - s.startClientY) / zoom;
  const MIN = 1;

  let { x, y, w, h } = s.bbox;
  const dir = s.dir;

  // 가로 크기 및 위치 계산 (Flip 허용)
  if (dir.includes('e')) {
    const valW = s.bbox.w + dx;
    w = Math.max(Math.abs(valW), MIN);
    if (valW < 0) x = s.bbox.x + valW; // 반대편으로 넘어가면 시작점 이동
  } else if (dir.includes('w')) {
    const valW = s.bbox.w - dx;
    w = Math.max(Math.abs(valW), MIN);
    if (valW >= 0) x = s.bbox.x + dx;
    else x = s.bbox.x + s.bbox.w; // 반대편으로 넘어가면 오른쪽 끝이 시작점
  }

  // 세로 크기 및 위치 계산 (Flip 허용)
  if (dir.includes('s')) {
    const valH = s.bbox.h + dy;
    h = Math.max(Math.abs(valH), MIN);
    if (valH < 0) y = s.bbox.y + valH;
  } else if (dir.includes('n')) {
    const valH = s.bbox.h - dy;
    h = Math.max(Math.abs(valH), MIN);
    if (valH >= 0) y = s.bbox.y + dy;
    else y = s.bbox.y + s.bbox.h;
  }

  return { x, y, width: w, height: h };
}

export function cleanupPictureResizeDrag(this: any): void {
  this.isPictureResizeDragging = false;
  this.pictureResizeState = null;
  this.container.style.cursor = '';
  if (this.dragRafId) {
    cancelAnimationFrame(this.dragRafId);
    this.dragRafId = 0;
  }
  this.pictureObjectRenderer?.clearDragPreview();
}

export function updatePictureMoveDrag(this: any, e: MouseEvent): void {
  if (!this.pictureMoveState) return;
  const zoom = this.viewportManager.getZoom();
  const sc = this.container.querySelector('#scroll-content');
  if (!sc) return;
  const cr = sc.getBoundingClientRect();
  const cx = e.clientX - cr.left;
  const cy = e.clientY - cr.top;
  // 좌표 기준은 «드래그를 시작한 쪽» 으로 못박는다. 매 프레임 getPageAtPoint 로 다시
  // 고르면 포인터가 쪽 경계를 넘는 순간 원점이 pageHeight+gap 만큼 불연속으로 바뀌어,
  // 그 차이가 통째로 이동 델타가 된다(A4 기준 약 -84,900HU ≈ -299mm 점프).
  const pi = this.pictureMoveState.pageIndex;
  const po = this.virtualScroll.getPageOffset(pi);
  const pl = this.virtualScroll.getPageLeftResolved(pi, sc.clientWidth);
  const px = (cx - pl) / zoom;
  const py = (cy - po) / zoom;

  // 시작점 기준 총 이동량 — 축 고정(Shift)·격자 스냅·이동 문턱은 모두 이 위에서 정한다.
  let totalXpx = px - this.pictureMoveState.startPageX;
  let totalYpx = py - this.pictureMoveState.startPageY;

  // 이동 문턱 — 이미 움직이기 시작했으면 다시 묻지 않는다. 표 드래그와 같은 3px 가드
  // (없으면 «선택된 그림을 클릭만» 해도 손떨림 1px 이 0.26mm 이동으로 기록된다).
  if (!this.pictureMoveState.hasMoved) {
    const threshold = 3 / Math.max(zoom, 0.1);
    if (Math.abs(totalXpx) < threshold && Math.abs(totalYpx) < threshold) return;
    this.pictureMoveState.hasMoved = true;
  }

  // Shift — 우세한 축만 남긴다(수평/수직 고정)
  if (e.shiftKey) {
    if (Math.abs(totalXpx) >= Math.abs(totalYpx)) totalYpx = 0; else totalXpx = 0;
  }

  // 격자 스냅 — 「자석 효과」·「격자에만 붙이기」는 시작 위치 + 총 이동량을 격자 간격으로 반올림한다.
  // (누적은 실수로 들고 표시만 스냅하므로 잔차가 사라지지 않는다.)
  const grid = getGridViewSettings();
  if (grid.snapMode !== 'free' && this.pictureMoveState.startBbox) {
    const stepX = Math.max(0.5, grid.horizontalMm) * 96 / 25.4; // mm → page px(96dpi)
    const stepY = Math.max(0.5, grid.verticalMm) * 96 / 25.4;
    const snap = (v: number, step: number) => Math.round(v / step) * step;
    const b = this.pictureMoveState.startBbox;
    if (totalXpx !== 0) totalXpx = snap(b.x + totalXpx, stepX) - b.x;
    if (totalYpx !== 0) totalYpx = snap(b.y + totalYpx, stepY) - b.y;
  }

  let dLeftHu = Math.round(totalXpx * 75) - this.pictureMoveState.totalDeltaH; // 1 page px = 75 HWPUNIT
  let dTopHu = Math.round(totalYpx * 75) - this.pictureMoveState.totalDeltaV;

  // 직전 프레임에 «그 방향으로» 막힌 축은 다시 시도하지 않는다 — 경계에 붙어 있는 동안
  // 프레임마다 (적용 → 되돌리기) 두 번 쓰는 것을 막는다. 방향이 뒤집히면 바로 푼다.
  if (this.pictureMoveState.clampedX && Math.sign(dLeftHu) === this.pictureMoveState.clampedX) dLeftHu = 0;
  else this.pictureMoveState.clampedX = 0;
  if (this.pictureMoveState.clampedY && Math.sign(dTopHu) === this.pictureMoveState.clampedY) dTopHu = 0;
  else this.pictureMoveState.clampedY = 0;

  if (dLeftHu === 0 && dTopHu === 0) return;

  try {
    // 다중 선택: 모든 개체를 «화면에서» 동일 delta 만큼 이동한다. offset 증감은
    // 개체마다 정렬 기준이 다를 수 있으므로 개체별로 축 변환한다.
    const targets = this.pictureMoveState.multiRefs || [this.pictureMoveState.ref];
    const primary = targets[0];
    const bboxBefore = this.pictureMoveState.lastBbox ?? findPictureBbox.call(this, primary, pi);
    const applied: { ref: any; prevH: number; prevV: number; horzAlign?: string; vertAlign?: string }[] = [];
    for (const ref of targets) {
      const props = getObjectProperties.call(this, ref);
      const { deltaH, deltaV } = moveOffsetDelta(props, dLeftHu, dTopHu);
      if (deltaH === 0 && deltaV === 0) continue;
      setObjectProperties.call(this, ref, {
        horzOffset: props.horzOffset + deltaH,
        vertOffset: props.vertOffset + deltaV,
      });
      applied.push({ ref, prevH: props.horzOffset, prevV: props.vertOffset,
                     horzAlign: props.horzAlign, vertAlign: props.vertAlign });
    }
    // 「쪽 영역 안으로 제한」 등 렌더 클램프에 걸리면 화면은 멈추는데 저장 offset 만 계속
    // 커진다 — 되돌릴 때 누적분이 소진될 때까지 개체가 꿈쩍도 않는 «죽은 구간»이다.
    // 실제로 그려진 자리를 되먹임으로 재서, «달성한 만큼만» offset 과 누적에 반영한다.
    const bboxAfter = findPictureBbox.call(this, primary, pi);
    const TOL_HU = 40; // ≈0.5 page px — 부동소수 잡음과 진짜 클램프를 가른다
    let commitX = dLeftHu;
    let commitY = dTopHu;
    if (bboxBefore && bboxAfter) {
      const achX = Math.round((bboxAfter.x - bboxBefore.x) * 75);
      const achY = Math.round((bboxAfter.y - bboxBefore.y) * 75);
      if (dLeftHu !== 0 && Math.abs(achX - dLeftHu) > TOL_HU) commitX = achX;
      if (dTopHu !== 0 && Math.abs(achY - dTopHu) > TOL_HU) commitY = achY;
    }
    if (commitX !== dLeftHu || commitY !== dTopHu) {
      for (const a of applied) {
        const fix: Record<string, unknown> = {};
        if (commitX !== dLeftHu) fix['horzOffset'] = a.prevH + horzOffsetDelta(a.horzAlign, commitX);
        if (commitY !== dTopHu) fix['vertOffset'] = a.prevV + vertOffsetDelta(a.vertAlign, commitY);
        if (Object.keys(fix).length > 0) setObjectProperties.call(this, a.ref, fix);
      }
      // 이 방향으로는 더 못 간다고 표시해 다음 프레임의 헛된 왕복을 막는다.
      if (commitX !== dLeftHu) this.pictureMoveState.clampedX = Math.sign(dLeftHu);
      if (commitY !== dTopHu) this.pictureMoveState.clampedY = Math.sign(dTopHu);
      this.pictureMoveState.lastBbox = findPictureBbox.call(this, primary, pi);
    } else {
      this.pictureMoveState.lastBbox = bboxAfter;
    }
    // 누적은 «화면 델타» 로 들고 있는다 — 종료 시 개체별로 다시 축 변환한다.
    this.pictureMoveState.totalDeltaH += commitX;
    this.pictureMoveState.totalDeltaV += commitY;
    // 연결선 자동 추적
    try { this.wasm.updateConnectorsInSection(targets[0].sec); } catch { /* ignore */ }
    this.eventBus.emit('document-changed');
    this.renderPictureObjectSelection();
  } catch (err) {
    console.warn('[InputHandler] 개체 이동 드래그 실패:', err);
  }
}

export function finishPictureMoveDrag(this: any): void {
  if (this.pictureMoveState) {
    const { totalDeltaH, totalDeltaV, multiRefs } = this.pictureMoveState;
    if (totalDeltaH !== 0 || totalDeltaV !== 0) {
      const targets = multiRefs || [{ ...this.pictureMoveState.ref, origHorzOffset: this.pictureMoveState.origHorzOffset, origVertOffset: this.pictureMoveState.origVertOffset }];
      for (const r of targets) {
        const CmdClass = (r.type === 'shape' || r.type === 'line' || r.type === 'group' || r.type === 'ole') ? MoveShapeCommand : MovePictureCommand;
        // 히스토리 명령은 «offset 공간» 으로 기록한다(redo 가 offset 에 그대로 더하므로).
        // 정렬 기준은 드래그 중 바뀌지 않으니 누적 화면 델타를 한 번만 축 변환하면 된다.
        let cmdH = totalDeltaH;
        let cmdV = totalDeltaV;
        try {
          const props = getObjectProperties.call(this, r);
          const d = moveOffsetDelta(props, totalDeltaH, totalDeltaV);
          cmdH = d.deltaH; cmdV = d.deltaV;
        } catch { /* 조회 실패 시 화면 델타 그대로 — 정렬 Left/Top 이면 동일하다 */ }
        this.executeOperation({
          kind: 'record',
          command: new CmdClass(
            r.sec, r.ppi, r.ci,
            cmdH, cmdV,
            r.origHorzOffset, r.origVertOffset,
            r.cellPath,
          ),
          meta: { domain: 'object', refresh: 'none', dirtyScope: 'object' },
        });
      }
    }
  }
  this.isPictureMoveDragging = false;
  this.pictureMoveState = null;
  this.container.style.cursor = '';
  if (this.dragRafId) {
    cancelAnimationFrame(this.dragRafId);
    this.dragRafId = 0;
  }
}

// ─── 회전 드래그 ─────────────────────────────────

/** 회전 드래그 중: 마우스 각도에 따라 실시간 회전 적용 */
export function updatePictureRotateDrag(this: any, e: MouseEvent): void {
  if (!this.pictureRotateState) return;
  if (isObjectSizeProtected.call(this, this.pictureRotateState.ref)) {
    this.isPictureRotateDragging = false;
    this.pictureRotateState = null;
    this.container.style.cursor = '';
    this.renderPictureObjectSelection();
    return;
  }
  const sc = this.container.querySelector('#scroll-content');
  if (!sc) return;
  const cr = sc.getBoundingClientRect();
  const mx = e.clientX - cr.left;
  const my = e.clientY - cr.top;

  const s = this.pictureRotateState;
  const currentAngle = Math.atan2(my - s.centerY, mx - s.centerX);
  let deltaDeg = (currentAngle - s.startAngle) * (180 / Math.PI);

  // Ctrl 키: 15° 단위 스냅
  let newAngle = s.origAngle + deltaDeg;
  if (e.ctrlKey) {
    newAngle = Math.round(newAngle / 15) * 15;
  }
  // -360 ~ 360 범위로 정규화
  newAngle = ((newAngle % 360) + 360) % 360;
  if (newAngle > 180) newAngle -= 360;

  try {
    setObjectProperties.call(this, s.ref, { rotationAngle: Math.round(newAngle) });
    this.eventBus.emit('document-changed');
    // 드래그 중에는 핸들 고정 — renderPictureObjectSelection 호출 안 함
  } catch (err) {
    console.warn('[InputHandler] 개체 회전 드래그 실패:', err);
  }
}

/** 회전 드래그 종료: 핸들을 최종 회전 위치로 스냅 */
export function finishPictureRotateDrag(this: any, _e: MouseEvent): void {
  this.isPictureRotateDragging = false;
  this.pictureRotateState = null;
  this.container.style.cursor = '';
  if (this.dragRafId) {
    cancelAnimationFrame(this.dragRafId);
    this.dragRafId = 0;
  }
  this.renderPictureObjectSelection();
}
