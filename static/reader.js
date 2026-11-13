// Reader für den Roman – Grundlage ist überarbeitung33.html.
// Lesen und Bearbeiten: Der Text eines Zettels steht als durchgehender Text da und ist direkt
// beschreibbar – ebenso Titel, Sonstige Vermerke und das Material (Handlung, Figuren …).
// Fett, kursiv, unterstrichen, durchgestrichen und Farben werden mit den Codes des
// Zettelkasten-Programms gespeichert (format.js). Absatznummern stehen nur am Rand.
// Auf dem Laptop wird über den lokalen Dienst gespeichert (Schreibwerkzeug mit Sicherungskopie
// und Änderungsbuch; solange das Zettelkasten-Programm geöffnet ist, warten die Änderungen).
// Unterwegs (Chromebook) kommen Text und Änderungen über GitHub – siehe daten.js.
import {
  escapeHtml, findAll, snippetHtml, formatNumber, formatDate, readingMinutes, KIND_LABELS,
  paragraphSpans, countWords, bookTitle,
} from "./textsatz.js";
import { marked } from "./vendor/marked.esm.js";
import { LOKALER_RECHNER, waehleQuelle } from "./daten.js";
import { cleanNachher, titelZeile, zeilenAenderung } from "./aenderung.js";
import { kindOf } from "./zkn3.js";
import { FARBEN, OHNE_FARBE, domLesen, feldHtml, klartext, zerlege, zusammensetzen } from "./format.js";
import { exportHtml, exportName, leseExport } from "./export.js";
import { Verlauf, anwenden, schrittVon } from "./verlauf.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const doc = $("#doc");
const tocEl = $("#inhalt-liste");
const tocPanel = $("#inhalt");
const insp = $("#insp");
const toastEl = $("#toast");
const errorBox = $("#fehler");
const searchInput = $("#suche");
const leiste = $("#schreibleiste");

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
      return true;
    } catch {
      return false; // ohne Speicher geht es auch (nur die Rettungskopie fehlt dann)
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
  leistePlatz();
}

function wideScreen() {
  return window.innerWidth >= 1100;
}

// Handy (schmaler Bildschirm): eine Zeile oben, der Rest im Menü „⋯“, die Schreibleiste unten
const handyAnsicht = window.matchMedia("(max-width: 640px)");
const istHandy = () => handyAnsicht.matches;
let tocSchmalOffen = false; // in schmalen Fenstern liegt das Inhaltsverzeichnis über dem Text: anfangs zu

function tocOpen() {
  return wideScreen() ? (settings.inhaltOffen ?? true) : tocSchmalOffen;
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
  if (wideScreen()) {
    settings.inhaltOffen = open;
    saveSettings();
  } else {
    tocSchmalOffen = open;
  }
  applySettings();
  if (open) markCurrent(state.view?.id);
  setTimeout(nummernSichtbare, 250); // die Breite des Blatts ändert sich
}

// ------------------------------------------------------------------ Zustand

const state = {
  book: null,
  version: null,
  entriesById: new Map(),
  extra: new Map(), // Zettel außerhalb der Anordnung, die gerade angezeigt werden
  material: [],
  materialText: null, // Text der gerade angezeigten Material-Datei
  materialNeu: false, // gespeichert, aber noch nicht neu gesetzt (ein anderer Block stand offen)
  view: null, // { mode, id | path }
  term: "",
  hitIndex: 0,
  git: null,
  edit: null,
  online: true,
  wholeKey: null,
  chapters: [],
  currentWhole: null,
  openMisc: new Set(), // Zettel, deren Sonstige Vermerke aufgeklappt sind
  saving: 0,
  sichernLaeuft: false,
  reloadWanted: false,
  lastError: null,
  title: "Roman",
};

// Bearbeitbare Felder eines Zettels: content (Text), title (Titel), misc (Sonstige Vermerke)
const fkey = (zettel, feld) => `${zettel}\u0000${feld}`;
const FELD_NAMEN = { content: "Text", misc: "Sonstige Vermerke", title: "Titel" };
const LEER_HINWEIS = {
  content: "Noch kein Text – hineinklicken und schreiben",
  misc: "Noch keine Vermerke – hineinklicken und schreiben",
  title: "(ohne Titel)",
};

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

// In der Gesamtansicht springt ein Klick an den Kapitelanfang – auch auf das schon markierte Kapitel
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
  versteckeLeiste();
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
  $("#vor").disabled = mode !== "kapitel";
  $("#weiter").disabled = mode !== "kapitel";
  if (mode !== "gesamt") {
    state.wholeKey = null;
    state.chapters = [];
  }
  if (mode !== "material") {
    state.materialText = null;
    state.materialNeu = false;
  }
  nummernSicht.disconnect();
  sichtbar.clear();
}

function currentEntryId() {
  if (state.view?.id && state.entriesById.has(String(state.view.id))) return state.view.id;
  const saved = store.get("position", null);
  if (saved && state.entriesById.has(saved.id)) return saved.id;
  return state.book.entries[0]?.id;
}

function updatePlace(entry, title) {
  // auf dem Handy steht nur der Titel da (der Abschnitt davor kostet dort zu viel Platz)
  if (entry) $("#ort").innerHTML = `<span class="ort-abschnitt">${escapeHtml(sectionName(entry))} · </span>${escapeHtml(entry.title)}`;
  else $("#ort").textContent = title || "";
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

// Über einem Feld steht nur dann etwas, wenn es ein Problem gibt (Konflikt, nicht gespeichert,
// Programm offen). Wie es um das Hochladen steht, zeigt der Knopf oben rechts.
function toolbarHtml(feld) {
  return `<div class="blk-tools"><span class="tag">${FELD_NAMEN[feld]}<span class="zustand"></span></span>`
    + `<button type="button" class="tb" data-act="durchsetzen" hidden>Meine Fassung speichern</button>`
    + `<button type="button" class="tb" data-act="verwerfen" hidden>Meine Fassung verwerfen</button></div>`;
}

function titleHtml(entry, tag) {
  const titel = sitzungText(entry, "title") ?? entry.title;
  return `<div class="titelzeile"><div class="blk titel" data-feld="title">`
    + `${toolbarHtml("title")}<${tag} class="text ed" contenteditable="true" spellcheck="true" data-leer="${LEER_HINWEIS.title}">${escapeHtml(titel)}</${tag}></div>`
    + `<button type="button" class="kopieren" data-act="kopieren" title="Überschrift und Text kopieren (ohne Vermerke)" aria-label="Überschrift und Text kopieren">${COPY_ICON}</button></div>`;
}

/** Inhalt eines Feldes für den Browser (Text formatiert, Vermerke als reiner Text). */
function feldInnen(entry, feld, startIndex = 0) {
  const text = sitzungText(entry, feld) ?? fieldText(entry, feld);
  const misc = feld === "misc";
  const { html, hits } = feldHtml(text, { term: state.term, startIndex, markClass: misc ? "treffer-v" : "treffer", formate: feld === "content" });
  // Endet der Text mit einem Zeilenumbruch, braucht die letzte (leere) Zeile einen Platzhalter
  return { html: html + (text.endsWith("\n") ? '<br data-ende="">' : ""), hits };
}

/** Ein ganzes Feld als ein durchgehender, beschreibbarer Text. */
function feldBlockHtml(entry, feld) {
  const { html, hits } = feldInnen(entry, feld, feld === "content" ? hitCounter : 0);
  if (feld === "content") hitCounter += hits;
  return `<div class="blk feld" data-feld="${feld}">${toolbarHtml(feld)}`
    + (feld === "content" ? '<div class="nummern" aria-hidden="true"></div>' : "")
    + `<div class="text ed" contenteditable="true" spellcheck="true" data-leer="${LEER_HINWEIS[feld]}">${html}</div></div>`;
}

function vermerkeSumme(entry) {
  return entry.miscWords ? "Sonstige Vermerke" : "Sonstige Vermerke (keine)";
}

function headingHtml(entry, level) {
  const meta = [
    entry.pos ? sectionName(entry) : "nicht in der Anordnung",
    KIND_LABELS[entry.kind],
    `${formatNumber(entry.words)} Wörter`,
    entry.words >= 300 ? `ca. ${readingMinutes(entry.words)} Min.` : null,
    `Zettel ${entry.id}`,
    entry.edited ? `geändert ${formatDate(entry.edited, false)}` : null,
  ].filter(Boolean).join(" · ");
  const tag = level === 1 ? "h2" : "h3";
  // Aufgeklappt bleibt aufgeklappt, auch wenn das Kapitel neu gesetzt wird
  const open = state.openMisc.has(entry.id);
  const known = open && entry.misc !== undefined;
  const vermerke = `<details class="vermerke${entry.miscWords ? "" : " leer"}" data-id="${escapeHtml(entry.id)}"${open ? " open" : ""}${known ? ' data-geladen="1"' : ""}>`
    + `<summary>${vermerkeSumme(entry)}</summary><div class="vermerke-text">${known ? feldBlockHtml(entry, "misc") : '<p class="hint">Wird geladen …</p>'}</div></details>`;
  return `<section class="blk kind-heading lvl-${level}"><span class="kap-ort">${escapeHtml(meta)}</span>${titleHtml(entry, tag)}${vermerke}${desktopNote(entry)}</section>`;
}

function chapterHtml(entry, level) {
  return headingHtml(entry, level) + feldBlockHtml(entry, "content");
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
  doc.innerHTML = `<div class="kapitel" data-zettel="${escapeHtml(entry.id)}">${chapterHtml(entry, 1)}</div>${navHtml(entry)}`;
  bindeSitzungen();
  loadOpenMisc();
  markCurrent(entry.id);
  updatePlace(entry);
  if (toHit && state.term && hitCounter) scrollToHit(state.hitIndex);
  else window.scrollTo(0, restore ?? 0);
  nummernAlle();
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
  // Ein Treffer kann aus mehreren Stücken bestehen (etwa halb fett): alle tragen dieselbe Nummer
  const mark = doc.querySelector(`mark.treffer[data-n="${Number(n)}"]`) || marks[marks.length - 1];
  marks.forEach((m) => m.classList.remove("aktiv"));
  $$(`mark.treffer[data-n="${mark.dataset.n}"]`, doc).forEach((m) => m.classList.add("aktiv"));
  mark.scrollIntoView({ block: "center" });
}

// Sonstige Vermerke (misc) erst beim Aufklappen laden – danach beschreibbar wie der Text
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
    box.innerHTML = feldBlockHtml(entry, "misc");
    bindeSitzungen(box);
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
  const blank = (entry.text.match(/\n(?=[ \t]*\n)/g) || []).length;
  return Math.round(entry.words * 2.1 + blank * 28 + 170);
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
    parts.push(`<div class="kapitel" data-zettel="${escapeHtml(entry.id)}" style="content-visibility:auto;contain-intrinsic-size:auto ${estimateHeight(entry)}px">${chapterHtml(entry, 2)}</div>`);
  }
  doc.innerHTML = parts.join("");
  bindeSitzungen();
  loadOpenMisc();
  state.chapters = $$(".kapitel", doc);
  state.wholeKey = key;
  const target = entryById(id) && isVisible(entryById(id)) ? id : entries[0]?.id;
  state.view = { mode: "gesamt", id: target };
  state.currentWhole = null;
  const container = state.chapters.find((c) => c.dataset.zettel === String(target));
  if (container && offset) {
    // gemerkte Lesestelle: so weit im Kapitel, wie zuletzt gelesen
    const goal = () => readingLine() - offset;
    window.scrollBy(0, container.getBoundingClientRect().top - goal());
    settleOn(container, goal);
  } else {
    scrollToChapter(target, false);
  }
  trackWhole();
  nummernAlle();
}

const chapterGoal = () => readingTop() + 12; // Kapitelanfang knapp unter der Kopfleiste

function scrollToChapter(id, smooth) {
  const container = state.chapters.find((c) => c.dataset.zettel === String(id));
  if (!container) return;
  const top = container.getBoundingClientRect().top + window.scrollY - chapterGoal();
  const far = Math.abs(container.getBoundingClientRect().top) > window.innerHeight * 3;
  if (smooth && !far) {
    stopSettling();
    const run = settleRun;
    window.scrollTo({ top, behavior: "smooth" });
    afterSmoothScroll(() => { if (run === settleRun) settleOn(container, chapterGoal); }); // nicht, wenn inzwischen selbst gescrollt
  } else {
    window.scrollTo({ top, behavior: "auto" });
    trackWhole();
    settleOn(container, chapterGoal);
  }
}

// In der Gesamtansicht haben Kapitel außerhalb des Bildes nur eine geschätzte Höhe. Nach einem
// Sprung setzt der Browser die Nachbarn des Ziels wirklich – ist eins davon länger oder kürzer
// als geschätzt, verrutscht das Ziel. Darum wird die Stelle danach nachgeführt, bis sie steht.
// Scrollt man selbst, hört das sofort auf.
let settleRun = 0;
function stopSettling() {
  settleRun += 1;
}

function settleOn(container, goal) {
  const run = ++settleRun;
  let quiet = 0;
  let frames = 0;
  const step = () => {
    if (run !== settleRun || !container.isConnected || state.view?.mode !== "gesamt") return;
    const delta = Math.round(container.getBoundingClientRect().top - goal());
    if (Math.abs(delta) > 1) {
      window.scrollBy(0, delta);
      quiet = 0;
    } else {
      quiet += 1;
    }
    frames += 1;
    if (quiet < 4 && frames < 60) requestAnimationFrame(step);
    else trackWhole();
  };
  requestAnimationFrame(step);
}

function afterSmoothScroll(fn) {
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    window.removeEventListener("scrollend", finish);
    fn();
  };
  window.addEventListener("scrollend", finish);
  setTimeout(finish, 1500); // Browser ohne „scrollend“
}

for (const type of ["wheel", "touchstart", "mousedown"]) window.addEventListener(type, stopSettling, { passive: true });
window.addEventListener("keydown", (event) => {
  if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) stopSettling();
});

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
  markCurrent(id); // das Inhaltsverzeichnis links zeigt, wo man gerade liest
  updatePlace(entryById(id));
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

// ------------------------------------------------------------------ Absatznummern (nur am Rand)
// Der Text steht durchgehend da; die Nummern werden daneben gesetzt, wo ein Absatz beginnt
// (ein Absatz ist eine Folge nicht leerer Zeilen – wie beim Schreibwerkzeug und für den Agenten).

const sichtbar = new Set();
const nummernSicht = new IntersectionObserver((items) => {
  for (const item of items) {
    if (item.isIntersecting) {
      sichtbar.add(item.target);
      if (!item.target.dataset.nummern) nummernSetzen(item.target);
    } else {
      sichtbar.delete(item.target);
    }
  }
}, { rootMargin: "800px 0px" });

function textStellen(ed) {
  const stellen = []; // [Textknoten, Beginn im Klartext]
  let plain = "";
  const walker = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === 3) {
      stellen.push([node, plain.length]);
      plain += node.nodeValue;
    } else if (node.tagName === "BR" && !node.hasAttribute("data-ende")) {
      plain += "\n";
    }
  }
  return { stellen, plain };
}

function knotenBei(stellen, offset) {
  let lo = 0;
  let hi = stellen.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (stellen[mid][1] <= offset) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  // Ein Knoten, der genau hier endet, gehört nicht dazu (dann der nächste mit Text)
  while (found >= 0 && found < stellen.length - 1 && offset >= stellen[found][1] + stellen[found][0].length) found += 1;
  return found >= 0 ? stellen[found] : null;
}

function nummernSetzen(block) {
  const gutter = $(".nummern", block);
  const ed = $(".ed", block);
  if (!gutter || !ed) return;
  if (!settings.nummern || window.innerWidth <= 760) {
    gutter.textContent = "";
    delete block.dataset.nummern;
    return;
  }
  block.dataset.nummern = "1";
  const { stellen, plain } = textStellen(ed);
  const oben = block.getBoundingClientRect().top;
  const range = document.createRange();
  const teile = [];
  paragraphSpans(plain).forEach((span, i) => {
    const found = knotenBei(stellen, span.start);
    if (!found) return;
    const [node, beginn] = found;
    const at = Math.max(0, Math.min(span.start - beginn, node.length - 1));
    range.setStart(node, at);
    range.setEnd(node, Math.min(at + 1, node.length));
    const rect = range.getClientRects()[0] || range.getBoundingClientRect();
    teile.push(`<span style="top:${Math.round(rect.top - oben)}px">${i + 1}</span>`);
  });
  gutter.innerHTML = teile.join("");
}

function nummernAlle() {
  const bloecke = $$('.blk.feld[data-feld="content"]', doc);
  if (!settings.nummern) {
    for (const block of bloecke) nummernSetzen(block);
    return;
  }
  if (state.view?.mode === "gesamt") {
    for (const block of bloecke) nummernSicht.observe(block);
  } else {
    for (const block of bloecke) nummernSetzen(block);
  }
}

function nummernSichtbare() {
  if (!settings.nummern) return;
  if (state.view?.mode === "gesamt") for (const block of sichtbar) nummernSetzen(block);
  else for (const block of $$('.blk.feld[data-feld="content"]', doc)) nummernSetzen(block);
}

const nummernTimer = new WeakMap();
function nummernBald(block) {
  if (!settings.nummern || !block) return;
  clearTimeout(nummernTimer.get(block));
  nummernTimer.set(block, setTimeout(() => nummernSetzen(block), 350));
}

// ------------------------------------------------------------------ Bearbeiten

const feldVonEd = (ed) => ed.closest(".blk")?.dataset.feld || "content";

/** Was im Feld steht: Text mit Formatcodes (Text), sonst reiner Text; ein Titel als eine Zeile. */
function edText(ed) {
  const feld = feldVonEd(ed);
  const text = domLesen(ed, { formate: feld === "content" });
  return feld === "title" ? titelZeile(text) : text;
}

function containerEntry(element) {
  return entryById(element.closest("[data-zettel]")?.dataset.zettel);
}

/** Endet der Text mit einer leeren Zeile, braucht sie einen Platzhalter, sonst ist sie unsichtbar. */
function ensureEnde(ed) {
  // Ein Platzhalter mitten im Text (dahinter wurde weitergeschrieben) ist eine echte Zeile
  for (const br of $$("br[data-ende]", ed)) {
    if (br !== ed.lastChild) br.replaceWith(document.createTextNode("\n"));
  }
  const last = ed.lastChild;
  const hat = last?.nodeType === 1 && last.tagName === "BR" && last.hasAttribute("data-ende");
  const endetLeer = domLesen(ed, { formate: false }).endsWith("\n");
  if (endetLeer && !hat) {
    const br = document.createElement("br");
    br.setAttribute("data-ende", "");
    ed.append(br);
  } else if (!endetLeer && hat) {
    last.remove();
  }
}

function insertText(text) {
  if (!document.execCommand("insertText", false, text)) {
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
}

/** Zustand eines Feldes: sichtbar nur, wenn etwas nicht stimmt (sonst zeigt der Knopf oben, wie es steht). */
function setBlockState(block, status, detail = "") {
  if (!block) return;
  block.dataset.zustand = status || "";
  block.classList.toggle("wartet", status === "wartet");
  block.classList.toggle("konflikt", status === "konflikt" || status === "fehler" || status === "nichtGespeichert");
  const label = {
    wartet: " · wartet, bis das Zettelkasten-Programm geschlossen ist",
    nichtGespeichert: ` · NOCH NICHT GESPEICHERT – ${quelle?.texte?.nichtErreichbar || "keine Verbindung"}; dein Text bleibt hier und wird von selbst gespeichert`,
    konflikt: ` · NICHT GESPEICHERT, Konflikt: ${detail} Dein Text bleibt hier.`,
    fehler: ` · nicht gespeichert: ${detail}`,
  }[status] || "";
  const zustandEl = $(":scope > .blk-tools .zustand", block);
  if (zustandEl) zustandEl.textContent = label;
  const durchsetzen = $(':scope > .blk-tools [data-act="durchsetzen"]', block);
  if (durchsetzen) durchsetzen.hidden = status !== "konflikt";
  const verwerfen = $(':scope > .blk-tools [data-act="verwerfen"]', block);
  if (verwerfen) verwerfen.hidden = status !== "konflikt";
}

const chapterContainer = (id) => doc.querySelector(`.kapitel[data-zettel="${CSS.escape(String(id))}"]`);

function updateEntryText(entry, text) {
  if (entry.text === text) return;
  entry.text = text;
  entry.words = countWords(text);
  state.wholeKey = null;
}

function updateMisc(entry, text) {
  if (entry.misc === text) return;
  entry.misc = text;
  entry.miscWords = countWords(text);
  state.wholeKey = null;
  const details = chapterContainer(entry.id)?.querySelector("details.vermerke");
  if (details) {
    details.classList.toggle("leer", !entry.miscWords);
    $("summary", details).textContent = vermerkeSumme(entry);
  }
}

/** Neuer Titel: Inhaltsverzeichnis und Kopfzeile ziehen mit (die Art – Szene usw. – hängt am Titel). */
function updateTitle(entry, text) {
  if (entry.title === text) return;
  const kind = kindOf(text);
  const same = state.book ? state.book.entries.filter((e) => e.id === entry.id) : [];
  for (const e of new Set([entry, ...same])) {
    e.title = text;
    e.kind = kind;
  }
  state.wholeKey = null;
  if (same.length) buildToc();
  if (String(state.view?.id) === entry.id) updatePlace(entry.pos ? entry : null, shownTitle(entry));
}

function updateField(entry, feld, text) {
  if (feld === "title") updateTitle(entry, text);
  else if (feld === "misc") updateMisc(entry, text);
  else updateEntryText(entry, text);
}

/** Die Änderung einer Eingabe: beim Titel der ganze Titel, sonst die geänderten Zeilen. */
function aenderungVon(session, jetzt) {
  if (session.feld === "title") return jetzt === session.raw ? null : { start: 0, vorher: session.raw, nachher: jetzt };
  return zeilenAenderung(session.raw, session.basis, jetzt);
}

const gleicheAenderung = (a, b) => Boolean(a && b) && a.start === b.start && a.vorher === b.vorher && a.nachher === b.nachher;

// ------------------------------------------------------------------ Sitzungen: Getipptes geht nicht verloren
// Eine Sitzung gehört zu einem Feld (Text, Vermerke oder Titel eines Zettels) – vom ersten
// Hineinklicken, bis der Text nachweislich gespeichert ist. Solange sie besteht:
// - zeigt das Feld IHREN Text, auch wenn das Kapitel neu gesetzt wird (Neuladen, Blättern, Suche);
// - liegt eine Rettungskopie im Browser (localStorage), die auch Neuladen und Absturz übersteht
//   und beim nächsten Öffnen wieder ins Feld kommt und gespeichert wird;
// - wird, wenn das Speichern scheitert (Dienst nicht erreichbar), von selbst erneut gesendet.
// Nur ein Konflikt (dieselbe Stelle wurde anderswo geändert) braucht deine Entscheidung.

const sitzungen = new Map(); // `${zettel}\0${feld}` -> Sitzung

const RETTUNG = "rettung";
let rettungWarnung = false;
const rettung = {
  alle: () => store.get(RETTUNG, {}),
  merken(eintrag) {
    const alle = rettung.alle();
    alle[eintrag.key] = eintrag;
    if (!store.set(RETTUNG, alle) && !rettungWarnung) {
      rettungWarnung = true;
      toast("Der Browser lässt keine Rettungskopie mehr zu", "Bitte bald speichern oder etwas Text kopieren.", 10000);
    }
  },
  loeschen(key) {
    const alle = rettung.alle();
    if (!(key in alle)) return;
    delete alle[key];
    store.set(RETTUNG, alle);
  },
};

function sitzungMerken(s) {
  if (s.ed?.isConnected) s.jetzt = edText(s.ed);
  rettung.merken({ key: s.key, art: "feld", zettel: s.zettel, feld: s.feld, sitzung: s.id, raw: s.raw, basis: s.basis,
    jetzt: s.jetzt, titel: s.titel, zeit: new Date().toISOString() });
}

/** Text, den das Feld gerade zeigen soll: der einer laufenden Sitzung, sonst der gespeicherte. */
function sitzungText(entry, feld) {
  const s = sitzungen.get(fkey(entry.id, feld));
  return s ? s.jetzt : null;
}

function startSitzung(ed, { ausDemZettel = false } = {}) {
  const block = ed.closest(".blk");
  const entry = containerEntry(ed);
  if (!entry || !block) return null;
  const feld = block.dataset.feld || "content";
  const key = fkey(entry.id, feld);
  const vorhanden = sitzungen.get(key);
  if (vorhanden) {
    ed._sitzung = vorhanden;
    vorhanden.ed = ed;
    return vorhanden;
  }
  const raw = fieldText(entry, feld);
  // basis: derselbe Stand, wie der Browser ihn zurückliest (sonst – wenn schon getippt wurde – der Zettel)
  const basis = feld === "title" || ausDemZettel ? raw : edText(ed);
  const s = { key, id: uid(), zettel: entry.id, feld, raw, basis, ursprung: raw, jetzt: feld === "title" ? raw : basis,
    titel: entry.title, sent: false, letzte: null, gesendet: null, aktiv: true, ed, zustand: null, meldung: "", versuche: 0 };
  sitzungen.set(key, s);
  ed._sitzung = s;
  return s;
}

/** Nach dem Setzen eines Kapitels: die Felder mit laufender Sitzung wieder an sie binden. */
function bindeSitzungen(root = doc) {
  if (!sitzungen.size) return;
  for (const ed of $$(".blk[data-feld] > .ed", root)) {
    const entry = containerEntry(ed);
    const s = entry && sitzungen.get(fkey(entry.id, ed.closest(".blk").dataset.feld));
    if (!s) continue;
    ed._sitzung = s;
    s.ed = ed;
    setBlockState(ed.closest(".blk"), s.zustand, s.meldung);
  }
}

function zustand(s, status, detail = "") {
  s.zustand = status;
  s.meldung = detail;
  if (s.ed?.isConnected) setBlockState(s.ed.closest(".blk"), status, detail);
  zeigeUngesichert();
  zeigeStatus();
}

/** Kopfzeile: ein unübersehbarer Hinweis, solange etwas nicht gespeichert ist. */
function zeigeUngesichert() {
  const el = $("#ungesichert");
  const offen = [...sitzungen.values()].filter((s) => s.zustand === "nichtGespeichert" || s.zustand === "konflikt");
  const material = $$(".md-blk.nicht-gespeichert", doc).length;
  const n = offen.length + material;
  if (!n) {
    el.hidden = true;
    el.textContent = "";
  } else {
    const konflikt = offen.some((s) => s.zustand === "konflikt");
    const ziel = offen[0] ? `#kapitel/${encodeURIComponent(offen[0].zettel)}` : "#";
    el.innerHTML = `<a href="${ziel}">⚠ ${n === 1 ? "Ein Text ist" : `${n} Texte sind`} noch nicht gespeichert`
      + `${konflikt ? " (Konflikt – bitte entscheiden)" : ` – ${escapeHtml(quelle?.texte?.nichtErreichbar || "keine Verbindung")}`}. Dein Text bleibt im Feld.</a>`;
    el.hidden = false;
  }
  $(".legend").hidden = el.hidden && !$("#speicherstand").textContent;
  hdrHeight();
}

function handleSaveResult(entry, block, session, result, fertig) {
  if (result.stand || result.version) state.version = result.stand || result.version;
  if (result.bearbeitung) updateEditStatus(result.bearbeitung);
  if (result.git) updateGit(result.git); // unterwegs: „Auf GitHub ✓“, sobald die Änderung oben ist
  if (entry && typeof result.text === "string") updateField(entry, session.feld, result.text);
  // Ein fertiger Titel steht so da, wie er gespeichert ist (eine Zeile, ohne Leerraum am Rand)
  const ed = block?.isConnected ? $(":scope > .ed", block) : null;
  if (entry && session.feld === "title" && fertig && !session.aktiv && ed && document.activeElement !== ed && ed.textContent !== entry.title) {
    ed.textContent = entry.title;
    session.jetzt = entry.title;
  }
  const outcome = result.einspielen?.status;
  let status = null;
  let detail = "";
  if (outcome === "wartet") status = "wartet";
  else if (outcome === "lokal") status = "lokal";
  else if (outcome === "fehler") {
    status = "fehler";
    detail = result.einspielen.meldung || "";
    toast("Eingespielt werden konnte nicht", detail, 10000);
  } else if (outcome === "konflikt") {
    status = "fehler";
    detail = "siehe Hinweis oben";
  } else if (outcome === "gespeichert") status = "gespeichert";
  else if (result.status === "offen") status = "offen";
  zustand(session, status, detail);
}

function senden(session, change, fertig) {
  return quelle.aendern({ zettel: session.zettel, feld: session.feld, start: change.start, vorher: change.vorher,
    nachher: change.nachher, sitzung: session.id, fertig });
}

/** Dieselbe Eingabe läuft weiter, aber was bisher gesendet wurde, ist schon eingespielt: von dort aus rechnen. */
function neuAnsetzen(s, serverText, gesendet) {
  s.raw = serverText;
  s.basis = gesendet ?? s.basis;
  s.id = uid();
  s.letzte = null;
  s.sent = false;
}

/** Gespeichert und fertig: Sitzung und Rettungskopie weg, das Feld zeigt den gespeicherten Stand. */
function abschliessen(s) {
  s.erledigt = true;
  clearTimeout(s.timer);
  clearTimeout(s.eingabeTimer);
  sitzungen.delete(s.key);
  rettung.loeschen(s.key);
  const ed = s.ed;
  if (ed && ed._sitzung === s) delete ed._sitzung;
  zeigeUngesichert();
  if (ed) setTimeout(() => nachEingabe(ed), 0);
}

function planeWiederholung(s) {
  clearTimeout(s.timer);
  const pause = Math.min(30000, 1500 * 2 ** Math.min(Math.max(s.versuche - 1, 0), 5));
  s.timer = setTimeout(() => save(s, !s.aktiv), pause);
}

/** Wieder Verbindung: alles, was noch nicht gespeichert ist, gleich noch einmal senden. */
function wiederholeAlle() {
  for (const s of sitzungen.values()) {
    if (s.zustand === "nichtGespeichert") {
      clearTimeout(s.timer);
      save(s, !s.aktiv);
    }
  }
}

function save(s, fertig) {
  if (!s || s.erledigt) return Promise.resolve();
  const run = async () => {
    if (s.erledigt) return;
    const ed = s.ed?.isConnected ? s.ed : null;
    const block = ed?.closest(".blk") || null;
    if (ed) s.jetzt = edText(ed);
    let jetzt = s.jetzt;
    if (s.feld === "title" && !jetzt) {
      if (!fertig) return; // ein leerer Titel wird nicht gespeichert
      jetzt = s.letzte ? s.letzte.nachher : s.raw; // zurück zum zuletzt gespeicherten Titel
      s.jetzt = jetzt;
      if (ed) ed.textContent = jetzt;
      if (jetzt) toast("Ein Titel darf nicht leer sein", "Der bisherige Titel bleibt stehen.", 5000);
    }
    let change = aenderungVon(s, jetzt);
    if (!change) {
      if (!s.sent) {
        if (fertig && !s.aktiv) abschliessen(s); // nichts geändert
        else zustand(s, null);
        return;
      }
      change = { ...s.letzte, nachher: s.letzte.vorher }; // wieder wie am Anfang: zurücknehmen
    }
    if (!fertig && s.zustand !== "nichtGespeichert" && gleicheAenderung(change, s.letzte)) return;
    s.sent = true;
    zustand(s, "speichert");
    sitzungMerken(s);
    state.saving += 1;
    try {
      let result = await senden(s, change, fertig);
      if (result.status === "neu-ansetzen") {
        neuAnsetzen(s, result.text, s.gesendet);
        change = aenderungVon(s, jetzt);
        if (!change) {
          handleSaveResult(entryById(s.zettel), block, s, { ...result, status: "unveraendert" }, fertig);
          if (fertig && !s.aktiv) abschliessen(s);
          return;
        }
        s.sent = true;
        result = await senden(s, change, fertig);
      }
      s.versuche = 0;
      clearTimeout(s.timer);
      if (result.status === "konflikt" || result.status === "fehler") {
        // Nichts wird verworfen: der Text bleibt im Feld und in der Rettungskopie, bis du entscheidest
        s.konfliktText = typeof result.text === "string" ? result.text : null;
        zustand(s, "konflikt", result.meldung || "");
        toast("Nicht gespeichert: Konflikt", "Diese Stelle wurde inzwischen anderswo geändert. Dein Text bleibt im Feld – „Meine Fassung speichern“ oder „Bearbeitung verwerfen“.", 15000);
        return;
      }
      s.letzte = change;
      s.gesendet = jetzt;
      handleSaveResult(entryById(s.zettel), block, s, result, fertig);
      if (fertig) {
        const weiter = s.aktiv || (s.ed?.isConnected && edText(s.ed) !== jetzt);
        if (weiter) neuAnsetzen(s, typeof result.text === "string" ? result.text : jetzt, jetzt); // während des Speicherns weitergeschrieben
        else abschliessen(s);
      }
    } catch (err) {
      // Der Dienst (bzw. das Gerät) war nicht erreichbar: Text bleibt, Rettungskopie bleibt, später noch einmal
      s.versuche += 1;
      zustand(s, "nichtGespeichert", err.message);
      sitzungMerken(s);
      if (s.versuche === 1) {
        toast("Noch nicht gespeichert", `${quelle?.texte?.nichtErreichbar || "Keine Verbindung"}. Dein Text bleibt im Feld und wird von selbst gespeichert, sobald es wieder geht.`, 12000);
      }
      planeWiederholung(s);
    } finally {
      state.saving -= 1;
    }
  };
  s.chain = (s.chain || Promise.resolve()).then(run, run);
  return s.chain;
}

/** Konflikt: deine Fassung trotzdem speichern (ersetzt, was anderswo an denselben Zeilen geändert wurde). */
function durchsetzen(s) {
  if (!window.confirm("Deine Fassung speichern? Was anderswo an denselben Zeilen geändert wurde, wird dabei ersetzt.")) return;
  const entry = entryById(s.zettel);
  const server = s.konfliktText ?? (entry ? fieldText(entry, s.feld) : null);
  if (server === null) return;
  neuAnsetzen(s, server, server);
  zustand(s, null);
  save(s, !s.aktiv);
}

/** Nicht gespeicherten Text eines Feldes bewusst verwerfen. */
function verwirfSitzung(s) {
  if (!window.confirm("Deinen nicht gespeicherten Text in diesem Feld verwerfen? Er lässt sich danach nicht wiederherstellen.")) return false;
  const ed = s.ed;
  abschliessen(s);
  if (ed?.isConnected) {
    delete ed._sitzung;
    setTimeout(() => feldNeuSetzen(ed), 0);
  }
  return true;
}

/** Beim Öffnen: Rettungskopien von früher wieder in ihre Felder bringen und speichern. */
async function rettungEinspielen() {
  const alle = rettung.alle();
  let wieder = 0;
  const material = [];
  for (const [key, r] of Object.entries(alle)) {
    if (r.art === "datei") {
      material.push(r);
      continue;
    }
    if (!r || typeof r.jetzt !== "string" || typeof r.raw !== "string" || sitzungen.has(key)) continue;
    let entry = entryById(r.zettel);
    try {
      if (!entry || (r.feld === "misc" && entry.misc === undefined)) {
        const z = await quelle.zettel(r.zettel);
        if (entry) {
          entry.misc = z.misc;
          entry.miscWords = z.miscWords;
        } else {
          entry = { id: z.id, title: z.title, text: z.content, misc: z.misc, kind: z.kind, words: z.words, miscWords: z.miscWords,
            edited: z.edited, pos: null, section: null, desktop: null, comment: "" };
          state.extra.set(entry.id, entry);
        }
      }
    } catch {
      continue; // jetzt nicht lesbar – die Kopie bleibt für das nächste Mal
    }
    if (gleicherText(fieldText(entry, r.feld), r.jetzt, r.feld)) {
      rettung.loeschen(key); // ist schon gespeichert
      continue;
    }
    const s = { key, id: r.sitzung || uid(), zettel: String(r.zettel), feld: r.feld, raw: r.raw, basis: r.basis ?? r.raw,
      ursprung: r.raw, jetzt: r.jetzt, titel: r.titel || entry.title, sent: false, letzte: null, gesendet: null, aktiv: false,
      ed: null, zustand: null, meldung: "", versuche: 0 };
    sitzungen.set(key, s);
    if (r.feld === "misc") state.openMisc.add(String(r.zettel));
    wieder += 1;
    save(s, true);
  }
  if (wieder) {
    toast(`${wieder === 1 ? "Ein nicht gespeicherter Text" : `${wieder} nicht gespeicherte Texte`} wiederhergestellt`,
      "Er steht wieder im Feld und wird jetzt gespeichert.", 9000);
  }
  for (const r of material) materialRettung(r);
}

const ohneRandZeilen = (t) => String(t ?? "").replace(/^(?:[ \t]*\n)+/, "").replace(/(?:\n[ \t]*)+$/, "");

function gleicherText(a, b, feld) {
  if (feld === "title") return titelZeile(a) === titelZeile(b);
  const norm = (t) => ohneRandZeilen(feld === "content" ? zusammensetzen(zerlege(t)) : t);
  return norm(a) === norm(b);
}

/** Stelle der Auswahl im Klartext eines Feldes (zum Wiederherstellen nach dem Neusetzen). */
function auswahlIn(ed) {
  const selection = window.getSelection();
  if (!selection.rangeCount || !ed.contains(selection.anchorNode)) return null;
  const range = selection.getRangeAt(0);
  const vor = (container, offset) => {
    const r = document.createRange();
    r.selectNodeContents(ed);
    r.setEnd(container, offset);
    return domLesen(r.cloneContents(), { formate: false }).length;
  };
  return { start: vor(range.startContainer, range.startOffset), end: vor(range.endContainer, range.endOffset) };
}

function setzeAuswahl(ed, stelle) {
  if (!stelle) return;
  const { stellen } = textStellen(ed);
  const punkt = (offset) => {
    const found = knotenBei(stellen, offset);
    if (!found) return [ed, ed.childNodes.length];
    return [found[0], Math.max(0, Math.min(offset - found[1], found[0].length))];
  };
  const range = document.createRange();
  range.setStart(...punkt(stelle.start));
  range.setEnd(...punkt(stelle.end));
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

/** Nach einer gespeicherten Eingabe: das Feld so setzen, wie es gespeichert ist (Anmerkungen, Formatierung, Zeilen). */
function feldNeuSetzen(ed) {
  const block = ed.closest(".blk");
  const entry = containerEntry(ed);
  if (!entry || !block || ed._sitzung || sitzungen.has(fkey(entry.id, block.dataset.feld || "content"))) return; // nie über Ungespeichertes
  const feld = block.dataset.feld || "content";
  if (feld === "title") {
    if (ed.textContent !== entry.title) ed.textContent = entry.title;
  } else {
    const aktiv = document.activeElement === ed;
    const stelle = aktiv ? auswahlIn(ed) : null;
    const { html } = feldInnen(entry, feld);
    if (ed.innerHTML !== html) {
      ed.innerHTML = html;
      if (aktiv) setzeAuswahl(ed, stelle);
    }
    if (feld === "content") nummernBald(block);
  }
}

function nachEingabe(ed) {
  if (ed.isConnected && !ed._sitzung && !(document.activeElement === ed && document.hasFocus())) feldNeuSetzen(ed);
  if (state.reloadWanted && !state.saving && !document.activeElement?.closest?.("#doc .ed")) {
    state.reloadWanted = false;
    poll();
  }
}

/** Getippt (oder formatiert): Sitzung aktuell halten, Rettungskopie, gleich speichern. */
function eingabe(ed) {
  const s = ed._sitzung || startSitzung(ed, { ausDemZettel: true }); // auch ohne focusin (manche Browser)
  if (!s) return;
  s.aktiv = true;
  s.ed = ed;
  if (s.zustand !== "konflikt" && s.zustand !== "nichtGespeichert") zustand(s, "ungespeichert");
  clearTimeout(s.rettungTimer);
  s.rettungTimer = setTimeout(() => sitzungMerken(s), 400);
  clearTimeout(s.eingabeTimer);
  s.eingabeTimer = setTimeout(() => {
    if (s.zustand !== "konflikt") save(s, false);
  }, 1500);
}

doc.addEventListener("focusin", (event) => {
  const ed = event.target.closest?.(".ed");
  if (!ed) return;
  const blk = ed.closest(".md-blk");
  if (blk) {
    // Ein Material-Block, der noch zum Bearbeiten offen steht (sein Text ist schon gespeichert)
    if (!ed._material && state.view?.mode === "material") {
      ed._material = { id: uid(), datei: state.view.path, start: Number(blk.dataset.s), vorher: domLesen(ed, { formate: false }) };
    }
    versteckeLeiste();
    return;
  }
  const s = ed._sitzung || startSitzung(ed);
  if (s) {
    s.aktiv = true;
    s.ed = ed;
  }
  zeigeLeiste(ed);
});

// Steht die Schreibmarke in einem Text, gehört die Schreibleiste dazu (auch wenn ein Browser kein focusin meldet)
document.addEventListener("selectionchange", () => {
  const ed = document.activeElement?.closest?.("#doc .ed");
  if (ed && !ed.closest(".md-blk") && leisteEd !== ed && (feldVonEd(ed) !== "title" || istHandy())) zeigeLeiste(ed);
  if (ed) markeSichtbar();
});

// Vor jeder Änderung im Feld: gehört sie zum laufenden Rückgängig-Schritt? (Rückgängig aus dem
// Menü des Browsers oder einer Geste der Bildschirmtastatur geht über denselben Verlauf.)
doc.addEventListener("beforeinput", (event) => {
  const ed = event.target.closest?.(".ed");
  if (!ed || ed.closest(".md-blk")) return;
  if (event.inputType === "historyUndo" || event.inputType === "historyRedo") {
    event.preventDefault();
    rueckgaengig(event.inputType === "historyUndo");
    return;
  }
  schrittBeginnen(ed, event.inputType || "");
});

doc.addEventListener("input", (event) => {
  const ed = event.target.closest?.(".ed");
  if (!ed) return;
  ensureEnde(ed);
  if (ed.closest(".md-blk")) {
    clearTimeout(ed._rettungTimer);
    ed._rettungTimer = setTimeout(() => materialMerken(ed), 400);
    return;
  }
  if (leisteEd !== ed && (feldVonEd(ed) !== "title" || istHandy())) zeigeLeiste(ed);
  if (offenerSchritt?.ed === ed) offenerSchritt.letzte = Date.now();
  eingabe(ed);
  if (feldVonEd(ed) === "content") nummernBald(ed.closest(".blk"));
  markeSichtbar();
});

doc.addEventListener("focusout", (event) => {
  const ed = event.target.closest?.(".ed");
  if (!ed) return;
  if (ed.closest(".md-blk")) {
    materialFertig(ed);
    return;
  }
  if (offenerSchritt?.ed === ed) schrittAbschliessen();
  const s = ed._sitzung;
  if (s) {
    clearTimeout(s.eingabeTimer);
    s.jetzt = edText(ed);
    s.aktiv = false;
    if (s.zustand !== "konflikt") save(s, true);
    else sitzungMerken(s);
  }
  if (!leiste.contains(event.relatedTarget)) versteckeLeiste();
});

const FORMAT_TASTEN = { b: "bold", i: "italic", u: "underline" };

doc.addEventListener("keydown", (event) => {
  const ed = event.target.closest?.(".ed");
  if (!ed) return;
  const material = Boolean(ed.closest(".md-blk"));
  const taste = (event.key || "").toLowerCase();
  if ((event.ctrlKey || event.metaKey) && !event.altKey && !material && (taste === "z" || taste === "y")) {
    event.preventDefault(); // Rückgängig (Strg+Z) und Wiederholen (Strg+Y, Strg+Umschalt+Z) über den eigenen Verlauf
    rueckgaengig(taste === "z" && !event.shiftKey);
    return;
  }
  if (event.key === "Enter" && !event.isComposing) {
    event.preventDefault();
    if (!material && feldVonEd(ed) === "title") ed.blur(); // ein Titel ist eine Zeile: Enter beendet die Eingabe
    else {
      if (!material) schrittBeginnen(ed, "insertParagraph");
      insertText(event.shiftKey ? "\n\n" : "\n"); // Enter: neue Zeile, Umschalt+Enter: neuer Absatz
    }
  } else if (event.key === "Escape") {
    event.preventDefault();
    ed.blur();
  } else if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && FORMAT_TASTEN[event.key.toLowerCase()]) {
    event.preventDefault();
    const was = FORMAT_TASTEN[event.key.toLowerCase()];
    if (material) markdownFormat(was);
    else if (feldVonEd(ed) === "content") formatieren(was); // Titel und Vermerke bleiben reiner Text
  }
}, true);

doc.addEventListener("paste", (event) => {
  const ed = event.target.closest?.(".ed");
  if (!ed) return;
  event.preventDefault();
  const text = (event.clipboardData?.getData("text/plain") || "").replace(/\r\n?/g, "\n");
  schrittBeginnen(ed, "einfuegen");
  insertText(!ed.closest(".md-blk") && feldVonEd(ed) === "title" ? text.replace(/\s*\n\s*/g, " ") : text);
  schrittBeginnen(ed, "einfuegen"); // was danach getippt wird, ist ein neuer Schritt
});

doc.addEventListener("drop", (event) => {
  if (event.target.closest?.(".ed")) event.preventDefault();
});

window.addEventListener("pagehide", () => {
  schrittAbschliessen(); // der laufende Rückgängig-Schritt bleibt gemerkt
  // Erst die Rettungskopien (die bleiben, bis beim nächsten Öffnen feststeht, dass alles gespeichert ist) …
  const bodies = [];
  for (const s of sitzungen.values()) {
    sitzungMerken(s);
    if (s.zustand === "konflikt") continue;
    let jetzt = s.jetzt;
    if (s.feld === "title" && !jetzt) jetzt = s.raw;
    const change = aenderungVon(s, jetzt) || (s.sent ? { ...s.letzte, nachher: s.letzte.vorher } : null);
    if (!change) continue;
    bodies.push({ zettel: s.zettel, feld: s.feld, start: change.start, vorher: change.vorher,
      nachher: change.nachher, sitzung: s.id, fertig: true });
  }
  for (const ed of $$(".md-blk .ed")) materialMerken(ed);
  // … dann noch schnell senden (ohne auf Antwort zu warten)
  if (bodies.length && quelle) quelle.verlassen(bodies);
  for (const ed of $$(".md-blk .ed")) {
    const sitzung = ed._material;
    const jetzt = sitzung ? domLesen(ed, { formate: false }) : null;
    if (sitzung && jetzt !== sitzung.vorher) quelle?.materialVerlassen?.({ ...sitzung, nachher: jetzt });
  }
  quelle?.fensterZu?.();
});

/** Was „Kopieren“ in die Zwischenablage legt: Überschrift und Text (ohne Formatcodes, Vermerke und Angaben). */
function copyText(container) {
  const title = titelZeile(domLesen($('.blk[data-feld="title"] .ed', container), { formate: false }));
  const ed = $('.blk[data-feld="content"] .ed', container);
  const text = ed ? domLesen(ed, { formate: false }) : "";
  const paragraphs = paragraphSpans(text).map((s) => text.slice(s.start, s.end));
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
  if (button) {
    // nur bei einem Konflikt da: deinen Text bewusst aufgeben (sonst gibt es „Rückgängig“)
    const s = $(":scope > .ed", button.closest(".blk"))?._sitzung;
    if (s) verwirfSitzung(s);
    return;
  }
  const durch = event.target.closest('[data-act="durchsetzen"]');
  if (durch) {
    const s = $(":scope > .ed", durch.closest(".blk"))?._sitzung;
    if (s) durchsetzen(s);
    return;
  }
  const blk = event.target.closest?.(".md-blk");
  if (blk && !blk.classList.contains("bearbeiten") && !event.target.closest("a[href]") && !String(window.getSelection()).trim()) {
    materialBearbeiten(blk, event);
  }
});

// ------------------------------------------------------------------ Schreibleiste: Rückgängig, fett, kursiv, Farbe …
// Erscheint, solange in einem Text oder in den Vermerken geschrieben wird: am Laptop oben rechts am
// Blatt, auf dem Handy unten über der Tastatur (dort auch beim Titel, mit „Fertig“ statt Esc).

let leisteEd = null;

function zeigeLeiste(ed) {
  const feld = feldVonEd(ed);
  if (feld === "title" && !istHandy()) {
    versteckeLeiste();
    return;
  }
  leisteEd = ed;
  $(".formate", leiste).hidden = feld !== "content";
  leiste.hidden = false;
  document.body.classList.add("schreibt");
  zeigeVerlaufKnoepfe();
  leistePlatz();
}

function versteckeLeiste() {
  leiste.hidden = true;
  leisteEd = null;
  document.body.classList.remove("schreibt");
  $(".farbwahl", leiste).hidden = true;
}

function leistePlatz() {
  if (!leiste || leiste.hidden) return;
  if (istHandy()) {
    // unten, genau über der Bildschirmtastatur (visualViewport: der sichtbare Teil der Seite)
    const vv = window.visualViewport;
    const unten = vv ? Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) : 0;
    Object.assign(leiste.style, { top: "auto", right: "0px", left: "0px", bottom: `${unten}px` });
    return;
  }
  Object.assign(leiste.style, { bottom: "", left: "" });
  leiste.style.top = `${Math.round(readingTop() + 8)}px`;
  const box = doc.getBoundingClientRect();
  leiste.style.right = window.innerWidth <= 760 ? "8px" : `${Math.max(8, Math.round(window.innerWidth - box.right + 10))}px`;
}

// Auf dem Handy bleibt die Schreibmarke über der Leiste (sonst schriebe man unter ihr)
let markeQueued = false;
function markeSichtbar() {
  if (markeQueued || !istHandy() || leiste.hidden) return;
  markeQueued = true;
  requestAnimationFrame(() => {
    markeQueued = false;
    const selection = window.getSelection();
    if (!selection.rangeCount || !leisteEd?.contains(selection.focusNode)) return;
    const range = selection.getRangeAt(0).cloneRange();
    range.collapse(false);
    const rect = range.getClientRects()[0] || range.getBoundingClientRect();
    if (!rect || (!rect.top && !rect.bottom)) return;
    const vv = window.visualViewport;
    const sichtUnten = (vv ? vv.offsetTop + vv.height : window.innerHeight) - leiste.offsetHeight - 12;
    const sichtOben = readingTop() + 8;
    if (rect.bottom > sichtUnten) window.scrollBy(0, rect.bottom - sichtUnten);
    else if (rect.top < sichtOben) window.scrollBy(0, rect.top - sichtOben);
  });
}

function planeSpeichern(ed) {
  if (ed) eingabe(ed);
}

function formatieren(befehl, wert) {
  const ed = document.activeElement?.closest?.(".ed");
  if (!ed || feldVonEd(ed) !== "content" || ed.closest(".md-blk")) return;
  schrittBeginnen(ed, "formatieren"); // Formatieren ist ein eigener Schritt (Rückgängig)
  document.execCommand(befehl, false, wert ?? null);
  ensureEnde(ed);
  schrittBeginnen(ed, "formatieren");
  planeSpeichern(ed); // nicht jeder Browser meldet Formatierungen als Eingabe
}

/** Im Material (Markdown): **fett**, *kursiv* um die Auswahl. */
function markdownFormat(was) {
  const zeichen = { bold: "**", italic: "*" }[was];
  if (!zeichen) return;
  insertText(`${zeichen}${String(window.getSelection())}${zeichen}`);
}

function baueLeiste() {
  $(".farbwahl", leiste).innerHTML = [...FARBEN, [OHNE_FARBE, "Standardfarbe"]].map(([farbe, name]) =>
    `<button type="button" class="farbe${farbe === OHNE_FARBE ? " ohne" : ""}" data-farbe="${farbe}" title="${name}" aria-label="${name}"${farbe === OHNE_FARBE ? "" : ` style="--f:${farbe}"`}></button>`).join("");
  // Die Leiste nimmt der Eingabe nie die Schreibmarke (sonst ginge die Auswahl verloren)
  leiste.addEventListener("mousedown", (event) => event.preventDefault());
  leiste.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.dataset.fmt) formatieren(button.dataset.fmt);
    else if (button.dataset.act === "farben") $(".farbwahl", leiste).hidden = !$(".farbwahl", leiste).hidden;
    else if (button.dataset.farbe) {
      formatieren("foreColor", button.dataset.farbe);
      $(".farbwahl", leiste).hidden = true;
    } else if (button.dataset.act === "zurueck") rueckgaengig(true);
    else if (button.dataset.act === "wieder") rueckgaengig(false);
    else if (button.dataset.act === "fertig") document.activeElement?.closest?.(".ed")?.blur();
  });
  try {
    document.execCommand("styleWithCSS", false, false); // fett als <b> usw., nicht als style-Angabe
  } catch {
    /* ältere Browser */
  }
}

// ------------------------------------------------------------------ Rückgängig und Wiederholen
// Ein eigener Verlauf statt dem des Browsers: Der vergisst alles, sobald ein Feld neu gesetzt wird
// (nach dem Speichern, beim Blättern). Dieser gilt über Felder und Kapitel hinweg, auch für Titel,
// Vermerke und Material, und übersteht das Neuladen der Seite (siehe verlauf.js). Ein Schritt endet
// nach einer Sekunde Pause, bei Zeilenumbruch, Einfügen, Ausschneiden und Formatieren.
// Rückgängig gemacht wird wie getippt: über die Sitzung des Feldes, also mit Rettungskopie und
// Speichern wie jede Eingabe.

const verlauf = new Verlauf({ laden: () => store.get("verlauf", null), speichern: (daten) => store.set("verlauf", daten) });
// Ein Zeilenumbruch beginnt einen neuen Schritt (was danach getippt wird, gehört dazu); Einfügen,
// Ausschneiden, Formatieren und Ersetzen (Rechtschreibvorschlag) sind je ein Schritt für sich.
const BEGINN = new Set(["insertParagraph", "insertLineBreak"]);
const BRUCH = new Set(["insertFromPaste", "insertFromDrop", "deleteByCut", "deleteByDrag", "insertReplacementText",
  "insertFromYank", "formatieren", "einfuegen"]);
let offenerSchritt = null;

/** Vor einer Änderung (das Feld zeigt noch den alten Stand): gehört sie zum laufenden Schritt? */
function schrittBeginnen(ed, typ = "") {
  if (!ed || ed.closest(".md-blk")) return;
  const block = ed.closest(".blk");
  const entry = containerEntry(ed);
  if (!entry || !block) return;
  const feld = block.dataset.feld || "content";
  const key = fkey(entry.id, feld);
  const now = Date.now();
  const loeschen = typ.startsWith("delete");
  const o = offenerSchritt;
  const weiter = o && o.key === key && o.ed === ed && now - o.letzte < 1000 && !o.bruch && !BRUCH.has(typ) && !BEGINN.has(typ)
    && o.loeschen === loeschen;
  if (!weiter) {
    schrittAbschliessen();
    offenerSchritt = { key, zettel: entry.id, feld, titel: entry.title, vorText: edText(ed), ed, loeschen, bruch: BRUCH.has(typ), letzte: now };
    zeigeVerlaufKnoepfe();
  }
  offenerSchritt.letzte = now;
}

/** Den laufenden Schritt festhalten (vor Rückgängig, beim Verlassen des Feldes, beim nächsten Schritt). */
function schrittAbschliessen() {
  const o = offenerSchritt;
  if (!o) return;
  offenerSchritt = null;
  const nach = o.ed?.isConnected ? edText(o.ed) : sitzungen.get(o.key)?.jetzt;
  if (typeof nach !== "string") return;
  const schritt = schrittVon(o.vorText, nach, { art: "feld", key: o.key, zettel: o.zettel, feld: o.feld, titel: o.titel });
  if (schritt) {
    verlauf.neu(schritt);
    zeigeVerlaufKnoepfe();
  }
}

function schrittName(schritt) {
  if (!schritt) return "";
  if (schritt.art === "datei") return `Material „${schritt.titel || schritt.datei}“`;
  return `${FELD_NAMEN[schritt.feld] || "Text"} in „${schritt.titel || `Zettel ${schritt.zettel}`}“`;
}

function zeigeVerlaufKnoepfe() {
  const zurueck = verlauf.zurueck[verlauf.zurueck.length - 1] || (offenerSchritt ? { art: "feld", ...offenerSchritt } : null);
  const vor = offenerSchritt ? null : verlauf.vor[verlauf.vor.length - 1];
  for (const button of $$('[data-act="zurueck"]')) {
    button.disabled = !zurueck;
    button.title = zurueck ? `Rückgängig: ${schrittName(zurueck)} (Strg+Z)` : "Rückgängig (Strg+Z) – noch nichts zu tun";
  }
  for (const button of $$('[data-act="wieder"]')) {
    button.disabled = !vor;
    button.title = vor ? `Wiederholen: ${schrittName(vor)} (Strg+Y)` : "Wiederholen (Strg+Y)";
  }
}

/** Das Feld eines Zettels zeigen (Kapitel aufschlagen, Vermerke aufklappen) – liefert sein Eingabefeld. */
async function feldZeigen(zettel, feld) {
  let container = chapterContainer(zettel);
  if (!container) {
    let entry = entryById(zettel);
    if (!entry) {
      try {
        await quelle.zettel(zettel);
      } catch {
        return null;
      }
      entry = entryById(zettel);
    }
    document.activeElement?.closest?.("#doc .ed")?.blur();
    versteckeLeiste();
    if (entry?.pos) {
      history.pushState(null, "", `#kapitel/${zettel}`);
      showChapter(zettel, { toHit: false });
    } else {
      history.pushState(null, "", `#zettel/${zettel}`);
      await showZettel(zettel);
    }
    container = chapterContainer(zettel);
  }
  if (!container) return null;
  if (feld === "misc") {
    const details = $("details.vermerke", container);
    if (!details) return null;
    if (!details.open) {
      details.open = true;
      state.openMisc.add(String(zettel));
    }
    await loadMisc(details);
    await waitFrame();
  }
  return container.querySelector(`.blk[data-feld="${feld}"] > .ed`);
}

const waitFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

/** Wie viele Zeichen der Leser vor dieser Stelle sieht (Formatcodes zählen nicht). */
function sichtbareLaenge(feld, text) {
  return feld === "content" ? klartext(text).length : text.length;
}

/** Ein Feld auf einen neuen Wortlaut setzen – wie getippt (Sitzung, Rettungskopie, Speichern). */
function feldSetzen(ed, text, stelle) {
  const block = ed.closest(".blk");
  const feld = block?.dataset.feld || "content";
  const fokus = document.activeElement === ed;
  const s = ed._sitzung || startSitzung(ed);
  if (!s) return false;
  if (feld === "title") ed.textContent = text;
  else {
    const { html } = feldHtml(text, { term: state.term, markClass: feld === "misc" ? "treffer-v" : "treffer", formate: feld === "content" });
    ed.innerHTML = html + (text.endsWith("\n") ? '<br data-ende="">' : "");
  }
  ensureEnde(ed);
  if (feld === "content") nummernBald(block);
  s.jetzt = edText(ed);
  sitzungMerken(s);
  const von = sichtbareLaenge(feld, text.slice(0, stelle.at));
  const bis = sichtbareLaenge(feld, text.slice(0, stelle.ende));
  if (fokus) {
    setzeAuswahl(ed, { start: bis, end: bis });
    eingabe(ed);
  } else {
    s.aktiv = false;
    clearTimeout(s.eingabeTimer);
    save(s, true);
  }
  zeigeStelle(ed, von, bis);
  return true;
}

/** Die geänderte Stelle ins Bild holen und kurz hervorheben. */
function zeigeStelle(ed, von, bis) {
  const { stellen } = textStellen(ed);
  const punkt = (offset) => {
    const found = knotenBei(stellen, offset);
    return found ? [found[0], Math.max(0, Math.min(offset - found[1], found[0].length))] : [ed, ed.childNodes.length];
  };
  try {
    const range = document.createRange();
    range.setStart(...punkt(von));
    range.setEnd(...punkt(Math.max(von, bis)));
    const rect = range.getClientRects()[0] || range.getBoundingClientRect() || ed.getBoundingClientRect();
    const oben = readingTop() + 12;
    const unten = (window.visualViewport ? window.visualViewport.height : window.innerHeight) - (leiste.hidden ? 24 : leiste.offsetHeight + 24);
    if (rect.top < oben || rect.bottom > unten) window.scrollBy(0, rect.top - oben - (unten - oben) / 3);
    if (typeof Highlight === "function" && CSS.highlights) {
      CSS.highlights.set("rueckgaengig", new Highlight(range));
      clearTimeout(zeigeStelle.timer);
      zeigeStelle.timer = setTimeout(() => CSS.highlights.delete("rueckgaengig"), 1600);
    }
  } catch {
    /* nur Komfort */
  }
}

async function feldSchritt(schritt, zurueck) {
  const ed = await feldZeigen(schritt.zettel, schritt.feld);
  if (!ed) return "Der Zettel ließ sich nicht öffnen.";
  const ergebnis = anwenden(edText(ed), schritt, zurueck);
  if (!ergebnis) return "Die Stelle wurde inzwischen anderswo geändert.";
  return feldSetzen(ed, ergebnis.text, ergebnis) ? null : "Das Feld lässt sich gerade nicht bearbeiten.";
}

async function materialSchritt(schritt, zurueck) {
  if (state.view?.mode !== "material" || state.view.path !== schritt.datei) {
    history.pushState(null, "", `#material/${schritt.datei}`);
    await showMaterial(schritt.datei);
  }
  const vorher = zurueck ? schritt.neu : schritt.alt;
  const nachher = zurueck ? schritt.alt : schritt.neu;
  const result = await quelle.materialAendern({ datei: schritt.datei, start: schritt.at, vorher, nachher, sitzung: uid() });
  if (result.git) updateGit(result.git);
  if (result.status === "konflikt" || result.status === "fehler") return result.meldung || "Die Stelle wurde inzwischen anderswo geändert.";
  if (typeof result.text === "string" && state.view?.path === schritt.datei) {
    state.materialText = result.text;
    if (!$$(".md-blk.bearbeiten", doc).length) zeigeMaterial(schritt.datei, { scroll: window.scrollY });
  }
  loadMaterial();
  return null;
}

// Mehrmals schnell hintereinander geklickt: jeder Klick ist ein Schritt, der Reihe nach
let verlaufKette = Promise.resolve();

/** Rückgängig (zurueck = true) oder Wiederholen. */
function rueckgaengig(zurueck = true) {
  verlaufKette = verlaufKette.then(() => verlaufSchritt(zurueck), () => verlaufSchritt(zurueck));
  return verlaufKette;
}

async function verlaufSchritt(zurueck) {
  try {
    const material = document.activeElement?.closest?.(".md-blk .ed");
    if (material) {
      material.blur(); // ein offener Material-Block wird erst gespeichert – das ist dann der letzte Schritt
      for (let i = 0; i < 50 && $$(".md-blk.speichert", doc).length; i += 1) await new Promise((r) => setTimeout(r, 100));
    }
    schrittAbschliessen();
    const stapelVon = zurueck ? verlauf.zurueck : verlauf.vor;
    const schritt = stapelVon.pop();
    if (!schritt) {
      toast(zurueck ? "Nichts zum Rückgängigmachen" : "Nichts zum Wiederholen");
      return;
    }
    let problem;
    try {
      problem = schritt.art === "datei" ? await materialSchritt(schritt, zurueck) : await feldSchritt(schritt, zurueck);
    } catch (err) {
      problem = err.message;
    }
    if (problem) {
      toast(zurueck ? "Ließ sich nicht rückgängig machen" : "Ließ sich nicht wiederholen", `${schrittName(schritt)}: ${problem}`, 8000);
    } else {
      (zurueck ? verlauf.vor : verlauf.zurueck).push(schritt);
      // feldSetzen hat den Stand wie eine Eingabe übernommen: das ist kein neuer Schritt
      if (offenerSchritt?.key === schritt.key) offenerSchritt = null;
    }
    verlauf.merken();
  } finally {
    zeigeVerlaufKnoepfe();
  }
}

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
  if (!target.isConnected || insp.contains(target) || target === searchInput || target.closest?.("[data-oeffnet]")) return;
  closeInsp();
});

searchInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    menuZu(); // auf dem Handy: die Treffer erscheinen unten, das Menü geht zu
    searchInput.blur();
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
    const plain = klartext(entry.text); // gesucht wird im Text, wie er dasteht (ohne Formatcodes)
    const found = findAll(plain, term).filter((hit) => !plain.slice(hit.index, hit.index + hit.length).includes("\n"));
    if (found.length) results.push({ entry, plain, found });
  }
  const total = results.reduce((n, r) => n + r.found.length, 0);
  const parts = [`<p class="treffer-kopf">${formatNumber(total)} Treffer in ${formatNumber(results.length)} Kapiteln · <a href="#" id="suche-alle">auch in allen übrigen Zetteln suchen</a></p>`];
  for (const { entry, plain, found } of results) {
    parts.push(`<div class="treffer-kap">${escapeHtml(entry.title)} <span class="hint">${found.length}</span></div>`);
    found.slice(0, 5).forEach((hit, n) => parts.push(`<a class="treffer" href="#kapitel/${escapeHtml(entry.id)}" data-id="${escapeHtml(entry.id)}" data-n="${n}">${snippetHtml(plain, hit.index, hit.length)}</a>`));
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
  // Markierungen direkt entfernen – auch in einem Feld, in dem gerade geschrieben wird
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
  if (document.activeElement?.closest?.("#doc .ed")) return;
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

// Einträge in den Listen des Speicherstands (Änderungen, Konflikte, verlorene Änderungen)
const HERKUNFT = { Chromebook: "vom Chromebook", Handy: "vom Handy", Tablet: "vom Tablet" };

function herkunftVon(change) {
  if (!(change.unterwegs || String(change.id || "").startsWith("u-"))) return "";
  return ` · ${HERKUNFT[change.geraet] || "von unterwegs"}`;
}

function changeWo(change) {
  const feld = { title: " · Titel", misc: " · Sonstige Vermerke" }[change.feld] || "";
  const wo = change.datei
    ? `<a href="#material/${escapeHtml(change.datei)}">${escapeHtml(change.titel || change.datei)}</a>`
    : `<a href="#kapitel/${escapeHtml(change.zettel)}">${escapeHtml(change.titel || `Zettel ${change.zettel}`)}</a>`;
  return `${wo}${feld}`;
}

function changeItem(change, actions) {
  const when = change.eingespielt || change.geaendert || change.erstellt;
  const buttons = actions.map(([action, label]) => `<button class="tb" data-aktion="${action}" data-id="${escapeHtml(change.id)}">${label}</button>`).join("");
  return `<li><div class="wo">${escapeHtml(formatDate(when))}${herkunftVon(change)} · ${changeWo(change)}${change.grund ? ` · ${escapeHtml(change.grund)}` : ""}</div>`
    + `<span class="vorher">${escapeHtml(change.vorher || "")}</span><span class="nachher">${escapeHtml(change.nachher || "(gelöscht)")}</span>${buttons}</li>`;
}

/** Kurz: wann, woher, wo – für lange Listen (was auf den Laptop wartet). */
function changeZeile(change) {
  const when = change.geaendert || change.erstellt;
  return `<li><div class="wo">${escapeHtml(kurzeZeit(when) || formatDate(when))}${herkunftVon(change)} · ${changeWo(change)}</div></li>`;
}

/**
 * Der Speicherstand im Überblick, auf beiden Geräten gleich aufgebaut: oben ein Satz, wie es steht;
 * darunter, was noch nicht auf GitHub ist, was auf den Laptop wartet und was nicht passt.
 */
async function openStatus() {
  const github = quelle.modus === "github";
  if (insp.hidden || insp.dataset.art !== "status") openInsp("Speicherstand", "", '<p class="hint">Wird geladen …</p>', "status");
  let o;
  try {
    o = await quelle.aenderungen();
  } catch (err) {
    $("#insp-body").innerHTML = `<p class="st-kopf st-problem">${escapeHtml(statusArt().satz)}</p><p class="hint">${escapeHtml(err.message)}</p>`;
    return;
  }
  if (insp.hidden || insp.dataset.art !== "status") return;
  const git = state.git || {};
  const a = statusArt();
  const n = (count, one, many) => `${count} ${count === 1 ? one : many}`;
  const parts = [`<p class="st-kopf st-${a.art}">${escapeHtml(a.satz)}</p>`];
  const hochladen = github ? o.hochladen.length : (git.changeCount || git.ahead);
  if (hochladen || a.art === "unten" || a.art === "offline") {
    parts.push(`<p><button class="btn primary" type="button" data-status="hochladen"${state.sichernLaeuft ? " disabled" : ""}>${state.sichernLaeuft ? "Lädt hoch …" : "Jetzt hochladen"}</button></p>`);
  }
  if (github) {
    if (o.hochladen.length) {
      parts.push(`<h4>Noch nicht auf GitHub (auf diesem Gerät gespeichert)</h4><ul class="aend-liste kurz">${o.hochladen.map(changeZeile).join("")}</ul>`);
    }
    if (o.offen.length) {
      parts.push(`<h4>Auf GitHub – wartet auf den Laptop</h4><p class="hint">${n(o.offen.length, "Änderung von unterwegs ist", "Änderungen von unterwegs sind")} sicher auf GitHub und hier schon zu sehen. In die zkn3 (und damit ins Zettelkasten-Programm) kommen sie, sobald der Reader-Dienst auf dem Laptop läuft; wenige Minuten danach meldet der Laptop das zurück.</p>`
        + `<ul class="aend-liste kurz">${o.offen.map(changeZeile).join("")}</ul>`);
    }
    if (o.konflikte.length) {
      parts.push(`<h4>Konflikte</h4><p class="hint">Die Stelle wurde auf dem Laptop geändert, deshalb kommt diese Fassung nicht in die zkn3. Kopiere sie bei Bedarf; den Eintrag verwirfst du im Reader auf dem Laptop.</p><ul class="aend-liste">${o.konflikte.map((c) => changeItem(c, [])).join("")}</ul>`);
    }
    const grundlage = o.stand?.datum ? `Grundlage ist die zkn3, wie der Laptop sie ${kurzeZeit(o.stand.datum, { lang: true })} gesichert hat${o.offen.length ? ", mit den Änderungen von unterwegs darüber" : ""}.` : "";
    const oben = o.zuletztOben ? ` Dieses Gerät (${o.geraet}) hat zuletzt ${kurzeZeit(o.zuletztOben, { lang: true })} hochgeladen.` : "";
    if (grundlage || oben) parts.push(`<p class="hint">${escapeHtml(grundlage + oben)}</p>`);
    if (o.ohneNetz) parts.push('<p class="hint">Ohne Verbindung geöffnet: Angezeigt wird der Stand, der zuletzt auf dieses Gerät geladen wurde.</p>');
    parts.push('<p class="abmelden"><button class="tb" data-github="abmelden">Zugangsschlüssel auf diesem Gerät löschen</button></p>');
  } else {
    if (git.changeCount) {
      const files = (git.changes || []).slice(0, 12).map((c) => `<li><div class="wo">${escapeHtml(c.path)}</div></li>`).join("");
      parts.push(`<h4>Noch nicht auf GitHub</h4><ul class="aend-liste kurz">${files}${git.changeCount > 12 ? `<li><div class="wo">… und ${git.changeCount - 12} weitere</div></li>` : ""}</ul>`);
    }
    if (o.fehler) parts.push(`<p class="hint">Beim letzten Einspielen: ${escapeHtml(o.fehler)}</p>`);
    if (o.verloren.length) parts.push(`<h4>Fehlen wieder in der zkn3</h4><p class="hint">Diese Änderungen waren eingespielt, stehen aber nicht mehr im Zettel – vermutlich hat das Zettelkasten-Programm einen älteren Stand gespeichert.</p><ul class="aend-liste">${o.verloren.map((c) => changeItem(c, [["erneut", "Erneut einspielen"], ["ignorieren", "Ist in Ordnung"]])).join("")}</ul>`);
    if (o.konflikte.length) parts.push(`<h4>Konflikte</h4><p class="hint">Die Stelle wurde anderswo geändert, deshalb ist diese Fassung nicht eingespielt. Kopiere sie bei Bedarf und verwirf den Eintrag dann.</p><ul class="aend-liste">${o.konflikte.map((c) => changeItem(c, [["verwerfen", "Verwerfen"]])).join("")}</ul>`);
    if (o.offen.length) parts.push(`<h4>Noch nicht in der zkn3</h4><p class="hint">${o.programm ? "Das Zettelkasten-Programm ist geöffnet – sie kommen hinein, sobald du es schließt." : "Sie werden gleich eingespielt."}</p><ul class="aend-liste">${o.offen.map((c) => changeItem(c, [])).join("")}</ul>`);
    const geholt = git.unterwegsFehler ? `GitHub ist gerade nicht erreichbar (${git.unterwegsFehler}); Änderungen von unterwegs kommen, sobald es wieder geht.`
      : git.unterwegsGeholt ? `Nach Änderungen von unterwegs (Chromebook, Handy) zuletzt ${kurzeZeit(git.unterwegsGeholt, { lang: true })} gesehen – das geschieht jede Minute.` : "";
    if (geholt) parts.push(`<p class="hint">${escapeHtml(geholt)}</p>`);
  }
  $("#insp-body").innerHTML = parts.join("");
}

// früherer Name (Hinweiszeile unter der Kopfleiste)
const openProblems = openStatus;

insp.addEventListener("click", (event) => {
  const button = event.target.closest('[data-status="hochladen"]');
  if (!button) return;
  button.disabled = true;
  button.textContent = "Lädt hoch …";
  sichern();
});

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

// ------------------------------------------------------------------ Material: lesen und blockweise bearbeiten
// Jeder Block (Überschrift, Absatz, Liste, Tabelle …) steht gesetzt da. Ein Klick zeigt ihn als
// Markdown zum Bearbeiten; Esc oder ein Klick daneben speichert ihn und setzt ihn wieder.

function resolvePath(base, href) {
  try {
    return decodeURIComponent(new URL(href, `http://x/${base}`).pathname.slice(1));
  } catch {
    return href;
  }
}

/** Die Blöcke einer Markdown-Datei mit ihrer Lage im Text – oder null, wenn das nicht aufgeht. */
function materialBloecke(text) {
  let tokens;
  try {
    tokens = marked.lexer(text, { gfm: true });
  } catch {
    return null;
  }
  let pos = 0;
  const parts = [];
  for (const token of tokens) {
    const raw = token.raw ?? "";
    if (text.slice(pos, pos + raw.length) !== raw) return null;
    const start = pos;
    pos += raw.length;
    if (token.type === "space" || !raw.trim()) continue;
    const quelltext = raw.replace(/\n+$/, "");
    const html = marked.parser(Object.assign([token], { links: tokens.links }), { gfm: true });
    parts.push(`<div class="md-blk" data-s="${start}" data-e="${start + quelltext.length}">${html}</div>`);
  }
  return pos === text.length ? parts.join("") : null;
}

function zeigeMaterial(path, { scroll = null } = {}) {
  const item = state.material.find((m) => m.path === path);
  const bloecke = materialBloecke(state.materialText);
  doc.innerHTML = `<div class="md" data-datei="${escapeHtml(path)}"><span class="kap-ort">Material · ${escapeHtml(item?.group ?? "")}${bloecke === null ? " · nur lesen" : ""}</span>`
    + `${bloecke ?? marked.parse(state.materialText, { gfm: true })}${bloecke === "" ? '<div class="md-blk" data-s="0" data-e="0"><p class="hint">Leer – hineinklicken und schreiben</p></div>' : ""}</div>`;
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
  if (scroll !== null) window.scrollTo(0, scroll);
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
    if (state.view?.path !== path) return;
    state.materialText = text;
    zeigeMaterial(path);
  } catch (err) {
    doc.innerHTML = `<p class="leer">Die Datei ließ sich nicht laden (${escapeHtml(err.message)}).</p>`;
  }
  window.scrollTo(0, 0);
}

/** Wo im Markdown ungefähr geklickt wurde: hinter dem Text, der vor der Klickstelle steht. */
function klickStelle(blk, event, quelltext) {
  let davor = "";
  try {
    const punkt = document.caretPositionFromPoint?.(event.clientX, event.clientY);
    const range = document.createRange();
    range.selectNodeContents(blk);
    if (punkt) range.setEnd(punkt.offsetNode, punkt.offset);
    else {
      const r = document.caretRangeFromPoint?.(event.clientX, event.clientY);
      if (!r) return quelltext.length;
      range.setEnd(r.startContainer, r.startOffset);
    }
    davor = range.toString();
  } catch {
    return quelltext.length;
  }
  for (const laenge of [24, 14, 8, 4]) {
    const probe = davor.slice(-laenge);
    if (probe.length < Math.min(laenge, davor.length) || !probe.trim()) continue;
    const at = quelltext.indexOf(probe);
    if (at >= 0) return at + probe.length;
  }
  return davor.trim() ? quelltext.length : 0;
}

function materialBearbeiten(blk, event) {
  const s = Number(blk.dataset.s);
  const e = Number(blk.dataset.e);
  const quelltext = state.materialText.slice(s, e);
  const ziel = klickStelle(blk, event, quelltext);
  blk._gesetzt = blk.innerHTML;
  blk.classList.add("bearbeiten");
  blk.innerHTML = `<div class="text ed md-quelle" contenteditable="true" spellcheck="true">${escapeHtml(quelltext)}${quelltext.endsWith("\n") ? '<br data-ende="">' : ""}</div>`;
  const ed = blk.firstElementChild;
  ed._material = { id: uid(), datei: state.view.path, start: s, vorher: quelltext };
  ed.focus();
  const { stellen } = textStellen(ed);
  const found = knotenBei(stellen, ziel);
  if (found) {
    const range = document.createRange();
    range.setStart(found[0], Math.max(0, Math.min(ziel - found[1], found[0].length)));
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }
}

const materialKey = (sitzung) => `datei\u0000${sitzung.datei}\u0000${sitzung.id}`;

/** Rettungskopie eines Material-Blocks, der gerade bearbeitet wird (übersteht Neuladen und Absturz). */
function materialMerken(ed) {
  const sitzung = ed._material;
  if (!sitzung) return;
  const nachher = domLesen(ed, { formate: false });
  if (nachher === sitzung.vorher && !sitzung.versuche) {
    rettung.loeschen(materialKey(sitzung));
    return;
  }
  rettung.merken({ key: materialKey(sitzung), art: "datei", datei: sitzung.datei, start: sitzung.start, vorher: sitzung.vorher,
    nachher, sitzung: sitzung.id, zeit: new Date().toISOString() });
}

async function materialFertig(ed) {
  const sitzung = ed._material;
  if (!sitzung) return;
  delete ed._material;
  clearTimeout(sitzung.timer);
  const blk = ed.closest(".md-blk");
  const jetzt = domLesen(ed, { formate: false });
  const path = sitzung.datei;
  const hier = () => state.view?.mode === "material" && state.view.path === path;
  // Neu gesetzt wird erst, wenn kein anderer Block mehr offen ist (sonst ginge dort Getipptes verloren)
  const andereOffen = () => $$(".md-blk.bearbeiten", doc).some((b) => b !== blk);
  if (jetzt === sitzung.vorher) {
    rettung.loeschen(materialKey(sitzung));
    if (blk && blk._gesetzt !== undefined && !state.materialNeu) {
      blk.innerHTML = blk._gesetzt; // unverändert: nur diesen Block wieder setzen
      blk.classList.remove("bearbeiten", "konflikt", "nicht-gespeichert");
    } else if (hier() && !andereOffen()) {
      state.materialNeu = false;
      zeigeMaterial(path, { scroll: window.scrollY });
    }
    zeigeUngesichert();
    return;
  }
  materialMerken(Object.assign(ed, { _material: sitzung })); // erst die Rettungskopie …
  delete ed._material;
  blk?.classList.add("speichert");
  try {
    const result = await quelle.materialAendern({ datei: path, start: sitzung.start, vorher: sitzung.vorher, nachher: jetzt, sitzung: sitzung.id });
    blk?.classList.remove("speichert", "nicht-gespeichert");
    if (result.git) updateGit(result.git);
    if (result.status === "konflikt" || result.status === "fehler") {
      // Nichts wird verworfen: der Text bleibt im Block und in der Rettungskopie
      ed._material = { ...sitzung, konflikt: true };
      blk?.classList.add("konflikt");
      toast(result.status === "konflikt" ? "Nicht gespeichert: dieser Abschnitt wurde inzwischen anderswo geändert" : "Nicht gespeichert",
        `${result.meldung || ""} Dein Text bleibt im Block – kopiere ihn, bevor du die Seite neu lädst.`, 15000);
      return;
    }
    rettung.loeschen(materialKey(sitzung));
    if (result.status === "gespeichert" || result.status === "offen") {
      const item = state.material.find((m) => m.path === path);
      verlauf.neu({ art: "datei", key: `datei\u0000${path}`, datei: path, titel: item?.title || path, at: sitzung.start,
        alt: sitzung.vorher, neu: cleanNachher("content", jetzt), vor: "", nach: "", zeit: Date.now() });
      zeigeVerlaufKnoepfe();
    }
    if (hier() && !ed.isConnected) {
      state.materialText = result.text; // der Block ist schon weg (anderes Kapitel): nur den Stand merken
    } else if (hier()) {
      state.materialText = result.text;
      if (andereOffen()) state.materialNeu = true;
      else {
        state.materialNeu = false;
        zeigeMaterial(path, { scroll: window.scrollY });
      }
    }
    loadMaterial(); // die Überschrift kann sich geändert haben (Inhaltsverzeichnis)
  } catch (err) {
    // Nicht erreichbar: Text bleibt, Rettungskopie bleibt, später von selbst noch einmal
    sitzung.versuche = (sitzung.versuche || 0) + 1;
    ed._material = sitzung;
    blk?.classList.remove("speichert");
    blk?.classList.add("nicht-gespeichert");
    materialMerken(ed);
    if (sitzung.versuche === 1) {
      toast("Noch nicht gespeichert", `${quelle?.texte?.nichtErreichbar || "Keine Verbindung"}. Dein Text bleibt im Block und wird von selbst gespeichert.`, 12000);
    }
    const pause = Math.min(30000, 1500 * 2 ** Math.min(sitzung.versuche - 1, 5));
    sitzung.timer = setTimeout(() => {
      if (ed._material !== sitzung) return;
      if (document.activeElement === ed) return; // wird gerade bearbeitet: beim Verlassen
      materialFertig(ed);
    }, pause);
  } finally {
    zeigeUngesichert();
  }
}

/** Beim Öffnen: eine Rettungskopie aus dem Material noch einmal speichern – oder zum Kopieren zeigen. */
async function materialRettung(r) {
  try {
    const result = await quelle.materialAendern({ datei: r.datei, start: r.start, vorher: r.vorher, nachher: r.nachher, sitzung: r.sitzung });
    const schonDa = typeof result.text === "string" && result.text.includes(String(r.nachher).replace(/^\n+|\n+$/g, ""));
    if (result.status !== "konflikt" && result.status !== "fehler") {
      rettung.loeschen(r.key);
      toast("Nicht gespeicherter Text wiederhergestellt", `${r.datei} – jetzt gespeichert.`, 8000);
      if (result.status === "gespeichert") loadMaterial();
      return;
    }
    if (schonDa) {
      rettung.loeschen(r.key);
      return;
    }
    openInsp("Nicht gespeichert", r.datei, `<p>Dieser Text aus dem Material wurde nicht gespeichert, weil der Abschnitt inzwischen anderswo geändert wurde. Kopiere ihn und füge ihn von Hand ein.</p>`
      + `<pre class="rettung-text">${escapeHtml(r.nachher)}</pre>`
      + `<p><button class="tb" type="button" data-rettung-kopieren="${escapeHtml(r.key)}">Kopieren</button> `
      + `<button class="tb" type="button" data-rettung-weg="${escapeHtml(r.key)}">Erledigt – Kopie löschen</button></p>`, "rettung");
  } catch {
    /* jetzt nicht erreichbar: die Kopie bleibt für das nächste Mal */
  }
}

insp.addEventListener("click", async (event) => {
  const kopieren = event.target.closest("[data-rettung-kopieren]");
  if (kopieren) {
    const r = rettung.alle()[kopieren.dataset.rettungKopieren];
    if (r && (await toClipboard(r.nachher))) toast("Kopiert");
    return;
  }
  const weg = event.target.closest("[data-rettung-weg]");
  if (weg) {
    rettung.loeschen(weg.dataset.rettungWeg);
    closeInsp();
  }
});

// ------------------------------------------------------------------ Zettel außerhalb der Anordnung

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
    doc.innerHTML = `<div class="kapitel" data-zettel="${escapeHtml(entry.id)}">${chapterHtml(entry, 1)}</div>`;
    bindeSitzungen();
    loadOpenMisc();
    if (state.term && hitCounter && restore === null) scrollToHit(state.hitIndex);
    else window.scrollTo(0, restore ?? 0);
    nummernAlle();
  } catch (err) {
    doc.innerHTML = `<p class="leer">${escapeHtml(err.message)}</p>`;
  }
}

// ------------------------------------------------------------------ Speicherstand, Sichern, Status

/** Die Zeile unter der Kopfleiste: nur wenn etwas nicht passt (Konflikt, Programm offen …). */
function updateEditStatus(b) {
  state.edit = b;
  const el = $("#speicherstand");
  const n = (count, one, many) => `${count} ${count === 1 ? one : many}`;
  let text = "";
  let cls = "";
  if (b.fehler && quelle?.modus !== "github") { text = `⚠ Speichern gestört: ${b.fehler}`; cls = "problem"; }
  else if (b.konflikte) { text = `⚠ ${n(b.konflikte, "Konflikt", "Konflikte")}`; cls = "problem"; }
  else if (b.verloren) { text = `⚠ ${n(b.verloren, "Änderung fehlt", "Änderungen fehlen")} wieder in der zkn3`; cls = "problem"; }
  else if (b.programm && b.offen) { text = `⏳ ${n(b.offen, "Änderung wartet", "Änderungen warten")}, bis das Zettelkasten-Programm geschlossen ist`; cls = "wartet"; }
  else if (b.programm) { text = "Zettelkasten-Programm geöffnet – Änderungen warten bis zum Schließen"; cls = "wartet"; }
  el.className = `speicherstand ${cls}`;
  el.innerHTML = text ? `<a href="#" data-oeffnet="1" id="zu-aenderungen">${escapeHtml(text)}</a>` : "";
  el.parentElement.hidden = !text && $("#ungesichert").hidden; // die Zeile erscheint nur, wenn es etwas zu melden gibt
  hdrHeight();
  zeigeStatus();
}

$("#speicherstand").addEventListener("click", (event) => {
  if (event.target.id !== "zu-aenderungen") return;
  event.preventDefault();
  openStatus();
});

const pad2 = (n) => String(n).padStart(2, "0");

/** Kurze Zeitangabe für den Knopf: „9:48“, „gestern 23:12“, „12.11. 23:12“. */
function kurzeZeit(iso, { lang = false } = {}) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return "";
  const hm = `${d.getHours()}:${pad2(d.getMinutes())}`;
  const tag = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const tage = Math.round((tag(new Date()) - tag(d)) / 86400000);
  if (tage === 0) return lang ? `heute um ${hm}` : hm;
  if (tage === 1) return lang ? `gestern um ${hm}` : `gestern ${hm}`;
  return lang ? `am ${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear() === new Date().getFullYear() ? "" : d.getFullYear()} um ${hm}`
    : `${d.getDate()}.${d.getMonth() + 1}. ${hm}`;
}

/**
 * Wie es um das Speichern steht – EIN Zustand für den Knopf oben, auf beiden Geräten:
 *   oben     alles (auch das eben Getippte) ist auf GitHub          „Auf GitHub ✓ 9:48“
 *   unten    etwas ist noch nicht oben (geht gleich von selbst hoch) „Noch nicht auf GitHub“
 *   laedt    wird gerade hochgeladen                                 „Lädt hoch …“
 *   offline  keine Verbindung: alles bleibt auf dem Gerät             „Offline“
 *   problem  etwas ist nicht gespeichert oder gestört                „Nicht gespeichert“ …
 */
function statusArt() {
  const git = state.git;
  const github = quelle?.modus === "github";
  const sitz = [...sitzungen.values()];
  const nichtGespeichert = sitz.filter((s) => s.zustand === "nichtGespeichert").length + $$(".md-blk.nicht-gespeichert", doc).length;
  const konflikte = sitz.filter((s) => s.zustand === "konflikt").length;
  const tippt = sitz.some((s) => s.zustand === "ungespeichert" || s.zustand === "speichert") || $$(".md-blk.speichert", doc).length > 0;
  const n = (count, one, many) => `${count} ${count === 1 ? one : many}`;
  if (!github && !state.online) {
    return { art: "problem", text: "Dienst antwortet nicht",
      satz: "Der Reader-Dienst auf dem Laptop antwortet nicht. Was du tippst, bleibt im Feld und wird gespeichert, sobald er wieder läuft (Doppelklick auf „Roman“)." };
  }
  if (nichtGespeichert) {
    return { art: "problem", text: "Nicht gespeichert",
      satz: `${n(nichtGespeichert, "Ein Text ist", "Texte sind")} noch nicht gespeichert – ${quelle?.texte?.nichtErreichbar || "keine Verbindung"}. Dein Text bleibt im Feld und wird von selbst gespeichert.` };
  }
  if (!git) return { art: "unbekannt", text: github ? "GitHub …" : "Sichern", satz: "Wird geprüft …" };
  const offen = (git.changeCount || 0) + (git.ahead || 0);
  const wartend = offen || tippt;
  if (github && git.offline) {
    return { art: "offline", text: wartend ? "Offline · auf dem Gerät" : "Offline", zeit: wartend ? null : git.standOben,
      satz: `Keine Verbindung zu GitHub. Du kannst weiterschreiben: ${wartend ? "Deine Änderungen sind auf diesem Gerät gespeichert und gehen" : "Was du schreibst, bleibt auf diesem Gerät und geht"} von selbst hoch, sobald wieder Verbindung besteht.` };
  }
  if (git.ok === false) {
    return { art: "problem", text: github ? "GitHub-Zugang" : "Git-Problem", satz: git.error || "Git meldet ein Problem." };
  }
  if (state.sichernLaeuft || git.laeuft) return { art: "laedt", text: "Lädt hoch …", satz: "Wird gerade zu GitHub hochgeladen …" };
  if (github && git.fehler) return { art: "problem", text: "Hochladen gestört", satz: `${git.fehler} Deine Änderungen sind auf diesem Gerät gespeichert.` };
  if (konflikte) return { art: "problem", text: "Konflikt", satz: "Eine Stelle wurde inzwischen anderswo geändert – bitte im Feld entscheiden." };
  if (wartend) {
    const satz = github
      ? `${offen ? n(offen, "Änderung ist", "Änderungen sind") : "Was du eben getippt hast, ist"} noch nicht auf GitHub (auf diesem Gerät gespeichert). Das geht in wenigen Sekunden von selbst.`
      : git.ahead && !git.changeCount
        ? "Auf dem Laptop gesichert, aber noch nicht hochgeladen (keine Verbindung?). Wird von selbst wiederholt."
        : `Auf dem Laptop gespeichert, aber noch nicht auf GitHub. ${git.auto || "Lädt von selbst hoch, kurz nachdem du etwas geändert hast."}`;
    return { art: "unten", text: "Noch nicht auf GitHub", satz };
  }
  const zeit = github ? git.standOben : git.zuletztOben || git.lastCommit?.time;
  return { art: "oben", text: "Auf GitHub ✓", zeit,
    satz: `Alles ist auf GitHub${zeit ? ` – Stand ${kurzeZeit(zeit, { lang: true })}` : ""}.` };
}

/** Knopf oben rechts: zeigt den Stand, ein Klick zeigt Einzelheiten (und lädt hoch, wenn etwas fehlt). */
function zeigeStatus() {
  const button = $("#btn-sichern");
  if (!button || !quelle) return;
  const a = statusArt();
  const zeit = a.zeit ? kurzeZeit(a.zeit) : "";
  button.dataset.stand = a.art;
  button.classList.remove("primary", "oben", "unten");
  for (const art of ["oben", "unten", "laedt", "offline", "problem", "unbekannt"]) button.classList.toggle(`st-${art}`, a.art === art);
  // Auf dem Handy steht statt des Textes ein Zeichen (die Uhrzeit bleibt): ✓ oben, ↑ fehlt noch, ⚠ Problem
  const kurz = { oben: "✓", unten: "↑", laedt: "↑", offline: "Offline", problem: "⚠", unbekannt: "…" }[a.art];
  button.innerHTML = `<span class="st-kurz" aria-hidden="true">${kurz}</span><span class="st-text">${escapeHtml(a.text)}</span>`
    + `${zeit ? `<span class="st-zeit">${escapeHtml(zeit)}</span>` : ""}`;
  button.title = `${a.satz}\nEin Klick zeigt Einzelheiten${a.art === "unten" || a.art === "offline" ? " und lädt sofort hoch" : ""}.`;
  button.setAttribute("aria-label", `${a.text}${zeit ? ` (${zeit})` : ""}`);
  const kopf = !insp.hidden && insp.dataset.art === "status" ? $(".st-kopf", insp) : null;
  if (kopf) {
    kopf.className = `st-kopf st-${a.art}`;
    kopf.textContent = a.satz;
  }
}

function updateGit(git) {
  if (!git) return;
  state.git = git;
  zeigeStatus();
}

async function sichern() {
  if (state.sichernLaeuft) return;
  state.sichernLaeuft = true;
  zeigeStatus();
  try {
    // Was eben noch im Feld stand (der Klick hat die Eingabe beendet), erst fertig speichern
    await Promise.all([...sitzungen.values()].map((s) => s.chain).filter(Boolean));
    const result = await quelle.sichern();
    if (result.git) state.git = result.git;
    if (!result.ok) toast(result.message, result.detail || "", 10000);
  } catch (err) {
    toast("Sichern ist fehlgeschlagen", err.message, 10000);
  } finally {
    state.sichernLaeuft = false;
    zeigeStatus();
    if (!insp.hidden && insp.dataset.art === "status") openStatus();
  }
}

/** Klick auf den Knopf: Einzelheiten zeigen – und hochladen, wenn noch etwas fehlt. */
function statusKlick() {
  const a = statusArt();
  openStatus();
  if (a.art === "unten" || a.art === "offline" || (a.art === "problem" && state.git?.changeCount)) sichern();
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
    wiederholeAlle();
    state.git = status.git || state.git;
    zeigeStatus();
    if (status.bearbeitung) updateEditStatus(status.bearbeitung);
    if (status.error && status.error !== state.lastError) toast(status.error, "", 8000);
    state.lastError = status.error;
    const stand = status.stand || status.version;
    if (stand && state.book && stand !== state.version) {
      if (document.activeElement?.closest?.("#doc .ed") || state.saving) state.reloadWanted = true;
      else await reloadBook(false, status);
    }
  } catch (err) {
    if (err?.zugang) {
      zeigeEinrichtung(err.message);
      return;
    }
    if (state.online) toast(...quelle.texte.offline, 8000);
    state.online = false;
    zeigeStatus();
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
  if (!quiet) toast(quelle.modus === "github" ? "Neuer Stand von GitHub geladen" : "Neuer Stand des Romans geladen",
    status?.modified ? `zkn3 gesichert ${kurzeZeit(status.modified, { lang: true })}` : "");
}

document.addEventListener("visibilitychange", () => {
  if (!quelle || !state.book) return;
  // Unterwegs endet eine Eingabe, wenn die Seite in den Hintergrund geht (Deckel zu, andere App): dann wird hochgeladen.
  if (document.hidden) schrittAbschliessen();
  if (document.hidden && quelle.modus === "github") document.activeElement?.closest?.(".ed")?.blur();
  if (!document.hidden) poll();
  else schedulePoll();
});

// ------------------------------------------------------------------ Export: der ganze Stand als Datei

function exportOeffnen() {
  const lokal = quelle.modus === "lokal";
  openInsp("Export", "", `<p>Lädt den ganzen Stand als eine Datei herunter: alle Kapitel der Anordnung mit Titel, Text und Sonstigen Vermerken, das Material und alle Änderungen, die noch nicht in der zkn3 stehen. Die Datei lässt sich ohne Internet in jedem Browser lesen.</p>`
    + '<p><button class="btn primary" type="button" data-export="laden">Herunterladen</button></p>'
    + (lokal
      ? '<h4>Datei vom Chromebook einlesen</h4><p class="hint">Bringt Änderungen, die unterwegs ohne Internet entstanden sind, in die zkn3 – genau wie beim Abholen über GitHub (mit Sicherungskopie und Änderungsbuch). Was schon da ist, wird übersprungen.</p>'
        + '<p><label class="btn">Datei wählen …<input type="file" accept=".html,.htm,.json" data-export="einlesen" hidden></label></p>'
      : '<p class="hint">Ohne Internet bleiben deine Änderungen auf diesem Gerät und gehen später von selbst auf GitHub. Die Datei ist die Sicherheit für den Notfall – der Reader auf dem Laptop kann sie unter „Export“ einlesen.</p>'), "export");
}

function herunterladen(text, name) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/html;charset=utf-8" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function exportieren(button) {
  button.disabled = true;
  button.textContent = "Wird zusammengestellt …";
  try {
    const daten = await quelle.exportDaten();
    const html = exportHtml({ titel: state.title, ...daten }, { markdown: (t) => marked.parse(t, { gfm: true }) });
    const name = exportName(state.title);
    herunterladen(html, name);
    toast("Export heruntergeladen", `${name} – ${formatNumber(daten.kapitel.length)} Kapitel, ${daten.aenderungen.length} offene Änderungen`, 6000);
  } catch (err) {
    toast("Export ging nicht", err.message, 9000);
  } finally {
    button.disabled = false;
    button.textContent = "Herunterladen";
  }
}

async function einlesen(input) {
  const file = input.files?.[0];
  if (!file) return;
  try {
    const daten = leseExport(await file.text());
    const result = await quelle.einlesen(daten.aenderungen);
    toast(result.neu ? `${result.neu === 1 ? "Eine Änderung" : `${result.neu} Änderungen`} übernommen` : "Nichts Neues in der Datei",
      result.meldung || "", 8000);
    if (result.bearbeitung) updateEditStatus(result.bearbeitung);
    await reloadBook(true);
  } catch (err) {
    toast("Einlesen ging nicht", err.message, 9000);
  } finally {
    input.value = "";
  }
}

insp.addEventListener("click", (event) => {
  const button = event.target.closest('[data-export="laden"]');
  if (button) exportieren(button);
});
insp.addEventListener("change", (event) => {
  if (event.target.matches?.('[data-export="einlesen"]')) einlesen(event.target);
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
    <p>Der Reader lädt den Roman aus deinem privaten GitHub-Repository – so, wie du ihn zuletzt auf dem Laptop gesichert hast. Was du hier schreibst, kommt in die zkn3, sobald der Reader auf dem Laptop läuft.</p>
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

insp.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-github]");
  if (!button) return;
  if (button.dataset.github === "abmelden") {
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

// ------------------------------------------------------------------ Handy: eine Zeile oben, der Rest im Menü
// Auf schmalen Bildschirmen wandern Ansicht, Blättern, Suche, Schalter, Export ins Menü „⋯“. Es sind
// dieselben Bedienelemente wie am Laptop (nur woanders), damit es nur einen Reader gibt.

const MENU_TEILE = [["#views", "ansicht"], ["#vor", "ansicht"], ["#weiter", "ansicht"], ["#suche", "suche"],
  ["#toggles", "anzeige"], ["#btn-schreibtisch", "mehr"], ["#btn-export", "mehr"]];
const platzhalter = new Map();

function layoutAnpassen() {
  const handy = istHandy();
  document.body.classList.toggle("handy", handy);
  const menu = $("#menu");
  for (const [sel, gruppe] of MENU_TEILE) {
    const el = $(sel);
    if (!el) continue;
    if (handy && !platzhalter.has(sel)) {
      const marke = document.createComment(sel);
      el.before(marke);
      platzhalter.set(sel, marke);
      $(`.menu-gruppe[data-g="${gruppe}"]`, menu).append(el);
    } else if (!handy && platzhalter.has(sel)) {
      platzhalter.get(sel).replaceWith(el);
      platzhalter.delete(sel);
    }
  }
  if (!handy) menuZu();
  hdrHeight();
  leistePlatz();
}

function menuZu() {
  $("#menu").hidden = true;
  $("#btn-menu").setAttribute("aria-expanded", "false");
}

function menuUmschalten() {
  const auf = $("#menu").hidden;
  $("#menu").hidden = !auf;
  $("#btn-menu").setAttribute("aria-expanded", String(auf));
  if (auf) closeInsp();
}

// ------------------------------------------------------------------ Bedienelemente

function wireUi() {
  baueLeiste();
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
    } else if (box.dataset.t === "nummern") {
      nummernSicht.disconnect();
      sichtbar.clear();
      nummernAlle();
    }
  });
  $("#inhalt-knopf").addEventListener("click", () => setTocOpen(!tocOpen()));
  $("#vor").addEventListener("click", () => navigate(-1));
  $("#weiter").addEventListener("click", () => navigate(1));
  $("#btn-sichern").addEventListener("click", statusKlick);
  $("#btn-export").addEventListener("click", exportOeffnen);
  // Rückgängig/Wiederholen oben: nehmen dem Feld die Schreibmarke nicht (die Eingabe läuft weiter)
  for (const button of $$("header.bar [data-act]")) button.addEventListener("mousedown", (event) => event.preventDefault());
  $("header.bar").addEventListener("click", (event) => {
    const act = event.target.closest("[data-act]")?.dataset.act;
    if (act === "zurueck") rueckgaengig(true);
    else if (act === "wieder") rueckgaengig(false);
  });
  $("#btn-menu").addEventListener("click", menuUmschalten);
  $("#menu").addEventListener("click", (event) => {
    // Eine Wahl im Menü schließt es (außer Schalter und Suchfeld)
    if (event.target.closest("button") && !event.target.closest("#toggles")) setTimeout(menuZu, 0);
  });
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!$("#menu").hidden && !target.closest?.("#menu, #btn-menu")) menuZu();
    // In schmalen Fenstern liegt das Inhaltsverzeichnis über dem Text: ein Tipp daneben schließt es
    if (!wideScreen() && tocOpen() && target.isConnected && !target.closest?.("#inhalt, #inhalt-knopf")) setTocOpen(false);
  });
  handyAnsicht.addEventListener("change", layoutAnpassen);
  window.visualViewport?.addEventListener("resize", () => { leistePlatz(); markeSichtbar(); });
  window.visualViewport?.addEventListener("scroll", leistePlatz);
  layoutAnpassen();
  zeigeVerlaufKnoepfe();

  document.addEventListener("keydown", (event) => {
    const target = event.target;
    const taste = (event.key || "").toLowerCase();
    // Strg+Z / Strg+Y auch außerhalb der Felder (in einem Feld fängt der Reader sie schon ab)
    if (!event.defaultPrevented && (event.ctrlKey || event.metaKey) && !event.altKey && (taste === "z" || taste === "y")
        && !target.closest?.(".ed") && !target.matches?.("input, textarea, select")) {
      event.preventDefault();
      rueckgaengig(taste === "z" && !event.shiftKey);
      return;
    }
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "Escape") {
      closeInsp();
      menuZu();
    }
    if (target.closest?.(".ed") || target.matches?.("input, textarea, select")) return;
    if (event.key === "ArrowLeft" && state.view?.mode === "kapitel") { navigate(-1); event.preventDefault(); }
    else if (event.key === "ArrowRight" && state.view?.mode === "kapitel") { navigate(1); event.preventDefault(); }
    else if (event.key === "/") { event.preventDefault(); searchInput.focus(); searchInput.select(); }
  });
  window.addEventListener("hashchange", () => route());
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    hdrHeight();
    leistePlatz();
    applySettings();
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(nummernSichtbare, 250);
  });
  document.fonts?.ready?.then(() => nummernSichtbare());
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
  if (quelle.modus === "github") document.body.classList.add("unterwegs");
  // Der Stand ändert sich auch ohne Abfrage (Hochladen fertig, Verbindung weg): dann gleich zeigen
  quelle.beobachten?.((z) => {
    if (z.git) state.git = z.git;
    if (z.bearbeitung) updateEditStatus(z.bearbeitung);
    else zeigeStatus();
  });
  zeigeStatus();
  // Unterwegs: die Seite selbst bleibt auch ohne Netz zu öffnen (sw.js legt sie im Browser ab)
  if ((!LOKALER_RECHNER || new URLSearchParams(location.search).has("sw")) && "serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
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
  await rettungEinspielen();
  await route();
  document.body.dataset.bereit = "1";
  poll();
}

init();
