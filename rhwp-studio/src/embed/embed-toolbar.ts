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

export interface EmbedToolbar {
  element: HTMLElement;
  /** 문서가 열리기 전에는 비활성으로 둔다 — 버튼은 항상 렌더하고 disabled 만 바꾼다. */
  setEnabled(enabled: boolean): void;
}

export function createEmbedToolbar(
  doc: Document,
  dispatch: (commandId: string) => void,
): EmbedToolbar {
  const bar = doc.createElement('div');
  bar.id = 'embed-toolbar';

  const group = doc.createElement('div');
  group.className = 'tb-group';
  bar.appendChild(group);

  const buttons: HTMLButtonElement[] = [];
  for (const entry of EMBED_TOOLBAR_ENTRIES) {
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
    btn.disabled = true;

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
  }

  return {
    element: bar,
    setEnabled(enabled: boolean) {
      for (const btn of buttons) btn.disabled = !enabled;
    },
  };
}
