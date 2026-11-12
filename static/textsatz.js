// Textsatz und Suche – reine Funktionen ohne Browser-Abhängigkeit (auch mit Node testbar).

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Wörter zählen wie zkn.py (\w+ mit Unicode)
const WORD_RE = /[\p{L}\p{N}_]+/gu;
export function countWords(text) {
  return (String(text ?? "").match(WORD_RE) || []).length;
}

const SCENE_BREAK_RE = /^\s*(?:\*\s*){3,}$/;
const RULE_RE = /^\s*[-–—_]{4,}\s*$/;

/**
 * Absätze mit ihrer genauen Lage im Anzeigetext (für das Bearbeiten):
 * Ein Absatz ist eine Folge nicht leerer Zeilen – genau so, wie sie im Zettel steht.
 * Ergebnis: [{ start, end, type: "p" }]
 */
export function paragraphSpans(text) {
  const spans = [];
  const value = String(text ?? "");
  const n = value.length;
  let current = null;
  const flush = () => {
    if (current) spans.push({ start: current.start, end: current.end, type: "p" });
    current = null;
  };
  let lineStart = 0;
  for (;;) {
    let lineEnd = value.indexOf("\n", lineStart);
    if (lineEnd < 0) lineEnd = n;
    const line = value.slice(lineStart, lineEnd);
    if (!line.trim()) {
      flush();
    } else if (current) {
      current.end = lineEnd;
    } else {
      current = { start: lineStart, end: lineEnd };
    }
    if (lineEnd >= n) break;
    lineStart = lineEnd + 1;
  }
  flush();
  return spans;
}

/**
 * Inhalt eines bearbeitbaren Absatzes (Zeilenumbrüche bleiben \n; white-space: pre-wrap).
 * markClass: Klasse der Suchmarkierungen (die Vermerke zählen nicht zu den Treffern im Text).
 */
export function editableHtml(text, { term = "", startIndex = 0, markClass = "treffer" } = {}) {
  let hits = 0;
  const lines = String(text).split("\n").map((line) => {
    const result = highlightLine(line, term, startIndex + hits, markClass);
    hits += result.count;
    return markAnnotations(result.html);
  });
  return { html: lines.join("\n"), hits };
}

/**
 * Zerlegt den Zetteltext (Zeilenumbrüche = [br]) in Blöcke:
 * Absätze (durch Leerzeilen getrennt, Zeilen darin bleiben Zeilen),
 * Szenenwechsel (***) und Trennlinien (-----).
 */
export function splitBlocks(text) {
  const blocks = [];
  let lines = [];
  const flush = () => {
    if (lines.length) blocks.push({ type: "p", lines });
    lines = [];
  };
  for (const raw of String(text ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.replace(/\s+$/u, "");
    if (!line.trim()) {
      flush();
    } else if (SCENE_BREAK_RE.test(line)) {
      flush();
      blocks.push({ type: "break" });
    } else if (RULE_RE.test(line)) {
      flush();
      blocks.push({ type: "rule" });
    } else {
      lines.push(line.replace(/^\s+/u, ""));
    }
  }
  flush();
  return blocks;
}

/** Hebt eigene Anmerkungen in eckigen Klammern hervor (auf bereits maskiertem Text). */
export function markAnnotations(escaped) {
  return escaped.replace(/\[[^\[\]\n]*\]/g, (m) => `<span class="anm">${m}</span>`);
}

function termRegExp(term) {
  return new RegExp(escapeRegExp(term), "giu");
}

/** Maskiert eine Zeile und markiert dabei Suchtreffer (ohne Groß-/Kleinschreibung). */
export function highlightLine(line, term, startIndex = 0, markClass = "treffer") {
  if (!term) return { html: escapeHtml(line), count: 0 };
  const re = termRegExp(term);
  let html = "";
  let last = 0;
  let count = 0;
  let m;
  while ((m = re.exec(line))) {
    if (!m[0].length) {
      re.lastIndex += 1;
      continue;
    }
    html += escapeHtml(line.slice(last, m.index));
    html += `<mark class="${markClass}" data-n="${startIndex + count}">${escapeHtml(m[0])}</mark>`;
    count += 1;
    last = m.index + m[0].length;
  }
  return { html: html + escapeHtml(line.slice(last)), count };
}

/**
 * Setzt einen Zetteltext als HTML.
 * options.term: Suchbegriff zum Markieren; options.annotations: [..] hervorheben.
 * Liefert { html, hits } – hits = Anzahl markierter Treffer.
 */
export function renderText(text, options = {}) {
  const { term = "", annotations = true } = options;
  let hits = 0;
  const parts = [];
  for (const block of splitBlocks(text)) {
    if (block.type === "break") {
      parts.push('<p class="szenenwechsel" aria-label="Szenenwechsel">⁂</p>');
    } else if (block.type === "rule") {
      parts.push('<hr class="trenner">');
    } else {
      const lines = block.lines.map((line) => {
        const result = highlightLine(line, term, hits);
        hits += result.count;
        return annotations ? markAnnotations(result.html) : result.html;
      });
      parts.push(`<p>${lines.join("<br>")}</p>`);
    }
  }
  return { html: parts.join("\n"), hits };
}

/** Kennzahlen für die Höhenschätzung noch nicht gesetzter Kapitel. */
export function textStats(text) {
  const blocks = splitBlocks(text);
  const lineLengths = [];
  let paragraphs = 0;
  for (const block of blocks) {
    if (block.type === "p") {
      paragraphs += 1;
      for (const line of block.lines) lineLengths.push(line.length);
    } else {
      paragraphs += 1;
      lineLengths.push(1);
    }
  }
  return { lineLengths, paragraphs };
}

/**
 * Geschätzte Höhe eines gesetzten Textes in Pixeln.
 * metrics: { charsPerLine, lineHeight, paragraphGap }
 */
export function estimateHeight(stats, metrics) {
  const cpl = Math.max(10, metrics.charsPerLine);
  let lines = 0;
  for (const length of stats.lineLengths) lines += Math.max(1, Math.ceil(length / cpl));
  return Math.round(lines * metrics.lineHeight + stats.paragraphs * metrics.paragraphGap);
}

/** Alle Fundstellen eines Begriffs (ohne Groß-/Kleinschreibung) als Indizes. */
export function findAll(text, term) {
  const result = [];
  if (!term) return result;
  const re = termRegExp(term);
  let m;
  while ((m = re.exec(String(text)))) {
    if (!m[0].length) {
      re.lastIndex += 1;
      continue;
    }
    result.push({ index: m.index, length: m[0].length });
  }
  return result;
}

/** Ausschnitt um eine Fundstelle, mit markiertem Treffer (HTML). */
export function snippetHtml(text, index, length, radius = 70) {
  const flat = String(text);
  const start = Math.max(0, index - radius);
  const end = Math.min(flat.length, index + length + radius);
  const clean = (s) => s.replace(/\s+/gu, " ");
  const before = clean(flat.slice(start, index));
  const match = clean(flat.slice(index, index + length));
  const after = clean(flat.slice(index + length, end));
  return `${start > 0 ? "… " : ""}${escapeHtml(before)}<mark>${escapeHtml(match)}</mark>${escapeHtml(after)}${end < flat.length ? " …" : ""}`;
}

const NUMBER = new Intl.NumberFormat("de-DE");
export function formatNumber(n) {
  return NUMBER.format(n || 0);
}

export function formatDate(iso, withTime = true) {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(iso);
  if (!m) return iso;
  const date = `${m[3]}.${m[2]}.${m[1]}`;
  return withTime && m[4] ? `${date}, ${m[4]}:${m[5]}` : date;
}

/** Lesezeit in Minuten (rund 230 Wörter pro Minute). */
export function readingMinutes(words) {
  return Math.max(1, Math.round((words || 0) / 230));
}

export const KIND_LABELS = { szene: "Szene", jahr: "Jahreschronik", sonstiges: "Text" };

/** Titel für die Kopfleiste aus dem Dateinamen: „Titel Zettelkasten 2.zkn3“ → „Titel“. */
export function bookTitle(fileName) {
  const stem = String(fileName ?? "").replace(/\.[^.]*$/, "");
  return stem.replace(/\s+Zettelkasten\b.*$/i, "").trim() || stem.trim() || "Roman";
}
