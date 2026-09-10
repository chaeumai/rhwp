import test from 'node:test';
import assert from 'node:assert/strict';

import {
  horzOffsetSign,
  vertOffsetSign,
  horzAnchorFraction,
  vertAnchorFraction,
  horzOffsetDelta,
  vertOffsetDelta,
  moveOffsetDelta,
} from '../src/engine/object-offset-axis.ts';

// 1 page px = 75 HWPUNIT (input-handler-picture.ts 의 환산과 같다)
const PX = 75;

test('offset 부호는 오른쪽/아래·바깥쪽 기준에서만 뒤집힌다', () => {
  assert.equal(horzOffsetSign('Left'), 1);
  assert.equal(horzOffsetSign('Center'), 1);
  assert.equal(horzOffsetSign('Inside'), 1);
  assert.equal(horzOffsetSign('Right'), -1);
  assert.equal(horzOffsetSign('Outside'), -1);
  assert.equal(vertOffsetSign('Top'), 1);
  assert.equal(vertOffsetSign('Center'), 1);
  assert.equal(vertOffsetSign('Inside'), 1);
  assert.equal(vertOffsetSign('Bottom'), -1);
  assert.equal(vertOffsetSign('Outside'), -1);
});

test('모르는 정렬값·누락은 기본(Left/Top)으로 다룬다', () => {
  assert.equal(horzOffsetSign(undefined), 1);
  assert.equal(horzOffsetSign(null), 1);
  assert.equal(horzOffsetSign('Nonsense'), 1);
  assert.equal(vertOffsetSign(undefined), 1);
  assert.equal(horzAnchorFraction(undefined), 0);
  assert.equal(vertAnchorFraction(undefined), 0);
});

test('정렬 기준점(frac)은 왼쪽 0 · 가운데 0.5 · 오른쪽 1', () => {
  assert.equal(horzAnchorFraction('Left'), 0);
  assert.equal(horzAnchorFraction('Center'), 0.5);
  assert.equal(horzAnchorFraction('Right'), 1);
  assert.equal(horzAnchorFraction('Outside'), 1);
  assert.equal(vertAnchorFraction('Top'), 0);
  assert.equal(vertAnchorFraction('Center'), 0.5);
  assert.equal(vertAnchorFraction('Bottom'), 1);
  assert.equal(vertAnchorFraction('Outside'), 1);
});

test('이동: 왼쪽 기준은 화면 델타 그대로, 오른쪽 기준은 부호가 뒤집힌다', () => {
  // 마우스를 오른쪽으로 100px
  assert.equal(horzOffsetDelta('Left', 100 * PX), 7500);
  assert.equal(horzOffsetDelta('Center', 100 * PX), 7500);
  assert.equal(horzOffsetDelta('Right', 100 * PX), -7500);
  assert.equal(horzOffsetDelta('Outside', 100 * PX), -7500);
  // 마우스를 아래로 80px
  assert.equal(vertOffsetDelta('Top', 80 * PX), 6000);
  assert.equal(vertOffsetDelta('Bottom', 80 * PX), -6000);
});

test('한컴 실측 재현 — 오른쪽 기준 그림을 왼쪽으로 끌면 offset 이 «는다»', () => {
  // 2026-09-10 한글 2024 실측: 오른쪽 기준 그림을 왼쪽으로 120 화면px 끌자
  // hOff 0 → +8609. 화면 배율 833/793.7 을 빼면 문서 기준 약 114.3px.
  const docPx = -114.3;                    // 왼쪽 = 음수
  const d = horzOffsetDelta('Right', docPx * PX);
  assert.ok(d > 0, `왼쪽 이동은 offset 을 늘려야 한다 (얻은 값 ${d})`);
  assert.equal(d, Math.round(114.3 * PX)); // 8573 — 실측 8609 와 40HU(0.14mm) 안
});

test('크기 조절: 정렬된 변이 실제로 움직인 만큼만 offset 이 바뀐다', () => {
  // 왼쪽 기준 — 좌상단이 움직인 만큼
  assert.equal(horzOffsetDelta('Left', -10 * PX, 10 * PX), -750);
  // 오른쪽 기준 — 서쪽 핸들을 왼쪽으로 끌면 폭만 커지고 «오른쪽 변»은 제자리 → offset 불변
  assert.equal(horzOffsetDelta('Right', -10 * PX, 10 * PX), 0);
  // 오른쪽 기준 — 동쪽 핸들을 오른쪽으로 끌면 좌상단은 그대로, 오른쪽 변만 이동
  assert.equal(horzOffsetDelta('Right', 0, 10 * PX), -750);
  // 가운데 기준 — 중심이 움직인 만큼 (폭 변화의 절반)
  assert.equal(horzOffsetDelta('Center', 0, 10 * PX), 375);
  // 세로도 대칭
  assert.equal(vertOffsetDelta('Bottom', -10 * PX, 10 * PX), 0);
  assert.equal(vertOffsetDelta('Top', -10 * PX, 10 * PX), -750);
});

test('moveOffsetDelta 는 두 축을 개체 속성 하나로 변환한다', () => {
  assert.deepEqual(
    moveOffsetDelta({ horzAlign: 'Right', vertAlign: 'Bottom' }, 100 * PX, 80 * PX),
    { deltaH: -7500, deltaV: -6000 },
  );
  assert.deepEqual(
    moveOffsetDelta({ horzAlign: 'Left', vertAlign: 'Top' }, 100 * PX, 80 * PX),
    { deltaH: 7500, deltaV: 6000 },
  );
  // 속성 조회 실패(null)여도 기본값으로 동작한다
  assert.deepEqual(moveOffsetDelta(null, 300, -150), { deltaH: 300, deltaV: -150 });
});

test('왼쪽/위 기준(코퍼스 91%/99%)에서는 종전 계산과 값이 같다', () => {
  for (const px of [-1000, -37, 0, 1, 42, 999]) {
    assert.equal(horzOffsetDelta('Left', px), px, '가로 Left 는 항등이어야 한다');
    assert.equal(vertOffsetDelta('Top', px), px, '세로 Top 은 항등이어야 한다');
  }
});
