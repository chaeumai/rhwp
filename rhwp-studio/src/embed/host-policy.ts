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
  // 단독 제한 표면도 embed 와 동일하게 묻지 않는다 (검증 표면 일관성).
  return !isRestrictedSurface();
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
  // 단독 제한 표면도 묻지 않는다 — 이 화면의 용도가 "저장본이 원본을 보존하는가"
  // 검증인데, 자동 보정(reflowLinesegs)을 권장 버튼으로 내밀면 클릭 한 번에
  // 문서 모델이 바뀌어 왕복 비교가 왜곡된다. 원본 그대로 연다.
  return !isRestrictedSurface();
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
  // 문자표(특수문자) — 캐럿 자리에 글자를 넣는 InsertTextCommand 경로라 "기존 칸의
  // 값을 고치는 것"에 든다. 대화상자는 self-contained (메뉴·툴바 chrome 불필요).
  'insert:symbols',
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
 * 제한 표면의 편집 프로파일 (2026-08-18 사용자 결정).
 *
 * "검증 표면(단독)에서 본 것과 embed 에 실은 것이 다르면 검증이 무의미하다"
 * — 그래서 표면 구성을 isEmbedded() 로 가르지 않고 프로파일 하나로 가른다.
 *
 * - `full`       : 서식·표·그림까지 여는 작성 표면. 단독 진입의 기본이자,
 *                  새 제품 화면(rhwp 기본 작성 화면)이 iframe src 에
 *                  `?profile=full` 을 붙여 선택하는 값. 단독에서 검증한
 *                  표면과 정확히 같은 코드 경로다.
 * - `restricted` : 기존 제한 편집(T1, 값만 고치기). embed 기본값 — 기존
 *                  draft-edit 흐름은 아무 표시 없이 지금 동작을 유지한다.
 *                  서버 저장 게이트(페이지 수·셀 수 불변)와 짝을 이룬다.
 *
 * 파일 명령(file:*)은 어느 프로파일에도 없다 — 문서 반입·반출은 호스트
 * RPC(loadFile/exportHwpx)의 몫이고, 단독 검증 표면은 ?url= 자동 로드와
 * lab.html 하니스로 왕복한다 (2026-08-18: 열기/저장 버튼 제거 결정).
 */
export type SurfaceProfile = 'full' | 'restricted';

export function surfaceProfile(): SurfaceProfile {
  if (!isEmbedded()) return 'full';
  try {
    const p = new URLSearchParams(window.location.search).get('profile');
    if (p === 'full') return 'full';
  } catch {
    // location 접근이 막히는 환경(테스트 등)은 보수적으로 restricted.
  }
  return 'restricted';
}

/**
 * full 프로파일에서 추가로 허용하는 명령.
 *
 * 서식 바(format:)·표 편집(table:)에 더해 그림 반입·편집 일체(2026-08-18
 * 사용자 결정: "모두 다"): 삽입·속성·삭제·캡션·배치·뒤집기·묶기, 그리고
 * 그림 컨텍스트 메뉴가 발사하는 잘라내기/복사/붙여넣기 계열.
 *
 * 의도적으로 계속 봉인: file:*(호스트 RPC 몫), page:*(쪽 설정), insert:table
 * (새 표 삽입 — 서식 골격 보존 원칙, 필요해지면 별도 결정), 수식·차트 등
 * 나머지 insert 계열.
 */
const FULL_SURFACE_COMMANDS = new Set([
  'view:border-transparent',
  'insert:image',
  'insert:picture-props',
  'insert:picture-delete',
  'insert:group-shapes',
  'insert:ungroup-shapes',
  'edit:cut',
  'edit:copy',
  'edit:paste',
  'edit:format-copy',
  'edit:format-paste',
]);

const FULL_SURFACE_PREFIXES = [
  'format:',
  'table:',
  'insert:caption-',
  'insert:arrange-',
  'insert:flip-',
];

export function isCommandAllowedInEmbed(commandId: string): boolean {
  if (!isRestrictedSurface()) return true;
  if (EMBED_ALLOWED_COMMANDS.has(commandId)) return true;
  if (surfaceProfile() === 'full') {
    return (
      FULL_SURFACE_COMMANDS.has(commandId)
      || FULL_SURFACE_PREFIXES.some((prefix) => commandId.startsWith(prefix))
    );
  }
  return false;
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
