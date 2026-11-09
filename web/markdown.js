/* ═══════════════════════════════════════════════════════════════
   Markdown renderer (streaming-friendly, no dependencies)

   Hermes answers are almost always markdown (headings, lists, tables,
   code blocks, bold). Setting them via textContent showed raw `## Heading`
   and `**bold**` to the user.

   Constraints:
   1. No external libraries — the page must load instantly on restricted
      networks and there is no build step.
   2. Must tolerate half-written input: while streaming the last line is
      often `## Hea`, or a ``` fence is still unmatched. Partial input must
      still be displayed — never swallow content.
   3. Safety: escape all text first, then assemble HTML from the markdown
      structure. No raw HTML ever passes through (answers may contain <script>).
   ═══════════════════════════════════════════════════════════════ */

const MD_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function mdEsc(s) {
  return String(s).replace(/[&<>"']/g, (c) => MD_ESC[c]);
}

/* Inline: escape first, then handle `code`, **bold**, *italic*, ~~strike~~, links.
   Order matters: code is stashed first so its * is not treated as emphasis. */
function mdInline(src) {
  let out = mdEsc(src);

  // Inline code (any run of backticks, shortest match)
  const codes = [];
  out = out.replace(/(`+)([\s\S]*?)\1/g, (m, tick, body) => {
    /* Store the raw (already escaped) text and then escape it again on restore.
       Previously this trimmed into codes and restored with another mdEsc, which
       re-escaped an existing &lt; into &amp;lt; — showing the entity literally. */
    codes.push(body.trim());
    return '\u0000C' + (codes.length - 1) + '\u0000';
  });

  // Links [text](url) — allow only http/https/relative, block javascript:
  // One level of nested parens is allowed (common in wiki links) so ) isn't eaten
  out = out.replace(/\[([^\]\n]+)\]\(((?:[^()\n]|\([^()\n]*\))*)\)/g, (m, text, href) => {
    const safe = /^(https?:\/\/|\/|#|\.\/)/i.test(href.trim()) ? href.trim() : '#';
    return '<a href="' + mdEsc(safe) + '" target="_blank" rel="noopener noreferrer">' + text + '</a>';
  });

  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  // Single-asterisk italic: no spaces on either side, so `a * b * c` isn't matched
  out = out.replace(/(^|[\s(])\*([^*\s][^*\n]*?)\*(?=[\s).,，。；;!?！？]|$)/g, '$1<em>$2</em>');

  // Restore inline code.
  // codes already holds escaped text (out was mdEsc'd up front); escaping
  // again here would produce &amp;lt; and display the literal &lt;. Do not mdEsc here.
  out = out.replace(/\u0000C(\d+)\u0000/g, (m, i) => '<code>' + codes[+i] + '</code>');
  return out;
}

/* Tables: a | a | b | row followed by a | --- | --- | separator row */
function mdTable(lines, start) {
  const head = lines[start];
  const sep = lines[start + 1];
  if (!sep || !/^\s*\|?[\s:-]*-{2,}[\s:|-]*$/.test(sep)) return null;
  const split = (row) => row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
  const cols = split(head).length;
  if (split(sep).length !== cols) return null;

  let html = '<div class="md-table-wrap"><table><thead><tr>';
  split(head).forEach((c) => { html += '<th>' + mdInline(c) + '</th>'; });
  html += '</tr></thead><tbody>';

  let i = start + 2;
  while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) {
    html += '<tr>';
    split(lines[i]).forEach((c) => { html += '<td>' + mdInline(c) + '</td>'; });
    html += '</tr>';
    i += 1;
  }
  html += '</tbody></table></div>';
  return { html, next: i };
}

function renderMarkdown(src) {
  const text = String(src || '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code fence: ``` or ~~~; if unclosed (streaming) emit it as a code block to EOF
    const fence = line.match(/^\s*(`{3,}|~{3,})\s*([\w+-]*)\s*$/);
    if (fence) {
      const mark = fence[1][0].repeat(3);
      const lang = fence[2] || '';
      const body = [];
      i += 1;
      while (i < lines.length && !new RegExp('^\\s*' + mark + '\\s*$').test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1;   // skip closing fence (naturally reaches EOF when unclosed)
      out.push(
        '<div class="md-code"' + (lang ? ' data-lang="' + mdEsc(lang) + '"' : '') + '>'
        + '<pre><code>' + mdEsc(body.join('\n')) + '</code></pre></div>'
      );
      continue;
    }

    // Blank line
    if (!line.trim()) { i += 1; continue; }

    // Headings: up to ######, so h1 doesn't blow up the bubble
    const h = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
    if (h) {
      const lv = Math.min(6, Math.max(3, h[1].length + 1));   // # renders as h2, ### renders as h4
      out.push('<h' + lv + '>' + mdInline(h[2].replace(/\s+#+\s*$/, '')) + '</h' + lv + '>');
      i += 1;
      continue;
    }

    // Horizontal rule
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push('<hr>');
      i += 1;
      continue;
    }

    // Table
    if (/\|/.test(line)) {
      const tbl = mdTable(lines, i);
      if (tbl) { out.push(tbl.html); i = tbl.next; continue; }
    }

    // Blockquote
    if (/^\s{0,3}>/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) {
        body.push(lines[i].replace(/^\s{0,3}>\s?/, ''));
        i += 1;
      }
      out.push('<blockquote>' + renderMarkdown(body.join('\n')) + '</blockquote>');
      continue;
    }

    // Lists: - / * / + unordered, 1. 2) ordered
    const ulRe = /^(\s*)([-*+])\s+(.*)$/;
    const olRe = /^(\s*)(\d{1,3})[.)]\s+(.*)$/;
    if (ulRe.test(line) || olRe.test(line)) {
      const ordered = olRe.test(line);
      const re = ordered ? olRe : ulRe;
      const baseIndent = line.match(re)[1].length;
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(re);
        if (!m) break;
        // Only same-level lines start a new item; deeper indents merge into the previous one (simplified, good enough)
        if (m[1].length > baseIndent + 1 && items.length) {
          items[items.length - 1] += '\n' + m[3];
          i += 1;
          continue;
        }
        if (m[1].length < baseIndent) break;
        items.push(m[3]);
        i += 1;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push('<' + tag + '>' + items.map((it) => '<li>' + mdInline(it) + '</li>').join('') + '</' + tag + '>');
      continue;
    }

    // Paragraph: merge consecutive non-blank lines, keeping soft line breaks
    const para = [];
    while (i < lines.length && lines[i].trim()
           && !/^\s*```/.test(lines[i]) && !/^\s*#{1,6}\s/.test(lines[i])
           && !/^\s{0,3}>/.test(lines[i]) && !ulRe.test(lines[i]) && !olRe.test(lines[i])
           && !/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(lines[i])) {
      para.push(lines[i]);
      i += 1;
    }
    out.push('<p>' + mdInline(para.join('\n')) + '</p>');
  }

  return out.join('');
}

window.__md = renderMarkdown;
