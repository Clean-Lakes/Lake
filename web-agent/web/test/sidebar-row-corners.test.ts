import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

function readSrc(file: string) {
  return readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
}

test('Lake and chat group sidebar rows share the macOS window corner contour', () => {
  const windowCorners = readSrc('windowCorners.css');
  const pilotWorkspace = readSrc('pilotWorkspace.css');
  const chatGroup = readSrc('chatGroup.css');

  assert.match(pilotWorkspace, /\.sidebar\.workspace-navigation \.pilot-workspace \.nav-row\s*\{[\s\S]*?border-radius:var\(--radius-window\);\s*corner-shape:var\(--corner-window\);/);
  assert.match(chatGroup, /\.sidebar\.workspace-navigation \.chat-group-nav-row\s*\{[\s\S]*?border-radius:var\(--radius-window\);\s*corner-shape:var\(--corner-window\);/);

  assert.doesNotMatch(windowCorners, /\.pilot-workspace \.nav-row\s*\{\s*--window-corner-radius:var\(--radius-settings-control\)/);
  assert.equal((windowCorners.match(/\.sidebar\.workspace-navigation \.pilot-workspace \.nav-row/g) ?? []).length, 3);
  assert.equal((windowCorners.match(/\.sidebar\.workspace-navigation \.chat-group-nav-row/g) ?? []).length, 3);
});
