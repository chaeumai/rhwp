import type { HmlSaveState } from '../core/hml-save-capability.ts';
import type { ApplyEditsResult, EditRequest, Outline } from './authoring.ts';

export interface EmbedRpcHandlers {
  ready(): Promise<boolean>;
  loadFile(
    data: Uint8Array,
    fileName: string,
    skipUnsavedGuard: boolean,
  ): Promise<{ pageCount: number }>;
  pageCount(): Promise<number>;
  /** 한채움 fork: 저장 검증용 구조 시그니처 — 중첩 포함 총 셀 수(논리 셀,
   *  병합=1) + 편집기 렌더 기준 쪽 수. DraftEditSaveService 의 tx-html
   *  파싱(maxPage/countCells) 대체 (2026-08-19 인계). */
  getStructureSignature(): Promise<{ totalCells: number; pageCount: number }>;
  /** 한채움 fork: 마지막 로드·저장 이후 편집이 있었는지. 호스트가 폴링한다. */
  isDirty(): Promise<boolean>;
  getRendererDiagnostics(page: number): Promise<EmbedRendererDiagnosticsV1>;
  getPageSvg(page: number): Promise<string>;
  exportHwp(): Promise<Uint8Array>;
  exportHwpx(): Promise<Uint8Array>;
  exportHml(): Promise<Uint8Array>;
  getHmlSaveState(): Promise<HmlSaveState>;
  exportHwpVerify(): Promise<unknown>;
  /** 한채움 fork: AI 작성 표면 (ai-authoring-v1). */
  getOutline(): Promise<Outline>;
  getTextByPaths(paths: readonly string[]): Promise<Array<{ path: string; text: string | null }>>;
  applyEdits(edits: readonly EditRequest[]): Promise<ApplyEditsResult>;
  revertLastBatch(): Promise<{ ok: boolean; reverted: boolean }>;
  /**
   * 사용자 직접 입력을 잠근다. AI 가 문서를 읽고 쓰는 동안 사용자가 타이핑하면
   * AI 가 잡아 둔 좌표가 밀려 배치 전체가 실패한다. 명령 허용 목록으로는
   * 막히지 않는 경로(직접 타이핑·붙여넣기·IME)라 별도 잠금이 필요하다.
   */
  setInputLocked(locked: boolean): Promise<{ locked: boolean }>;
}

export interface EmbedRendererDiagnosticsV1 {
  schemaVersion: 1;
  request: unknown;
  initialized: boolean;
  initializationError: string | null;
  effectiveBackend: 'canvas2d' | 'canvaskit' | null;
  backendFallbackReason: string | null;
  page: { index: number; canvaskit: unknown };
}

function asParams(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

/**
 * 인자 검증은 여기서 끝낸다. 잘못된 모양을 통과시켜 WASM 까지 내려보내면
 * 실패 지점이 편집 코어 안쪽이 되어 호출자가 무엇이 틀렸는지 알 수 없다.
 */
function asPaths(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('paths must be an array');
  if (value.length > 200) throw new Error('paths accepts at most 200 entries');
  return value.map((entry) => {
    if (typeof entry !== 'string' || entry.length === 0) throw new Error('path must be a non-empty string');
    return entry;
  });
}

function asEdits(value: unknown): EditRequest[] {
  if (!Array.isArray(value)) throw new Error('edits must be an array');
  if (value.length > 100) throw new Error('edits accepts at most 100 entries');
  return value.map((entry) => {
    if (typeof entry !== 'object' || entry === null) throw new Error('edit must be an object');
    const edit = entry as Record<string, unknown>;
    if (typeof edit.path !== 'string' || edit.path.length === 0) throw new Error('edit.path must be a non-empty string');
    if (typeof edit.expectedText !== 'string') throw new Error('edit.expectedText must be a string');
    if (typeof edit.newText !== 'string') throw new Error('edit.newText must be a string');
    return { path: edit.path, expectedText: edit.expectedText, newText: edit.newText };
  });
}

function asBytes(value: unknown, allowLegacyArray: boolean): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (allowLegacyArray && Array.isArray(value)) return new Uint8Array(value);
  throw new Error('loadFile requires binary data');
}

export async function routeEmbedRequest(
  method: string,
  rawParams: unknown,
  handlers: EmbedRpcHandlers,
  allowLegacyArray = false,
): Promise<unknown> {
  const params = asParams(rawParams);
  switch (method) {
    case 'ready': return handlers.ready();
    case 'loadFile':
      return handlers.loadFile(
        asBytes(params.data, allowLegacyArray),
        typeof params.fileName === 'string' ? params.fileName : 'document.hwp',
        params.skipUnsavedGuard === true,
      );
    case 'pageCount': return handlers.pageCount();
    case 'getStructureSignature': return handlers.getStructureSignature();
    // 한채움 fork: 호스트가 저장 필요 여부를 폴링한다.
    case 'isDirty': return handlers.isDirty();
    case 'getRendererDiagnostics': {
      const page = params.page ?? 0;
      if (!Number.isSafeInteger(page) || (page as number) < 0) {
        throw new Error('page must be a non-negative safe integer');
      }
      return handlers.getRendererDiagnostics(page as number);
    }
    case 'getPageSvg': return handlers.getPageSvg(
      typeof params.page === 'number' ? params.page : 0,
    );
    case 'exportHwp': return handlers.exportHwp();
    case 'exportHwpx': return handlers.exportHwpx();
    case 'exportHml': return handlers.exportHml();
    case 'getHmlSaveState': return handlers.getHmlSaveState();
    case 'exportHwpVerify': return handlers.exportHwpVerify();
    case 'getOutline': return handlers.getOutline();
    case 'getTextByPaths': return handlers.getTextByPaths(asPaths(params.paths));
    case 'applyEdits': return handlers.applyEdits(asEdits(params.edits));
    case 'revertLastBatch': return handlers.revertLastBatch();
    case 'setInputLocked': return handlers.setInputLocked(params.locked === true);
    default: throw new Error(`Unknown method: ${method}`);
  }
}
