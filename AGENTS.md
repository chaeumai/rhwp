# rhwp 작업 지침 (한채움 fork)

이 저장소는 `edwardkim/rhwp`(MIT)에서 갈라져 나온 **독립 fork**다. upstream 과
병합하지 않는다. 아래는 이 fork 의 작업 계약이고, `mydocs/` 는 upstream 이
남긴 참고 자료로 취급한다 — 사실 확인에는 쓰되 절차의 정본으로 삼지 않는다.

## 문서 로딩 순서

1. **이 파일(`AGENTS.md`)이 절차의 정본이다.** `CLAUDE.md` 는 Claude 전용
   부트로더이며 여기로 보내는 포인터일 뿐이다
2. 엔진 구조·포맷 지식은 `mydocs/tech/README.md` (upstream 자료, 사실 참고용)
3. 빌드·WASM 세부는 `mydocs/manual/dev_environment_guide.md` (동일)

upstream 문서의 **절차**(PR 검토, collaborator 역할, `upstream/devel` 기준
브랜치)는 이 fork 에 적용되지 않는다. 기술적 **사실**만 유효하다.

## 공통 원칙

- 구현 전에 기존 계획·보고서·트러블슈팅을 확인한다.
- 사용자 또는 다른 도구가 만든 변경은 임의로 되돌리거나 삭제하지 않는다.
- 작업 브랜치는 `hanchaeum/port` 를 기준으로 만든다. `hanchaeum/base-0.7.19`
  는 갈라져 나온 시점의 불변 기준점이며 **출처 증명용**이다 — 병합 대상이 아니다.
- 작업 단계가 바뀌면 현재 단계의 변경을 커밋한 뒤 다음 단계를 시작한다.
- GitHub comment, remote push, PR 생성은 사용자 승인을 받은 뒤 수행한다.

## 라이선스

독립 fork 여도 MIT 의무는 남는다. `LICENSE` 와 저작권 표시를 유지하고,
`scripts/rhwp-selfhost/rhwp-pin.json`(한채움 저장소)의 감사 기록을
**출처 증명**으로 보존한다. 배포본 SBOM 과 폰트 라이선스 manifest 도 같다.

## 제한 표면 profile (2026-08-18)

편집 표면 구성은 `?profile=full|restricted` 로 가른다
(`rhwp-studio/src/embed/host-policy.ts`). isEmbedded() 로 표면을 가르지
않는다 — 단독 검증 표면과 embed 가 다른 코드 경로를 타면 검증이 무의미하다.

- **full**: 단독 진입 기본. embed 는 iframe src 에 `?profile=full`.
  서식(format:)·표(table:)·그림 일체(insert:image·속성·삭제·캡션·배치·
  뒤집기)·cut/copy/paste 를 연다. 툴바에 표·그림 그룹 노출.
- **restricted**: embed 기본값 — 기존 제한 편집(T1, 값만 고치기).
  호스트의 저장 게이트(페이지 수·셀 수 불변)와 짝을 이룬다.
- file:*·page:*·insert:table 은 어느 profile 에서도 봉인. 반입·반출은
  호스트 RPC(loadFile/exportHwpx)와 `?url=` 자동 로드의 몫이다.

새 명령을 열 때는 allowlist(host-policy)와 툴바(embed-toolbar) 그리고
`tests/embed-command-allowlist.test.ts` 의 표본 목록을 함께 갱신한다.

## 문서와 검증

- 렌더링·레이아웃 변경은 PDF/SVG 또는 동등한 근거를 남긴다.
- 저장 경로(`serializer/`) 변경은 fidelity 루프로 왕복 보존을 확인한다
  (한채움 `scripts/rhwp-fidelity/run-fidelity-loop.sh`).

---

## 테스트 계층 — 무엇을 언제 돌리는가

이 저장소의 테스트는 **두 층이고 규모가 100배 다르다.** 구분하지 않으면 5분이면
끝날 검증에 한 시간을 쓴다(2026-08-17 실제 발생).

| 층 | 명령 | 규모 | 실측 |
|---|---|---:|---|
| 모듈 필터 | `cargo test --lib <모듈경로>` | 해당 모듈 | **39초** (`document_core::queries::cursor_rect` 7개) |
| **커밋 게이트** | `cargo test --lib` | **2,283** | **307초** |
| 저장 충실도 | `scripts/rhwp-fidelity/run-fidelity-loop.sh` (한채움 저장소) | swuniv 전수 | 왕복 보존 |
| studio | `npx tsc --noEmit` + `npm test` | 331 | 1초 미만 |

- **게이트는 `--lib` 2,283개다.** `src/` 안 `#[test]` 이고 구현과 같은 파일에 있다.
  serializer 384 · parser 248 · document_core 232 · model 164 로, 한채움이 넣은
  1,006줄을 직접 덮는다. 물려받았지만 지금은 우리 코드를 검사하는 그물이다
- upstream 회귀 핀 `tests/*.rs` 275개는 **2026-08-18 에 제거**했다(독립 fork 전환).
  239개가 `issue_*` 로 upstream 이슈에 묶여 있었고 한채움 추가·수정분은 0개였다.
  cargo 가 테스트 바이너리를 **하나씩 직렬 실행**해 전체 1시간+ 였다(13분에 21/275).
  그래서 지금은 `--workspace` 와 `--lib` 가 사실상 같다
- **`tests/fixtures/` 는 지우지 말 것.** `src/paint`, `src/document_core` 가
  `include_bytes!("../../tests/fixtures/fonts/...")` 로 컴파일 타임에 박아 넣는다.
  통째로 지우면 테스트가 아니라 **라이브러리가 빌드 실패**한다
- 게이트 307초의 꼬리는 **60초 이상 걸리는 3개**가 만든다 —
  `serializer::cfb_writer::tests::test_serialize_real_hwp_files`,
  `renderer::layout::table_layout::row_cut_tests::issue2214_deferred_insert_uses_scoped_cache_eviction`,
  `wasm_api::tests::issue2214_scoped_cache_coherence_preserves_transient_pagination`
- 우리 회귀는 별도로 쌓는다. 현재 자산은 위 fidelity 루프와 `rhwp-studio/tests/`
  의 embed 계열(허용목록·authoring·host-policy·protocol·toolbar)이다

### TypeScript만 바꿨다면 cargo는 불필요하다

`rhwp-studio/` 안만 변경했다면 `npx tsc --noEmit` + `npm test`(331개, 1초 미만)로
충분하다. 변경 범위를 먼저 확인한다:

```bash
git diff --name-only <base> HEAD -- '*.rs' | wc -l   # 0 이면 cargo 불필요
```

병합 커밋의 경우 **첫 부모와 대조**한다(`git diff --name-only <merge>^1 <merge> -- '*.rs'`).
양쪽 브랜치가 `.rs`를 건드리지 않았다면 병합된 트리의 Rust는 병합 전과 바이트
동일하므로, 이미 통과한 게이트를 다시 돌리는 것에 그친다.

### 빌드 산출물 배치 (필수)

```bash
cd /data/rhwp-fork
export CARGO_HOME=$PWD/.cargo-home RUSTUP_HOME=$PWD/.rustup-home   # 격리 툴체인
export PATH=$PWD/.cargo-home/bin:$PATH
export CARGO_TARGET_DIR=/data/build/cargo-target                   # fork 트리 밖
export CARGO_PROFILE_TEST_DEBUG=0                                  # 용량 주범
```

- 기본 배치로 돌리면 `target/`이 fork 트리 안에서 **59G까지** 자라 디스크를 채운다
  (2026-08-17 `/data` 95% 포화 사고). `debuginfo`를 끄면 **8.4G**로 86% 줄어든다
- **warm 캐시(`/data/build/cargo-target`)를 지우지 말 것.** 지우면 콜드 컴파일
  5분이 매번 앞에 붙는다. 위 39초·307초 측정은 warm 상태 기준이다
- 장시간 빌드 전후로 `df -h /data`를 확인한다. 여유가 15G 아래로 내려가면
  파일이 조용히 0바이트로 잘린다. 호스트 전체 정책은 `~/DISK_CAPACITY_PLAN.md`
