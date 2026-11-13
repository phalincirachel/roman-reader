// Rückgängig und Wiederholen – für Text, Titel, Sonstige Vermerke und Material, über Kapitel
// hinweg, auch nach dem Speichern und nach dem Neuladen der Seite.
//
// Ein Schritt ist eine zusammenhängende Änderung eines Feldes (Tippen bis zu einer kurzen Pause,
// ein Zeilenumbruch, Einfügen, Formatieren …). Gemerkt wird nur, was sich geändert hat: Stelle,
// alter und neuer Wortlaut, dazu ein Stück Text davor und danach. Daran findet „Rückgängig“ die
// Stelle wieder, auch wenn sich der Text davor inzwischen verschoben hat (etwa durch eine Änderung
// vom anderen Gerät). Passt die Stelle nicht mehr, wird nichts überschrieben.
// Reine Funktionen ohne Browser – auch mit Node testbar.

const KONTEXT = 24;

/** Die eine zusammenhängende Stelle, an der sich zwei Fassungen unterscheiden. */
export function textDiff(a, b) {
  const x = String(a ?? "");
  const y = String(b ?? "");
  const n = Math.min(x.length, y.length);
  let p = 0;
  while (p < n && x[p] === y[p]) p += 1;
  let s = 0;
  while (s < n - p && x[x.length - 1 - s] === y[y.length - 1 - s]) s += 1;
  // nie mitten in einem Zeichen aus zwei Hälften (Emoji) trennen
  while (p > 0 && /[\uDC00-\uDFFF]/.test(x[p] ?? y[p] ?? "")) p -= 1;
  while (s > 0 && /[\uDC00-\uDFFF]/.test(x[x.length - s])) s -= 1;
  return { at: p, alt: x.slice(p, x.length - s), neu: y.slice(p, y.length - s) };
}

/** Ein Schritt von `vorher` nach `nachher` (oder null, wenn sich nichts geändert hat). */
export function schrittVon(vorher, nachher, info = {}) {
  const a = String(vorher ?? "");
  const d = textDiff(a, nachher);
  if (!d.alt && !d.neu) return null;
  return {
    ...info, at: d.at, alt: d.alt, neu: d.neu,
    vor: a.slice(Math.max(0, d.at - KONTEXT), d.at),
    nach: a.slice(d.at + d.alt.length, d.at + d.alt.length + KONTEXT),
    zeit: Date.now(),
  };
}

function alleStellen(text, teil) {
  const found = [];
  if (!teil) return found;
  for (let i = text.indexOf(teil); i >= 0; i = text.indexOf(teil, i + 1)) found.push(i);
  return found;
}

function naechste(stellen, ziel) {
  let best = stellen[0];
  for (const s of stellen) if (Math.abs(s - ziel) < Math.abs(best - ziel)) best = s;
  return best;
}

/**
 * Wendet einen Schritt auf den Text an: zurueck=true nimmt ihn zurück, sonst wird er wiederholt.
 * Liefert { text, at, ende } (ende = Ende des eingesetzten Wortlauts) oder null, wenn die Stelle
 * nicht mehr eindeutig zu finden ist.
 */
export function anwenden(text, schritt, zurueck = true) {
  const t = String(text ?? "");
  const weg = zurueck ? schritt.neu : schritt.alt;
  const hin = zurueck ? schritt.alt : schritt.neu;
  const vor = schritt.vor || "";
  const nach = schritt.nach || "";
  const passt = (at) => at >= vor.length && t.slice(at - vor.length, at) === vor && t.startsWith(weg, at)
    && t.slice(at + weg.length, at + weg.length + nach.length) === nach;
  let at = null;
  if (passt(schritt.at)) at = schritt.at;
  else {
    // verschoben: dieselbe Stelle mit demselben Text davor und danach
    for (const [muster, versatz] of [[vor + weg + nach, vor.length], [vor + weg, vor.length], [weg + nach, 0]]) {
      if (!muster || (muster === weg && !weg)) continue;
      const stellen = alleStellen(t, muster);
      if (stellen.length === 1 || (stellen.length > 1 && muster === vor + weg + nach)) {
        at = naechste(stellen, schritt.at - versatz) + versatz;
        break;
      }
    }
  }
  if (at === null) return null;
  return { text: t.slice(0, at) + hin + t.slice(at + weg.length), at, ende: at + hin.length };
}

/** Die beiden Stapel (Rückgängig, Wiederholen) – begrenzt, damit der Browser-Speicher reicht. */
export class Verlauf {
  constructor({ laden = () => null, speichern = () => true, max = 300, maxZeichen = 300000 } = {}) {
    const data = laden() || {};
    this.zurueck = Array.isArray(data.zurueck) ? data.zurueck : [];
    this.vor = Array.isArray(data.vor) ? data.vor : [];
    this.speichern = speichern;
    this.max = max;
    this.maxZeichen = maxZeichen;
  }

  static groesse(schritt) {
    return (schritt.alt?.length || 0) + (schritt.neu?.length || 0) + 120;
  }

  kuerzen() {
    while (this.zurueck.length > this.max) this.zurueck.shift();
    while (this.vor.length > this.max) this.vor.shift();
    let summe = [...this.zurueck, ...this.vor].reduce((n, s) => n + Verlauf.groesse(s), 0);
    while (summe > this.maxZeichen && this.zurueck.length > 1) summe -= Verlauf.groesse(this.zurueck.shift());
  }

  merken() {
    this.kuerzen();
    if (!this.speichern({ zurueck: this.zurueck, vor: this.vor })) {
      // zu voll: die ältere Hälfte vergessen (die Rettungskopien sind wichtiger)
      this.zurueck.splice(0, Math.ceil(this.zurueck.length / 2));
      this.vor = [];
      this.speichern({ zurueck: this.zurueck, vor: this.vor });
    }
  }

  /** Neuer Schritt: was wiederholt werden konnte, gilt nicht mehr. */
  neu(schritt) {
    this.zurueck.push(schritt);
    this.vor = [];
    this.merken();
  }
}
