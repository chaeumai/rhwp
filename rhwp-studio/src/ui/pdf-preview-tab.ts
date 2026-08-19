/**
 * PDF 확인 탭 — 단독 검증 표면(디버깅 화면) 전용.
 *
 * 현재 문서를 HWPX 로 내보내 hwpx-agent(hwpAgent-api)에 변환을 맡기고,
 * 결과 PDF 를 슬라이드 패널의 iframe 으로 보여준다. 편집기 저장 경로와
 * 무관한 눈 검증용 도구라 문서 상태를 건드리지 않는다.
 *
 * 변환 결과는 캐시되지만 문서 리비전을 추적해 편집 후 패널을 열면 자동
 * 재변환한다 — "편집했는데 PDF 가 옛것" 상태를 만들지 않는다.
 *
 * 서빙 전제: same-origin `/hwpx-agent/*` 가 hwpAgent-api(:3001) 로 중계된다
 * (dev 는 vite proxy, 라이브는 nginx location — CSP connect-src 'self' 유지).
 */

const AGENT_BASE = '/hwpx-agent';
const POLL_INTERVAL_MS = 700;
const POLL_TIMEOUT_MS = 90_000;

export interface PdfPreviewTabOptions {
  /** 현재 문서의 HWPX 바이트를 반환한다. 문서 미로드 시 throw 가능. */
  exportHwpx: () => Uint8Array;
  /** 다운로드 파일명에 쓸 문서 이름 (확장자 제외). */
  getDocName?: () => string;
  /** 문서가 편집될 때마다 cb 를 불러 달라 (재변환 필요 감지용). */
  onDocumentChanged?: (cb: () => void) => void;
  /** 문서가 로드돼 있는가 (기본 열림 시 첫 변환 시점 판단용). */
  hasDocument?: () => boolean;
  /** true 면 설치 즉시 분할 패널을 연다 (?url= 디버그 진입). */
  autoOpen?: boolean;
}

const WIDTH_KEY = 'rhwp-pdfp-width';

export function installPdfPreviewTab(opts: PdfPreviewTabOptions): void {
  // ── DOM 구성 ──
  const tab = document.createElement('button');
  tab.id = 'pdf-preview-tab';
  tab.type = 'button';
  tab.textContent = 'PDF 확인';
  tab.title = 'hwpx-agent 로 변환한 PDF 를 확인합니다';

  const panel = document.createElement('div');
  panel.id = 'pdf-preview-panel';
  panel.hidden = true;
  panel.innerHTML = `
    <div class="pdfp-divider" title="드래그로 폭 조절"></div>
    <div class="pdfp-header">
      <span class="pdfp-title">PDF 미리보기 — hwpx-agent</span>
      <span class="pdfp-status" role="status"></span>
      <span class="pdfp-spacer"></span>
      <button type="button" class="pdfp-btn pdfp-refresh" title="현재 문서로 다시 변환">다시 변환</button>
      <button type="button" class="pdfp-btn pdfp-save-hwpx" title="현재 문서를 HWPX 파일로 저장 (저장 위치 선택)">HWPX 저장</button>
      <button type="button" class="pdfp-btn pdfp-dl-hwpx" title="현재 문서를 HWPX 로 즉시 다운로드">HWPX ↓</button>
      <button type="button" class="pdfp-btn pdfp-dl-pdf" title="변환된 PDF 다운로드" disabled>PDF ↓</button>
      <button type="button" class="pdfp-btn pdfp-close" title="닫기">×</button>
    </div>
    <div class="pdfp-body">
      <div class="pdfp-empty">아직 변환 결과가 없습니다.</div>
      <iframe class="pdfp-frame" title="PDF 미리보기" hidden></iframe>
    </div>`;

  document.body.appendChild(tab);
  document.body.appendChild(panel);

  const dividerEl = panel.querySelector('.pdfp-divider') as HTMLElement;
  const statusEl = panel.querySelector('.pdfp-status') as HTMLElement;
  const emptyEl = panel.querySelector('.pdfp-empty') as HTMLElement;
  const frameEl = panel.querySelector('.pdfp-frame') as HTMLIFrameElement;
  const refreshBtn = panel.querySelector('.pdfp-refresh') as HTMLButtonElement;
  const saveHwpxBtn = panel.querySelector('.pdfp-save-hwpx') as HTMLButtonElement;
  const dlHwpxBtn = panel.querySelector('.pdfp-dl-hwpx') as HTMLButtonElement;
  const dlPdfBtn = panel.querySelector('.pdfp-dl-pdf') as HTMLButtonElement;
  const closeBtn = panel.querySelector('.pdfp-close') as HTMLButtonElement;

  let converting = false;
  let blobUrl: string | null = null;
  let hasResult = false;

  // 문서 리비전 추적 — 편집마다 증가, 변환 성공 시점의 값을 기억한다.
  let docRevision = 0;
  let convertedRevision = -1;
  opts.onDocumentChanged?.(() => {
    docRevision++;
    // 패널이 열려 있는데 문서가 바뀌면 결과가 낡았음을 알린다.
    if (!panel.hidden && !converting && hasResult && convertedRevision !== docRevision) {
      setStatus('문서가 바뀌었습니다 — 다시 변환하세요');
    }
  });

  const setStatus = (text: string, isError = false): void => {
    statusEl.textContent = text;
    statusEl.classList.toggle('pdfp-error', isError);
  };

  const docName = (): string =>
    (opts.getDocName?.() || 'document').replace(/\.(hwpx?|hml)$/i, '');

  const showPdf = (url: string): void => {
    emptyEl.hidden = true;
    frameEl.hidden = false;
    frameEl.src = url;
    dlPdfBtn.disabled = false;
  };

  const downloadBlob = (blob: Blob, filename: string): void => {
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  };

  const convert = async (): Promise<void> => {
    if (converting) return;
    converting = true;
    refreshBtn.disabled = true;
    const startedAt = performance.now();
    const revisionAtExport = docRevision;
    try {
      setStatus('HWPX 내보내는 중…');
      const bytes = opts.exportHwpx();

      setStatus('변환 요청 중…');
      const form = new FormData();
      form.append('file', new File([new Blob([bytes as BlobPart])], `${docName()}.hwpx`));
      const submitRes = await fetch(`${AGENT_BASE}/api/jobs/pdf-only`, { method: 'POST', body: form });
      if (!submitRes.ok) {
        throw new Error(submitRes.status === 503
          ? 'hwpx-agent 가 바쁩니다 — 잠시 후 다시 시도하세요'
          : `변환 요청 실패 (HTTP ${submitRes.status})`);
      }
      const { jobId } = await submitRes.json();
      if (!jobId) throw new Error('jobId 없는 응답');

      // 상태 폴링
      for (;;) {
        if (performance.now() - startedAt > POLL_TIMEOUT_MS) {
          throw new Error('변환 시간 초과 (90초)');
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        const jobRes = await fetch(`${AGENT_BASE}/api/jobs/${jobId}`);
        if (!jobRes.ok) throw new Error(`상태 조회 실패 (HTTP ${jobRes.status})`);
        const job = await jobRes.json();
        if (job.status === 'SUCCEEDED') break;
        if (job.status === 'FAILED') {
          throw new Error(`변환 실패: ${job.error ?? '원인 미상'}`);
        }
        setStatus(`변환 중… (${((performance.now() - startedAt) / 1000).toFixed(0)}초)`);
      }

      const pdfRes = await fetch(`${AGENT_BASE}/api/jobs/${jobId}/result/pdf`);
      if (!pdfRes.ok) throw new Error(`PDF 다운로드 실패 (HTTP ${pdfRes.status})`);
      const pdfBlob = await pdfRes.blob();
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      blobUrl = URL.createObjectURL(pdfBlob.type === 'application/pdf'
        ? pdfBlob
        : new Blob([pdfBlob], { type: 'application/pdf' }));
      showPdf(blobUrl);
      hasResult = true;
      convertedRevision = revisionAtExport;
      const suffix = docRevision !== revisionAtExport ? ' — 변환 중 편집됨, 필요시 다시 변환' : '';
      setStatus(`완료 (${((performance.now() - startedAt) / 1000).toFixed(1)}초)${suffix}`);
    } catch (err) {
      const msg = err instanceof TypeError
        ? 'hwpx-agent 에 연결할 수 없습니다 (/hwpx-agent 중계 확인)'
        : String(err instanceof Error ? err.message : err);
      setStatus(msg, true);
    } finally {
      converting = false;
      refreshBtn.disabled = false;
    }
  };

  // ── 분할 폭 관리 — --pdfp-width 하나로 에디터 margin·패널·탭 위치를 다스린다 ──
  const clampWidth = (w: number): number =>
    Math.min(Math.max(w, 360), Math.round(window.innerWidth * 0.7));
  let panelWidth = clampWidth(
    parseInt(localStorage.getItem(WIDTH_KEY) ?? '', 10) || Math.round(window.innerWidth * 0.45));
  const applyWidth = (): void => {
    document.documentElement.style.setProperty('--pdfp-width', `${panelWidth}px`);
  };
  applyWidth();
  window.addEventListener('resize', () => {
    panelWidth = clampWidth(panelWidth);
    applyWidth();
  });

  dividerEl.addEventListener('pointerdown', (ev: PointerEvent) => {
    ev.preventDefault();
    dividerEl.setPointerCapture(ev.pointerId);
    dividerEl.classList.add('pdfp-dragging');
    document.documentElement.classList.add('pdfp-resizing');
    const onMove = (mv: PointerEvent): void => {
      panelWidth = clampWidth(window.innerWidth - mv.clientX);
      applyWidth();
    };
    const onUp = (): void => {
      dividerEl.classList.remove('pdfp-dragging');
      document.documentElement.classList.remove('pdfp-resizing');
      localStorage.setItem(WIDTH_KEY, String(panelWidth));
      dividerEl.removeEventListener('pointermove', onMove);
      dividerEl.removeEventListener('pointerup', onUp);
    };
    dividerEl.addEventListener('pointermove', onMove);
    dividerEl.addEventListener('pointerup', onUp);
  });

  /** 문서가 준비돼 있고 결과가 없거나 낡았으면 변환한다. */
  const maybeConvert = (): void => {
    if (converting || panel.hidden) return;
    if (opts.hasDocument && !opts.hasDocument()) {
      setStatus('문서 로드 대기 중…');
      return;
    }
    if (!hasResult || convertedRevision !== docRevision) void convert();
  };

  const openPanel = (): void => {
    panel.hidden = false;
    document.documentElement.classList.add('pdfp-open-split');
    tab.title = 'PDF 패널 접기';
    maybeConvert();
  };
  const closePanel = (): void => {
    panel.hidden = true;
    document.documentElement.classList.remove('pdfp-open-split');
    tab.title = 'hwpx-agent 로 변환한 PDF 를 확인합니다';
  };

  tab.addEventListener('click', () => (panel.hidden ? openPanel() : closePanel()));
  closeBtn.addEventListener('click', closePanel);
  refreshBtn.addEventListener('click', () => void convert());

  // ?url= 디버그 진입은 고정 분할이 기본 — 문서 로드가 끝나면 첫 변환을 돈다.
  if (opts.autoOpen) {
    openPanel();
    if (opts.hasDocument && !opts.hasDocument()) {
      const waitId = window.setInterval(() => {
        if (panel.hidden) { window.clearInterval(waitId); return; }
        if (opts.hasDocument!()) {
          window.clearInterval(waitId);
          maybeConvert();
        }
      }, 400);
    }
  }

  // HWPX 저장 — 저장 위치를 고르는 파일 저장 (미지원 브라우저는 다운로드로).
  saveHwpxBtn.addEventListener('click', () => {
    void (async () => {
      let bytes: Uint8Array;
      try { bytes = opts.exportHwpx(); } catch (err) {
        setStatus(`HWPX 내보내기 실패: ${err instanceof Error ? err.message : err}`, true);
        return;
      }
      const blob = new Blob([bytes as BlobPart], { type: 'application/octet-stream' });
      const picker = (window as any).showSaveFilePicker as
        | ((o: any) => Promise<any>) | undefined;
      if (picker) {
        try {
          const handle = await picker({
            suggestedName: `${docName()}.hwpx`,
            types: [{ description: 'HWPX 문서', accept: { 'application/octet-stream': ['.hwpx'] } }],
          });
          const w = await handle.createWritable();
          await w.write(blob);
          await w.close();
          setStatus(`HWPX 저장 완료: ${handle.name}`);
          return;
        } catch (err) {
          if ((err as any)?.name === 'AbortError') return; // 사용자가 취소
          // picker 실패 → 다운로드로 폴백
        }
      }
      downloadBlob(blob, `${docName()}.hwpx`);
      setStatus('HWPX 다운로드 시작');
    })();
  });

  // HWPX 다운로드 — 즉시 받기.
  dlHwpxBtn.addEventListener('click', () => {
    try {
      const bytes = opts.exportHwpx();
      downloadBlob(new Blob([bytes as BlobPart], { type: 'application/octet-stream' }), `${docName()}.hwpx`);
      setStatus('HWPX 다운로드 시작');
    } catch (err) {
      setStatus(`HWPX 내보내기 실패: ${err instanceof Error ? err.message : err}`, true);
    }
  });

  // PDF 다운로드 — 마지막 변환 결과.
  dlPdfBtn.addEventListener('click', () => {
    if (!blobUrl) return;
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = `${docName()}.pdf`;
    a.click();
  });
}
