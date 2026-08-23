import test from 'node:test';
import assert from 'node:assert/strict';

import { EventBus } from '../src/core/event-bus.ts';
import { DocumentDirtyState, type DirtyStateChange } from '../src/core/document-dirty-state.ts';

type Listener = (event: unknown) => unknown;

class FakeWindow {
  private listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

function createBeforeUnloadEvent() {
  return {
    defaultPrevented: false,
    returnValue: undefined as string | undefined,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
}

test('DocumentDirtyState는 dirty/clean 전환 시 변경 이벤트를 한 번씩 발행한다', () => {
  const eventBus = new EventBus();
  const changes: DirtyStateChange[] = [];
  eventBus.on('document-dirty-changed', (payload) => changes.push(payload as DirtyStateChange));

  const state = new DocumentDirtyState(eventBus);

  assert.equal(state.isDirty(), false);

  state.markDirty('typing');
  state.markDirty('typing-again');
  state.markClean('save');
  state.markClean('save-again');

  assert.deepEqual(changes, [
    { dirty: true, reason: 'typing' },
    { dirty: false, reason: 'save' },
  ]);
  assert.equal(state.isDirty(), false);
});

test('DocumentDirtyState beforeunload는 dirty 상태에서만 페이지 이탈을 막는다', () => {
  const state = new DocumentDirtyState(new EventBus());
  const fakeWindow = new FakeWindow();

  state.installBeforeUnload(fakeWindow as unknown as Window);

  const cleanEvent = createBeforeUnloadEvent();
  fakeWindow.dispatch('beforeunload', cleanEvent);
  assert.equal(cleanEvent.defaultPrevented, false);
  assert.equal(cleanEvent.returnValue, undefined);

  state.markDirty('typing');
  const dirtyEvent = createBeforeUnloadEvent();
  fakeWindow.dispatch('beforeunload', dirtyEvent);
  assert.equal(dirtyEvent.defaultPrevented, true);
  assert.equal(dirtyEvent.returnValue, '');

  state.markClean('save');
  const savedEvent = createBeforeUnloadEvent();
  fakeWindow.dispatch('beforeunload', savedEvent);
  assert.equal(savedEvent.defaultPrevented, false);
  assert.equal(savedEvent.returnValue, undefined);
});

test('DocumentDirtyState beforeunload 해제 함수는 설치한 핸들러만 제거한다', () => {
  const state = new DocumentDirtyState(new EventBus());
  const fakeWindow = new FakeWindow();

  const uninstall = state.installBeforeUnload(fakeWindow as unknown as Window);
  assert.equal(fakeWindow.listenerCount('beforeunload'), 1);

  uninstall();
  assert.equal(fakeWindow.listenerCount('beforeunload'), 0);

  state.markDirty('typing');
  const event = createBeforeUnloadEvent();
  fakeWindow.dispatch('beforeunload', event);
  assert.equal(event.defaultPrevented, false);
});

test('DocumentDirtyState.markSavedAt 는 export 이후 편집이 없을 때만 clean 으로 내린다 (한채움 F1)', () => {
  const eventBus = new EventBus();
  const state = new DocumentDirtyState(eventBus);

  // 아직 export 한 적 없음(-1) — 아무것도 내리지 않는다.
  state.markDirty('typing');
  assert.equal(state.markSavedAt(-1), false);
  assert.equal(state.isDirty(), true);

  // export 시점 세대를 적어 두고, 그 뒤 편집이 없으면 내려간다.
  const exported = state.revision();
  assert.equal(state.markSavedAt(exported), true);
  assert.equal(state.isDirty(), false);

  // export 뒤 편집이 끼어들면 그 export 의 저장은 지금 상태를 대표하지 않는다 — 내리지 않는다.
  const exported2 = state.revision();
  state.markDirty('typing-after-export');
  assert.equal(state.markSavedAt(exported2), false);
  assert.equal(state.isDirty(), true);
  // 같은 세대를 다시 export 하고 저장하면 내려간다.
  assert.equal(state.markSavedAt(state.revision()), true);
  assert.equal(state.isDirty(), false);
});
