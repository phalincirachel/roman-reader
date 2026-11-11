// Regeln für das Ändern eines Absatzes – dieselben wie in reader/schreiben.py (locate,
// apply_change). Positionen zählen hier in UTF-16-Einheiten, wie der Browser zählt;
// der Laptop rechnet sie beim Übernehmen um (schreiben.js_offset).
import { hasText, stripNewlines } from "./pytext.js";

export class Konflikt extends Error {
  constructor(message) {
    super(message);
    this.name = "Konflikt";
  }
}

/** Position, an der `vorher` als ganzer Absatz im Text steht (hint: vermutete Position). */
export function locate(text, vorher, hint = -1) {
  if (!vorher) throw new Konflikt("Der Ausgangstext ist leer.");
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

/** Neuer Anzeigetext; ein geleerter Absatz verschwindet samt Leerzeilen. */
export function applyChange(text, change) {
  const pos = locate(text, change.vorher, Number.isInteger(change.start) ? change.start : -1);
  const end = pos + change.vorher.length;
  const nachher = normalizeNachher(change.nachher);
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

// ------------------------------------------------------------------ Warteschlange „unterwegs“

/** Felder, die eine Änderung auf GitHub trägt (alles andere bleibt auf dem Gerät). */
export const QUEUE_FIELDS = ["id", "zettel", "titel", "vorher", "nachher", "start", "erstellt", "geaendert", "geraet", "wer", "basis"];

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
    && e.zettel !== undefined);
}
