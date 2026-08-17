/**
 * 한채움 fork: 사용자 직접 입력 잠금.
 *
 * AI 가 문서를 읽고 쓰는 동안 사용자가 타이핑하면, AI 가 잡아 둔 좌표
 * (문단 순번·셀 인덱스·글자 오프셋)가 밀린다. 그러면 뒤이은 편집 묶음이
 * expectedText 검증에서 전부 실패한다 — 오적용은 막지만 작업은 무산된다.
 *
 * 명령 허용 목록(host-policy)만으로는 이걸 막을 수 없다. 직접 타이핑·삭제·
 * 붙여넣기·IME 조합은 command dispatcher 를 거치지 않고 textarea 이벤트로
 * 곧장 들어오기 때문이다. 그래서 입력 경로 자체에 게이트가 필요하다.
 *
 * 잠금 중 입력은 **무시**한다. 오류를 띄우지 않는 이유는 이것이 사용자의
 * 잘못이 아니라 타이밍이기 때문이다. 상태 표시는 호스트 UI 의 몫이다.
 */

let locked = false;

export function setEmbedInputLocked(value: boolean): boolean {
  locked = value;
  return locked;
}

export function isEmbedInputLocked(): boolean {
  return locked;
}
