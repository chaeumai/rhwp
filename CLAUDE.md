# CLAUDE.md

**먼저 [`AGENTS.md`](AGENTS.md)를 읽어라.** 이 저장소의 작업 계약·테스트 계층·
빌드 배치는 전부 거기 있다. 이 파일은 그리로 보내는 포인터이며, 절차를 여기
중복 기록하지 않는다.

이 저장소는 `edwardkim/rhwp`(MIT)에서 갈라진 **독립 fork**다. upstream 과
병합하지 않는다.

## 프로젝트 개요

rhwp는 Rust로 HWP/HWPX/HWP3 문서를 읽고 편집·렌더링하며, WebAssembly로
브라우저에서도 동작하는 문서 엔진이다. 모든 포맷 파서는 공통 `Document` IR을
반환한다. 브라우저 UI는 `rhwp-studio/`(TypeScript)다.

한채움 제품은 이 엔진을 **별도 origin(`editor.hdev.kr`)에 배포하고 iframe
postMessage RPC로** 사용한다. 소스를 가져다 번들하지 않는다.

## upstream 참고 자료

`mydocs/` 는 upstream 이 남긴 문서다. **기술적 사실**(파서 구조, 포맷 지식,
UI 명칭 규칙)은 유효하지만 **절차**(PR 검토, collaborator 역할,
`upstream/devel` 기준 브랜치)는 이 fork 에 적용되지 않는다.

- 파서 책임과 공통 IR 경계: `mydocs/tech/parser_architecture.md`
  (HWP3 전용 해석은 `src/parser/hwp3/` 안에서 끝내고 렌더러·레이아웃·문서
  코어에 HWP3 전용 분기를 만들지 않는다)
- rhwp-studio UI 명칭·CSS 접두어: `mydocs/manual/rhwp_studio_ui_conventions.md`
