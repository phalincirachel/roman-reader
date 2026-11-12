// Regeln für das Ändern eines Absatzes – dieselben wie in reader/schreiben.py (locate,
// apply_change). Positionen zählen hier in UTF-16-Einheiten, wie der Browser zählt;
// der Laptop rechnet sie beim Übernehmen um (schreiben.js_offset).
// Bearbeitet werden Text (content) und Sonstige Vermerke (misc) absatzweise, der Titel (title)
// als Ganzes. Eine Änderung ohne „feld“ betrifft den Text.
import { PY_WS, hasText, pyStrip, stripNewlines } from "./pytext.js";

export const FELDER = ["content", "title", "misc"];
const TITEL_UMBRUCH_RE = new RegExp(`[${PY_WS}]*\\n[${PY_WS}]*`, "gu");

export class Konflikt extends Error {
  constructor(message) {
    super(message);
    this.name = "Konflikt";
  }
}

export const feldVon = (change) => change?.feld || "content";

/** Ein Titel ist eine Zeile (wie schreiben.titel_zeile). */
export function titelZeile(text) {
  return pyStrip(String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(TITEL_UMBRUCH_RE, " "));
}

/** Wie locate; beim Titel muss `vorher` der ganze bisherige Titel sein. */
export function locateIn(feld, text, vorher, hint = -1) {
  if (feld === "title") {
    if (text !== vorher) throw new Konflikt("Der Titel wurde inzwischen anderswo geändert.");
    return 0;
  }
  return locate(text, vorher, hint);
}

/**
 * Position, an der `vorher` als ganze Zeilen im Text steht (hint: vermutete Position).
 * Ein leeres `vorher` heißt: Das Feld war leer – das passt nur, solange es noch leer ist.
 */
export function locate(text, vorher, hint = -1) {
  if (!vorher) {
    if (!hasText(text)) return 0;
    throw new Konflikt("Das Feld war leer, inzwischen steht anderswo etwas darin.");
  }
  const whole = (pos) => {
    const end = pos + vorher.length;
    return (pos === 0 || text[pos - 1] === "\n") && (end === text.length || text[end] === "\n");
  };
  if (hint >= 0 && text.startsWith(vorher, hint) && whole(hint)) return hint;
  const positions = [];
  for (let pos = text.indexOf(vorher); pos >= 0; pos = text.indexOf(vorher, pos + 1)) {
    if (whole(pos)) positions.push(pos);
  }
  if (!positions.length) throw new Konflikt("Dieser Absatz steht so nicht mehr im Zettel – er wurde inzwischen anderswo geändert.");
  if (positions.length > 1 && hint < 0) throw new Konflikt("Dieser Absatz kommt im Zettel mehrfach vor.");
  let best = positions[0];
  for (const pos of positions) if (Math.abs(pos - hint) < Math.abs(best - hint)) best = pos;
  return best;
}

/** Neuer Text eines Absatzes wie im Schreibwerkzeug: ohne \r, ohne Leerzeilen am Rand. */
export function normalizeNachher(nachher) {
  return stripNewlines(String(nachher ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n"));
}

/** Neuer Wortlaut des Feldes: wie beim Einspielen (Titel als eine Zeile, sonst ohne Leerzeilen am Rand). */
export function cleanNachher(feld, nachher) {
  return feld === "title" ? titelZeile(nachher) : normalizeNachher(nachher);
}

/** Neuer Anzeigetext; ein geleerter Absatz verschwindet samt Leerzeilen. Ein Titel darf nicht leer werden. */
export function applyChange(text, change) {
  const feld = feldVon(change);
  if (!FELDER.includes(feld)) throw new Konflikt(`Das Feld „${feld}“ lässt sich nicht bearbeiten.`);
  const pos = locateIn(feld, text, change.vorher, Number.isInteger(change.start) ? change.start : -1);
  if (feld === "title") {
    const titel = titelZeile(change.nachher);
    if (!titel) throw new Konflikt("Ein Titel darf nicht leer sein.");
    return titel;
  }
  const nachher = normalizeNachher(change.nachher);
  if (!change.vorher) return hasText(nachher) ? nachher : ""; // das leere Feld bekommt seinen ersten Text
  const end = pos + change.vorher.length;
  if (hasText(nachher)) return text.slice(0, pos) + nachher + text.slice(end);
  let tail = end;
  while (tail < text.length && text[tail] === "\n") tail += 1;
  if (tail > end) return text.slice(0, pos) + text.slice(tail);
  let head = pos;
  while (head > 0 && text[head - 1] === "\n") head -= 1;
  return text.slice(0, head) + text.slice(end);
}

/**
 * Wendet Änderungen der Reihe nach an. Liefert den Text und die Änderungen, die nicht
 * passten (id -> Grund). Andere Fehler als Konflikte werden weitergereicht.
 */
export function applyList(text, changes) {
  const konflikte = new Map();
  let applied = 0;
  for (const change of changes) {
    try {
      text = applyChange(text, change);
      applied += 1;
    } catch (err) {
      if (!(err instanceof Konflikt)) throw err;
      konflikte.set(change.id, err.message);
    }
  }
  return { text, konflikte, applied };
}

/**
 * Was sich zwischen zwei Fassungen eines Feldes geändert hat – als Ersetzung ganzer Zeilen, so wie
 * das Schreibwerkzeug Änderungen einspielt: { start, vorher, nachher } oder null (nichts geändert).
 *
 * roh:   der Text, wie er im Zettel steht (`vorher` und `start` stammen daraus);
 * basis: derselbe Stand, wie ihn der Browser zurückliest – Zeile für Zeile wie roh, nur die
 *        Reihenfolge von Formatcodes an derselben Stelle kann abweichen;
 * neu:   der bearbeitete Text (wie basis zurückgelesen).
 * Am Rand der Änderung stehen Zeilen mit Text (Leerzeilen am Rand gehen beim Einspielen verloren).
 * War das Feld leer, ist `vorher` leer und `nachher` der ganze neue Text.
 */
export function zeilenAenderung(roh, basis, neu) {
  const R = String(roh ?? "").split("\n");
  const B = String(neu ?? "").split("\n");
  let A = String(basis ?? roh ?? "").split("\n");
  if (A.length !== R.length) A = R; // passt nicht Zeile für Zeile: dann direkt gegen den Zettel
  const n = Math.min(A.length, B.length);
  let p = 0;
  while (p < n && A[p] === B[p]) p += 1;
  let s = 0;
  while (s < n - p && A[A.length - 1 - s] === B[B.length - 1 - s]) s += 1;
  let a0 = p;
  let a1 = A.length - s;
  let b0 = p;
  let b1 = B.length - s;
  if (a0 === a1 && b0 === b1) return null;
  // Nur eingefügt oder nur gelöscht: Leerzeilen am Rand lieber oben als unten (dann ist der Bereich kleiner)
  if (a0 === a1) while (a0 > 0 && b1 > b0 && !hasText(B[b1 - 1]) && B[b1 - 1] === A[a0 - 1]) { a0 -= 1; a1 -= 1; b0 -= 1; b1 -= 1; }
  if (b0 === b1) while (b0 > 0 && a1 > a0 && !hasText(A[a1 - 1]) && A[a1 - 1] === B[b0 - 1]) { a0 -= 1; a1 -= 1; b0 -= 1; b1 -= 1; }
  const bIrgendwo = B.some(hasText);
  for (;;) {
    const aText = A.slice(a0, a1).some(hasText);
    const bText = B.slice(b0, b1).some(hasText);
    const obenLeer = bText && !hasText(B[b0]);
    const untenLeer = bText && !hasText(B[b1 - 1]);
    // Ganz ohne Text im neuen Teil würde das Einspielen auch die Leerzeilen daneben entfernen:
    // dann eine Nachbarzeile mitnehmen (außer das ganze Feld ist leer geworden)
    const nachbar = !bText && bIrgendwo;
    if (aText && !obenLeer && !untenLeer && !nachbar) break;
    let weiter = false;
    if ((!aText || obenLeer || nachbar) && a0 > 0) {
      a0 -= 1;
      b0 -= 1;
      weiter = true;
    }
    if ((((!aText || nachbar) && !weiter) || untenLeer) && a1 < A.length) {
      a1 += 1;
      b1 += 1;
      weiter = true;
    }
    if (!weiter) break;
  }
  if (!A.slice(a0, a1).some(hasText)) {
    // Das ganze Feld war leer (oder nur Leerzeilen): der neue Text ersetzt es
    return hasText(neu) ? { start: 0, vorher: "", nachher: String(neu) } : null;
  }
  let start = 0;
  for (let i = 0; i < a0; i += 1) start += R[i].length + 1;
  return { start, vorher: R.slice(a0, a1).join("\n"), nachher: B.slice(b0, b1).join("\n") };
}

// ------------------------------------------------------------------ Warteschlange „unterwegs“

/** Felder, die eine Änderung auf GitHub trägt (alles andere bleibt auf dem Gerät). */
export const QUEUE_FIELDS = ["id", "zettel", "datei", "feld", "titel", "vorher", "nachher", "start", "erstellt", "geaendert", "geraet", "wer", "basis"];

export function queueEntry(change) {
  const entry = {};
  for (const key of QUEUE_FIELDS) if (change[key] !== undefined) entry[key] = change[key];
  return entry;
}

/** Neue Warteschlange: vorhandene ohne `remove`, dazu neue Einträge (je id nur einmal). */
export function mergeQueue(remote, add, remove = new Set()) {
  const result = [];
  const seen = new Set();
  for (const entry of remote) {
    if (remove.has(entry.id) || seen.has(entry.id)) continue;
    seen.add(entry.id);
    result.push(entry);
  }
  for (const entry of add) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    result.push(queueEntry(entry));
  }
  return result;
}

/** Dateiinhalt der Warteschlange (eine Änderung je Zeile, gut lesbar in Git). */
export function queueText(entries) {
  const lines = entries.map((entry) => JSON.stringify(entry));
  return `{"format": 1, "aenderungen": [${lines.length ? `\n${lines.join(",\n")}\n` : ""}]}\n`;
}

export function parseQueue(text) {
  const data = JSON.parse(text);
  const list = Array.isArray(data?.aenderungen) ? data.aenderungen : [];
  return list.filter((e) => e && typeof e.id === "string" && typeof e.vorher === "string" && typeof e.nachher === "string"
    && (e.zettel !== undefined || typeof e.datei === "string"));
}
