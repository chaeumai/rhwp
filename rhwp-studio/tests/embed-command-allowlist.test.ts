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
    for (const id of ['edit:undo', 'edit:redo', 'edit:select-all', 'edit:find', 'view:zoom-in']) {
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

test('단독 실행도 제한 표면 — 파일 반입·반출만 추가 허용된다', () => {
  const previous = (globalThis as { window?: unknown }).window;
  const self: Record<string, unknown> = {};
  self.parent = self;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: self });
  try {
    // 호스트가 없으므로 파일 명령과, 사용자 결정(2026-08-17)에 따른 서식·표
    // 계열, 투명선 토글이 열린다.
    for (const id of [
      'file:open',
      'file:save',
      'file:save-as-hwpx',
      'edit:undo',
      'view:zoom-in',
      'view:border-transparent',
      'format:bold',
      'format:apply-style',
      'table:insert-row-above',
      'table:cell-merge',
    ]) {
      assert.equal(isCommandAllowedInEmbed(id), true, `단독 제한 표면에서 ${id} 는 허용`);
    }
    // 개체 삽입·쪽 설정·기타 파일 명령은 계속 봉인된다.
    for (const id of ['insert:image', 'insert:shape', 'page:setup', 'file:new-doc', 'file:print']) {
      assert.equal(isCommandAllowedInEmbed(id), false, `단독 제한 표면에서 ${id} 는 차단`);
    }
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previous });
  }
});
