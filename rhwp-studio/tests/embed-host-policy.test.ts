import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isEmbedded,
  shouldPromptLocalFonts,
  shouldPromptValidationWarnings,
} from '../src/embed/host-policy.ts';

function withParent(parent: unknown, run: () => void): void {
  const previous = (globalThis as { window?: unknown }).window;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: parent === 'self' ? undefined : { parent },
  });
  if (parent === 'self') {
    const self: Record<string, unknown> = {};
    self.parent = self;
    Object.defineProperty(globalThis, 'window', { configurable: true, value: self });
  }
  try {
    run();
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previous });
  }
}

test('단독 실행에서는 두 확인 창을 그대로 띄운다', () => {
  withParent('self', () => {
    assert.equal(isEmbedded(), false);
    assert.equal(shouldPromptLocalFonts(), true);
    assert.equal(shouldPromptValidationWarnings(), true);
  });
});

test('임베드 상태에서는 사용자에게 묻지 않는다', () => {
  withParent({ different: true }, () => {
    assert.equal(isEmbedded(), true);
    // 호스트 화면 뒤에 가려진 창을 사용자가 누를 수 없어 로딩이 멈춰 선다.
    assert.equal(shouldPromptLocalFonts(), false);
    assert.equal(shouldPromptValidationWarnings(), false);
  });
});

test('부모 창 접근이 막히면 임베드로 본다', () => {
  const previous = (globalThis as { window?: unknown }).window;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      get parent(): unknown {
        throw new Error('cross-origin');
      },
    },
  });
  try {
    assert.equal(isEmbedded(), true);
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previous });
  }
});
