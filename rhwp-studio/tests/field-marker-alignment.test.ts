import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(
  new URL('../src/engine/field-marker-renderer.ts', import.meta.url),
  'utf8',
);

test('누름틀 시작 낫표의 오른쪽 끝을 필드 시작 경계에 맞춘다', () => {
  assert.match(
    source,
    /this\.startEl\.style\.transform = 'translateX\(-100%\)'/,
  );
  assert.doesNotMatch(
    source,
    /this\.endEl\.style\.transform = 'translateX\(-100%\)'/,
    '끝 낫표는 필드 끝 경계 오른쪽에 그대로 둔다',
  );
});
