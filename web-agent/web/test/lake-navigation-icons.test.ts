import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Glyph } from '../src/Icons';

test('clear-lake navigation glyphs render crystalline outline and layered filled states', () => {
  for (const name of ['lakeSpecialists', 'lakeResources', 'lakeWorkspace'] as const) {
    const outline = renderToStaticMarkup(createElement(Glyph, { name, size: 22, filled: false }));
    const solid = renderToStaticMarkup(createElement(Glyph, { name, size: 22, filled: true }));

    assert.match(outline, new RegExp(`data-glyph="${name}"`));
    assert.match(outline, /aria-hidden="true"/);
    assert.match(outline, /viewBox="0 0 24 24"/);
    assert.match(outline, /stroke="currentColor"/);
    assert.match(outline, /stroke-width="1\.55"/);
    assert.ok(!outline.includes('fill-opacity="0.86"'), `${name} outline should not use solid water fill`);

    assert.match(solid, new RegExp(`data-glyph="${name}"`));
    assert.match(solid, /fill-opacity="0\.22"/);
    assert.match(solid, /fill-opacity="0\.86"/);
    assert.notEqual(outline, solid);
  }
});

test('non-navigation lakeIcons and Lucide glyphs preserve existing rendering', () => {
  const terminal = renderToStaticMarkup(createElement(Glyph, { name: 'lakeTerminal', size: 18 }));
  const search = renderToStaticMarkup(createElement(Glyph, { name: 'search', size: 15 }));

  assert.match(terminal, /data-glyph="lakeTerminal"/);
  assert.match(terminal, /stroke-width="1\.4"/);
  assert.match(search, /<svg/);
  assert.match(search, /lucide-search/);
});
