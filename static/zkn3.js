// Liest die zkn3 im Browser – mit denselben Regeln und Ergebnissen wie reader/modell.py
// auf dem Laptop. Die zkn3 ist ein ZIP-Archiv mit XML-Teilen: entpackt wird mit
// DecompressionStream, gelesen mit DOMParser. Es wird nichts verändert.
import { countWords } from "./textsatz.js";
import { PY_WS, casefold, pyStrip } from "./pytext.js";

export const DESKTOP_NAME = "Anordnung";
const W = PY_WS;
const SCENE_RE = new RegExp(`^[${W}]*(?:\\?|löschen\\?)?[${W}]*S[${W}]+\\p{Nd}{4}(?![\\p{L}\\p{N}_])`, "iu");
const YEAR_RE = new RegExp(`^[${W}]*jahr[${W}]+\\p{Nd}{4}(?![\\p{L}\\p{N}_])`, "iu");
const SEPARATOR_RE = new RegExp(`[${W}]*-{3,}[${W}]*$`, "u");
const ID_SPLIT_RE = new RegExp(`[${W},;]+`, "u");
const BR_ANY_RE = new RegExp(`\\[br[${W}]*/?\\]`, "giu");
const WS_RUN_RE = new RegExp(`[${W}]+`, "gu");

export const MATERIAL_GROUPS = [
  ["Handlung", ["handlung.md"]],
  ["Figuren", ["charaktere/*.md"]],
  ["Gedanken", ["Gedanken*.md"]],
  ["Weiteres", ["vorschlag*.md", "modemsettings.md"]],
];
const MATERIAL_EXCLUDE = new Set(["charaktere/readme.md"]);

// ------------------------------------------------------------------ ZIP

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function inflateRaw(data) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Inhaltsverzeichnis eines ZIP-Archivs: Name -> Eintrag. */
export function zipDirectory(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Die zkn3 ist kein vollständiges ZIP-Archiv.");
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const entries = new Map();
  const utf8 = new TextDecoder("utf-8");
  const latin = new TextDecoder("latin1");
  for (let n = 0; n < count; n += 1) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== 0x02014b50) throw new Error("Das Inhaltsverzeichnis der zkn3 ist beschädigt.");
    const flags = view.getUint16(p + 8, true);
    const nameLength = view.getUint16(p + 28, true);
    const extraLength = view.getUint16(p + 30, true);
    const commentLength = view.getUint16(p + 32, true);
    const nameBytes = bytes.subarray(p + 46, p + 46 + nameLength);
    const name = (flags & 0x800 ? utf8 : latin).decode(nameBytes);
    entries.set(name, {
      name, flags,
      method: view.getUint16(p + 10, true),
      crc: view.getUint32(p + 16, true),
      compressedSize: view.getUint32(p + 20, true),
      size: view.getUint32(p + 24, true),
      offset: view.getUint32(p + 42, true),
    });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Ein Teil des Archivs als Bytes (mit Prüfsumme wie Pythons zipfile). */
export async function zipRead(bytes, entry) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (entry.flags & 0x1) throw new Error(`„${entry.name}“ ist verschlüsselt.`);
  if (view.getUint32(entry.offset, true) !== 0x04034b50) throw new Error(`„${entry.name}“ ist beschädigt.`);
  const start = entry.offset + 30 + view.getUint16(entry.offset + 26, true) + view.getUint16(entry.offset + 28, true);
  const data = bytes.subarray(start, start + entry.compressedSize);
  let out;
  if (entry.method === 0) out = data;
  else if (entry.method === 8) out = await inflateRaw(data);
  else throw new Error(`„${entry.name}“ ist auf unbekannte Art gepackt (${entry.method}).`);
  if (out.length !== entry.size || crc32(out) !== entry.crc) throw new Error(`„${entry.name}“ ist beschädigt (Prüfsumme).`);
  return out;
}

// ------------------------------------------------------------------ kleine Helfer (wie modell.py / zkn.py)

export function kindOf(title) {
  if (SCENE_RE.test(title)) return "szene";
  if (YEAR_RE.test(title)) return "jahr";
  return "sonstiges";
}

const pad = (n) => String(n).padStart(2, "0");

/** Zeitstempel der zkn3 (JJMMTTHHMM) als ISO-Zeit, sonst null. */
export function formatTs(ts) {
  if (!ts || !/^[0-9]{10}$/.test(ts)) return null;
  const [yy, month, day, hour, minute] = [0, 2, 4, 6, 8].map((i) => Number(ts.slice(i, i + 2)));
  const year = yy <= 68 ? 2000 + yy : 1900 + yy;
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > days || hour > 23 || minute > 59) return null;
  return `${String(year).padStart(4, "0")}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}`;
}

function normalizeZknText(text) {
  if (!text) return "";
  return pyStrip(text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(BR_ANY_RE, "\n"));
}

function child(element, name) {
  for (const item of element.children) if (item.localName === name) return item;
  return null;
}

const elementText = (element) => (element ? normalizeZknText(element.textContent) : "");
const childText = (element, name) => elementText(child(element, name));
const splitIds = (raw) => String(raw || "").split(ID_SPLIT_RE).filter((token) => pyStrip(token));
const all = (root, name) => (root ? [...root.getElementsByTagNameNS("*", name)] : []);

function parseXml(text, name) {
  if (!pyStrip(text)) return null;
  const doc = new DOMParser().parseFromString(text, "application/xml");
  const error = doc.getElementsByTagName("parsererror")[0];
  if (error) throw new Error(`${name} konnte nicht als XML gelesen werden: ${pyStrip(error.textContent).slice(0, 200)}`);
  return doc;
}

function numberedEntries(root) {
  const map = new Map();
  all(root, "entry").forEach((element, index) => {
    const value = elementText(element);
    if (value) map.set(String(index + 1), value);
  });
  return map;
}

function resolveKeywords(raw, keywords) {
  if (!raw) return [];
  return raw.split(ID_SPLIT_RE).map(pyStrip).filter(Boolean).map((token) => keywords.get(token) ?? token);
}

// ------------------------------------------------------------------ Vergleich mit der Schreibtisch-Fassung (wie difflib)

function matchingBlocks(a, b) {
  const b2j = new Map();
  b.forEach((item, j) => {
    if (!b2j.has(item)) b2j.set(item, []);
    b2j.get(item).push(j);
  });
  const longest = (alo, ahi, blo, bhi) => {
    let besti = alo;
    let bestj = blo;
    let bestsize = 0;
    let j2len = new Map();
    for (let i = alo; i < ahi; i += 1) {
      const next = new Map();
      for (const j of b2j.get(a[i]) || []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) || 0) + 1;
        next.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
      j2len = next;
    }
    while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
      besti -= 1;
      bestj -= 1;
      bestsize += 1;
    }
    while (besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] === b[bestj + bestsize]) bestsize += 1;
    return [besti, bestj, bestsize];
  };
  const queue = [[0, a.length, 0, b.length]];
  const blocks = [];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop();
    const [i, j, k] = longest(alo, ahi, blo, bhi);
    if (!k) continue;
    blocks.push([i, j, k]);
    if (alo < i && blo < j) queue.push([alo, i, blo, j]);
    if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
  }
  blocks.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
  const merged = [];
  let [i1, j1, k1] = [0, 0, 0];
  for (const [i2, j2, k2] of blocks) {
    if (i1 + k1 === i2 && j1 + k1 === j2) {
      k1 += k2;
    } else {
      if (k1) merged.push([i1, j1, k1]);
      [i1, j1, k1] = [i2, j2, k2];
    }
  }
  if (k1) merged.push([i1, j1, k1]);
  merged.push([a.length, b.length, 0]);
  return merged;
}

function opcodes(a, b) {
  let i = 0;
  let j = 0;
  const answer = [];
  for (const [ai, bj, size] of matchingBlocks(a, b)) {
    let tag = "";
    if (i < ai && j < bj) tag = "replace";
    else if (i < ai) tag = "delete";
    else if (j < bj) tag = "insert";
    if (tag) answer.push([tag, i, ai, j, bj]);
    i = ai + size;
    j = bj + size;
    if (size) answer.push(["equal", ai, i, bj, j]);
  }
  return answer;
}

export function compareDesktop(note, desktop) {
  const lines = (text) => text.split("\n").map(pyStrip).filter(Boolean);
  const a = lines(note);
  const b = lines(desktop);
  const extra = [];
  let missingWords = 0;
  for (const [tag, i1, i2, j1, j2] of opcodes(a, b)) {
    if (tag === "replace" || tag === "insert") extra.push(...b.slice(j1, j2));
    if (tag === "replace" || tag === "delete") for (const line of a.slice(i1, i2)) missingWords += countWords(line);
  }
  return {
    same: !extra.length && missingWords === 0,
    older: missingWords > 0,
    extraLines: extra.slice(0, 12),
    extraLineCount: extra.length,
    extraWords: extra.reduce((n, line) => n + countWords(line), 0),
    missingWords,
  };
}

// ------------------------------------------------------------------ Suche (wie zkn.make_context)

function makeContext(text, query, radius) {
  const flat = [...pyStrip(text.replace(WS_RUN_RE, " "))];
  const folded = casefold(flat.join(""));
  const at = folded.indexOf(casefold(query));
  if (at < 0) return "";
  const index = [...folded.slice(0, at)].length; // wie Python: Position im gefalteten Text
  const start = Math.max(0, index - radius);
  const end = Math.min(flat.length, index + [...query].length + radius);
  let context = pyStrip(flat.slice(start, end).join(""));
  if (start > 0) context = `... ${context}`;
  if (end < flat.length) context += " ...";
  return context;
}

// ------------------------------------------------------------------ Das Modell

export class Buch {
  /** parts: Name -> Text der XML-Teile; data: die Bytes der zkn3 (für Größe und Version). */
  constructor(parts, { fileName, size, version }) {
    this.fileName = fileName;
    this.size = size;
    this.version = version;
    const keywords = numberedEntries(parseXml(parts["keywordFile.xml"] || "", "keywordFile.xml"));
    const authors = numberedEntries(parseXml(parts["authorFile.xml"] || "", "authorFile.xml"));
    const zknRoot = parseXml(parts["zknFile.xml"] || "", "zknFile.xml");
    if (!zknRoot) throw new Error("In der zkn3 fehlt zknFile.xml.");
    this.zettels = all(zknRoot, "zettel").map((element, index) => {
      const contentElement = child(element, "content");
      const content = contentElement ? contentElement.textContent.replaceAll("[br]", "\n") : "";
      const misc = childText(element, "misc");
      return {
        id: String(index + 1),
        title: childText(element, "title"),
        content,
        misc,
        keywords: resolveKeywords(childText(element, "keywords"), keywords),
        authors: splitIds(childText(element, "author")).map((a) => authors.get(a) ?? a),
        links: splitIds(childText(element, "manlinks")),
        followers: splitIds(childText(element, "luhmann")),
        created: formatTs(element.getAttribute("ts_created")),
        edited: formatTs(element.getAttribute("ts_edited")),
        words: countWords(content),
        miscWords: countWords(misc),
      };
    });
    this.byId = new Map(this.zettels.map((z) => [z.id, z]));
    this.parseOutline(parseXml(parts["desktop.xml"] || "", "desktop.xml"));
    const modified = new Map();
    for (const element of all(parseXml(parts["desktopme.xml"] || "", "desktopme.xml"), "entry")) {
      if (element.getAttribute("timestamp")) modified.set(element.getAttribute("timestamp"), elementText(element));
    }
    this.notes = [];
    this.firstPos = new Map();
    for (const entry of this.entries) {
      if (!this.firstPos.has(entry.id)) this.firstPos.set(entry.id, entry.pos);
      const zettel = this.byId.get(entry.id);
      if (!zettel) this.notes.push(`Eintrag ${entry.pos} verweist auf Zettel ${entry.id}, den es nicht gibt.`);
      const desktopText = modified.get(entry.timestamp);
      entry.desktop = desktopText === undefined ? null : compareDesktop(zettel ? zettel.content : "", desktopText);
    }
  }

  parseOutline(root) {
    const desktop = all(root, "desktop").find((d) => d.getAttribute("name") === DESKTOP_NAME);
    if (!desktop) throw new Error(`Die Schreibtisch-Anordnung „${DESKTOP_NAME}“ fehlt in der zkn3.`);
    this.sections = [];
    this.entries = [];
    const walk = (element, depth, section) => {
      for (const item of element.children) {
        if (item.localName === "bullet") {
          const raw = item.getAttribute("name") || "";
          const created = {
            index: this.sections.length,
            name: pyStrip(raw.replace(SEPARATOR_RE, "")) || pyStrip(raw),
            depth,
            separator: SEPARATOR_RE.test(raw),
            comment: childText(item, "comment"),
            entries: [],
          };
          this.sections.push(created);
          walk(item, depth + 1, created);
        } else if (item.localName === "entry" && pyStrip(item.getAttribute("id") || "")) {
          const entry = {
            pos: this.entries.length + 1,
            id: pyStrip(item.getAttribute("id")),
            timestamp: item.getAttribute("timestamp") ?? "",
            section: section ? section.index : null,
            comment: childText(item, "comment"),
          };
          this.entries.push(entry);
          if (section) section.entries.push(entry.pos);
        }
      }
    };
    walk(desktop, 0, null);
  }

  /** Wie Book.book_payload: overlay = Zettelnummer -> Anzeigetext mit offenen Änderungen. */
  bookPayload(overlay = {}) {
    const entries = this.entries.map((entry) => {
      const zettel = this.byId.get(entry.id);
      const title = zettel?.title || `(Zettel ${entry.id} fehlt)`;
      const text = Object.hasOwn(overlay, entry.id) ? overlay[entry.id] : zettel?.content ?? "";
      return {
        pos: entry.pos,
        id: entry.id,
        title,
        kind: kindOf(title),
        section: entry.section,
        words: countWords(text),
        text,
        pending: Object.hasOwn(overlay, entry.id),
        miscWords: zettel?.miscWords ?? 0,
        created: zettel?.created ?? null,
        edited: zettel?.edited ?? null,
        comment: entry.comment,
        desktop: entry.desktop,
      };
    });
    const scenes = entries.filter((e) => e.kind === "szene");
    return {
      file: { name: this.fileName, size: this.size, modified: null, version: this.version, zettelCount: this.zettels.length },
      desktopName: DESKTOP_NAME,
      sections: this.sections.map(({ index, name, depth, separator, comment, entries: list }) => ({ index, name, depth, separator, comment, entries: list })),
      entries,
      totals: {
        entries: entries.length,
        words: entries.reduce((n, e) => n + e.words, 0),
        scenes: scenes.length,
        sceneWords: scenes.reduce((n, e) => n + e.words, 0),
        desktopVersions: entries.filter((e) => e.desktop !== null).length,
      },
      notes: this.notes,
    };
  }

  /** Wie Book.zettel_payload. */
  zettelPayload(id, overlay = {}) {
    let zettel = this.byId.get(String(id));
    if (!zettel) return null;
    if (Object.hasOwn(overlay, zettel.id)) zettel = { ...zettel, content: overlay[zettel.id], words: countWords(overlay[zettel.id]) };
    const ref = (target) => ({ id: target, title: this.byId.get(target)?.title ?? null, pos: this.firstPos.get(target) ?? null });
    return {
      id: zettel.id, title: zettel.title, content: zettel.content, misc: zettel.misc, keywords: zettel.keywords,
      authors: zettel.authors, created: zettel.created, edited: zettel.edited, words: zettel.words, miscWords: zettel.miscWords,
      links: zettel.links.map(ref),
      followers: zettel.followers.map(ref),
      pos: this.firstPos.get(zettel.id) ?? null,
      kind: kindOf(zettel.title),
    };
  }

  /** Wie Book.search: Volltextsuche über alle Zettel (Titel, Text, Bemerkungen). */
  search(query, limit = 300) {
    const needle = casefold(pyStrip(query));
    const hits = [];
    let total = 0;
    if ([...needle].length < 2) return { query, hits, total: 0 };
    for (const zettel of this.zettels) {
      for (const field of ["title", "content", "misc"]) {
        const haystack = zettel[field];
        const folded = casefold(haystack);
        let count = 0;
        for (let at = folded.indexOf(needle); at >= 0; at = folded.indexOf(needle, at + needle.length)) count += 1;
        if (!count) continue;
        total += count;
        if (hits.length < limit) {
          hits.push({ id: zettel.id, title: zettel.title, field, count, pos: this.firstPos.get(zettel.id) ?? null,
            context: makeContext(haystack, pyStrip(query), 80) });
        }
      }
    }
    return { query, hits, total };
  }
}

/** Liest die Bytes einer zkn3 und baut das Modell (wie modell.Book). */
export async function leseZkn3(bytes, fileName) {
  const directory = zipDirectory(bytes);
  const decoder = new TextDecoder("utf-8");
  const parts = {};
  for (const name of ["zknFile.xml", "keywordFile.xml", "authorFile.xml", "desktop.xml", "desktopme.xml"]) {
    const entry = directory.get(name);
    parts[name] = entry ? decoder.decode(await zipRead(bytes, entry)) : "";
  }
  if (!pyStrip(parts["zknFile.xml"])) throw new Error("In der zkn3 fehlt zknFile.xml.");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
  const version = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
  return new Buch(parts, { fileName, size: bytes.length, version });
}

// ------------------------------------------------------------------ Material (Markdown-Dateien des Projekts)

function globToRegExp(pattern) {
  const body = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*");
  return new RegExp(`^${body}$`, "i"); // Windows vergleicht Dateinamen ohne Groß-/Kleinschreibung
}

/** Wie modell.list_material, aber aus der Dateiliste des Repositorys (paths: alle Dateipfade). */
export function materialListe(paths) {
  const items = [];
  const seen = new Set();
  for (const [group, patterns] of MATERIAL_GROUPS) {
    for (const pattern of patterns) {
      const re = globToRegExp(pattern);
      const matches = paths.filter((p) => re.test(p)).sort((x, y) => (x.toLowerCase() < y.toLowerCase() ? -1 : x.toLowerCase() > y.toLowerCase() ? 1 : 0));
      for (const path of matches) {
        if (seen.has(path) || MATERIAL_EXCLUDE.has(path.toLowerCase())) continue;
        seen.add(path);
        items.push({ path, group });
      }
    }
  }
  return items;
}

/** Wie modell.material_title: erste Überschrift „# “ in den ersten 20 Zeilen, sonst der Dateiname. */
export function materialTitel(path, text) {
  const lines = String(text ?? "").split(/(?<=\n)/).slice(0, 20);
  for (const line of lines) if (line.startsWith("# ")) return pyStrip(line.slice(2));
  const name = path.split("/").pop();
  return name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : name;
}
