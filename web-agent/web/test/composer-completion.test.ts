import assert from 'node:assert/strict';
import {test} from 'node:test';
import {completableDraft,completionSuffix} from '../../shared/draftCompletion';
import {localComposerCompletion} from '../src/composerCompletion';

test('an empty composer offers a starter or a follow-up without any model request', () => {
  assert.equal(localComposerCompletion('', false), '帮我检查服务运行状态。');
  assert.equal(localComposerCompletion('', true), '请对照上次结果，看看现在有没有变化。');
  assert.equal(localComposerCompletion('帮我检查', true), '服务运行状态。');
  assert.equal(localComposerCompletion('检查样例服务的', true), '');
});

test('draft completions accept short prose and exclude references, commands and credential text', () => {
  for (const text of ['帮', '请核对 ', '请先检查\n再确认']) assert.ok(completableDraft(text), text);
  for (const text of ['', ' ', '已经查完。', '/plan 检查', '@服务', '检查\ufffc', '再核对\n', 'api_key: synthetic',
    '{"password":"synthetic"}', '访问令牌：synthetic', 'Bearer synthetic', '-----BEGIN PRIVATE KEY-----', 'a'.repeat(2001)])
    assert.equal(completableDraft(text), false, text);
});

test('a suggested suffix is a short single line with its original spacing', () => {
  assert.ok(completionSuffix(' status and report the result.'));
  for (const suffix of ['', ' ', '多行\n内容', '@服务', '[REDACTED]', 'a'.repeat(121), null])
    assert.equal(completionSuffix(suffix), false);
});
