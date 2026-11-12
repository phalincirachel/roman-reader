// Formatierungen im Zetteltext – mit denselben Codes wie das Zettelkasten-Programm
// (de.danielluedecke.zettelkasten.util.HtmlUbbUtil):
//
//   [f]fett[/f]   [k]kursiv[/k]   [u]unterstrichen[/u]   [d]durchgestrichen[/d]   [color #rrggbb]Farbe[/color]
//
// Das Programm sucht jedes Paar für sich (nicht gierig: ein Anfang gilt bis zum nächsten Ende
// derselben Art); ein Anfang ohne Ende bleibt Text. Hier ebenso, damit der Reader auf dem Laptop,
// der Reader unterwegs und das Programm dieselben Formatierungen zeigen.
//
// Im Reader wird ein Feld als formatierter Text gezeigt (fett, kursiv …) und beim Speichern
// wieder in Codes übersetzt. Reine Funktionen ohne Browser – auch mit Node testbar; das Lesen
// des Browser-Textes (domLesen) braucht nur childNodes, nodeType, nodeValue, tagName, getAttribute, style.
import { escapeHtml, escapeRegExp } from "./textsatz.js";

export const ARTEN = ["f", "k", "u", "d"]; // fett, kursiv, unterstrichen, durchgestrichen
const HTML_TAG = { f: "b", k: "i", u: "u", d: "s" };
const CODE_RE = /\[(\/?)(f|k|u|d)\]|\[color ([^[\]]*)\]|\[\/color\]/g;
export const OHNE_FARBE = "#010203"; // Platzhalter des Readers für „Standardfarbe“ (wird nie gespeichert)

/** Farben, die die Leiste anbietet (gut lesbar auf hellem und dunklem Grund). */
export const FARBEN = [
  ["#d04437", "Rot"], ["#2f6fdb", "Blau"], ["#23935a", "Grün"], ["#d9822b", "Orange"], ["#8e44ad", "Violett"], ["#8a8178", "Grau"],
];

// ------------------------------------------------------------------ Codes lesen

const KEIN = Object.freeze({ f: false, k: false, u: false, d: false, color: null });

function schluessel(a) {
  return `${a.f ? "f" : ""}${a.k ? "k" : ""}${a.u ? "u" : ""}${a.d ? "d" : ""}|${a.color ?? ""}`;
}

/** Alle Codes im Text: { art, auf, start, end, wert } in Textreihenfolge. */
function codes(text) {
  const list = [];
  CODE_RE.lastIndex = 0;
  let m;
  while ((m = CODE_RE.exec(text))) {
    if (m[2]) list.push({ art: m[2], auf: !m[1], start: m.index, end: m.index + m[0].length });
    else if (m[3] !== undefined) list.push({ art: "color", auf: true, start: m.index, end: m.index + m[0].length, wert: m[3] });
    else list.push({ art: "color", auf: false, start: m.index, end: m.index + m[0].length });
  }
  return list;
}

/**
 * Zerlegt einen Zetteltext in Stücke mit gleicher Formatierung: [{ text, f, k, u, d, color }].
 * Die Codes selbst fallen weg; was kein Paar bildet, bleibt Text.
 */
export function zerlege(text) {
  const value = String(text ?? "");
  const alle = codes(value);
  const weg = []; // Bereiche der Codes, die ein Paar bilden
  const bereiche = []; // { art, von, bis, wert } – formatierter Bereich im Text
  for (const art of [...ARTEN, "color"]) {
    const eigene = alle.filter((c) => c.art === art);
    let i = 0;
    while (i < eigene.length) {
      const auf = eigene.findIndex((c, j) => j >= i && c.auf);
      if (auf < 0) break;
      const zu = eigene.findIndex((c, j) => j > auf && !c.auf);
      if (zu < 0) break; // ein Anfang ohne Ende bleibt Text (wie im Programm)
      // Was zwischen Anfang und Ende steht, gehört zum Inhalt – auch weitere Anfänge derselben Art
      weg.push([eigene[auf].start, eigene[auf].end], [eigene[zu].start, eigene[zu].end]);
      bereiche.push({ art, von: eigene[auf].end, bis: eigene[zu].start, wert: eigene[auf].wert });
      i = zu + 1;
    }
  }
  if (!weg.length) return value ? [{ text: value, ...KEIN }] : [];
  weg.sort((x, y) => x[0] - y[0]);
  // Zeichen für Zeichen die Formatierung bestimmen (Grenzen genügen: nur dort ändert sie sich)
  const grenzen = new Set([0, value.length]);
  for (const [s, e] of weg) grenzen.add(s).add(e);
  for (const b of bereiche) grenzen.add(b.von).add(b.bis);
  const punkte = [...grenzen].sort((x, y) => x - y);
  const stuecke = [];
  let w = 0;
  for (let p = 0; p + 1 < punkte.length; p += 1) {
    const von = punkte[p];
    const bis = punkte[p + 1];
    while (w < weg.length && weg[w][1] <= von) w += 1;
    if (w < weg.length && weg[w][0] <= von && bis <= weg[w][1]) continue; // ein Code
    const a = { ...KEIN };
    for (const b of bereiche) {
      if (b.von <= von && bis <= b.bis) {
        if (b.art === "color") a.color = b.wert;
        else a[b.art] = true;
      }
    }
    anhaengen(stuecke, value.slice(von, bis), a);
  }
  return stuecke;
}

function anhaengen(stuecke, text, a) {
  if (!text) return;
  const last = stuecke[stuecke.length - 1];
  if (last && schluessel(last) === schluessel(a)) last.text += text;
  else stuecke.push({ text, f: Boolean(a.f), k: Boolean(a.k), u: Boolean(a.u), d: Boolean(a.d), color: a.color ?? null });
}

/** Der Text ohne Formatcodes (für Suche, Kopieren, Zählen). */
export function klartext(text) {
  return zerlege(text).map((s) => s.text).join("");
}

// ------------------------------------------------------------------ Codes schreiben

/**
 * Stücke wieder als Zetteltext mit Codes. Jede Art wird für sich geöffnet und geschlossen
 * (das Programm liest sie ebenso einzeln); an einer Stelle erst schließen, dann öffnen.
 */
export function zusammensetzen(stuecke) {
  let out = "";
  let jetzt = { ...KEIN };
  const wechsel = (neu) => {
    if (jetzt.color !== null && jetzt.color !== neu.color) out += "[/color]";
    for (const art of [...ARTEN].reverse()) if (jetzt[art] && !neu[art]) out += `[/${art}]`;
    for (const art of ARTEN) if (!jetzt[art] && neu[art]) out += `[${art}]`;
    if (neu.color !== null && jetzt.color !== neu.color) out += `[color ${neu.color}]`;
    jetzt = { ...neu };
  };
  for (const stueck of stuecke) {
    if (!stueck.text) continue;
    wechsel({ f: Boolean(stueck.f), k: Boolean(stueck.k), u: Boolean(stueck.u), d: Boolean(stueck.d), color: stueck.color ?? null });
    out += stueck.text;
  }
  wechsel(KEIN);
  return out;
}

// ------------------------------------------------------------------ Anzeige

const ANM_RE = /\[[^[\]\n]*\]/g;
const SICHERE_FARBE = /^(#[0-9a-f]{3,8}|[a-z]{3,20})$/i;

/**
 * HTML eines bearbeitbaren Feldes: Formatierung als <b>, <i>, <u>, <s> und farbige Spannen,
 * [Anmerkungen] hervorgehoben, Suchtreffer markiert. Zeilenumbrüche bleiben \n (white-space: pre-wrap).
 * formate=false: Codes bleiben sichtbarer Text (Titel, Sonstige Vermerke).
 * Liefert { html, hits } – hits = Zahl der markierten Treffer.
 */
export function feldHtml(text, { term = "", startIndex = 0, markClass = "treffer", formate = true } = {}) {
  const stuecke = formate ? zerlege(text) : (text ? [{ text: String(text), ...KEIN }] : []);
  const plain = stuecke.map((s) => s.text).join("");
  // Merkmale je Zeichen: Anmerkung, Treffer
  const anm = new Uint8Array(plain.length);
  ANM_RE.lastIndex = 0;
  let m;
  while ((m = ANM_RE.exec(plain))) anm.fill(1, m.index, m.index + m[0].length);
  const hit = new Int32Array(plain.length).fill(-1);
  let hits = 0;
  if (term) {
    const re = new RegExp(escapeRegExp(term), "giu");
    while ((m = re.exec(plain))) {
      if (!m[0].length) {
        re.lastIndex += 1;
        continue;
      }
      if (m[0].includes("\n")) continue;
      hit.fill(startIndex + hits, m.index, m.index + m[0].length);
      hits += 1;
    }
  }
  let html = "";
  let pos = 0;
  for (const stueck of stuecke) {
    const ende = pos + stueck.text.length;
    let i = pos;
    while (i < ende) {
      let j = i + 1;
      while (j < ende && anm[j] === anm[i] && hit[j] === hit[i]) j += 1;
      let inner = escapeHtml(plain.slice(i, j));
      if (hit[i] >= 0) inner = `<mark class="${markClass}" data-n="${hit[i]}">${inner}</mark>`;
      if (stueck.color !== null) {
        const style = SICHERE_FARBE.test(stueck.color) ? ` style="color:${stueck.color}"` : "";
        inner = `<span class="farbe" data-farbe="${escapeHtml(stueck.color)}"${style}>${inner}</span>`;
      }
      for (const art of [...ARTEN].reverse()) if (stueck[art]) inner = `<${HTML_TAG[art]}>${inner}</${HTML_TAG[art]}>`;
      if (anm[i]) inner = `<span class="anm">${inner}</span>`;
      html += inner;
      i = j;
    }
    pos = ende;
  }
  return { html, hits };
}

// ------------------------------------------------------------------ Was im Browser steht

function farbwert(value) {
  const v = String(value ?? "").trim();
  if (!v) return undefined;
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(v);
  const hex = (rgb ? `#${[rgb[1], rgb[2], rgb[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("")}` : v).toLowerCase();
  return hex === OHNE_FARBE ? null : hex;
}

/** Formatierung, die ein Element seinem Inhalt gibt (nur was es selbst festlegt). */
function elementFormat(el) {
  const tag = String(el.tagName || "").toUpperCase();
  const a = {};
  if (tag === "B" || tag === "STRONG") a.f = true;
  if (tag === "I" || tag === "EM") a.k = true;
  if (tag === "U" || tag === "INS") a.u = true;
  if (tag === "S" || tag === "STRIKE" || tag === "DEL") a.d = true;
  const eigen = el.getAttribute?.("data-farbe");
  if (eigen !== null && eigen !== undefined) a.color = eigen === OHNE_FARBE ? null : eigen;
  else if (tag === "FONT" && el.getAttribute?.("color")) a.color = farbwert(el.getAttribute("color"));
  const st = el.style;
  if (st) {
    const weight = String(st.fontWeight || "");
    if (weight === "bold" || weight === "bolder" || Number(weight) >= 600) a.f = true;
    else if (weight === "normal" || weight === "lighter" || (Number(weight) > 0 && Number(weight) < 600)) a.f = false;
    if (st.fontStyle === "italic" || st.fontStyle === "oblique") a.k = true;
    else if (st.fontStyle === "normal") a.k = false;
    const deko = `${st.textDecorationLine || ""} ${st.textDecoration || ""}`;
    if (deko.includes("underline")) a.u = true;
    if (deko.includes("line-through")) a.d = true;
    if (st.color && eigen == null) {
      const c = farbwert(st.color);
      if (c !== undefined) a.color = c;
    }
  }
  return a;
}

/**
 * Liest ein bearbeitbares Feld aus dem Browser zurück: Text mit Formatcodes (formate=true)
 * oder reiner Text. <br> ist eine neue Zeile (außer dem Platzhalter am Ende, data-ende),
 * <div>/<p> beginnen eine neue Zeile.
 */
export function domLesen(root, { formate = true } = {}) {
  const stuecke = [];
  let letztes = "";
  const text = (value, a) => {
    if (!value) return;
    anhaengen(stuecke, value, a);
    letztes = value[value.length - 1];
  };
  const walk = (node, a) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        text(child.nodeValue, a);
      } else if (child.nodeType === 1) {
        const tag = String(child.tagName || "").toUpperCase();
        if (tag === "BR") {
          if (!child.hasAttribute?.("data-ende")) text("\n", a);
        } else if (tag === "DIV" || tag === "P") {
          if (letztes && letztes !== "\n") text("\n", a);
          walk(child, formate ? { ...a, ...elementFormat(child) } : a);
        } else {
          walk(child, formate ? { ...a, ...elementFormat(child) } : a);
        }
      }
    }
  };
  walk(root, { ...KEIN });
  return formate ? zusammensetzen(stuecke) : stuecke.map((s) => s.text).join("");
}
