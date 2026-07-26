// HTML/CSS escaping for the string-built markup the views render.
// Lives in its own module so it can be unit-tested outside the browser — both
// of these guard against injection and were previously duplicated in app.js and
// import.js, untested.

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Escape a URL for use inside style="...url('…')".
// NB: encodeURIComponent cannot do this job — it leaves ' ( ) untouched, which
// are precisely the characters that break out of the url('…') wrapper and let a
// crafted poster URL append its own CSS declarations.
const CSS_URL_ESCAPE = { '\\': '%5C', "'": '%27', '"': '%22', '(': '%28', ')': '%29' };

export const imgCss = (url) => {
  if (!url || !/^https?:\/\//i.test(url)) return '';   // http(s) images only
  const safe = url.replace(/[\\'"()\s]/g, c => CSS_URL_ESCAPE[c] || encodeURIComponent(c));
  return `background-image:url('${safe}')`;
};
