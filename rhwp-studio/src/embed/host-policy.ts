/**
 * 한채움 fork: 임베드 상태에서의 사용자 확인 정책.
 *
 * Studio 를 단독으로 열면 문서를 여는 도중 두 가지를 사용자에게 묻는다.
 *   - 로컬 글꼴 감지 (원본에 가깝게 보이려면 브라우저의 글꼴 목록 접근 허용)
 *   - HWPX 비표준 감지 (렌더 품질을 위해 lineseg 자동 보정)
 *
 * 호스트 애플리케이션 안에 끼워 넣은 상태에서는 이 질문을 하면 안 된다.
 *   1. 로딩이 사용자의 응답이 있을 때까지 멈춰 선다. 호스트는 편집기가 언제
 *      준비되는지 알 수 없고, 자기 화면에 뜨지도 않은 창을 기다리게 된다.
 *   2. 문서를 어떻게 다룰지는 호스트 제품의 정책이지 편집기가 매번 물어볼
 *      성질이 아니다. 같은 질문에 사용자가 다르게 답하면 결과가 갈린다.
 *
 * 그래서 임베드 상태에서는 묻지 않고 아래 기본값으로 조용히 진행한다.
 */

/** iframe 안에서 돌고 있는가. 부모 창이 자기 자신이면 단독 실행이다. */
export function isEmbedded(): boolean {
  try {
    return window.parent !== window;
  } catch {
    // 교차 출처 부모 접근이 막히는 환경이라면 그 자체가 임베드된 상태다.
    return true;
  }
}

/**
 * 로컬 글꼴 감지를 물어볼 것인가.
 *
 * 임베드에서는 묻지 않고 번들 대체 글꼴로 표시한다. 사용자의 설치 글꼴 목록은
 * 브라우저 지문이 될 수 있는 정보라, 호스트가 요구하지 않았는데 편집기가
 * 임의로 요청할 일이 아니다.
 */
export function shouldPromptLocalFonts(): boolean {
  return !isEmbedded();
}

/**
 * HWPX 비표준 경고를 물어볼 것인가.
 *
 * 임베드에서는 묻지 않고 원본 그대로 연다. 자동 보정(reflowLinesegs)은 렌더만
 * 바꾸는 것이 아니라 문서 모델의 lineseg 를 다시 계산해 저장본까지 달라진다.
 * 호스트가 원본 보존과 페이지 수 불변을 검사하는 저장 경로를 갖고 있으면
 * 로드 단계에서 조용히 문서를 바꾸는 쪽이 더 위험하다.
 */
export function shouldPromptValidationWarnings(): boolean {
  return !isEmbedded();
}

/**
 * 임베드 상태에서 실행을 허용하는 명령.
 *
 * 호스트 제품의 제한 편집(T1)은 "기존 칸의 값을 고치는 것"까지다. 문서 구조와
 * 서식을 바꾸는 명령은 편집기 화면(메뉴·툴바)을 숨기는 것만으로는 막히지
 * 않는다 — 단축키와 명령 팔레트가 dispatcher 로 직행하기 때문이다. 그래서
 * 차단 목록이 아니라 **허용 목록**으로 잠근다. 새 명령이 upstream 에 추가되면
 * 기본값이 "차단"이어야 봉인이 유지된다.
 *
 * 직접 타이핑·삭제·복사·붙여넣기는 dispatcher 를 거치지 않는 텍스트 편집
 * 경로라 이 목록과 무관하게 동작한다. 문단 추가·셀 안 줄바꿈 같은 잔여 구조
 * 변화는 호스트의 저장 검증(페이지 수·표 구조 불변)이 최종 방어선이다.
 */
const EMBED_ALLOWED_COMMANDS = new Set([
  'edit:undo',
  'edit:redo',
  'edit:select-all',
  'edit:delete',
  'edit:find',
  'edit:find-again',
  'edit:find-replace',
  'edit:goto',
  'view:zoom-in',
  'view:zoom-out',
]);

/**
 * 한채움 배포는 단독 진입(editor.hdev.kr 직접 접속)도 제한 편집 표면이다
 * (2026-08-17 결정). full 편집기 화면은 제품 표면이 아니고, 단독 진입은
 * 배포 검증·왕복 실험용이므로 embed 와 같은 minimal set 만 노출한다.
 * upstream full 화면으로 되돌리려면 false 로.
 */
export const RESTRICTED_STANDALONE = true;

/** 제한 편집 표면인가 — embed 이거나, 단독 제한 정책이 켜져 있으면 참. */
export function isRestrictedSurface(): boolean {
  return isEmbedded() || RESTRICTED_STANDALONE;
}

/**
 * 단독 제한 표면에서 추가로 허용하는 파일 명령.
 *
 * embed 에서는 문서 반입·반출을 호스트가 postMessage RPC 로 수행하므로 파일
 * 명령이 허용 목록에 없다. 단독 진입에는 호스트가 없어 왕복 실험 자체가
 * 불가능해지므로 열기/저장만 연다. embed 에서는 이 목록이 적용되지 않는다.
 */
const STANDALONE_ALLOWED_COMMANDS = new Set(['file:open', 'file:save', 'file:save-as-hwpx']);

export function isCommandAllowedInEmbed(commandId: string): boolean {
  if (isEmbedded()) return EMBED_ALLOWED_COMMANDS.has(commandId);
  if (RESTRICTED_STANDALONE) {
    return EMBED_ALLOWED_COMMANDS.has(commandId) || STANDALONE_ALLOWED_COMMANDS.has(commandId);
  }
  return true;
}

/**
 * 자동 저장(브라우저 IndexedDB 초안)과 시작 시 "문서 복구" 제안을 쓸 것인가.
 *
 * 한채움 배포에서는 embed·단독 공통으로 끈다. 문서의 정본은 호스트(hwpAgent
 * 작업 디렉터리 + 저장=재파생 흐름)가 관리하므로, 브라우저 로컬 초안은 정본과
 * 어긋난 상태를 복구라는 이름으로 되살릴 수 있는 표면이다 (2026-08-17 결정).
 * upstream 기본 동작으로 되돌리려면 true 로.
 */
export const AUTOSAVE_ENABLED = false;
