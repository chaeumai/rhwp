import assert from 'node:assert/strict';
import test from 'node:test';

import { createEmbedToolbar } from '../src/embed/embed-toolbar.ts';
import { isCommandAllowedInEmbed } from '../src/embed/host-policy.ts';

/**
 * 이 테스트는 node --test 로 돌므로 실제 DOM 이 없다. createEmbedToolbar 가
 * 사용하는 표면(createElement, append*, addEventListener, click)만 흉내 낸다.
 */
interface FakeElement {
  tag: string;
  id: string;
  className: string;
  type: string;
  title: string;
  textContent: string;
  disabled: boolean;
  dataset: Record<string, string>;
  children: FakeElement[];
  listeners: Record<string, Array<() => void>>;
  appendChild(child: FakeElement): void;
  append(...nodes: FakeElement[]): void;
  addEventListener(type: string, handler: () => void): void;
  insertAdjacentElement(position: string, element: FakeElement): void;
  click(): void;
}

function makeElement(tag: string): FakeElement {
  const el: FakeElement = {
    tag,
    id: '',
    className: '',
    type: '',
    title: '',
    textContent: '',
    disabled: false,
    dataset: {},
    children: [],
    listeners: {},
    appendChild(child) {
      el.children.push(child);
    },
    append(...nodes) {
      el.children.push(...nodes);
    },
    addEventListener(type, handler) {
      (el.listeners[type] ??= []).push(handler);
    },
    insertAdjacentElement() {},
    click() {
      // 실제 브라우저의 disabled 버튼처럼 click 이벤트 자체가 발생하지 않는다.
      if (el.disabled) return;
      for (const handler of el.listeners.click ?? []) handler();
    },
  };
  return el;
}

const fakeDocument = {
  createElement: (tag: string) => makeElement(tag),
} as unknown as Document;

function collectButtons(root: FakeElement): FakeElement[] {
  const out: FakeElement[] = [];
  const walk = (el: FakeElement) => {
    if (el.tag === 'button') out.push(el);
    for (const child of el.children) walk(child);
  };
  walk(root);
  return out;
}

test('임베드 툴바의 모든 버튼은 임베드 허용 명령만 발사한다', () => {
  const toolbar = createEmbedToolbar(fakeDocument, () => {});
  const buttons = collectButtons(toolbar.element as unknown as FakeElement);
  assert.ok(buttons.length > 0, '버튼이 하나 이상 있어야 한다');
  for (const btn of buttons) {
    const cmd = btn.dataset.cmd;
    assert.ok(cmd, '버튼마다 명령 id 가 있어야 한다');
    // 이 테스트 환경은 window 부재 → isEmbedded() 가 임베드로 판정하므로
    // 허용 목록 검사 그 자체를 통과해야 한다.
    assert.equal(isCommandAllowedInEmbed(cmd), true, `${cmd} 는 임베드 허용 명령이어야 한다`);
  }
});

test('문서가 열리기 전에는 전 버튼 비활성이고 클릭해도 발사되지 않는다', () => {
  const dispatched: string[] = [];
  const toolbar = createEmbedToolbar(fakeDocument, (cmd) => dispatched.push(cmd));
  const buttons = collectButtons(toolbar.element as unknown as FakeElement);
  for (const btn of buttons) {
    assert.equal(btn.disabled, true);
    btn.click();
  }
  assert.deepEqual(dispatched, []);
});

test('단독 제한 표면에서는 파일 그룹이 추가되고 열기는 문서 이전에도 활성', () => {
  const toolbar = createEmbedToolbar(fakeDocument, () => {}, { includeFileCommands: true });
  const buttons = collectButtons(toolbar.element as unknown as FakeElement);
  const cmds = buttons.map((btn) => btn.dataset.cmd);
  assert.ok(cmds.includes('file:open'), '열기 버튼이 있어야 한다');
  assert.ok(cmds.includes('file:save'), '저장 버튼이 있어야 한다');

  const open = buttons.find((btn) => btn.dataset.cmd === 'file:open')!;
  const save = buttons.find((btn) => btn.dataset.cmd === 'file:save')!;
  assert.equal(open.disabled, false, '열기는 문서가 없어도 활성');
  assert.equal(save.disabled, true, '저장은 문서가 열려야 활성');

  toolbar.setEnabled(true);
  assert.equal(save.disabled, false);
  toolbar.setEnabled(false);
  assert.equal(open.disabled, false, '비활성 전환에도 열기는 활성 유지');
});

test('setEnabled(true) 후에는 클릭이 해당 명령을 발사한다', () => {
  const dispatched: string[] = [];
  const toolbar = createEmbedToolbar(fakeDocument, (cmd) => dispatched.push(cmd));
  toolbar.setEnabled(true);
  const buttons = collectButtons(toolbar.element as unknown as FakeElement);
  for (const btn of buttons) {
    assert.equal(btn.disabled, false);
    btn.click();
  }
  assert.deepEqual(
    dispatched,
    buttons.map((btn) => btn.dataset.cmd),
  );
});
