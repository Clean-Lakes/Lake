import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {workbenchModalMotion} from '../src/WorkbenchModalDialog';

test('workbenchModalMotion matches WorkspaceConsole entrance and reverse timing', () => {
  assert.deepEqual(workbenchModalMotion, {
    duration: 180,
    easing: 'cubic-bezier(.2,.7,.2,1)',
    fill: 'both',
  });
});

test('SpecialistCreate and CreateChatGroup use WorkbenchModalDialog without stale dialog display rules', () => {
  const specialistSource = readFileSync(new URL('../src/SpecialistCreate.tsx', import.meta.url), 'utf8');
  const groupSource = readFileSync(new URL('../src/ChatGroup.tsx', import.meta.url), 'utf8');
  const specialistCss = readFileSync(new URL('../src/pilotWorkspace.css', import.meta.url), 'utf8');
  const groupCss = readFileSync(new URL('../src/chatGroup.css', import.meta.url), 'utf8');

  assert.match(specialistSource, /WorkbenchModalDialog/);
  assert.match(groupSource, /WorkbenchModalDialog/);
  assert.doesNotMatch(specialistCss, /\.specialist-create-dialog:not\(\[open\]\)/);
  assert.doesNotMatch(groupCss, /\.chat-group-create-dialog:not\(\[open\]\)/);
});
