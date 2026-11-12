// Reader für den Roman – Grundlage ist überarbeitung33.html.
// Lesen und Bearbeiten: Jeder Absatz, der Titel und die Sonstigen Vermerke sind direkt
// beschreibbar. Auf dem Laptop wird über den lokalen Dienst gespeichert (Schreibwerkzeug mit
// Sicherungskopie und Änderungsbuch; solange das Zettelkasten-Programm geöffnet ist, warten
// die Änderungen). Unterwegs (Chromebook) kommen Text und Änderungen über GitHub – siehe daten.js.
import {
  escapeHtml, findAll, snippetHtml, formatNumber, formatDate, readingMinutes, KIND_LABELS,
  paragraphSpans, editableHtml, countWords, bookTitle,
} from "./textsatz.js";
import { marked } from "./vendor/marked.esm.js";
import { LOKALER_RECHNER, waehleQuelle } from "./daten.js";
import { titelZeile } from "./aenderung.js";
import { kindOf } from "./zkn3.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const doc = $("#doc");
const tocEl = $("#inhalt-liste");
const tocPanel = $("#inhalt");
const mini = $("#minitoc");
const insp = $("#insp");
const toastEl = $("#toast");
const errorBox = $("#fehler");
const searchInput = $("#suche");

let quelle = null; // Laptop-Dienst oder GitHub (daten.js)
let toastTimer = null;
let pollTimer = null;
let saveTimer = null;
let scrollQueued = false;
let hitCounter = 0;

// ------------------------------------------------------------------ Fehler sichtbar machen

function reportError(message) {
  errorBox.textContent += message + "\n";
  console.error(message);
  toast("Im Reader ist ein Fehler aufgetreten", message, 8000);
}
window.addEventListener("error", (e) => reportError(`${e.message} (${e.filename}:${e.lineno})`));
window.addEventListener("unhandledrejection", (e) => reportError(String(e.reason?.stack || e.reason)));

// ------------------------------------------------------------------ Einstellungen (nur Bequemlichkeit)

const store = {
  get(key, fallback) {
    try {
      const value = localStorage.getItem("roman." + key);
      return value === null ? fallback : JSON.parse(value);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem("roman." + key, JSON.stringify(value));
    } catch {
      /* ohne Speicher geht es auch */
    }
  },
};

const settings = Object.assign(
  { szenen: false, anm: true, nummern: false, inhaltOffen: null },
  store.get("einstellungen", {}),
);

function saveSettings() {
  store.set("einstellungen", settings);
}

function hdrHeight() {
  document.documentElement.style.setProperty("--hdr", `${$("header.bar").offsetHeight}px`);
}

function wideScreen() {
  return window.innerWidth >= 1100;
}

function tocOpen() {
  return settings.inhaltOffen ?? wideScreen();
}

function applySettings() {
  $$("#toggles input").forEach((cb) => { cb.checked = Boolean(settings[cb.dataset.t]); });
  document.body.classList.toggle("nur-szenen", settings.szenen);
  document.body.classList.toggle("no-anm", !settings.anm);
  document.body.classList.toggle("mit-nummern", settings.nummern);
  document.body.classList.toggle("inhalt-offen", tocOpen());
  $("#inhalt-knopf").setAttribute("aria-expanded", String(tocOpen()));
  hdrHeight();
}

function setTocOpen(open) {
  settings.inhaltOffen = open;
  saveSettings();
  applySettings();
  if (open) markCurrent(state.view?.id);
}

// ------------------------------------------------------------------ Zustand

const state = {
  book: null,
  version: null,
  entriesById: new Map(),
  extra: new Map(), // Zettel außerhalb der Anordnung, die gerade angezeigt werden
  material: [],
  view: null, // { mode, id | path }
  term: "",
  hitIndex: 0,
  git: null,
  edit: null,
  online: true,
  wholeKey: null,
  chapters: [],
  currentWhole: null,
  rerender: new Set(), // Kapitel, deren Absätze nach dem Bearbeiten neu gesetzt werden
  rerenderMisc: new Set(), // ebenso für die Sonstigen Vermerke
  openMisc: new Set(), // Zettel, deren Sonstige Vermerke aufgeklappt sind
  edited: new Map(), // `${zettel}\0${feld}\0${jetziger Text}` -> Text vor der ersten Bearbeitung in dieser Sitzung
  saving: 0,
  reloadWanted: false,
  lastError: null,
  title: "Roman",
};

// Bearbeitbare Felder eines Zettels: content (Text), title (Titel), misc (Sonstige Vermerke)
const editKey = (zettel, feld, text) => `${zettel}\u0000${feld}\u0000${text}`;

function fieldText(entry, feld) {
  if (feld === "title") return entry.title;
  if (feld === "misc") return entry.misc ?? "";
  return entry.text;
}

function entryById(id) {
  return state.entriesById.get(String(id)) || state.extra.get(String(id));
}

function isVisible(entry) {
  return !settings.szenen || entry.kind === "szene";
}

function visibleEntries() {
  return state.book.entries.filter(isVisible);
}

function neighbors(entry) {
  const list = state.book.entries;
  let prev = null;
  let next = null;
  if (!entry.pos) return { prev, next };
  for (let i = entry.pos - 2; i >= 0; i -= 1) if (isVisible(list[i])) { prev = list[i]; break; }
  for (let i = entry.pos; i < list.length; i += 1) if (isVisible(list[i])) { next = list[i]; break; }
  return { prev, next };
}

function sectionName(entry) {
  return state.book.sections[entry.section]?.name ?? "";
}

function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ------------------------------------------------------------------ Daten laden

async function loadBook() {
  const book = await quelle.buch();
  state.book = book;
  state.version = book.stand || book.file.version;
  state.title = bookTitle(book.file.name);
  $("#titel").textContent = state.title;
  state.entriesById = new Map();
  for (const entry of book.entries) if (!state.entriesById.has(entry.id)) state.entriesById.set(entry.id, entry);
  state.wholeKey = null;
  buildToc();
  updateDesktopButton();
}

async function loadMaterial() {
  try {
    state.material = await quelle.material();
  } catch {
    state.material = [];
  }
  if (state.book) buildToc();
}

// ------------------------------------------------------------------ Inhaltsverzeichnis (klappt von links aus)

function buildToc() {
  const parts = [];
  for (const section of state.book.sections) {
    const items = section.entries.map((pos) => state.book.entries[pos - 1]).filter(Boolean);
    const scenes = items.some((e) => e.kind === "szene");
    parts.push(`<div class="toc-jahr${section.separator ? " trenner" : ""}${scenes ? "" : " ohne-szenen"}">`
      + `<div class="nptitle">${escapeHtml(section.name)}</div><ol>${items.map(tocItem).join("")}</ol></div>`);
  }
  if (state.material.length) {
    parts.push(`<div class="toc-jahr trenner"><div class="nptitle">Material</div><ol>${state.material.map((m) =>
      `<li><a class="toc-e" href="#material/${escapeHtml(m.path)}" data-path="${escapeHtml(m.path)}">${escapeHtml(m.title)}</a></li>`).join("")}</ol></div>`);
  }
  tocEl.innerHTML = parts.join("");
  if (state.view?.mode === "material") markCurrentMaterial(state.view.path);
  else if (state.view) markCurrent(state.view.id);
}

function tocItem(entry) {
  return `<li class="art-${entry.kind}"><a class="toc-e art-${entry.kind}" href="#kapitel/${escapeHtml(entry.id)}" data-id="${escapeHtml(entry.id)}">${escapeHtml(entry.title)}</a><span class="np-extra">${formatNumber(entry.words)}</span></li>`;
}

function scrollWithin(container, element) {
  const box = container.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  if (rect.top < box.top || rect.bottom > box.bottom) container.scrollTop += rect.top - box.top - container.clientHeight / 2;
}

function markCurrent(id) {
  $$(".toc-e.aktuell", tocEl).forEach((a) => a.classList.remove("aktuell"));
  const link = id ? tocEl.querySelector(`a.toc-e[data-id="${CSS.escape(String(id))}"]`) : null;
  if (link) {
    link.classList.add("aktuell");
    if (tocOpen()) scrollWithin(tocPanel, link);
  }
}

function markCurrentMaterial(path) {
  $$(".toc-e.aktuell", tocEl).forEach((a) => a.classList.remove("aktuell"));
  tocEl.querySelector(`a.toc-e[data-path="${CSS.escape(path)}"]`)?.classList.add("aktuell");
}

tocEl.addEventListener("click", (event) => {
  const link = event.target.closest("a.toc-e");
  if (!link) return;
  if (link.dataset.id && state.view?.mode === "gesamt") {
    event.preventDefault();
    go(`gesamt/${link.dataset.id}`);
  }
  if (!wideScreen()) setTocOpen(false); // in schmalen Fenstern liegt es über dem Text
});

// ------------------------------------------------------------------ Navigation

function parseHash() {
  const raw = decodeURIComponent(location.hash.replace(/^#/, ""));
  const [mode, ...rest] = raw.split("/");
  const arg = rest.join("/");
  if ((mode === "kapitel" || mode === "zettel") && arg) return { mode, id: arg };
  if (mode === "gesamt") return { mode, id: arg || null };
  if (mode === "material" && arg) return { mode, path: arg };
  return null;
}

function go(hash) {
  if (location.hash === `#${hash}` || decodeURIComponent(location.hash) === `#${hash}`) route();
  else location.hash = hash;
}

async function route() {
  if (!state.book) return;
  let target = parseHash();
  const saved = store.get("position", null);
  if (!target) {
    const fallback = state.book.entries.find((e) => e.kind === "szene") || state.book.entries[0];
    const id = saved && state.entriesById.has(saved.id) ? saved.id : fallback?.id;
    target = { mode: saved?.mode === "gesamt" ? "gesamt" : "kapitel", id };
    history.replaceState(null, "", `#${target.mode}/${target.id}`);
  }
  const first = !state.view;
  if (target.mode === "kapitel") {
    showChapter(target.id, { restore: first && saved?.mode === "kapitel" && saved.id === target.id ? saved.scroll : null });
  } else if (target.mode === "gesamt") {
    showWhole(target.id, { offset: first && saved?.mode === "gesamt" && saved.id === target.id ? saved.offset : null });
  } else if (target.mode === "material") {
    await showMaterial(target.path);
  } else if (target.mode === "zettel") {
    await showZettel(target.id);
  }
}

function setView(mode) {
  $$("#views button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.view === mode)));
  mini.hidden = mode !== "gesamt";
  $("#vor").disabled = mode !== "kapitel";
  $("#weiter").disabled = mode !== "kapitel";
  if (mode !== "gesamt") {
    state.wholeKey = null;
    state.chapters = [];
  }
}

function currentEntryId() {
  if (state.view?.id && state.entriesById.has(String(state.view.id))) return state.view.id;
  const saved = store.get("position", null);
  if (saved && state.entriesById.has(saved.id)) return saved.id;
  return state.book.entries[0]?.id;
}

function updatePlace(entry, title) {
  $("#ort").textContent = entry ? `${sectionName(entry)} · ${entry.title}` : title || "";
  document.title = `${entry ? entry.title : title || "Reader"} · ${state.title}`;
  hdrHeight();
}

const shownTitle = (entry) => entry.title || "(ohne Titel)";

function navigate(step) {
  const entry = entryById(state.view?.id);
  if (!entry) return;
  const { prev, next } = neighbors(entry);
  const target = step < 0 ? prev : next;
  if (target) go(`kapitel/${target.id}`);
}

// ------------------------------------------------------------------ Kapitel setzen

function desktopNote(entry) {
  const d = entry.desktop;
  if (!d) return "";
  let text;
  if (d.same) text = "Im Zettelkasten-Programm hat dieses Kapitel eine eigene Schreibtisch-Fassung; sie stimmt mit dem Zettel überein.";
  else if (d.older) text = `Im Zettelkasten-Programm zeigt der Schreibtisch eine ältere Fassung (${formatNumber(d.missingWords)} Wörter des Zettels fehlen dort). Hier steht der Zettel.`;
  else text = `Der Schreibtisch im Zettelkasten-Programm zeigt dieses Kapitel mit ${d.extraLineCount === 1 ? "einer zusätzlichen Zeile" : `${d.extraLineCount} zusätzlichen Zeilen`}: ${d.extraLines.slice(0, 3).map((l) => `„${escapeHtml(l)}“`).join(" ")}`;
  return `<div class="pc"><b>Schreibtisch</b>${text}</div>`;
}

// Zwei schräg versetzte Quadrate, das vordere verdeckt das hintere
const COPY_ICON = '<svg class="symbol" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">'
  + '<rect x="1.5" y="1.5" width="9" height="9" rx="1.6"/><rect x="5.5" y="5.5" width="9" height="9" rx="1.6"/></svg>';

function toolbarHtml(label, edited) {
  return `<div class="blk-tools"><span class="tag">${label}<span class="zustand">${edited ? " · bearbeitet" : ""}</span></span>`
    + `<button class="tb" data-act="verwerfen"${edited ? "" : " hidden"}>Bearbeitung verwerfen</button></div>`;
}

function titleHtml(entry, tag, tools) {
  const edited = state.edited.has(editKey(entry.id, "title", entry.title));
  return `<div class="titelzeile"><div class="blk titel${edited ? " bearbeitet" : ""}" data-feld="title" data-s="0" data-e="${entry.title.length}">`
    + `${tools ? toolbarHtml("Titel", edited) : ""}<${tag} class="text ed" contenteditable="true" spellcheck="true" data-leer="(ohne Titel)">${escapeHtml(entry.title)}</${tag}></div>`
    + `<button type="button" class="kopieren" data-act="kopieren" title="Überschrift und Text kopieren (ohne Vermerke)" aria-label="Überschrift und Text kopieren">${COPY_ICON}</button></div>`;
}

function headingHtml(entry, level, tools) {
  const meta = [
    entry.pos ? sectionName(entry) : "nicht in der Anordnung",
    KIND_LABELS[entry.kind],
    `${formatNumber(entry.words)} Wörter`,
    entry.words >= 300 ? `ca. ${readingMinutes(entry.words)} Min.` : null,
    `Zettel ${entry.id}`,
    entry.edited ? `geändert ${formatDate(entry.edited, false)}` : null,
  ].filter(Boolean).join(" · ");
  const tag = level === 1 ? "h2" : "h3";
  let vermerke = "";
  if (entry.miscWords) {
    // Aufgeklappt bleibt aufgeklappt, auch wenn das Kapitel neu gesetzt wird
    const open = state.openMisc.has(entry.id);
    const known = open && entry.misc !== undefined;
    vermerke = `<details class="vermerke" data-id="${escapeHtml(entry.id)}" data-tools="${tools ? 1 : 0}"${open ? " open" : ""}${known ? ' data-geladen="1"' : ""}>`
      + `<summary>Sonstige Vermerke</summary><div class="vermerke-text">${known ? miscHtml(entry, tools) : '<p class="hint">Wird geladen …</p>'}</div></details>`;
  }
  return `<section class="blk kind-heading lvl-${level}"><span class="kap-ort">${escapeHtml(meta)}</span>${titleHtml(entry, tag, tools)}${vermerke}${desktopNote(entry)}</section>`;
}

/** Ein bearbeitbarer Absatz des Textes (feld content) oder der Sonstigen Vermerke (feld misc). */
function blockHtml(entry, feld, span, index, tools) {
  const raw = fieldText(entry, feld).slice(span.start, span.end);
  const misc = feld === "misc";
  // Treffer in den Vermerken zählen nicht zu denen im Text (Sprung zum n-ten Treffer)
  const { html, hits } = editableHtml(raw, { term: state.term, startIndex: misc ? 0 : hitCounter, markClass: misc ? "treffer-v" : "treffer" });
  if (!misc) hitCounter += hits;
  const edited = state.edited.has(editKey(entry.id, feld, raw));
  return `<div class="blk ${misc ? "vermerk" : "absatz"}${edited ? " bearbeitet" : ""}" data-feld="${feld}" data-i="${index}" data-s="${span.start}" data-e="${span.end}">`
    + `${tools ? toolbarHtml("Absatz", edited) : ""}<div class="text ed" contenteditable="true" spellcheck="true">${html}</div></div>`;
}

function miscHtml(entry, tools) {
  const spans = paragraphSpans(entry.misc ?? "");
  return spans.map((s, i) => blockHtml(entry, "misc", s, i, tools)).join("") || '<p class="hint">keine</p>';
}

function chapterHtml(entry, { level, tools }) {
  const spans = paragraphSpans(entry.text);
  const blocks = spans.map((s, i) => blockHtml(entry, "content", s, i, tools)).join("");
  return headingHtml(entry, level, tools) + (blocks || '<p class="leer">(Dieser Zettel hat noch keinen Text.)</p>');
}

function navHtml(entry) {
  const { prev, next } = neighbors(entry);
  const link = (target, cls, label) => `<a class="${cls}" href="#kapitel/${escapeHtml(target.id)}"><small>${label}</small><span>${escapeHtml(target.title)}</span></a>`;
  return `<nav class="kap-nav" aria-label="Blättern">${prev ? link(prev, "zurueck", "← Zurück") : ""}${next ? link(next, "weiter", "Weiter →") : ""}</nav>`;
}

function showChapter(id, { restore = null, toHit = true } = {}) {
  const entry = entryById(id);
  if (!entry || !entry.pos) {
    showMissing(`Das Kapitel (Zettel ${id}) steht nicht in der Anordnung.`);
    return;
  }
  setView("kapitel");
  state.view = { mode: "kapitel", id: entry.id };
  hitCounter = 0;
  doc.innerHTML = `<div class="kapitel" data-zettel="${escapeHtml(entry.id)}">${chapterHtml(entry, { level: 1, tools: true })}</div>${navHtml(entry)}`;
  loadOpenMisc();
  markCurrent(entry.id);
  updatePlace(entry);
  if (toHit && state.term && hitCounter) scrollToHit(state.hitIndex);
  else window.scrollTo(0, restore ?? 0);
  savePosition();
}

function showMissing(message) {
  setView("other");
  state.view = { mode: "other" };
  doc.innerHTML = `<p class="leer">${escapeHtml(message)} <a href="#kapitel/${escapeHtml(state.book.entries[0]?.id ?? "")}">Zum Anfang</a></p>`;
}

function scrollToHit(n) {
  const marks = $$("mark.treffer", doc);
  if (!marks.length) return;
  const mark = marks[Math.min(n, marks.length - 1)];
  marks.forEach((m) => m.classList.remove("aktiv"));
  mark.classList.add("aktiv");
  mark.scrollIntoView({ block: "center" });
}

// Sonstige Vermerke (misc) erst beim Aufklappen laden – danach absatzweise beschreibbar wie der Text
async function loadMisc(details) {
  if (!details.open || details.dataset.geladen) return;
  details.dataset.geladen = "1";
  const box = $(".vermerke-text", details);
  try {
    const z = await quelle.zettel(details.dataset.id);
    const entry = containerEntry(details);
    if (!entry || !details.isConnected) return;
    entry.misc = z.misc;
    entry.miscWords = z.miscWords;
    box.innerHTML = miscHtml(entry, details.dataset.tools === "1");
  } catch (err) {
    box.innerHTML = `<p class="hint">${escapeHtml(err.message)}</p>`;
    delete details.dataset.geladen;
  }
}

function loadOpenMisc() {
  for (const details of $$("details.vermerke[open]:not([data-geladen])", doc)) loadMisc(details);
}

doc.addEventListener("toggle", (event) => {
  const details = event.target;
  if (!details.matches?.("details.vermerke")) return;
  if (details.open) state.openMisc.add(details.dataset.id);
  else state.openMisc.delete(details.dataset.id);
  loadMisc(details);
}, true);

// ------------------------------------------------------------------ Gesamtansicht

function estimateHeight(entry) {
  return Math.round(entry.words * 2.2 + (entry.text.match(/\n\s*\n/g) || []).length * 18 + 140);
}

function showWhole(id, { offset = null } = {}) {
  const key = [state.version, settings.szenen, state.term, state.book.entries.length].join("|");
  if (state.wholeKey === key && state.chapters.length) {
    scrollToChapter(id, true);
    return;
  }
  setView("gesamt");
  hitCounter = 0;
  const entries = visibleEntries();
  const parts = [];
  let lastSection = -1;
  for (const entry of entries) {
    if (entry.section !== lastSection) {
      const section = state.book.sections[entry.section];
      parts.push(`<h2 class="jahr-titel${section?.separator ? " trenner" : ""}">${escapeHtml(section?.name ?? "")}</h2>`);
      lastSection = entry.section;
    }
    // Nur in der Gesamtansicht: Kapitel außerhalb des Bildes werden nicht gesetzt (schnelles Scrollen)
    parts.push(`<div class="kapitel" data-zettel="${escapeHtml(entry.id)}" style="content-visibility:auto;contain-intrinsic-size:auto ${estimateHeight(entry)}px">${chapterHtml(entry, { level: 2, tools: false })}</div>`);
  }
  doc.innerHTML = parts.join("");
  loadOpenMisc();
  state.chapters = $$(".kapitel", doc);
  state.wholeKey = key;
  buildMiniToc(entries);
  const target = entryById(id) && isVisible(entryById(id)) ? id : entries[0]?.id;
  state.view = { mode: "gesamt", id: target };
  state.currentWhole = null;
  scrollToChapter(target, false);
  if (offset) {
    const container = state.chapters.find((c) => c.dataset.zettel === String(target));
    if (container) window.scrollBy(0, container.getBoundingClientRect().top - (readingLine() - offset));
  }
  trackWhole();
}

function scrollToChapter(id, smooth) {
  const container = state.chapters.find((c) => c.dataset.zettel === String(id));
  if (!container) return;
  const top = container.getBoundingClientRect().top + window.scrollY - readingTop() - 12;
  const far = Math.abs(container.getBoundingClientRect().top) > window.innerHeight * 3;
  window.scrollTo({ top, behavior: smooth && !far ? "smooth" : "auto" });
  if (!smooth || far) trackWhole();
}

function buildMiniToc(entries) {
  const parts = [];
  let lastSection = -1;
  for (const entry of entries) {
    if (entry.section !== lastSection) {
      parts.push(`<div class="m-jahr">${escapeHtml(sectionName(entry))}</div>`);
      lastSection = entry.section;
    }
    parts.push(`<a href="#gesamt/${escapeHtml(entry.id)}" data-id="${escapeHtml(entry.id)}" class="art-${entry.kind}" title="${escapeHtml(entry.title)}">${escapeHtml(entry.title)}</a>`);
  }
  mini.innerHTML = parts.join("");
}

function readingTop() {
  return $("header.bar").getBoundingClientRect().bottom;
}

function readingLine() {
  const top = readingTop();
  return top + Math.min((window.innerHeight - top) * 0.3, 240);
}

function trackWhole() {
  const chapters = state.chapters;
  if (!chapters.length) return;
  const line = readingLine();
  let lo = 0;
  let hi = chapters.length - 1;
  let found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (chapters[mid].getBoundingClientRect().top <= line) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const id = chapters[found].dataset.zettel;
  if (id === state.currentWhole) return;
  state.currentWhole = id;
  state.view = { mode: "gesamt", id };
  const entry = entryById(id);
  markCurrent(id);
  updatePlace(entry);
  $$("a.aktuell", mini).forEach((a) => a.classList.remove("aktuell"));
  const link = mini.querySelector(`a[data-id="${CSS.escape(id)}"]`);
  if (link) {
    link.classList.add("aktuell");
    scrollWithin(mini, link);
  }
  history.replaceState(null, "", `#gesamt/${id}`);
}

// ------------------------------------------------------------------ Lesestand merken

function capturePosition() {
  const v = state.view;
  if (!v) return null;
  if (v.mode === "kapitel") return { mode: "kapitel", id: v.id, scroll: Math.round(window.scrollY) };
  if (v.mode === "gesamt") {
    const container = state.chapters.find((c) => c.dataset.zettel === v.id);
    const offset = container ? Math.round(readingLine() - container.getBoundingClientRect().top) : 0;
    return { mode: "gesamt", id: v.id, offset: Math.max(0, offset) };
  }
  return null;
}

function savePosition() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const position = capturePosition();
    if (position) store.set("position", position);
  }, 400);
}

window.addEventListener("scroll", () => {
  if (scrollQueued) return;
  scrollQueued = true;
  requestAnimationFrame(() => {
    scrollQueued = false;
    if (state.view?.mode === "gesamt") trackWhole();
    savePosition();
  });
}, { passive: true });

// ------------------------------------------------------------------ Bearbeiten

function domToText(node) {
  let out = "";
  for (const child of node.childNodes) {
    if (child.nodeType === 3) {
      out += child.nodeValue;
    } else if (child.nodeType === 1) {
      if (child.tagName === "BR") {
        out += "\n";
      } else if (child.tagName === "DIV" || child.tagName === "P") {
        if (out && !out.endsWith("\n")) out += "\n";
        out += domToText(child);
      } else {
        out += domToText(child);
      }
    }
  }
  return out;
}

const cleanText = (text) => text.replace(/\r\n?/g, "\n").replace(/^\n+|\n+$/g, "");

function insertText(text) {
  if (document.execCommand("insertText", false, text)) return;
  const selection = window.getSelection();
  if (!selection.rangeCount) return;
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

function containerEntry(element) {
  return entryById(element.closest("[data-zettel]")?.dataset.zettel);
}

function setBlockState(block, status, detail = "") {
  if (!block) return;
  block.classList.toggle("wartet", status === "wartet" || status === "lokal");
  block.classList.toggle("konflikt", status === "konflikt" || status === "fehler");
  const label = {
    ungespeichert: " · wird gleich gespeichert",
    speichert: " · speichert …",
    offen: " · gespeichert, wird gleich eingespielt",
    gespeichert: " · gespeichert ✓",
    wartet: " · wartet, bis das Zettelkasten-Programm geschlossen ist",
    ...(quelle?.zustandTexte || {}),
    konflikt: ` · Konflikt: ${detail}`,
    fehler: ` · nicht gespeichert: ${detail}`,
  }[status] || (block.classList.contains("bearbeitet") ? " · bearbeitet" : "");
  const zustand = $(".zustand", block);
  if (zustand) zustand.textContent = label;
}

const chapterContainer = (id) => doc.querySelector(`.kapitel[data-zettel="${CSS.escape(String(id))}"]`);

/** Lage der Absätze nach dem Speichern neu setzen; passt die Zahl nicht mehr, wird neu gesetzt (rerender). */
function respan(box, feld, text, onMismatch) {
  if (!box) return;
  const spans = paragraphSpans(text);
  const blocks = $$(`.blk[data-feld="${feld}"]`, box);
  if (blocks.length !== spans.length) {
    onMismatch();
    return;
  }
  blocks.forEach((b, i) => {
    b.dataset.s = spans[i].start;
    b.dataset.e = spans[i].end;
    const ed = $(".ed", b);
    if (ed?._sitzung) ed._sitzung.start = spans[i].start;
  });
}

function updateEntryText(entry, text) {
  if (entry.text === text) return;
  entry.text = text;
  entry.words = countWords(text);
  state.wholeKey = null;
  respan(chapterContainer(entry.id), "content", text, () => state.rerender.add(entry.id));
}

function updateMisc(entry, text) {
  if (entry.misc === text) return;
  entry.misc = text;
  entry.miscWords = countWords(text);
  state.wholeKey = null;
  respan(chapterContainer(entry.id)?.querySelector("details.vermerke .vermerke-text"), "misc", text,
    () => state.rerenderMisc.add(entry.id));
}

/** Neuer Titel: Inhaltsverzeichnis, Übersicht und Kopfzeile ziehen mit (die Art – Szene usw. – hängt am Titel). */
function updateTitle(entry, text) {
  if (entry.title === text) return;
  const kind = kindOf(text);
  const same = state.book ? state.book.entries.filter((e) => e.id === entry.id) : [];
  for (const e of new Set([entry, ...same])) {
    e.title = text;
    e.kind = kind;
  }
  state.wholeKey = null;
  for (const block of $$(`.kapitel[data-zettel="${CSS.escape(entry.id)}"] .blk[data-feld="title"]`, doc)) block.dataset.e = text.length;
  if (same.length) {
    buildToc();
    for (const link of $$(`a[data-id="${CSS.escape(entry.id)}"]`, mini)) {
      link.textContent = text;
      link.title = text;
      link.classList.remove("art-szene", "art-jahr", "art-sonstiges");
      link.classList.add(`art-${kind}`);
    }
  }
  if (String(state.view?.id) === entry.id) updatePlace(entry.pos ? entry : null, shownTitle(entry));
}

function updateField(entry, feld, text) {
  if (feld === "title") updateTitle(entry, text);
  else if (feld === "misc") updateMisc(entry, text);
  else updateEntryText(entry, text);
}

function rememberEdit(session, nachher) {
  // session.erst: Wortlaut vor der ersten Bearbeitung; session.shown: zuletzt gespeicherter Wortlaut
  state.edited.delete(editKey(session.zettel, session.feld, session.shown));
  if (nachher !== session.erst) state.edited.set(editKey(session.zettel, session.feld, nachher), session.erst);
  session.shown = nachher;
  return nachher !== session.erst;
}

function handleSaveResult(entry, block, session, nachher, result) {
  if (result.stand || result.version) state.version = result.stand || result.version;
  if (result.bearbeitung) updateEditStatus(result.bearbeitung);
  if (result.git) updateGit(result.git); // unterwegs: „Gesichert“, sobald die Änderung auf GitHub ist
  if (result.status === "konflikt") {
    setBlockState(block, "konflikt", result.meldung || "");
    toast("Dieser Absatz wurde inzwischen anderswo geändert", "Deine Fassung ist nicht gespeichert – kopiere sie, bevor du neu lädst.", 12000);
    return;
  }
  if (result.status === "fehler") {
    setBlockState(block, "fehler", result.meldung || "");
    toast("Speichern ist fehlgeschlagen", result.meldung || "", 10000);
    return;
  }
  if (typeof result.text === "string") updateField(entry, session.feld, result.text);
  const marked = rememberEdit(session, nachher);
  if (block?.isConnected) {
    block.classList.toggle("bearbeitet", marked);
    const discard = $('[data-act="verwerfen"]', block);
    if (discard) discard.hidden = !marked;
    // Ein fertiger Titel steht so da, wie er gespeichert ist (eine Zeile, ohne Leerraum am Rand)
    const ed = $(".ed", block);
    if (session.feld === "title" && session.fertig && ed && document.activeElement !== ed && ed.textContent !== entry.title) {
      ed.textContent = entry.title;
    }
  }
  const outcome = result.einspielen?.status;
  if (outcome === "wartet") setBlockState(block, "wartet");
  else if (outcome === "lokal") setBlockState(block, "lokal");
  else if (outcome === "fehler") {
    setBlockState(block, "fehler", result.einspielen.meldung || "");
    toast("Eingespielt werden konnte nicht", result.einspielen.meldung || "", 10000);
  } else if (outcome === "konflikt") setBlockState(block, "konflikt", "siehe Hinweis oben");
  else if (outcome === "gespeichert") setBlockState(block, "gespeichert");
  else if (result.status === "offen") setBlockState(block, "offen");
  else setBlockState(block, null);
}

function save(ed, fertig) {
  const session = ed._sitzung;
  if (!session) return Promise.resolve();
  if (fertig) {
    delete ed._sitzung;
    session.fertig = true;
  }
  const block = ed.closest(".blk");
  const run = async () => {
    const entry = entryById(session.zettel);
    let nachher = cleanText(domToText(ed));
    if (session.feld === "title") {
      nachher = titelZeile(nachher);
      if (!nachher) {
        if (!fertig) return; // ein leerer Titel wird nicht gespeichert
        ed.textContent = session.shown; // zurück zum zuletzt gespeicherten Titel
        nachher = session.shown;
        if (session.shown) toast("Ein Titel darf nicht leer sein", "Der bisherige Titel bleibt stehen.", 5000);
      }
    }
    if (!session.sent && nachher === session.original) {
      setBlockState(block, null);
      return;
    }
    if (!fertig && nachher === session.last) return;
    session.sent = true;
    session.last = nachher;
    setBlockState(block, "speichert");
    state.saving += 1;
    try {
      const result = await quelle.aendern({
        zettel: session.zettel, feld: session.feld, start: session.start, vorher: session.original, nachher,
        sitzung: session.id, fertig,
      });
      handleSaveResult(entry, block, session, nachher, result);
    } catch (err) {
      setBlockState(block, "fehler", err.message);
      toast("Speichern ist fehlgeschlagen", `${err.message} – der Text steht noch im Absatz.`, 10000);
    } finally {
      state.saving -= 1;
    }
  };
  session.chain = (session.chain || Promise.resolve()).then(run, run);
  return session.chain.then(() => { if (fertig) setTimeout(afterEditing, 0); });
}

function afterEditing() {
  if (document.activeElement?.closest?.(".ed")) return;
  if (state.rerender.size) {
    const y = window.scrollY;
    const ids = [...state.rerender];
    state.rerender.clear();
    if (state.view?.mode === "kapitel" && ids.includes(String(state.view.id))) showChapter(state.view.id, { restore: y, toHit: false });
    else if (state.view?.mode === "gesamt") for (const id of ids) replaceWholeChapter(id);
    else if (state.view?.mode === "zettel" && ids.includes(String(state.view.id))) showZettel(state.view.id, { restore: y });
    window.scrollTo(0, y);
  }
  for (const id of state.rerenderMisc) {
    const entry = entryById(id);
    const details = chapterContainer(id)?.querySelector("details.vermerke[data-geladen]");
    if (entry && details) $(".vermerke-text", details).innerHTML = miscHtml(entry, details.dataset.tools === "1");
  }
  state.rerenderMisc.clear();
  if (state.reloadWanted && !state.saving) {
    state.reloadWanted = false;
    poll();
  }
}

function replaceWholeChapter(id) {
  const entry = entryById(id);
  const container = doc.querySelector(`.kapitel[data-zettel="${CSS.escape(String(id))}"]`);
  if (!entry || !container) return;
  hitCounter = 0;
  container.innerHTML = chapterHtml(entry, { level: 2, tools: false });
  loadOpenMisc();
}

doc.addEventListener("focusin", (event) => {
  const ed = event.target.closest?.(".ed");
  if (!ed || ed._sitzung) return;
  const block = ed.closest(".blk");
  const entry = containerEntry(ed);
  if (!entry || !block) return;
  const feld = block.dataset.feld || "content";
  const text = feld === "title" ? entry.title : cleanText(domToText(ed));
  ed._sitzung = { id: uid(), zettel: entry.id, feld, original: text, start: Number(block.dataset.s), sent: false,
    shown: text, erst: state.edited.get(editKey(entry.id, feld, text)) ?? text };
});

const isTitle = (ed) => ed.closest(".blk")?.dataset.feld === "title";

doc.addEventListener("input", (event) => {
  const ed = event.target.closest?.(".ed");
  if (!ed?._sitzung) return;
  setBlockState(ed.closest(".blk"), "ungespeichert");
  clearTimeout(ed._timer);
  ed._timer = setTimeout(() => save(ed, false), 1500);
});

doc.addEventListener("focusout", (event) => {
  const ed = event.target.closest?.(".ed");
  if (!ed) return;
  clearTimeout(ed._timer);
  if (ed._sitzung) save(ed, true);
});

doc.addEventListener("keydown", (event) => {
  const ed = event.target.closest?.(".ed");
  if (!ed) return;
  if (event.key === "Enter" && !event.isComposing) {
    event.preventDefault();
    if (isTitle(ed)) ed.blur(); // ein Titel ist eine Zeile: Enter beendet die Eingabe
    else insertText(event.shiftKey ? "\n\n" : "\n"); // Enter: neue Zeile, Umschalt+Enter: neuer Absatz
  } else if (event.key === "Escape") {
    event.preventDefault();
    ed.blur();
  } else if ((event.ctrlKey || event.metaKey) && ["b", "i", "u"].includes(event.key.toLowerCase())) {
    event.preventDefault(); // keine Formatierungen: die zkn3 kennt hier nur Text
  }
}, true);

doc.addEventListener("paste", (event) => {
  const ed = event.target.closest?.(".ed");
  if (!ed) return;
  event.preventDefault();
  const text = (event.clipboardData?.getData("text/plain") || "").replace(/\r\n?/g, "\n");
  insertText(isTitle(ed) ? text.replace(/\s*\n\s*/g, " ") : text);
});

doc.addEventListener("drop", (event) => {
  if (event.target.closest?.(".ed")) event.preventDefault();
});

window.addEventListener("pagehide", () => {
  const bodies = [];
  for (const ed of $$(".ed")) {
    const session = ed._sitzung;
    if (!session) continue;
    let nachher = cleanText(domToText(ed));
    if (session.feld === "title") nachher = titelZeile(nachher) || session.shown;
    if (nachher === session.original && !session.sent) continue;
    bodies.push({ zettel: session.zettel, feld: session.feld, start: session.start, vorher: session.original, nachher,
      sitzung: session.id, fertig: true });
  }
  if (bodies.length && quelle) quelle.verlassen(bodies);
});

async function discardEdit(entry, block) {
  const ed = $(".ed", block);
  const feld = block.dataset.feld || "content";
  const current = feld === "title" ? entry.title : fieldText(entry, feld).slice(Number(block.dataset.s), Number(block.dataset.e));
  const original = state.edited.get(editKey(entry.id, feld, current));
  if (original === undefined || !ed) return;
  try {
    const result = await quelle.aendern({ zettel: entry.id, feld, start: Number(block.dataset.s), vorher: current,
      nachher: original, sitzung: uid(), fertig: true });
    if (result.status === "konflikt" || result.status === "fehler") {
      toast("Verwerfen ging nicht", result.meldung || "", 9000);
      return;
    }
    if (result.stand || result.version) state.version = result.stand || result.version;
    if (result.bearbeitung) updateEditStatus(result.bearbeitung);
    state.edited.delete(editKey(entry.id, feld, current));
    if (typeof result.text === "string") updateField(entry, feld, result.text);
    if (state.rerender.has(entry.id) || state.rerenderMisc.has(entry.id)) {
      afterEditing();
    } else {
      if (feld === "title") ed.textContent = original;
      else ed.innerHTML = editableHtml(original).html;
      block.classList.remove("bearbeitet");
      $('[data-act="verwerfen"]', block).hidden = true;
      setBlockState(block, null);
    }
    toast("Bearbeitung verworfen", feld === "title" ? "Der Titel steht wieder wie vorher." : "Der Absatz steht wieder wie vorher.");
  } catch (err) {
    toast("Verwerfen ging nicht", err.message, 9000);
  }
}

/** Was „Kopieren“ in die Zwischenablage legt: Überschrift und Text, so wie sie dastehen – ohne Vermerke und Angaben. */
function copyText(container) {
  const title = titelZeile(domToText($('.blk[data-feld="title"] .ed', container)));
  const paragraphs = $$('.blk[data-feld="content"] .ed', container).map((ed) => cleanText(domToText(ed))).filter((p) => p.trim());
  return [title, ...paragraphs].filter(Boolean).join("\n\n");
}

async function toClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // ältere Browser oder keine Erlaubnis: über ein unsichtbares Textfeld
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0";
    document.body.append(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

async function copyChapter(button) {
  const container = button.closest(".kapitel");
  if (!container) return;
  const text = copyText(container);
  if (await toClipboard(text)) {
    button.classList.add("kopiert");
    setTimeout(() => button.classList.remove("kopiert"), 1500);
    const title = text.split("\n", 1)[0];
    toast("Kopiert", `„${title.length > 60 ? `${title.slice(0, 60)} …` : title}“ – Überschrift und Text, ${formatNumber(countWords(text))} Wörter`);
  } else {
    toast("Kopieren ging nicht", "Der Browser hat den Zugriff auf die Zwischenablage verweigert.", 8000);
  }
}

doc.addEventListener("click", (event) => {
  const copy = event.target.closest('[data-act="kopieren"]');
  if (copy) {
    copyChapter(copy);
    return;
  }
  const button = event.target.closest('[data-act="verwerfen"]');
  if (!button) return;
  const entry = containerEntry(button);
  if (entry) discardEdit(entry, button.closest(".blk"));
});

// ------------------------------------------------------------------ Inspektor: Suche, Hinweise

function openInsp(title, where, html, kind) {
  $("#insp-title").textContent = title;
  $("#insp-where").textContent = where || "";
  $("#insp-body").innerHTML = html;
  insp.dataset.art = kind || "";
  insp.hidden = false;
}

function closeInsp() {
  if (insp.hidden) return;
  const wasSearch = insp.dataset.art === "suche";
  insp.hidden = true;
  if (wasSearch) clearSearch();
}

$("#insp-close").addEventListener("click", closeInsp);

// Ein Klick außerhalb schließt die Suche (und andere Einblendungen)
document.addEventListener("click", (event) => {
  if (insp.hidden) return;
  const target = event.target;
  if (insp.contains(target) || target === searchInput || target.closest?.("[data-oeffnet]")) return;
  closeInsp();
});

searchInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    runSearch(searchInput.value);
  } else if (event.key === "Escape") {
    closeInsp();
    clearSearch();
  }
});
searchInput.addEventListener("search", () => { if (!searchInput.value) clearSearch(); });

function runSearch(raw) {
  const term = raw.trim();
  if (term.length < 2) {
    toast("Bitte mindestens zwei Zeichen eingeben.");
    return;
  }
  removeMarks();
  state.term = term;
  state.hitIndex = 0;
  state.wholeKey = null;
  const results = [];
  for (const entry of state.book.entries) {
    const found = findAll(entry.text, term);
    if (found.length) results.push({ entry, found });
  }
  const total = results.reduce((n, r) => n + r.found.length, 0);
  const parts = [`<p class="treffer-kopf">${formatNumber(total)} Treffer in ${formatNumber(results.length)} Kapiteln · <a href="#" id="suche-alle">auch in allen übrigen Zetteln suchen</a></p>`];
  for (const { entry, found } of results) {
    parts.push(`<div class="treffer-kap">${escapeHtml(entry.title)} <span class="hint">${found.length}</span></div>`);
    found.slice(0, 5).forEach((hit, n) => parts.push(`<a class="treffer" href="#kapitel/${escapeHtml(entry.id)}" data-id="${escapeHtml(entry.id)}" data-n="${n}">${snippetHtml(entry.text, hit.index, hit.length)}</a>`));
    if (found.length > 5) parts.push(`<p class="hint">… und ${found.length - 5} weitere in diesem Kapitel</p>`);
  }
  if (!results.length) parts.push('<p class="hint">Im Roman nichts gefunden.</p>');
  parts.push('<div id="suche-weitere"></div>');
  openInsp(`Suche: „${term}“`, "", parts.join(""), "suche");
  refreshView();
}

async function searchOthers() {
  const box = $("#suche-weitere");
  box.innerHTML = '<p class="hint">Suche in allen Zetteln …</p>';
  try {
    const data = await quelle.suche(state.term);
    const others = data.hits.filter((hit) => !state.entriesById.has(hit.id));
    box.innerHTML = `<div class="treffer-kap">Übrige Zettel (${formatNumber(others.length)})</div>` + others.map((hit) => {
      const where = { title: "Titel", content: "Text", misc: "Sonstige Vermerke" }[hit.field] || hit.field;
      return `<a class="treffer" href="#zettel/${escapeHtml(hit.id)}" data-zettel="${escapeHtml(hit.id)}"><b>${escapeHtml(hit.title || `Zettel ${hit.id}`)}</b> <span class="hint">· ${where}</span><br>${escapeHtml(hit.context)}</a>`;
    }).join("");
  } catch (err) {
    box.innerHTML = `<p class="hint">${escapeHtml(err.message)}</p>`;
  }
}

insp.addEventListener("click", (event) => {
  if (event.target.id === "suche-alle") {
    event.preventDefault();
    searchOthers();
    return;
  }
  const link = event.target.closest("a.treffer");
  if (!link) return;
  event.preventDefault();
  $$("a.treffer.aktuell", insp).forEach((a) => a.classList.remove("aktuell"));
  link.classList.add("aktuell");
  state.hitIndex = Number(link.dataset.n || 0);
  if (link.dataset.zettel) go(`zettel/${link.dataset.zettel}`);
  else if (state.view?.mode === "kapitel" && state.view.id === link.dataset.id) scrollToHit(state.hitIndex);
  else go(`kapitel/${link.dataset.id}`);
});

function removeMarks() {
  // Markierungen direkt entfernen – auch in einem Absatz, in dem gerade geschrieben wird
  for (const mark of $$("mark.treffer, mark.treffer-v", doc)) {
    const parent = mark.parentNode;
    mark.replaceWith(...mark.childNodes);
    parent.normalize();
  }
}

function clearSearch() {
  searchInput.value = "";
  if (!state.term) return;
  state.term = "";
  state.wholeKey = null;
  removeMarks();
}

function refreshView() {
  if (document.activeElement?.closest?.(".ed")) return;
  const v = state.view;
  const y = window.scrollY;
  if (v?.mode === "kapitel") showChapter(v.id, { restore: y, toHit: false });
  else if (v?.mode === "gesamt") {
    const position = capturePosition();
    showWhole(position?.id, { offset: position?.offset });
  } else if (v?.mode === "zettel") showZettel(v.id, { restore: y });
}

function updateDesktopButton() {
  const list = state.book.entries.filter((e) => e.desktop);
  const button = $("#btn-schreibtisch");
  button.hidden = list.length === 0;
  button.textContent = `Schreibtisch-Fassungen (${list.length})`;
  button.dataset.oeffnet = "1";
  button.onclick = () => openInsp("Schreibtisch-Fassungen", `${list.length}`,
    `<p class="hint">Diese Kapitel zeigt das Zettelkasten-Programm auf dem Schreibtisch in einer eigenen, eingefrorenen Fassung. Der Reader zeigt immer den Zettel.</p><ul>${list.map((e) => `<li><a href="#kapitel/${escapeHtml(e.id)}">${escapeHtml(e.title)}</a></li>`).join("")}</ul>`);
}

// Hinweise zu wartenden Änderungen, Konflikten und verlorenen Änderungen (nur wenn es welche gibt)
function changeItem(change, actions) {
  const when = change.eingespielt || change.geaendert || change.erstellt;
  const buttons = actions.map(([action, label]) => `<button class="tb" data-aktion="${action}" data-id="${escapeHtml(change.id)}">${label}</button>`).join("");
  const herkunft = change.unterwegs ? ` · ${change.geraet === "Chromebook" ? "vom Chromebook" : "von unterwegs"}` : "";
  const feld = { title: " · Titel", misc: " · Sonstige Vermerke" }[change.feld] || "";
  return `<li><div class="wo">${escapeHtml(formatDate(when))}${herkunft} · <a href="#kapitel/${escapeHtml(change.zettel)}">${escapeHtml(change.titel || `Zettel ${change.zettel}`)}</a>${feld}${change.grund ? ` · ${escapeHtml(change.grund)}` : ""}</div>`
    + `<span class="vorher">${escapeHtml(change.vorher || "")}</span><span class="nachher">${escapeHtml(change.nachher || "(gelöscht)")}</span>${buttons}</li>`;
}

async function openProblems() {
  if (quelle.modus === "github") {
    openGithubInfo();
    return;
  }
  openInsp("Änderungen", "", '<p class="hint">Wird geladen …</p>', "aenderungen");
  try {
    const o = await quelle.aenderungen();
    const parts = [];
    if (o.fehler) parts.push(`<p class="hint">Beim letzten Einspielen: ${escapeHtml(o.fehler)}</p>`);
    if (o.verloren.length) parts.push(`<h4>Fehlen wieder in der zkn3</h4><p class="hint">Diese Änderungen waren eingespielt, stehen aber nicht mehr im Zettel – vermutlich hat das Zettelkasten-Programm einen älteren Stand gespeichert.</p><ul class="aend-liste">${o.verloren.map((c) => changeItem(c, [["erneut", "Erneut einspielen"], ["ignorieren", "Ist in Ordnung"]])).join("")}</ul>`);
    if (o.konflikte.length) parts.push(`<h4>Konflikte</h4><p class="hint">Der Absatz wurde anderswo geändert, deshalb ist deine Fassung nicht eingespielt. Kopiere sie bei Bedarf und verwirf den Eintrag dann.</p><ul class="aend-liste">${o.konflikte.map((c) => changeItem(c, [["verwerfen", "Verwerfen"]])).join("")}</ul>`);
    if (o.offen.length) parts.push(`<h4>Noch nicht in der zkn3</h4><p class="hint">${o.programm ? "Das Zettelkasten-Programm ist geöffnet – sie kommen hinein, sobald du es schließt." : "Sie werden gleich eingespielt."}</p><ul class="aend-liste">${o.offen.map((c) => changeItem(c, [])).join("")}</ul>`);
    if (!parts.length) parts.push('<p class="hint">Alles ist eingespielt.</p>');
    $("#insp-body").innerHTML = parts.join("");
  } catch (err) {
    $("#insp-body").innerHTML = `<p class="hint">${escapeHtml(err.message)}</p>`;
  }
}

insp.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-aktion]");
  if (!button) return;
  button.disabled = true;
  try {
    const result = await quelle.aktion(button.dataset.aktion, button.dataset.id);
    if (!result.ok) toast("Das ging nicht", result.meldung || "", 9000);
    if (result.bearbeitung) updateEditStatus(result.bearbeitung);
    await reloadBook(true);
    await openProblems();
  } catch (err) {
    toast("Das ging nicht", err.message, 9000);
    button.disabled = false;
  }
});

// ------------------------------------------------------------------ Material und Zettel außerhalb der Anordnung

function resolvePath(base, href) {
  try {
    return decodeURIComponent(new URL(href, `http://x/${base}`).pathname.slice(1));
  } catch {
    return href;
  }
}

async function showMaterial(path) {
  setView("material");
  state.view = { mode: "material", path };
  const item = state.material.find((m) => m.path === path);
  updatePlace(null, item?.title || path);
  markCurrentMaterial(path);
  doc.innerHTML = '<p class="leer">Wird geladen …</p>';
  try {
    const text = await quelle.materialText(path);
    doc.innerHTML = `<div class="md"><span class="kap-ort">Material · ${escapeHtml(item?.group ?? "")} · nur lesen</span>${marked.parse(text, { gfm: true })}</div>`;
    for (const a of $$("a[href]", doc)) {
      const href = a.getAttribute("href");
      if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
        a.target = "_blank";
        a.rel = "noopener noreferrer";
      } else if (!href.startsWith("#")) {
        const target = state.material.find((m) => m.path === resolvePath(path, href.split("#")[0]));
        if (target) a.setAttribute("href", `#material/${target.path}`);
        else a.removeAttribute("href");
      }
    }
  } catch (err) {
    doc.innerHTML = `<p class="leer">Die Datei ließ sich nicht laden (${escapeHtml(err.message)}).</p>`;
  }
  window.scrollTo(0, 0);
}

async function showZettel(id, { restore = null } = {}) {
  if (state.entriesById.has(String(id))) {
    history.replaceState(null, "", `#kapitel/${id}`);
    showChapter(id);
    return;
  }
  setView("zettel");
  state.view = { mode: "zettel", id: String(id) };
  doc.innerHTML = '<p class="leer">Wird geladen …</p>';
  try {
    const z = await quelle.zettel(id);
    const entry = { id: z.id, title: z.title, text: z.content, misc: z.misc, kind: z.kind, words: z.words,
      miscWords: z.miscWords, edited: z.edited, pos: null, section: null, desktop: null, comment: "" };
    state.extra.set(entry.id, entry);
    updatePlace(null, shownTitle(entry));
    markCurrent(null);
    hitCounter = 0;
    doc.innerHTML = `<div class="kapitel" data-zettel="${escapeHtml(entry.id)}">${chapterHtml(entry, { level: 1, tools: true })}</div>`;
    loadOpenMisc();
    if (state.term && hitCounter && restore === null) scrollToHit(state.hitIndex);
    else window.scrollTo(0, restore ?? 0);
  } catch (err) {
    doc.innerHTML = `<p class="leer">${escapeHtml(err.message)}</p>`;
  }
}

// ------------------------------------------------------------------ Speicherstand, Sichern, Status

function updateEditStatus(b) {
  state.edit = b;
  const el = $("#speicherstand");
  const n = (count, one, many) => `${count} ${count === 1 ? one : many}`;
  let text = "";
  let cls = "";
  if (b.fehler) { text = `⚠ Speichern gestört: ${b.fehler}`; cls = "problem"; }
  else if (b.konflikte) { text = `⚠ ${n(b.konflikte, "Konflikt", "Konflikte")}`; cls = "problem"; }
  else if (b.verloren) { text = `⚠ ${n(b.verloren, "Änderung fehlt", "Änderungen fehlen")} wieder in der zkn3`; cls = "problem"; }
  else if (b.hochladen) { text = `⏳ ${n(b.hochladen, "Änderung", "Änderungen")} noch nicht auf GitHub – keine Verbindung`; cls = "wartet"; }
  else if (b.programm && b.offen) { text = `⏳ ${n(b.offen, "Änderung wartet", "Änderungen warten")}, bis das Zettelkasten-Programm geschlossen ist`; cls = "wartet"; }
  else if (b.programm) { text = "Zettelkasten-Programm geöffnet – Änderungen warten bis zum Schließen"; cls = "wartet"; }
  else if (b.offen) { text = `${n(b.offen, "Änderung wird", "Änderungen werden")} gleich eingespielt`; cls = "offen"; }
  el.className = `speicherstand ${cls}`;
  el.innerHTML = text ? `<a href="#" data-oeffnet="1" id="zu-aenderungen">${escapeHtml(text)}</a>` : "";
  el.parentElement.hidden = !text; // die Zeile erscheint nur, wenn es etwas zu melden gibt
  hdrHeight();
}

$("#speicherstand").addEventListener("click", (event) => {
  if (event.target.id !== "zu-aenderungen") return;
  event.preventDefault();
  openProblems();
});

function updateGit(git) {
  state.git = git;
  const button = $("#btn-sichern");
  if (!git) return;
  const saved = git.ok && !git.changeCount && !git.ahead;
  // „Gesichert“ nur, wenn wirklich alles auf GitHub ist
  button.textContent = saved ? "Gesichert" : "Sichern";
  if (!git.ok) {
    button.title = `Git meldet ein Problem: ${git.error}`;
    return;
  }
  const last = !git.lastCommit ? ""
    : git.github ? `\nRoman-Stand vom ${formatDate(git.lastCommit.time)} (zuletzt auf dem Laptop gesichert)`
      : `\nZuletzt gesichert: ${formatDate(git.lastCommit.time)} – ${git.lastCommit.subject}`;
  if (saved) {
    button.title = `${git.github ? "Alle Änderungen von hier sind auf GitHub." : "Alles ist auf GitHub gesichert."}${last}`;
  } else {
    const files = git.changes.slice(0, 12).map((c) => `• ${c.path}`).join("\n");
    button.title = `Noch nicht auf GitHub:\n${files}${git.changeCount > 12 ? `\n… und ${git.changeCount - 12} weitere` : ""}${git.ahead ? `\n${git.ahead} Sicherung(en) noch nicht hochgeladen` : ""}${last}`;
  }
}

async function sichern() {
  const button = $("#btn-sichern");
  if (quelle.modus === "github" && state.git?.ok && !state.git.changeCount) {
    openGithubInfo(); // alles oben: zeigen, wie es steht
    return;
  }
  button.disabled = true;
  button.textContent = "Sichere …";
  try {
    const result = await quelle.sichern();
    toast(result.message, result.detail || result.committed || "", result.ok ? 4500 : 10000);
    if (result.git) state.git = result.git;
  } catch (err) {
    toast("Sichern ist fehlgeschlagen", err.message, 10000);
  } finally {
    button.disabled = false;
    updateGit(state.git);
  }
}

function toast(title, detail = "", ms = 3500) {
  toastEl.innerHTML = `${escapeHtml(title)}${detail ? `<small>${escapeHtml(detail)}</small>` : ""}`;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, ms);
}

function schedulePoll(ms) {
  clearTimeout(pollTimer);
  const pause = quelle.pause;
  pollTimer = setTimeout(poll, ms ?? (document.hidden ? pause.versteckt : state.online ? pause.sichtbar : pause.offline));
}

async function poll() {
  clearTimeout(pollTimer);
  try {
    const status = await quelle.status();
    if (!state.online) toast(quelle.texte.wieder);
    state.online = true;
    updateGit(status.git);
    if (status.bearbeitung) updateEditStatus(status.bearbeitung);
    if (status.error && status.error !== state.lastError) toast(status.error, "", 8000);
    state.lastError = status.error;
    const stand = status.stand || status.version;
    if (stand && state.book && stand !== state.version) {
      if (document.activeElement?.closest?.(".ed") || state.saving) state.reloadWanted = true;
      else await reloadBook(false, status);
    }
  } catch (err) {
    if (err?.zugang) {
      zeigeEinrichtung(err.message);
      return;
    }
    if (state.online) toast(...quelle.texte.offline, 8000);
    state.online = false;
  }
  schedulePoll();
}

async function reloadBook(quiet, status = null) {
  const position = capturePosition();
  const y = window.scrollY;
  await loadBook();
  const v = state.view;
  if (v?.mode === "kapitel") showChapter(entryById(v.id) ? v.id : state.book.entries[0].id, { restore: y, toHit: false });
  else if (v?.mode === "gesamt") showWhole(position?.id, { offset: position?.offset });
  else if (v?.mode === "zettel") showZettel(v.id, { restore: y });
  if (!quiet) toast("Neuer Stand des Romans geladen", status?.modified ? `gespeichert ${formatDate(status.modified)}` : "");
}

document.addEventListener("visibilitychange", () => {
  if (!quelle || !state.book) return;
  // Unterwegs endet eine Eingabe, wenn die Seite in den Hintergrund geht (Deckel zu): dann wird hochgeladen.
  if (document.hidden && quelle.modus === "github") document.activeElement?.closest?.(".ed")?.blur();
  if (!document.hidden) poll();
  else schedulePoll();
});

// ------------------------------------------------------------------ Unterwegs: Zugang einrichten, Stand auf GitHub

function zeigeEinrichtung(meldung = "", { auswahl = [], frageRepo = false, schluessel = "" } = {}) {
  clearTimeout(pollTimer);
  closeInsp();
  setView("other");
  state.view = { mode: "other" };
  document.body.dataset.einrichten = "1";
  $("#ort").textContent = "";
  const repoFeld = auswahl.length
    ? `<label>Repository <select id="repo">${auswahl.map((r) => `<option>${escapeHtml(r)}</option>`).join("")}</select></label>`
    : frageRepo ? '<label>Repository <input type="text" id="repo" placeholder="name/repository" autocomplete="off" spellcheck="false"></label>' : "";
  doc.innerHTML = `<div class="einrichten">
    <h2>Den Roman hier öffnen</h2>
    <p>Der Reader lädt den Roman aus deinem privaten GitHub-Repository – so, wie du ihn zuletzt auf dem Laptop mit „Sichern“ hochgeladen hast. Was du hier schreibst, kommt in die zkn3, sobald der Reader auf dem Laptop läuft.</p>
    <p>Dafür braucht er einmal einen Zugangsschlüssel:</p>
    <ol>
      <li><a href="${escapeHtml(quelle.schluesselLink)}" target="_blank" rel="noopener noreferrer">Schlüssel bei GitHub anlegen</a> (Name, Laufzeit und Berechtigung sind schon ausgefüllt). Unter <b>Repository access</b> wählst du <b>Only select repositories</b> und dort dein Roman-Repository, dann ganz unten <b>Generate token</b>.</li>
      <li>Den angezeigten Schlüssel kopieren und hier einfügen:</li>
    </ol>
    <form id="verbinden" autocomplete="off">
      <input type="text" id="schluessel" class="verdeckt" placeholder="github_pat_…" spellcheck="false" aria-label="Zugangsschlüssel" value="${escapeHtml(schluessel)}">
      ${repoFeld}
      <button class="btn primary" type="submit">Verbinden</button>
    </form>
    ${meldung ? `<p class="problem" role="alert">${escapeHtml(meldung)}</p>` : ""}
    <p class="hint">Der Schlüssel bleibt nur in diesem Browser gespeichert.</p>
  </div>`;
  $("#verbinden").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("#verbinden button");
    const token = $("#schluessel").value;
    button.disabled = true;
    button.textContent = "Verbinde …";
    const result = await quelle.verbinden(token, $("#repo")?.value || "");
    if (result.ok) {
      location.reload();
      return;
    }
    zeigeEinrichtung(result.meldung, { auswahl: result.auswahl || [], frageRepo: result.frageRepo, schluessel: token });
  });
}

async function openGithubInfo() {
  openInsp("Auf GitHub", "", '<p class="hint">Wird geladen …</p>', "github");
  try {
    const o = await quelle.aenderungen();
    const parts = [`<p>Roman-Stand vom ${escapeHtml(formatDate(o.stand.datum) || "?")} – so wurde er zuletzt auf dem Laptop gesichert.</p>`];
    if (o.fehler) parts.push(`<p class="hint">Beim letzten Hochladen: ${escapeHtml(o.fehler)}</p>`);
    if (o.hochladen.length) {
      parts.push(`<h4>Noch nicht auf GitHub</h4><p class="hint">Sie sind auf diesem Gerät gespeichert.</p><ul class="aend-liste">${o.hochladen.map((c) => changeItem(c, [])).join("")}</ul>`
        + '<p><button class="tb" data-github="hochladen">Jetzt hochladen</button></p>');
    }
    if (o.konflikte.length) {
      parts.push(`<h4>Konflikte</h4><p class="hint">Der Absatz wurde auf dem Laptop geändert, deshalb kommt deine Fassung nicht in die zkn3. Kopiere sie bei Bedarf; den Eintrag verwirfst du im Reader auf dem Laptop.</p><ul class="aend-liste">${o.konflikte.map((c) => changeItem(c, [])).join("")}</ul>`);
    }
    if (o.offen.length) {
      parts.push(`<h4>Auf GitHub, noch nicht in der zkn3</h4><p class="hint">Sie kommen hinein, sobald der Reader auf dem Laptop läuft. Bis dahin zeigt der Reader hier sie schon an.</p><ul class="aend-liste">${o.offen.map((c) => changeItem(c, [])).join("")}</ul>`);
    }
    if (!o.hochladen.length && !o.konflikte.length && !o.offen.length) parts.push('<p class="hint">Alle Änderungen von hier sind in der zkn3.</p>');
    parts.push('<p class="abmelden"><button class="tb" data-github="abmelden">Zugangsschlüssel auf diesem Gerät löschen</button></p>');
    $("#insp-body").innerHTML = parts.join("");
  } catch (err) {
    $("#insp-body").innerHTML = `<p class="hint">${escapeHtml(err.message)}</p>`;
  }
}

insp.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-github]");
  if (!button) return;
  if (button.dataset.github === "hochladen") {
    await sichern();
    if (!insp.hidden) openGithubInfo();
  } else if (button.dataset.github === "abmelden") {
    const o = await quelle.aenderungen();
    if (o.hochladen.length) {
      toast("Erst hochladen", `${o.hochladen.length === 1 ? "Eine Änderung ist" : `${o.hochladen.length} Änderungen sind`} noch nicht auf GitHub.`, 8000);
      return;
    }
    if (!window.confirm("Den Zugangsschlüssel auf diesem Gerät löschen? Danach brauchst du hier einen neuen.")) return;
    quelle.abmelden();
    location.reload();
  }
});

// ------------------------------------------------------------------ Bedienelemente

function wireUi() {
  $("#views").addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    go(`${button.dataset.view}/${currentEntryId()}`);
  });
  $("#toggles").addEventListener("change", (event) => {
    const box = event.target;
    if (!box.dataset.t) return;
    settings[box.dataset.t] = box.checked;
    saveSettings();
    applySettings();
    if (box.dataset.t === "szenen") {
      state.wholeKey = null;
      refreshView();
    }
  });
  $("#inhalt-knopf").addEventListener("click", () => setTocOpen(!tocOpen()));
  $("#vor").addEventListener("click", () => navigate(-1));
  $("#weiter").addEventListener("click", () => navigate(1));
  $("#btn-sichern").addEventListener("click", sichern);

  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target;
    if (event.key === "Escape") closeInsp();
    if (target.closest?.(".ed") || target.matches?.("input, textarea, select")) return;
    if (event.key === "ArrowLeft" && state.view?.mode === "kapitel") { navigate(-1); event.preventDefault(); }
    else if (event.key === "ArrowRight" && state.view?.mode === "kapitel") { navigate(1); event.preventDefault(); }
    else if (event.key === "/") { event.preventDefault(); searchInput.focus(); searchInput.select(); }
  });
  window.addEventListener("hashchange", () => route());
  window.addEventListener("resize", () => {
    hdrHeight();
    if (settings.inhaltOffen === null) applySettings();
  });
}

// ------------------------------------------------------------------ Start

async function init() {
  wireUi();
  applySettings();
  quelle = await waehleQuelle();
  if (LOKALER_RECHNER) { // für die Tests
    window.romanQuelle = quelle;
    window.romanPruefen = () => poll();
  }
  if (quelle.modus === "github") {
    document.body.classList.add("unterwegs");
    $("#btn-sichern").dataset.oeffnet = "1";
    $("#btn-sichern").title = "Änderungen von hier auf GitHub";
  }
  if (!(await quelle.bereit())) {
    zeigeEinrichtung();
    return;
  }
  try {
    // Unterwegs braucht das Material eigene Downloads – das Inhaltsverzeichnis bekommt es nach.
    await Promise.all([loadBook(), quelle.modus === "lokal" ? loadMaterial() : null]);
  } catch (err) {
    if (err?.zugang) {
      zeigeEinrichtung(err.message);
      return;
    }
    const neu = quelle.modus === "github" ? ' <button class="btn" type="button" id="neu-einrichten">Zugang neu einrichten</button>' : "";
    doc.innerHTML = `<p class="leer">Der Roman ließ sich nicht laden: ${escapeHtml(err.message)} <button class="btn" type="button" id="neu-laden">Noch einmal versuchen</button>${neu}</p>`;
    $("#neu-laden").addEventListener("click", () => location.reload());
    $("#neu-einrichten")?.addEventListener("click", () => zeigeEinrichtung());
    if (quelle.modus === "lokal") schedulePoll();
    return;
  }
  if (quelle.modus !== "lokal") loadMaterial();
  await route();
  document.body.dataset.bereit = "1";
  poll();
}

init();
