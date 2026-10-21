import assert from 'node:assert/strict';
import test from 'node:test';
import {clearSubmittedDraft, sessionDraft, updateSessionDraft, type SessionDrafts} from '../src/sessionComposerDrafts';
import {composerMessage} from '../src/composerMentionState';

test('switching sessions retains independent text, atomic references and attachments', () => {
  let drafts: SessionDrafts = new Map();
  drafts = updateSessionDraft(drafts, 'a', 'message', '检查 \ufffc 的负载');
  const reference = {kind: 'resource' as const, resourceId: 'host', label: '测试节点', position: 3};
  drafts = updateSessionDraft(drafts, 'a', 'references', [reference]);
  drafts = updateSessionDraft(drafts, 'a', 'images', [{id: 'image', name: 'test.png', mimeType: 'image/png', base64: 'fixture', sizeBytes: 7, width: 1, height: 1}]);
  drafts = updateSessionDraft(drafts, 'a', 'files', [{sourceId: 'file', name: 'test.txt', sizeBytes: 4}]);
  drafts = updateSessionDraft(drafts, 'a', 'ignoreProjectMemory', true);
  const a = sessionDraft(drafts, 'a');
  assert.equal(sessionDraft(drafts, 'b').message, '');
  drafts = updateSessionDraft(drafts, 'b', 'message', '独立草稿');
  assert.equal(sessionDraft(drafts, 'a'), a);
  assert.deepEqual(sessionDraft(drafts, 'a').references, [reference]);
  assert.equal(sessionDraft(drafts, 'a').images.length, 1);
  assert.equal(sessionDraft(drafts, 'a').files.length, 1);
  assert.equal(sessionDraft(drafts, 'a').ignoreProjectMemory, true);
  assert.equal(sessionDraft(drafts, 'b').message, '独立草稿');
  assert.equal(sessionDraft(drafts, 'b').references.length, 0);
  assert.deepEqual(composerMessage(a.message, a.references, ['host']).resourceIds, ['host']);
});

test('send completion clears its submitted session after switching, preserving newer edits', () => {
  let drafts = updateSessionDraft(new Map(), 'a', 'message', '已提交的内容');
  const submitted = sessionDraft(drafts, 'a');
  drafts = updateSessionDraft(drafts, 'b', 'message', '另一会话尚未发送');
  const cleared = clearSubmittedDraft(drafts, 'a', submitted);
  assert.equal(sessionDraft(cleared, 'a').message, '');
  assert.equal(sessionDraft(cleared, 'b').message, '另一会话尚未发送');
  drafts = updateSessionDraft(drafts, 'a', 'message', previous => previous + '；继续编辑');
  assert.equal(clearSubmittedDraft(drafts, 'a', submitted), drafts);
  assert.equal(sessionDraft(drafts, 'a').message, '已提交的内容；继续编辑');
});
