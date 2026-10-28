// A small, safe markdown renderer for chat replies and boards.
// Everything is HTML-escaped first, so agent text can never inject markup. No links, no images, no raw HTML.

const escapeHtml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Inline: `code`, **bold**, *italic*. Input is raw text. */
export function renderInline(raw) {
  const codes = [];
  let out = escapeHtml(raw.replace(/\u0000/g, ""));
  out = out.replace(/`([^`\n]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  out = out.replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?![*\w])/g, "$1<em>$2</em>");
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
}

const FENCE = /^\s*```/;
const HEADING = /^(#{1,4})\s+(.*)$/;
const BULLET = /^\s*[-*]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const TABLE_ROW = /^\s*\|.*\|?\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function splitRow(line) {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  return t.split("|").map((c) => c.trim());
}

const startsBlock = (line, next) =>
  FENCE.test(line) ||
  HEADING.test(line) ||
  BULLET.test(line) ||
  NUMBERED.test(line) ||
  (TABLE_ROW.test(line) && next !== undefined && TABLE_SEP.test(next));

/**
 * @param {string} text
 * @param {{ headingBase?: number, listItem?: (raw: string) => string | null }} [options]
 *   headingBase: the h-level that "#" becomes (chat uses 3 so replies sit under the page title).
 *   listItem: return HTML for a list item to render it specially, or null for the default.
 */
export function renderMarkdown(text, options = {}) {
  const base = options.headingBase ?? 3;
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  const html = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i++;
      continue;
    }

    if (FENCE.test(line)) {
      const body = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i])) body.push(lines[i++]);
      i++; // closing fence (or end of text)
      html.push(`<pre><code>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }

    const h = HEADING.exec(line);
    if (h) {
      const level = Math.min(h[1].length + base - 1, 6);
      html.push(`<h${level}>${renderInline(h[2])}</h${level}>`);
      i++;
      continue;
    }

    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && TABLE_ROW.test(lines[i]) && lines[i].trim() !== "") rows.push(splitRow(lines[i++]));
      const th = head.map((c) => `<th>${renderInline(c)}</th>`).join("");
      const tr = rows
        .map((r) => `<tr>${head.map((_, k) => `<td>${renderInline(r[k] ?? "")}</td>`).join("")}</tr>`)
        .join("");
      html.push(`<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`);
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (bullet || numbered) {
      const re = bullet ? BULLET : NUMBERED;
      const items = [];
      while (i < lines.length) {
        const m = re.exec(lines[i]);
        if (!m) break;
        const special = options.listItem ? options.listItem(m[1]) : null;
        items.push(special ?? `<li>${renderInline(m[1])}</li>`);
        i++;
      }
      html.push(`<${bullet ? "ul" : "ol"}>${items.join("")}</${bullet ? "ul" : "ol"}>`);
      continue;
    }

    const para = [];
    while (i < lines.length && lines[i].trim() !== "" && !startsBlock(lines[i], lines[i + 1])) para.push(lines[i++]);
    if (para.length === 0) para.push(lines[i++]); // safety: never loop forever
    html.push(`<p>${para.map(renderInline).join("<br>")}</p>`);
  }

  return html.join("\n");
}

const ITEM = /^([A-Z][A-Z0-9]*-\d+)\s+\[(proposed|active|done|dropped)\]\s+(.*)$/;

/** Boards: goal lines ("PI-1 [active] Title | owner: x") become rows with a status mark. */
export function renderBoard(text) {
  return renderMarkdown(text, {
    headingBase: 2,
    listItem(raw) {
      const m = ITEM.exec(raw);
      if (!m) return null;
      const [, id, status, rest] = m;
      const [title, ...extras] = rest.split(" | ");
      const fields = extras
        .map((e) => {
          const k = e.indexOf(":");
          return k > 0 ? `<span class="field"><b>${renderInline(e.slice(0, k).trim())}</b> ${renderInline(e.slice(k + 1).trim())}</span>` : "";
        })
        .join("");
      return (
        `<li class="item" data-status="${status}"><span class="mark" aria-hidden="true"></span>` +
        `<span class="item-main"><span class="item-id">${id}</span> <span class="item-title">${renderInline(title.trim())}</span>` +
        `<span class="item-status">${status}</span>${fields ? `<span class="fields">${fields}</span>` : ""}</span></li>`
      );
    },
  });
}
