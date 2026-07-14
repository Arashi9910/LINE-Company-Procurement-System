import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('variant sheet keeps long mobile product names inside the viewport', async () => {
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');

  assert.match(css, /\.variant-sheet\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;/s);
  assert.match(css, /\.variant-items\s*\{[^}]*overflow-x:\s*hidden;/s);
  assert.match(css, /\.variant-header h2\s*\{[^}]*overflow-wrap:\s*anywhere;[^}]*white-space:\s*normal;/s);
});

test('variant sheet keeps the footer visible when the variant list is long', async () => {
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');

  assert.match(css, /\.variant-sheet\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*max-height:\s*88dvh;/s);
  assert.match(css, /\.variant-items\s*\{[^}]*flex:\s*1 1 auto;[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/s);
  assert.match(css, /\.variant-header,\s*\.inline-notice,\s*\.variant-footer\s*\{[^}]*flex:\s*0 0 auto;/s);
});

