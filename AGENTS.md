# rhwp 작업 지침

이 파일은 저장소 안에서 재현 가능한 작업 부트스트랩이다. 세부 절차는 아래 권위 문서를 우선한다.

## 문서 로딩 순서

1. `CLAUDE.md`
2. `mydocs/README.md`
3. 작업 성격에 맞는 `mydocs/manual/README.md` 또는 `mydocs/tech/README.md`
4. 개발·문서·Git 작업은 `mydocs/manual/codex/docs_and_git_workflow.md`
5. PR 검토·merge·후속 처리는 `mydocs/manual/pr_review_workflow.md`
6. 로컬 빌드·WASM 검증은 `mydocs/manual/dev_environment_guide.md`
7. CLI 작업은 `mydocs/manual/cli_commands.md`
8. 시각 검증은 `mydocs/manual/verification/visual_verification_governance.md`와 `mydocs/manual/verification/visual_sweep_guide.md`

더 구체적인 문서가 이 요약과 다르면 그 문서를 따른다.

## 공통 원칙

- 구현 전에 관련 이슈, 기존 계획·보고서·트러블슈팅을 확인한다.
- 사용자 또는 다른 도구가 만든 변경은 임의로 되돌리거나 삭제하지 않는다.
- 작업 브랜치는 최신 `upstream/devel`을 기준으로 만들고, 일반 변경은 PR로 통합한다.
- collaborator·maintainer의 예외 처리와 오늘할일·PR review 문서는 `pr_review_workflow.md`의 역할별 절차를 따른다.
- 작업 단계가 바뀌면 현재 단계의 변경을 커밋한 뒤 다음 단계 문서를 시작한다.
- GitHub comment, remote push, PR 생성은 사용자 승인을 받은 뒤 수행한다.

## 문서와 검증

- 문서 역할·생명주기·canonical 관계는 `mydocs/README.md`의 manifest를 따른다.
- 문서 이동·정보구조 리팩토링의 링크와 메타데이터 검사는
  `mydocs/manual/markdown_link_check_guide.md`를 따른다. 일반 Markdown 추가·수정에는 자동 CI를 실행하지 않는다.
- 렌더링·레이아웃 변경은 시각 검증 정책에 따라 PDF/SVG 또는 동등한 근거를 남긴다.

---

<!-- 이하 한채움(chaeumai) fork 전용. upstream 병합 시 이 섹션은 유지한다. -->

## 테스트 계층 — 무엇을 언제 돌리는가 (fork 전용)

이 저장소의 테스트는 **두 층이고 규모가 100배 다르다.** 구분하지 않으면 5분이면
끝날 검증에 한 시간을 쓴다(2026-08-17 실제 발생).

| 층 | 명령 | 규모 | 실측 |
|---|---|---:|---|
| 모듈 필터 | `cargo test --lib <모듈경로>` | 해당 모듈 | **39초** (`document_core::queries::cursor_rect` 7개) |
| **커밋·병합 게이트** | `cargo test --lib` | **2,283** | **307초** |
| upstream 회귀 핀 | `cargo test --test <이름>` | 지목한 것만 | — |
| 전체 | `cargo test --workspace` | 2,283 + 바이너리 275개 | 13분에 21/275 (**1시간+**) |

- 리포트에 나오는 **"cargo 2,283"은 `--lib` 단위 테스트**다. `tests/*.rs` 275개는
  그 위에 얹히는 별개 층이다. 이 둘을 혼동하지 말 것
- `tests/*.rs` 275개는 **전부 upstream 것**이고 그중 **239개가 `issue_*`**
  (이슈별 회귀 핀)이다. 한채움이 추가·수정한 것은 **0개**
- **`--workspace` 전체를 사람이 기다리며 돌리지 않는다.** cargo는 275개 테스트
  바이너리를 **하나씩 직렬 실행**한다(바이너리 내부만 병렬). 전체 수행은 CI 몫이다.
  `cargo-nextest`를 쓰면 전역 스레드 풀로 돌려 이 직렬 구간이 사라진다(현재 미설치)
- 게이트 307초의 꼬리는 **60초 이상 걸리는 3개**가 만든다 —
  `serializer::cfb_writer::tests::test_serialize_real_hwp_files`,
  `renderer::layout::table_layout::row_cut_tests::issue2214_deferred_insert_uses_scoped_cache_eviction`,
  `wasm_api::tests::issue2214_scoped_cache_coherence_preserves_transient_pagination`

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
