import assert from 'node:assert/strict';
import test from 'node:test';

import { isCommandAllowedInEmbed } from '../src/embed/host-policy.ts';
import { defaultShortcuts } from '../src/command/shortcut-map.ts';

function inEmbed(run: () => void): void {
  const previous = (globalThis as { window?: unknown }).window;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { parent: { different: true } },
  });
  try {
    run();
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previous });
  }
}

test('임베드에서 텍스트 편집·탐색 명령만 허용된다', () => {
  inEmbed(() => {
    for (const id of ['edit:undo', 'edit:redo', 'edit:select-all', 'edit:find', 'view:zoom-in', 'insert:symbols']) {
      assert.equal(isCommandAllowedInEmbed(id), true, `${id} 는 허용돼야 한다`);
    }
  });
});

test('임베드에서 구조·서식·파일 명령은 전부 차단된다', () => {
  inEmbed(() => {
    for (const id of [
      'format:bold',
      'insert:table',
      'table:insert-row',
      'page:setup',
      'file:save',
      'file:open',
      'file:new-doc',
      'edit:format-copy',
      'view:form-mode',
      'field:edit',
    ]) {
      assert.equal(isCommandAllowedInEmbed(id), false, `${id} 는 차단돼야 한다`);
    }
  });
});

test('허용 목록 방식이다 — 단축키 맵의 미열거 명령은 기본 차단', () => {
  inEmbed(() => {
    // upstream 이 단축키를 새로 달아도 허용 목록에 없으면 임베드에서는 잠긴다.
    const blocked = defaultShortcuts
      .map(([, commandId]) => commandId)
      .filter((commandId) => !isCommandAllowedInEmbed(commandId));
    // 서식·파일 계열이 실제로 걸러지는지 표본으로 확인한다.
    assert.ok(blocked.some((id) => id.startsWith('format:')), 'format: 계열이 차단 목록에 있어야 한다');
    assert.ok(blocked.some((id) => id.startsWith('file:')), 'file: 계열이 차단 목록에 있어야 한다');
  });
});

// full 프로파일에서 열리는 대표 명령 — 단독 기본과 ?profile=full embed 가
// 같은 집합을 봐야 한다 (2026-08-18 결정: 검증 표면 = 제품 표면).
const FULL_PROFILE_SAMPLE = [
  'edit:undo',
  'view:zoom-in',
  'view:border-transparent',
  'format:bold',
  'format:apply-style',
  'table:insert-row-above',
  'table:cell-merge',
  'insert:image',
  'insert:picture-props',
  'insert:picture-delete',
  'insert:caption-toggle',
  'insert:arrange-front',
  'insert:flip-horz',
  'edit:cut',
  'edit:copy',
  'edit:paste',
];

// full 에서도 계속 봉인되는 명령 — 파일 반입·반출은 호스트 RPC 몫(2026-08-18
// 열기/저장 버튼 제거 결정), 쪽 설정·새 표 삽입·기타 개체는 별도 결정 전 봉인.
const SEALED_EVERYWHERE = [
  'file:open',
  'file:save',
  'file:save-as-hwpx',
  'file:new-doc',
  'file:print',
  'page:setup',
  'insert:table',
  'insert:shape',
  'insert:equation',
];

test('단독 실행은 full 프로파일 — 서식·표·그림이 열리고 파일 명령은 봉인', () => {
  const previous = (globalThis as { window?: unknown }).window;
  const self: Record<string, unknown> = {};
  self.parent = self;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: self });
  try {
    for (const id of FULL_PROFILE_SAMPLE) {
      assert.equal(isCommandAllowedInEmbed(id), true, `단독(full)에서 ${id} 는 허용`);
    }
    for (const id of SEALED_EVERYWHERE) {
      assert.equal(isCommandAllowedInEmbed(id), false, `단독(full)에서 ${id} 는 차단`);
    }
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previous });
  }
});

test('embed 도 ?profile=full 이면 단독과 같은 집합을 본다', () => {
  const previous = (globalThis as { window?: unknown }).window;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { parent: { different: true }, location: { search: '?profile=full' } },
  });
  try {
    for (const id of FULL_PROFILE_SAMPLE) {
      assert.equal(isCommandAllowedInEmbed(id), true, `embed(full)에서 ${id} 는 허용`);
    }
    for (const id of SEALED_EVERYWHERE) {
      assert.equal(isCommandAllowedInEmbed(id), false, `embed(full)에서 ${id} 는 차단`);
    }
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previous });
  }
});

test('embed 기본(restricted)은 profile 파라미터가 없으면 종전 봉인 그대로', () => {
  const previous = (globalThis as { window?: unknown }).window;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { parent: { different: true }, location: { search: '' } },
  });
  try {
    for (const id of ['format:bold', 'table:insert-row-above', 'insert:image', 'edit:cut']) {
      assert.equal(isCommandAllowedInEmbed(id), false, `embed(restricted)에서 ${id} 는 차단`);
    }
    assert.equal(isCommandAllowedInEmbed('edit:undo'), true);
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previous });
  }
});
