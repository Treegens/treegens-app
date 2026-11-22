// A web page (HTML) is never handed to the converter as it was uploaded (src/server/convert.ts).
//
// LibreOffice's HTML import loads what a page names: <body background="/some/file.png"> or a style sheet's url(...)
// can pull a picture from the converter's own disk, or from another server, into the PDF. So before a page is
// converted, everything in it that names something outside the page is taken out: only pictures carried inside the
// page itself (data: addresses) stay, and links a reader can click (http, https, mailto) stay as links. What was
// taken out is counted, so the sender is told the PDF does not hold it.
//
// It works on the bytes as Latin-1, so every byte of the text survives whatever the page's encoding is; a page that
// declares an encoding in which "<" could be spelled another way (UTF-7, ISO-2022 and the like) loses that
// declaration and is read as plain bytes.

const VOID_OUT = new Set(['link', 'base', 'frame', 'embed', 'source', 'track', 'bgsound', 'param']);
// Taken out with everything between the opening and the closing tag.
const BLOCK_OUT = new Set(['script', 'iframe', 'object', 'applet', 'frameset', 'noframes', 'video', 'audio', 'svg', 'math', 'template', 'xml']);
const URL_ATTRS = new Set(['src', 'href', 'background', 'data', 'srcset', 'poster', 'lowsrc', 'dynsrc', 'action', 'formaction', 'codebase', 'code', 'classid', 'archive', 'usemap', 'cite', 'longdesc', 'manifest', 'profile', 'icon', 'xlink:href', 'ping', 'imagesrcset']);
const TEXT_ATTRS = new Set(['alt', 'title', 'value', 'content', 'name', 'id', 'class', 'style', 'summary', 'abbr', 'label', 'placeholder', 'lang', 'dir', 'align', 'valign', 'width', 'height', 'size', 'color', 'bgcolor', 'face', 'border', 'cellpadding', 'cellspacing', 'colspan', 'rowspan', 'type', 'start', 'charset', 'http-equiv', 'rel', 'target']);
const SAFE_CHARSET = /^(utf-?8|us-ascii|ascii|iso-?8859-\d+|latin-?\d|windows-125\d|cp125\d|koi8-[ru]|shift[_-]jis|euc-(jp|kr)|gbk|gb2312|gb18030|big5)$/i;

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", colon: ':', sol: '/', bsol: '\\', period: '.', tab: '\t', newline: '\n', nbsp: ' ', lpar: '(', rpar: ')' };

/** An attribute value as a parser would read it: entities resolved, then spaces and control characters removed. */
function plain(v: string): string {
  const once = (s: string) => s.replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+));?/gi, (m, hex, dec, name) => {
    if (hex || dec) {
      const n = parseInt(hex || dec, hex ? 16 : 10);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
    }
    return NAMED[String(name).toLowerCase()] ?? m;
  });
  // eslint-disable-next-line no-control-regex
  return once(once(v)).replace(/[\x00-\x20\x7f-\xa0]+/g, '');
}

const INLINE_PICTURE = /^data:image\/(png|jpe?g|gif|bmp);base64,[a-z0-9+/=]*$/i;
const CLICKABLE = /^(https?:\/\/|mailto:|#)/i;
// Anything that reads like an address or a path: a scheme, a slash or backslash at the start, ./ ../ or ~.
const LOOKS_LIKE_ADDRESS = /^([a-z][a-z0-9+.-]*:|[/\\]|\.{1,2}[/\\]|~)/i;

/** A style sheet or a style attribute with every address taken out. */
function safeCss(css: string, count: () => void): string {
  // Escapes and comments can hide the word "url", so neither survives.
  let s = css.replace(/\/\*[\s\S]*?(\*\/|$)/g, '').replace(/\\/g, '');
  s = s.replace(/@import[^;{}]*;?/gi, () => (count(), ''));
  s = s.replace(/@(font-face|namespace|document)\b[^{}]*(\{[^{}]*\})?/gi, () => (count(), ''));
  s = s.replace(/\b(url|image-set|-webkit-image-set|image|cross-fade|element|src)\s*\(\s*(["']?)([^)"']*)\2\s*\)?/gi, (m, fn, _q, target) => {
    if (String(fn).toLowerCase() === 'url' && INLINE_PICTURE.test(plain(String(target)))) return m;
    count();
    return 'none';
  });
  // A bare "url" that the pattern above did not close is not left for a forgiving parser to finish.
  return s.replace(/\burl\s*\((?!\s*["']?data:image\/)/gi, () => (count(), 'none('));
}

type Attr = { name: string; value: string | null };

/** Reads one tag starting at `<`: its name, attributes and where it ends. Null when this `<` does not start a tag. */
function readTag(s: string, at: number): { end: number; name: string; closing: boolean; attrs: Attr[]; selfClosing: boolean } | null {
  let i = at + 1;
  const closing = s[i] === '/';
  if (closing) i++;
  const nm = /^[a-zA-Z][^\s/>]*/.exec(s.slice(i, i + 64));
  if (!nm) return null;
  i += nm[0].length;
  const attrs: Attr[] = [];
  let selfClosing = false;
  for (;;) {
    while (i < s.length && /[\s/]/.test(s[i])) { selfClosing = s[i] === '/'; i++; }
    if (i >= s.length) return { end: s.length, name: nm[0].toLowerCase(), closing, attrs, selfClosing };
    if (s[i] === '>') return { end: i + 1, name: nm[0].toLowerCase(), closing, attrs, selfClosing };
    selfClosing = false;
    let j = i;
    while (j < s.length && !/[\s=>/]/.test(s[j])) j++;
    if (j === i) { i++; continue; } // a stray "=": skipped
    const name = s.slice(i, j).toLowerCase();
    i = j;
    while (i < s.length && /\s/.test(s[i])) i++;
    let value: string | null = null;
    if (s[i] === '=') {
      i++;
      while (i < s.length && /\s/.test(s[i])) i++;
      if (s[i] === '"' || s[i] === "'") {
        const close = s.indexOf(s[i], i + 1);
        value = s.slice(i + 1, close < 0 ? s.length : close);
        i = close < 0 ? s.length : close + 1;
      } else {
        j = i;
        while (j < s.length && !/[\s>]/.test(s[j])) j++;
        value = s.slice(i, j);
        i = j;
      }
    }
    attrs.push({ name, value });
  }
}

const esc = (v: string) => v.replace(/&(?![a-z#])/gi, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The page with everything that names something outside it taken out. `removed` counts what was. */
export function safeHtml(input: string): { html: string; removed: number } {
  let removed = 0;
  const count = () => void removed++;
  let out = '';
  let i = 0;
  const s = input;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt < 0) { out += s.slice(i); break; }
    out += s.slice(i, lt);
    // Comments, processing instructions and declarations: none of them is text a reader sees.
    if (s.startsWith('<!--', lt)) { const e = s.indexOf('-->', lt + 4); i = e < 0 ? s.length : e + 3; continue; }
    if (s[lt + 1] === '?' || s[lt + 1] === '!') {
      const e = s.indexOf('>', lt);
      if (/^<!doctype\s+html/i.test(s.slice(lt, lt + 20))) out += '<!DOCTYPE html>';
      i = e < 0 ? s.length : e + 1;
      continue;
    }
    const tag = readTag(s, lt);
    if (!tag) { out += '&lt;'; i = lt + 1; continue; }
    i = tag.end;
    const name = tag.name;
    if (BLOCK_OUT.has(name)) {
      if (!tag.closing && !tag.selfClosing) {
        const close = new RegExp(`</${name.replace(/[^a-z0-9]/g, '')}[\\s>/]`, 'i').exec(s.slice(i));
        i = close ? i + close.index : s.length;
        const e = close ? s.indexOf('>', i) : -1;
        i = close ? (e < 0 ? s.length : e + 1) : s.length;
      }
      if (name !== 'script' && name !== 'template' && name !== 'noframes') count();
      continue;
    }
    if (VOID_OUT.has(name)) { if (!tag.closing) count(); continue; }
    if (tag.closing) { out += `</${name.replace(/[^a-z0-9:-]/g, '')}>`; continue; }
    if (name === 'style') {
      const close = /<\/style[\s>/]/i.exec(s.slice(i));
      const body = s.slice(i, close ? i + close.index : s.length);
      const e = close ? s.indexOf('>', i + close.index) : -1;
      i = close ? (e < 0 ? s.length : e + 1) : s.length;
      out += `<style>${safeCss(body, count).replace(/</g, '')}</style>`;
      continue;
    }
    if (name === 'meta') {
      const a = (n: string) => plain(tag.attrs.find((x) => x.name === n)?.value || '');
      const equiv = a('http-equiv').toLowerCase();
      const charset = a('charset') || (/charset=([^;]+)/i.exec(a('content'))?.[1] ?? '');
      if (equiv && equiv !== 'content-type') continue; // a refresh, a cookie, a policy: none belongs in a document
      if (charset && !SAFE_CHARSET.test(charset)) continue;
    }
    const kept: string[] = [];
    for (const { name: an, value } of tag.attrs) {
      if (!/^[a-z][a-z0-9:_.-]*$/.test(an) || an.startsWith('on')) continue;
      if (value === null) { kept.push(an); continue; }
      const v = plain(value);
      if (an === 'style') { kept.push(`style="${esc(safeCss(value.replace(/&(?:#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (m) => plain(m) || ' '), count))}"`); continue; }
      if (URL_ATTRS.has(an)) {
        const ok = an === 'src' && name === 'img' ? INLINE_PICTURE.test(v) : an === 'href' && (name === 'a' || name === 'area') ? CLICKABLE.test(v) : false;
        if (!ok) { if (v) count(); continue; }
      } else if (!TEXT_ATTRS.has(an) && LOOKS_LIKE_ADDRESS.test(v)) { count(); continue; }
      kept.push(`${an}="${esc(value)}"`);
    }
    out += `<${name.replace(/[^a-z0-9:-]/g, '')}${kept.length ? ` ${kept.join(' ')}` : ''}>`;
  }
  return { html: out, removed };
}

/** The same for the bytes of an upload: every byte of the text is kept as it is. */
export function safeHtmlBytes(b: Uint8Array): { bytes: Uint8Array; removed: number } {
  const r = safeHtml(Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('latin1'));
  return { bytes: new Uint8Array(Buffer.from(r.html, 'latin1')), removed: r.removed };
}
