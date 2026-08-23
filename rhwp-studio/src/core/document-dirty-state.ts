import type { EventBus } from './event-bus';

export interface DirtyStateChange {
  dirty: boolean;
  reason?: string;
}

/**
 * 저장되지 않은 문서 변경 상태를 관리한다.
 *
 * 브라우저는 beforeunload에서 앱 커스텀 모달을 허용하지 않으므로,
 * dirty 상태일 때만 브라우저 기본 이탈 확인창이 뜨도록 한다.
 */
export class DocumentDirtyState {
  private dirty = false;
  /**
   * 한채움 fork: 편집 세대. markDirty 가 불릴 때마다 오른다 — 이미 dirty 여도 오른다.
   * 호스트가 "export 한 그 상태를 저장했다" 고 알릴 때, export 이후 편집이 끼어들었는지
   * 가르는 근거다 (export 시점 세대 == 지금 세대 이면 clean 으로 내려도 된다).
   */
  private editRevision = 0;
  private beforeUnloadWindow: Window | null = null;
  private readonly eventBus: EventBus;
  private readonly beforeUnloadHandler = (event: BeforeUnloadEvent): string | void => {
    if (!this.dirty) return;
    event.preventDefault();
    event.returnValue = '';
    return '';
  };

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
  }

  isDirty(): boolean {
    return this.dirty;
  }

  markDirty(reason?: string): void {
    this.editRevision += 1;
    this.setDirty(true, reason);
  }

  /** 한채움 fork: 지금까지의 편집 세대. {@link markDirty} 횟수와 같다. */
  revision(): number {
    return this.editRevision;
  }

  /**
   * 한채움 fork: 호스트가 {@code revision} 세대의 export 를 저장했다고 알린다.
   * 그 뒤 편집이 없었으면 clean 으로 내리고 true, 끼어들었으면 그대로 두고 false.
   * export 자체는 저장이 아니라서(업로드가 실패할 수 있다) export 시점에 내리지 않는다.
   */
  markSavedAt(revision: number, reason = 'host-saved'): boolean {
    if (revision !== this.editRevision) return false;
    this.setDirty(false, reason);
    return true;
  }

  markClean(reason?: string): void {
    this.setDirty(false, reason);
  }

  installBeforeUnload(windowLike: Window): () => void {
    if (this.beforeUnloadWindow === windowLike) {
      return () => this.uninstallBeforeUnload(windowLike);
    }
    this.beforeUnloadWindow?.removeEventListener('beforeunload', this.beforeUnloadHandler);
    this.beforeUnloadWindow = windowLike;
    windowLike.addEventListener('beforeunload', this.beforeUnloadHandler);
    return () => this.uninstallBeforeUnload(windowLike);
  }

  private uninstallBeforeUnload(windowLike: Window): void {
    if (this.beforeUnloadWindow !== windowLike) return;
    windowLike.removeEventListener('beforeunload', this.beforeUnloadHandler);
    this.beforeUnloadWindow = null;
  }

  private setDirty(next: boolean, reason?: string): void {
    if (this.dirty === next) return;
    this.dirty = next;
    this.eventBus.emit('document-dirty-changed', { dirty: next, reason } satisfies DirtyStateChange);
  }
}
