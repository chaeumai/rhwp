# 작업 기록 — task_m100_3790 Stage 5B frontend-only canary

- **이슈**: [#3790](https://github.com/edwardkim/rhwp/issues/3790)
- **브랜치**: `issue-3790-stage5b-codeql-canary`
- **worktree**: `tmp/issue-3790-stage5b-canary`
- **기준**: `upstream/devel` `c64b5c70a700` (#4519 merge)
- **상태**: canary 변경·focused 검증 완료, 원격 PR 생성 승인 대기

## 목적과 종료 조건

Stage 5B가 활성화된 첫 frontend-only PR에서 CodeQL 언어 선택 진리표와 절감량을 실측한다. 이 PR은 제품
반영 대상이 아닌 measurement-only canary다. selective/full 결과를 같은 head SHA에서 확보해 #3790과
canary PR에 기록한 뒤 merge하지 않고 close한다.

## 변경 형태

- Stage 3 PR #3951과 Stage 4 PR #4078이 사용한 것과 같은
  `rhwp-studio/src/command/shortcut-map.ts` + `rhwp-studio/tests/shortcut-map.test.ts` 변경을 재사용한다.
- 단축키 정의와 mapping entry를 TypeScript 읽기 전용 계약으로 좁히고, 개체 속성 `P` 단축키의
  영문·한글·IME pending 입력 회귀를 추가한다.
- 계획·오늘할일·이 작업 기록은 `mydocs/**` review-only 경로다. 이번 측정의 주 대조군은 과거 canary가
  아니라 같은 새 head SHA의 manual full run이므로 문서 동반 여부가 CodeQL 절감량 해석을 바꾸지 않는다.

## classifier v2 기대값

| 출력 | 기대값 |
| --- | --- |
| `classification_status` | `classified` |
| `classifier_version` | `2` |
| `frontend_mode` | `unit` |
| `render_required` | `false` |
| `rust_required` | `false` |
| `native_skia_required` | `false` |
| `codeql_languages` | `javascript-typescript` |
| `reason` | `classified:studio-unit` |

## 원격 selective/full 진리표

일반 PR run에서는 Frontend unit과 JavaScript/TypeScript CodeQL만 실제 실행한다. Frontend package,
Canvas visual diff, Rust lint·세 builder·네 worker와 Native Skia는 skip되어야 한다. Python·Rust
`Analyze (...)` job은 check identity를 유지하되 실제 checkout·init·analysis 없이 no-op success여야 하며,
`Build & Test`와 GHAS `CodeQL`은 success여야 한다.

같은 head SHA에서 CI·CodeQL·Render Diff를 `workflow_dispatch`하면 full 경로가 되어 package·Canvas·Rust·
Native Skia와 세 CodeQL 언어를 실제 실행해야 한다. 두 실행의 job duration 합계와 workflow wall time을
비교해 Stage 5B CodeQL 절감량과 Stage 3~5 전체 최종 절감량을 분리해 기록한다.

## focused 검증 결과

- `node --test rhwp-studio/tests/shortcut-map.test.ts` — 7/7 통과.
- `npx --prefix rhwp-studio tsc --project rhwp-studio/tsconfig.ci-unit.json --noEmit` — 통과.
- `npm --prefix rhwp-studio test` — 837건 중 836 pass, 정책 skip 1, fail 0.
- 실제 변경 6개 파일 목록으로 `node scripts/ci-impact-classifier.cjs --input <canary-file-list.json>`을
  실행해 classifier v2 기대값 전체가 일치했다.
- `git diff --check` — 통과.

새 worktree의 `npm --prefix rhwp-studio ci`는 lockfile 기준 설치를 완료했으며 audit는 기존 의존성의
low 1건·high 3건을 보고했다. manifest·lockfile 변경은 없고 측정 canary 범위가 아니므로 자동 수정하지
않는다.

Rust·WASM·renderer·fixture를 바꾸지 않으므로 Cargo, wasm-pack과 시각 검증은 적용하지 않는다.
