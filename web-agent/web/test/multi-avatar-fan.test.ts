import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ChatGroupAvatars} from '../src/ChatGroup';
import type {ChatGroupMember} from '../../shared/contracts';

function readSrc(file: string) {
  return readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
}

function member(index: number): ChatGroupMember {
  return {roleId: `role-${index}`, roleName: `专员 ${index}`};
}

test('ChatGroupAvatars wraps each member in a micro-backed chip and renders +N overflow beyond compact limit', () => {
  const twoHtml = renderToStaticMarkup(createElement(ChatGroupAvatars, {members: [member(1), member(2)], compact: true}));
  assert.match(twoHtml, /data-multiple="true"/);
  assert.equal((twoHtml.match(/class="chat-group-avatar-chip"/g) ?? []).length, 2);
  assert.doesNotMatch(twoHtml, /chat-group-avatar-overflow/);

  const fiveHtml = renderToStaticMarkup(
    createElement(ChatGroupAvatars, {members: [1, 2, 3, 4, 5].map(member), compact: true}),
  );
  assert.equal((fiveHtml.match(/class="chat-group-avatar-chip"/g) ?? []).length, 3);
  assert.match(fiveHtml, /class="chat-group-avatar-overflow">\+2</);

  const soloHtml = renderToStaticMarkup(createElement(ChatGroupAvatars, {members: [member(1)], compact: true}));
  assert.doesNotMatch(soloHtml, /data-multiple/);
});

test('chatGroup.css and specialistTaskList.css define micro-backed chips and 600ms Bento spring hover fan expansion', () => {
  const chatGroupCss = readSrc('chatGroup.css');
  const taskListCss = readSrc('specialistTaskList.css');

  for (const css of [chatGroupCss, taskListCss]) {
    assert.match(css, /--avatar-fan-spring:\s*linear\(0,\.0794,\.2486/);
    assert.match(css, /600ms var\(--avatar-fan-spring\)/);
    assert.match(css, /box-shadow:0 0 0 1\.5px var\(--(?:sidebar|background)\)/);
    assert.match(css, /:is\(:hover,:focus-visible\)/);
    assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  }
});
