// Escaping used by every string-built view. Both functions guard against
// injection, so they get direct coverage.

import { test } from 'node:test';
import assert from 'node:assert';
import { esc, imgCss } from '../js/html.js';

test('esc neutralizes the HTML metacharacters', () => {
  assert.strictEqual(esc('<script>alert(1)</script>'),
    '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.strictEqual(esc(`a"b'c&d`), 'a&quot;b&#39;c&amp;d');
});

test('esc renders null and undefined as empty, not as words', () => {
  assert.strictEqual(esc(null), '');
  assert.strictEqual(esc(undefined), '');
  assert.strictEqual(esc(0), '0');
});

test('imgCss passes an ordinary poster URL through', () => {
  assert.strictEqual(imgCss('https://static.tvmaze.com/uploads/images/medium/1/2.jpg'),
    "background-image:url('https://static.tvmaze.com/uploads/images/medium/1/2.jpg')");
});

test('imgCss rejects anything that is not http(s)', () => {
  for (const bad of ['javascript:alert(1)', 'data:image/svg+xml,<svg/>', 'file:///etc/passwd', '', null]) {
    assert.strictEqual(imgCss(bad), '', `should reject ${bad}`);
  }
});

// Regression: the escape was `url.replace(/[\\'"()\s]/g, encodeURIComponent)`,
// but encodeURIComponent leaves ' ( ) untouched — the exact characters needed to
// close the url('…') wrapper and append arbitrary CSS declarations.
test('imgCss cannot be used to break out of url(...) and inject CSS', () => {
  const attack = "https://evil.test/a');color:red;background:url('x";
  const out = imgCss(attack);
  assert.ok(!out.includes("');"), `single quote escaped through: ${out}`);
  assert.ok(!/[()]/.test(out.slice("background-image:url('".length, -2)),
    `parens escaped through: ${out}`);
  assert.strictEqual(out,
    "background-image:url('https://evil.test/a%27%29;color:red;background:url%28%27x')");
});

test('imgCss escapes quotes, backslashes and whitespace', () => {
  assert.strictEqual(imgCss('https://x.test/a b'), "background-image:url('https://x.test/a%20b')");
  assert.strictEqual(imgCss('https://x.test/a"b'), "background-image:url('https://x.test/a%22b')");
  assert.strictEqual(imgCss('https://x.test/a\\b'), "background-image:url('https://x.test/a%5Cb')");
  assert.ok(!/\n/.test(imgCss('https://x.test/a\nb')));
});
