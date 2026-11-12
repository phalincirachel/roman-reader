// Export: der ganze Stand als eine Datei – für den Fall, dass kein Internet da ist.
// Die Datei ist eine HTML-Seite, die sich ohne Netz im Browser lesen lässt: alle Kapitel der
// Anordnung mit Titel, Text (formatiert) und Sonstigen Vermerken, dazu das Material. Unten steht
// derselbe Stand maschinenlesbar, mit allen Änderungen, die noch nicht in der zkn3 sind – so kann
// der Reader auf dem Laptop eine Datei vom Chromebook einlesen (leseExport).
// Reine Funktionen ohne Browser – auch mit Node testbar.
import { escapeHtml, formatDate } from "./textsatz.js";
import { feldHtml } from "./format.js";

export const EXPORT_ART = "roman-export";
const DATEN_RE = /<script type="application\/json" id="roman-export">([\s\S]*?)<\/script>/;

const STIL = `
:root{--bg:#f7f5f0;--surface:#fff;--ink:#1e1c19;--muted:#6a645b;--line:#e2ddd2;--accent:#2b4a86;--anm:#8a6a2e}
@media (prefers-color-scheme: dark){:root{--bg:#191816;--surface:#22201d;--ink:#ece7de;--muted:#a59e92;--line:#3a3731;--accent:#8fb0f2;--anm:#c9a96a}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:system-ui,"Segoe UI",Roboto,Arial,sans-serif;line-height:1.5}
main{max-width:50rem;margin:0 auto;padding:1rem}
.blatt{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:1.6rem 2rem 2rem;margin:1rem 0}
h1,h2,h3{font-family:"Iowan Old Style","Palatino Linotype","Book Antiqua",Palatino,Georgia,serif;line-height:1.25}
h1{font-size:1.7rem;margin:.2rem 0 .3rem}
.jahr{text-align:center;color:var(--muted);letter-spacing:.25em;font-weight:400;font-size:1.05rem;margin:2.6rem 0 1rem}
h3{font-size:1.38rem;margin:2rem 0 .5rem}
.text{font-family:"Iowan Old Style","Palatino Linotype","Book Antiqua",Palatino,Georgia,serif;font-size:1.08rem;line-height:1.62;white-space:pre-wrap;overflow-wrap:break-word}
.anm{color:var(--anm)}
.ort,.hint{color:var(--muted);font-size:.8rem}
details{margin:.3rem 0 .6rem;font-size:.9rem}
details .text{font-size:.95rem;border:1px solid var(--line);border-radius:8px;padding:.5rem .8rem}
nav ol{columns:2 18rem;font-size:.85rem;padding-left:1.2rem}
nav a{color:var(--ink);text-decoration:none}
a{color:var(--accent)}
.md table{border-collapse:collapse;font-size:.88rem}.md th,.md td{border:1px solid var(--line);padding:.3rem .55rem;text-align:left;vertical-align:top}
.aend li{margin:.4rem 0}.aend .vorher{color:#b3261e;text-decoration:line-through}.aend .nachher{color:#0b6a72}
@media (max-width:760px){.blatt{padding:1.1rem 1rem}}
@media print{nav,.aend{display:none}body{background:#fff}.blatt{border:0}}
`;

const pad = (n) => String(n).padStart(2, "0");

/** Dateiname für den Export: „Chronik Stand 2026-11-12 16-40.html“. */
export function exportName(titel, jetzt = new Date()) {
  const stamp = `${jetzt.getFullYear()}-${pad(jetzt.getMonth() + 1)}-${pad(jetzt.getDate())} ${pad(jetzt.getHours())}-${pad(jetzt.getMinutes())}`;
  return `${String(titel || "Roman").replace(/[\\/:*?"<>|]+/g, " ").trim()} Stand ${stamp}.html`;
}

/**
 * Die Exportdatei als HTML-Text.
 * daten: { titel, erstellt, geraet, stand, abschnitte, kapitel, material, aenderungen }
 * markdown: Funktion Markdown -> HTML (im Reader: marked.parse)
 */
export function exportHtml(daten, { markdown = (t) => `<pre>${escapeHtml(t)}</pre>` } = {}) {
  const titel = daten.titel || "Roman";
  const teile = [];
  const offen = daten.aenderungen || [];
  teile.push(`<h1>${escapeHtml(titel)}</h1>`);
  teile.push(`<p class="ort">Stand ${escapeHtml(formatDate(daten.erstellt))} · exportiert ${escapeHtml(daten.geraet ? `auf dem ${daten.geraet}` : "")}`
    + `${daten.stand?.datum ? ` · Roman-Stand der zkn3 vom ${escapeHtml(formatDate(daten.stand.datum))}` : ""}`
    + ` · ${offen.length === 1 ? "eine Änderung" : `${offen.length} Änderungen`} noch nicht in der zkn3 (hier schon enthalten)</p>`);
  const kapitel = daten.kapitel || [];
  teile.push(`<nav><ol>${kapitel.map((k) => `<li><a href="#z${escapeHtml(k.id)}">${escapeHtml(k.title)}</a></li>`).join("")}`
    + `${(daten.material || []).length ? '<li><a href="#material">Material</a></li>' : ""}</ol></nav>`);
  let abschnitt = null;
  const blatt = [];
  for (const k of kapitel) {
    if (k.section !== abschnitt) {
      abschnitt = k.section;
      const name = daten.abschnitte?.[k.section]?.name;
      if (name) blatt.push(`<h2 class="jahr">${escapeHtml(name)}</h2>`);
    }
    blatt.push(`<section id="z${escapeHtml(k.id)}"><h3>${escapeHtml(k.title || "(ohne Titel)")}</h3>`
      + `<p class="ort">Zettel ${escapeHtml(k.id)}</p>`
      + (k.misc ? `<details><summary>Sonstige Vermerke</summary><div class="text">${feldHtml(k.misc, { formate: false }).html}</div></details>` : "")
      + `<div class="text">${feldHtml(k.text || "").html}</div></section>`);
  }
  teile.push(`<div class="blatt">${blatt.join("\n")}</div>`);
  if ((daten.material || []).length) {
    teile.push('<h2 id="material" class="jahr">Material</h2>');
    for (const m of daten.material) {
      teile.push(`<div class="blatt md"><p class="ort">${escapeHtml(m.group || "")} · ${escapeHtml(m.path)}</p>${markdown(m.text || "")}</div>`);
    }
  }
  if (offen.length) {
    teile.push(`<div class="blatt aend"><h2>Änderungen, die noch nicht in der zkn3 sind</h2><ol>${offen.map((c) =>
      `<li><span class="ort">${escapeHtml(formatDate(c.geaendert || c.erstellt))} · ${escapeHtml(c.datei || c.titel || `Zettel ${c.zettel}`)}`
      + `${c.feld && c.feld !== "content" ? ` · ${c.feld === "title" ? "Titel" : "Sonstige Vermerke"}` : ""}</span><br>`
      + `<span class="vorher">${escapeHtml(c.vorher)}</span><br><span class="nachher">${escapeHtml(c.nachher || "(gelöscht)")}</span></li>`).join("")}</ol></div>`);
  }
  const json = JSON.stringify({ art: EXPORT_ART, format: 1, ...daten }).replace(/</g, "\\u003c");
  return `<!doctype html>\n<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<title>${escapeHtml(titel)} – Stand ${escapeHtml(formatDate(daten.erstellt))}</title><style>${STIL}</style></head>\n`
    + `<body><main>${teile.join("\n")}</main>\n<script type="application/json" id="roman-export">${json}</script>\n</body></html>\n`;
}

/** Liest die Daten aus einer Exportdatei (HTML wie oben oder reines JSON). Wirft bei fremden Dateien. */
export function leseExport(text) {
  const raw = String(text ?? "");
  const match = DATEN_RE.exec(raw);
  let daten;
  try {
    daten = JSON.parse(match ? match[1] : raw);
  } catch {
    throw new Error("Das ist keine Exportdatei des Readers.");
  }
  if (!daten || daten.art !== EXPORT_ART || !Array.isArray(daten.aenderungen)) throw new Error("Das ist keine Exportdatei des Readers.");
  return daten;
}
