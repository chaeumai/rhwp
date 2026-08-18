/**
 * 한채움 fork: 임베드 상태의 최소 편집 툴바.
 *
 * 임베드에서는 메뉴 바·아이콘 툴바·서식 바를 전부 감춘다 — 구조·서식 명령의
 * 진입점이기 때문이다. 하지만 허용된 편집 명령(EMBED_ALLOWED_COMMANDS)까지
 * 단축키로만 접근되면 사용자는 편집 도구가 아예 없는 것으로 오해한다.
 *
 * 그래서 허용 목록에 있는 명령만으로 구성한 전용 툴바를 대신 노출한다.
 * 여기 있는 버튼은 전부 dispatcher 를 거치므로, 허용 목록이 줄어들면
 * 버튼이 남아 있어도 dispatcher 단계에서 차단된다 — 봉인은 유지된다.
 */

interface EmbedToolbarItem {
  command: string;
  glyph: string;
  label: string;
  title: string;
  /** 문서가 열리기 전에도 활성 (파일 열기 등 반입 명령) */
  alwaysEnabled?: boolean;
}

type EmbedToolbarEntry = EmbedToolbarItem | 'separator';

/**
 * 버튼 구성. EMBED_ALLOWED_COMMANDS 의 부분집합만 올 수 있다.
 * select-all/delete/goto 는 문서 안 상호작용으로 충분해 버튼을 만들지 않는다.
 */
const EMBED_TOOLBAR_ENTRIES: EmbedToolbarEntry[] = [
  { command: 'edit:undo', glyph: '↶', label: '되돌리기', title: '되돌리기 (Ctrl+Z)' },
  { command: 'edit:redo', glyph: '↷', label: '다시 실행', title: '다시 실행 (Ctrl+Y)' },
  'separator',
  { command: 'edit:find', glyph: '⌕', label: '찾기', title: '찾기 (Ctrl+F)' },
  { command: 'edit:find-replace', glyph: '⥂', label: '찾아 바꾸기', title: '찾아 바꾸기 (Ctrl+F2)' },
  'separator',
  { command: 'view:zoom-out', glyph: '−', label: '축소', title: '축소 (Ctrl+-)' },
  { command: 'view:zoom-in', glyph: '+', label: '확대', title: '확대 (Ctrl++)' },
];

/**
 * full 프로파일 추가 그룹 — 표 편집·그림·화면 전용 보기 토글.
 *
 * 단독 진입(검증 표면)과 `?profile=full` embed 가 같은 목록을 쓴다 — 검증
 * 표면에서 본 구성이 제품 embed 와 달라지면 안 된다 (2026-08-18 결정).
 * 파일 열기/저장 버튼은 두지 않는다 — 반입·반출은 호스트 RPC(?url=/lab)의 몫.
 */
const FULL_PROFILE_ENTRIES: EmbedToolbarEntry[] = [
  'separator',
  // 표 편집 — 캐럿이 표 안에 있을 때만 dispatcher canExecute 가 실행을 허용한다.
  { command: 'table:insert-row-below', glyph: '⊕', label: '행 추가', title: '아래에 행 추가' },
  { command: 'table:delete-row', glyph: '⊖', label: '행 삭제', title: '행 삭제' },
  { command: 'table:insert-col-right', glyph: '⊞', label: '열 추가', title: '오른쪽에 열 추가' },
  { command: 'table:delete-col', glyph: '⊟', label: '열 삭제', title: '열 삭제' },
  { command: 'table:cell-merge', glyph: '⧉', label: '셀 병합', title: '셀 합치기 (셀 블록 선택 후)' },
  { command: 'table:cell-split', glyph: '⿲', label: '셀 나누기', title: '셀 나누기' },
  'separator',
  // 그림 — 삽입은 파일 선택 후 본문/셀 안 클릭·드래그로 배치한다.
  // 속성·삭제·캡션·배치·뒤집기는 그림 선택 후 우클릭 컨텍스트 메뉴에도 있다.
  { command: 'insert:image', glyph: '🖼', label: '그림', title: '그림 넣기 — 파일 선택 후 본문/셀 안에서 클릭·드래그' },
  { command: 'insert:picture-props', glyph: '⚙', label: '개체 속성', title: '선택한 그림/개체 속성 (그림 선택 후)' },
  { command: 'insert:picture-delete', glyph: '✖', label: '개체 삭제', title: '선택한 그림/개체 지우기 (그림 선택 후)' },
  'separator',
  {
    command: 'view:border-transparent',
    glyph: '⊡',
    label: '투명선',
    title: '투명 테두리 가이드 (빨간 점선, 화면 전용) 토글',
  },
];

export interface EmbedToolbar {
  element: HTMLElement;
  /** 문서가 열리기 전에는 비활성으로 둔다 — 버튼은 항상 렌더하고 disabled 만 바꾼다. */
  setEnabled(enabled: boolean): void;
}

export function createEmbedToolbar(
  doc: Document,
  dispatch: (commandId: string) => void,
  options?: { profile?: 'full' | 'restricted' },
): EmbedToolbar {
  const bar = doc.createElement('div');
  bar.id = 'embed-toolbar';

  const group = doc.createElement('div');
  group.className = 'tb-group';
  bar.appendChild(group);

  const entries: EmbedToolbarEntry[] = options?.profile === 'full'
    ? [...EMBED_TOOLBAR_ENTRIES, ...FULL_PROFILE_ENTRIES]
    : EMBED_TOOLBAR_ENTRIES;

  const buttons: HTMLButtonElement[] = [];
  const alwaysEnabledFlags: boolean[] = [];
  for (const entry of entries) {
    if (entry === 'separator') {
      const sep = doc.createElement('span');
      sep.className = 'tb-sep';
      group.appendChild(sep);
      continue;
    }
    const btn = doc.createElement('button');
    btn.className = 'tb-btn';
    btn.type = 'button';
    btn.title = entry.title;
    btn.dataset.cmd = entry.command;
    btn.disabled = !entry.alwaysEnabled;

    const glyph = doc.createElement('span');
    glyph.className = 'tb-icon-text';
    glyph.textContent = entry.glyph;
    const label = doc.createElement('span');
    label.className = 'tb-label';
    label.textContent = entry.label;
    btn.append(glyph, label);

    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      dispatch(entry.command);
    });
    group.appendChild(btn);
    buttons.push(btn);
    alwaysEnabledFlags.push(Boolean(entry.alwaysEnabled));
  }

  return {
    element: bar,
    setEnabled(enabled: boolean) {
      buttons.forEach((btn, i) => {
        btn.disabled = alwaysEnabledFlags[i] ? false : !enabled;
      });
    },
  };
}
