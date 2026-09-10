/**
 * 개체 offset 의 «축 변환» — 화면에서 옮긴 양을 저장 offset 의 증감으로 바꾼다.
 *
 * `horzOffset`/`vertOffset` 은 화면 좌표가 아니라 **정렬 기준선으로부터의 거리**다.
 * 렌더러(`src/renderer/layout/picture_footnote.rs` `compute_object_position`,
 * `src/renderer/float_placement.rs` `horizontal_range`, `src/renderer/layout/shape_layout.rs`)가
 * 이렇게 해석한다:
 *
 *   가로  Left | Inside     → x = ref_x + off
 *         Center            → x = ref_x + (ref_w - w)/2 + off
 *         Right | Outside   → x = ref_x + ref_w - w - off      ← 부호가 뒤집힌다
 *   세로  Top | Inside      → y = ref_y + off
 *         Center            → y = ref_y + (ref_h - h)/2 + off
 *         Bottom | Outside  → y = ref_y + ref_h - h - off      ← 부호가 뒤집힌다
 *
 * 그래서 «마우스를 오른쪽으로 100px» 을 `horzOffset += 100px` 로 옮기면
 * 오른쪽 기준 개체는 화면에서 **왼쪽으로** 간다. 이 모듈이 그 변환을 한 곳에 모은다.
 *
 * 일반형:  Δoffset = sign × (Δ좌상단 + frac × Δ크기)
 *   frac — 정렬이 개체의 어느 지점을 잡는가 (Left/Top 0 · Center 0.5 · Right/Bottom 1)
 *   sign — 그 기준이 offset 을 어느 방향으로 재는가 (Right/Outside·Bottom/Outside 만 −1)
 *
 * 이동(Δ크기 = 0)은 `Δoffset = sign × Δ좌상단` 으로 줄고, 크기 조절에서는
 * «정렬된 변»이 화면에서 실제로 움직인 만큼만 offset 이 바뀐다
 * (예: 오른쪽 기준 개체의 왼쪽 핸들을 끌면 오른쪽 변이 안 움직이므로 offset 불변).
 *
 * 🔴 한컴 실측 (2026-09-10, 한글 2024 · CRD):
 *   · 가로 `RIGHT` 는 실제로 뒤집힌다 — 개체를 왼쪽으로 120px 끌자 `hOff 0 → +8609`,
 *     오른쪽으로 150px 끌자 `hOff 8609 → 0`. **정렬값은 그대로 두고 offset 만 바꾼다.**
 *     즉 위 렌더 규약은 한컴과 일치하고, 틀린 것은 편집기의 델타 계산이었다.
 *   · 세로 `BOTTOM` 은 한컴이 «문단 높이»를 기준 상자로 삼아 우리 렌더와 기준이 다르다
 *     (아래로 150px → `vOff +10748`). 그 차이는 렌더 규약의 문제이지 이 변환의 문제가 아니다 —
 *     편집기는 **우리 렌더러의 규약**에 맞춘다. 그래야 «우리 화면에서» 개체가 마우스를 따라온다.
 *     렌더 규약 정정은 파리티 레인 몫이다. 판정 정본
 *     `rhwp-cai/docs/그림배치-진단-82퍼센트가못움직인다-정렬부호반전-보조장치0-20260910-1118.md`.
 *
 * 정렬 문자열은 wasm 게터가 내보내는 어휘를 쓴다 —
 * `Left|Center|Right|Inside|Outside`, `Top|Center|Bottom|Inside|Outside`
 * (`object_ops/picture.rs` · `object_ops/common.rs`). 모르는 값은 기본(+1, frac 0)으로 둔다.
 */

export type AxisSign = 1 | -1;

/** 가로 offset 이 재는 방향 — 오른쪽/바깥쪽 기준만 −1. */
export function horzOffsetSign(horzAlign?: string | null): AxisSign {
  return horzAlign === 'Right' || horzAlign === 'Outside' ? -1 : 1;
}

/** 세로 offset 이 재는 방향 — 아래/바깥쪽 기준만 −1. */
export function vertOffsetSign(vertAlign?: string | null): AxisSign {
  return vertAlign === 'Bottom' || vertAlign === 'Outside' ? -1 : 1;
}

/** 가로 정렬이 개체의 어느 지점을 잡는가 (0 왼쪽 · 0.5 가운데 · 1 오른쪽). */
export function horzAnchorFraction(horzAlign?: string | null): number {
  if (horzAlign === 'Center') return 0.5;
  if (horzAlign === 'Right' || horzAlign === 'Outside') return 1;
  return 0;
}

/** 세로 정렬이 개체의 어느 지점을 잡는가 (0 위 · 0.5 가운데 · 1 아래). */
export function vertAnchorFraction(vertAlign?: string | null): number {
  if (vertAlign === 'Center') return 0.5;
  if (vertAlign === 'Bottom' || vertAlign === 'Outside') return 1;
  return 0;
}

/**
 * 화면에서 개체 좌상단이 `dLeftHu`, 폭이 `dWidthHu` 만큼 변했을 때 `horzOffset` 에 더할 값.
 * 단순 이동이면 `dWidthHu` 를 생략한다.
 */
export function horzOffsetDelta(
  horzAlign: string | null | undefined,
  dLeftHu: number,
  dWidthHu = 0,
): number {
  const moved = dLeftHu + horzAnchorFraction(horzAlign) * dWidthHu;
  const d = Math.round(horzOffsetSign(horzAlign) * moved);
  return d === 0 ? 0 : d; // -0 정규화 (JSON·비교에서 새는 것을 막는다)
}

/**
 * 화면에서 개체 좌상단이 `dTopHu`, 높이가 `dHeightHu` 만큼 변했을 때 `vertOffset` 에 더할 값.
 * 단순 이동이면 `dHeightHu` 를 생략한다.
 */
export function vertOffsetDelta(
  vertAlign: string | null | undefined,
  dTopHu: number,
  dHeightHu = 0,
): number {
  const moved = dTopHu + vertAnchorFraction(vertAlign) * dHeightHu;
  const d = Math.round(vertOffsetSign(vertAlign) * moved);
  return d === 0 ? 0 : d; // -0 정규화
}

/** 개체 속성 중 이 변환에 필요한 부분만. */
export interface ObjectAlignLike {
  horzAlign?: string | null;
  vertAlign?: string | null;
}

/**
 * 이동 한 번을 두 축 한꺼번에 변환한다 — 드래그·방향키 공용 진입점.
 * `props` 는 wasm 게터가 돌려준 개체 속성(정렬만 읽는다).
 */
export function moveOffsetDelta(
  props: ObjectAlignLike | null | undefined,
  dLeftHu: number,
  dTopHu: number,
): { deltaH: number; deltaV: number } {
  return {
    deltaH: horzOffsetDelta(props?.horzAlign, dLeftHu),
    deltaV: vertOffsetDelta(props?.vertAlign, dTopHu),
  };
}
