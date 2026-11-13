// Datenquelle unterwegs (Chromebook, Handy): liest den Roman aus dem privaten GitHub-Repository –
// so, wie er zuletzt auf dem Laptop mit „Sichern“ hochgeladen wurde – und legt Bearbeitungen in
// den Zweig „unterwegs“. Auf dem Laptop holt der Reader-Dienst sie dort ab und spielt sie über das
// Schreibwerkzeug in die zkn3 ein (reader/unterwegs.py). Welche schon eingespielt sind, steht in
// aenderungsbuch/unterwegs.json; diese Datei kommt mit „Sichern“ zusammen mit der zkn3 auf GitHub.
// So passen zkn3 und Rückmeldung immer zueinander.
//
// Jede Änderung ist eine eigene Datei im Zweig: eintraege/<Kennung>.json (bis 13.11.2026 lagen alle
// zusammen in aenderungen.json – die wird gelesen, solange sie noch da ist). Hochgeladen wird so nur
// die neue Änderung, nicht alle bisherigen. Eine hochgeladene Änderung ändert sich nie mehr (der
// Laptop übernimmt sie vielleicht schon): Wer danach im selben Feld weiterschreibt, bekommt eine
// neue Änderung („neu ansetzen“, wie auf dem Laptop).
//
// Wann hochgeladen wird: fertige Eingaben (Feld verlassen, Seite in den Hintergrund) sofort; was
// gerade geschrieben wird, ein paar Sekunden nach der letzten Eingabe, höchstens alle 20 Sekunden
// und spätestens nach 45 Sekunden. GitHub erlaubt 80 schreibende Anfragen je Minute und 500 je
// Stunde; der Reader bleibt deutlich darunter. Ohne Netz bleibt alles auf dem Gerät (localStorage)
// und geht hoch, sobald wieder Verbindung besteht. Auch ohne Netz lässt sich der Roman öffnen:
// mit dem zuletzt geladenen Stand (zwischengespeichert im Browser).
import { leseZkn3, materialListe, materialTitel } from "./zkn3.js";
import {
  FELDER, Konflikt, applyChange, applyList, cleanNachher, eintragText, feldVon, locateIn, parseEintrag, parseQueue,
  queueEntry, queueText,
} from "./aenderung.js";

const ZWEIG = "unterwegs";
const ALTE_DATEI = "aenderungen.json";
const ORDNER = "eintraege";
const RUECKMELDUNG = "aenderungsbuch/unterwegs.json";
const ERLEDIGT = new Set(["eingespielt", "verworfen"]); // in dieser zkn3 schon berücksichtigt
const NICHT_ANWENDEN = new Set(["eingespielt", "verworfen", "konflikt"]);
const CACHE = "roman-reader-1";
const UA = navigator.userAgent;
const GERAET = /\bCrOS\b/.test(UA) ? "Chromebook" : /iPad|Tablet/.test(UA) ? "Tablet" : /Android|iPhone|Mobile/.test(UA) ? "Handy" : "Browser";
export const SCHLUESSEL_ANLEGEN = "https://github.com/settings/personal-access-tokens/new"
  + "?name=Roman-Reader&description=Lesen+und+Bearbeiten+des+Romans+im+Reader&expires_in=366&contents=write";

// Wann hochgeladen wird (Millisekunden)
const RUHE = 4000; // so lange nach der letzten Eingabe geht eine laufende Eingabe hoch …
const LAENGSTENS = 45000; // … spätestens aber so lange nach ihrem Beginn
const ABSTAND = 20000; // laufende Eingaben höchstens so oft
const GRENZE_MINUTE = 50; // GitHub: höchstens 80 schreibende Anfragen je Minute …
const GRENZE_STUNDE = 400; // … und 500 je Stunde
const AUFRAEUMEN_ABSTAND = 20 * 60000; // Erledigtes aus dem Zweig räumen, höchstens so oft
const VERSIEGELT_TAGE = 7;

class GithubFehler extends Error {
  constructor(status, message, { zugang = false, warte = 0 } = {}) {
    super(message);
    this.status = status;
    this.zugang = zugang;
    this.warte = warte;
  }
}

const pad = (n) => String(n).padStart(2, "0");

function ortsZeit(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function lokaleZeit(iso) {
  const date = iso ? new Date(iso) : null;
  return date && !Number.isNaN(date.getTime()) ? ortsZeit(date) : null;
}

/** Die jüngste von mehreren Zeitangaben (als Ortszeit), oder null. */
function neueste(...isos) {
  const times = isos.map((iso) => (iso ? new Date(iso).getTime() : NaN)).filter((t) => !Number.isNaN(t));
  return times.length ? ortsZeit(new Date(Math.max(...times))) : null;
}

function base64ToBytes(text) {
  const binary = atob(String(text || "").replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

const textBase64 = (text) => bytesToBase64(new TextEncoder().encode(text));
const hex = (buffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
const pfadUrl = (path) => path.split("/").map(encodeURIComponent).join("/");
const eintragPfad = (id) => `${ORDNER}/${id}.json`;

/** Git-Prüfsumme einer Datei – so lässt sich prüfen, dass sie vollständig angekommen ist. */
async function gitBlobSha(bytes) {
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const all = new Uint8Array(header.length + bytes.length);
  all.set(header);
  all.set(bytes, header.length);
  return hex(await crypto.subtle.digest("SHA-1", all));
}

/** Aufgaben mit höchstens n gleichzeitig ausführen. */
async function parallel(tasks, n) {
  const results = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next;
      next += 1;
      results[i] = await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, worker));
  return results;
}

const LIESMICH = { path: "LIESMICH.txt", text: "Änderungen aus dem Reader unterwegs (eine Datei je Änderung in eintraege/).\n"
  + "Der Reader auf dem Laptop holt sie ab und spielt sie in die zkn3 ein. Bitte nicht von Hand ändern.\n" };

const leereSchlange = (fehlt = false) => ({ kopf: null, baum: null, datum: null, dateien: new Map(), alt: new Set(), aenderungen: [], fehlt });

export function githubQuelle({ apiBase, test = false }) {
  const prefix = `roman.github.${test ? "test." : ""}`;
  const store = {
    get(key, fallback) {
      try {
        const value = localStorage.getItem(prefix + key);
        return value === null ? fallback : JSON.parse(value);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(prefix + key, JSON.stringify(value));
        return true;
      } catch {
        return false;
      }
    },
    remove(key) {
      try {
        localStorage.removeItem(prefix + key);
      } catch {
        /* nichts zu tun */
      }
    },
  };

  const s = {
    zugang: store.get("zugang", null), // { token, repo, zweig }
    kopf: null, // letzter Commit des Hauptzweigs: { sha, tree, datum, nachricht }
    bekannteKoepfe: new Set(),
    modell: null,
    zkn3Pfad: null,
    zkn3Sha: null,
    zkn3Stand: null, // wann die zkn3 zuletzt auf GitHub kam: { datum, nachricht }
    rueckmeldung: {},
    rueckmeldungSha: null,
    material: [],
    materialRoh: new Map(), // Pfad -> Text der Datei, wie sie auf GitHub liegt
    materialSha: new Map(), // Pfad -> Git-Prüfsumme dieses Textes
    schlange: leereSchlange(), // der Zweig „unterwegs“
    eigene: new Set(), // Kennungen, die dieses Fenster hochgeladen hat
    lokal: store.get("lokal", []), // Bearbeitungen, die noch nicht auf GitHub sind
    versiegelt: new Map(store.get("versiegelt", [])), // Eingaben (Sitzungen), deren Änderung feststeht
    zuletztOben: store.get("zuletztOben", null), // wann dieses Gerät zuletzt etwas hochgeladen hat
    schreibzeiten: store.get("schreibzeiten", []), // Zeitpunkte schreibender Anfragen (GitHub-Grenzen)
    konflikte: new Map(),
    fremd: 0,
    fehler: null,
    offline: false,
    ohneNetz: false, // ohne Verbindung geöffnet (mit dem zuletzt geladenen Stand)
    zugangFehler: null,
    geladen: null,
    laeuft: false,
    timer: null,
    letzterLauf: 0,
    letzteEingabe: 0,
    versuche: 0,
    naechsterVersuch: 0,
    gesperrtBis: 0,
    letztesAufraeumen: store.get("aufgeraeumt", 0),
    beobachter: null,
  };
  let letzteNr = store.get("nr", 0);

  const repo = () => s.zugang.repo;
  const speichereLokal = () => {
    if (!store.set("lokal", s.lokal)) s.fehler = "Der Browser lässt nichts mehr speichern – bitte bald hochladen.";
  };

  /** Kennung einer neuen Änderung: Datum und Uhrzeit auf die Millisekunde – so sortiert der Laptop richtig. */
  function neueId() {
    const t = Math.max(Date.now(), letzteNr + 1);
    letzteNr = t;
    store.set("nr", t);
    const d = new Date(t);
    const random = [...crypto.getRandomValues(new Uint8Array(2))].map((b) => b.toString(16).padStart(2, "0")).join("");
    return `u-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, "0")}${random}`;
  }

  function versiegeln(sitzung) {
    if (!sitzung) return;
    s.versiegelt.set(sitzung, Date.now());
    const grenze = Date.now() - VERSIEGELT_TAGE * 86400000;
    for (const [key, t] of s.versiegelt) if (t < grenze) s.versiegelt.delete(key);
    store.set("versiegelt", [...s.versiegelt].slice(-500));
  }

  function melde() {
    try {
      s.beobachter?.(zustand());
    } catch {
      /* die Anzeige darf das Hochladen nie stören */
    }
  }

  // ---------------------------------------------------------------- GitHub-Anfragen

  function notiereSchreiben() {
    const now = Date.now();
    s.schreibzeiten = s.schreibzeiten.filter((t) => now - t < 3600000);
    s.schreibzeiten.push(now);
    store.set("schreibzeiten", s.schreibzeiten);
  }

  /** Wie lange bis zur nächsten schreibenden Anfrage gewartet werden muss (GitHubs Grenzen). */
  function budgetWarte() {
    const now = Date.now();
    s.schreibzeiten = s.schreibzeiten.filter((t) => now - t < 3600000 && t <= now);
    if (now < s.gesperrtBis) return s.gesperrtBis - now;
    const minute = s.schreibzeiten.filter((t) => now - t < 60000);
    if (minute.length >= GRENZE_MINUTE) return 60000 - (now - minute[0]) + 100;
    if (s.schreibzeiten.length >= GRENZE_STUNDE) return 3600000 - (now - s.schreibzeiten[0]) + 100;
    return 0;
  }

  async function gh(path, { method = "GET", body = null, accept = "application/vnd.github+json", bytes = false } = {}) {
    const headers = { Accept: accept };
    if (s.zugang?.token) headers.Authorization = `Bearer ${s.zugang.token}`;
    if (body) headers["Content-Type"] = "application/json";
    if (method !== "GET") notiereSchreiben();
    let response;
    try {
      response = await fetch(apiBase + path, { method, headers, body: body ? JSON.stringify(body) : undefined,
        cache: "no-cache", referrerPolicy: "no-referrer" });
    } catch {
      throw new GithubFehler(0, "Keine Verbindung zu GitHub.");
    }
    if (!response.ok) {
      let message = "";
      try {
        message = (await response.json()).message || "";
      } catch {
        /* keine JSON-Antwort */
      }
      if (response.status === 401) {
        throw new GithubFehler(401, "GitHub nimmt den Zugangsschlüssel nicht mehr an – vielleicht ist er abgelaufen.", { zugang: true });
      }
      const retry = Number(response.headers.get("retry-after")) || 0;
      if (response.status === 429 || (response.status === 403 && /secondary rate|abuse/i.test(message))) {
        throw new GithubFehler(429, "GitHub bremst gerade (zu viele Anfragen kurz hintereinander) – es geht gleich von selbst weiter.",
          { warte: retry || 60 });
      }
      if (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") {
        const reset = Number(response.headers.get("x-ratelimit-reset")) || 0;
        throw new GithubFehler(429, "GitHub bremst gerade (zu viele Anfragen in dieser Stunde) – es geht später von selbst weiter.",
          { warte: reset ? Math.max(60, reset - Math.floor(Date.now() / 1000)) : 900 });
      }
      if (response.status === 403) {
        throw new GithubFehler(403, `GitHub verweigert den Zugriff${message ? ` („${message}“)` : ""}. Darf der Schlüssel „Contents: Read and write“?`);
      }
      throw new GithubFehler(response.status, message || `GitHub meldet Fehler ${response.status}.`);
    }
    if (bytes) return new Uint8Array(await response.arrayBuffer());
    return response.status === 204 ? null : response.json();
  }

  // Nacheinander: Hochladen und Nachsehen dürfen sich nicht überholen.
  let kette = Promise.resolve();
  function nacheinander(fn) {
    const run = kette.then(fn, fn);
    kette = run.catch(() => {});
    return run;
  }

  // ---------------------------------------------------------------- Zwischenspeicher im Browser

  const cacheKey = (sha) => `${apiBase}/__zwischenspeicher/${encodeURIComponent(repo())}/${sha}`;

  async function cacheLesen(sha) {
    try {
      const hit = await (await caches.open(CACHE)).match(cacheKey(sha));
      return hit ? new Uint8Array(await hit.arrayBuffer()) : null;
    } catch {
      return null;
    }
  }

  async function cacheAblegen(sha, bytes) {
    try {
      await (await caches.open(CACHE)).put(cacheKey(sha), new Response(bytes));
    } catch {
      /* ohne Zwischenspeicher geht es auch */
    }
  }

  /** Eine Datei nach ihrer Git-Prüfsumme: aus dem Zwischenspeicher oder von GitHub (dann geprüft). */
  async function blob(sha, { nurHier = false } = {}) {
    const hier = await cacheLesen(sha);
    if (hier) return hier;
    if (nurHier) throw new GithubFehler(0, "Keine Verbindung zu GitHub – und dieser Stand liegt noch nicht auf dem Gerät.");
    const bytes = await gh(`/repos/${repo()}/git/blobs/${sha}`, { accept: "application/vnd.github.raw+json", bytes: true });
    if ((await gitBlobSha(bytes)) !== sha) throw new GithubFehler(0, "Eine Datei kam unvollständig von GitHub an.");
    await cacheAblegen(sha, bytes);
    return bytes;
  }

  const blobText = async (sha, optionen) => new TextDecoder("utf-8", { ignoreBOM: true }).decode(await blob(sha, optionen));

  async function rohText(item) {
    if (!s.materialRoh.has(item.path) || s.materialSha.get(item.path) !== item.sha) {
      s.materialRoh.set(item.path, await blobText(item.sha, { nurHier: s.ohneNetz })); // wie Python: das BOM gehört zum Text
      s.materialSha.set(item.path, item.sha);
    }
    return s.materialRoh.get(item.path);
  }

  async function aufraeumenCache() {
    const behalten = new Set([s.zkn3Sha, s.rueckmeldungSha, ...s.material.map((m) => m.sha), ...s.schlange.dateien.values()]);
    try {
      const cache = await caches.open(CACHE);
      for (const request of await cache.keys()) {
        if (!behalten.has(request.url.split("/").pop())) await cache.delete(request);
      }
    } catch {
      /* nicht wichtig */
    }
  }

  /** Was zum Öffnen ohne Netz gebraucht wird (die Dateien selbst liegen im Zwischenspeicher). */
  function merkeStand() {
    store.set("stand", {
      repo: repo(), kopf: s.kopf, zkn3Pfad: s.zkn3Pfad, zkn3Sha: s.zkn3Sha, zkn3Stand: s.zkn3Stand, rueckSha: s.rueckmeldungSha,
      material: s.material.map(({ path, group, sha }) => ({ path, group, sha })),
      schlange: { kopf: s.schlange.kopf, baum: s.schlange.baum, datum: s.schlange.datum, fehlt: s.schlange.fehlt,
        dateien: [...s.schlange.dateien], alt: [...s.schlange.alt] },
    });
  }

  // ---------------------------------------------------------------- Lesen

  async function ladeKopf() {
    const branch = await gh(`/repos/${repo()}/branches/${encodeURIComponent(s.zugang.zweig || "main")}`);
    const commit = branch.commit.commit;
    return { sha: branch.commit.sha, tree: commit.tree.sha, datum: commit.committer?.date || commit.author?.date, nachricht: commit.message };
  }

  function leseRueckmeldung(bytes) {
    try {
      const data = JSON.parse(new TextDecoder().decode(bytes));
      return data && typeof data.aenderungen === "object" && data.aenderungen ? data.aenderungen : {};
    } catch {
      return {};
    }
  }

  async function ladeStand(kopf) {
    const tree = await gh(`/repos/${repo()}/git/trees/${kopf.tree}?recursive=1`);
    const files = new Map(tree.tree.filter((t) => t.type === "blob").map((t) => [t.path, t.sha]));
    const zkn3 = [...files.keys()].filter((p) => !p.includes("/") && /\.zkn3$/i.test(p));
    if (zkn3.length !== 1) {
      throw new GithubFehler(-1, zkn3.length ? `Im Repository liegen mehrere .zkn3-Dateien (${zkn3.join(", ")}).` : "Im Repository liegt keine .zkn3-Datei.");
    }
    const zkn3Sha = files.get(zkn3[0]);
    if (zkn3Sha !== s.zkn3Sha || !s.modell) {
      s.modell = await leseZkn3(await blob(zkn3Sha), zkn3[0]);
      s.zkn3Sha = zkn3Sha;
      s.zkn3Pfad = zkn3[0];
      // Stand des Romans = letzter Commit, der die zkn3 geändert hat (nicht etwa eine Änderung am Programm)
      try {
        const [last] = await gh(`/repos/${repo()}/commits?path=${encodeURIComponent(zkn3[0])}&sha=${kopf.sha}&per_page=1`);
        s.zkn3Stand = { datum: last?.commit?.committer?.date || kopf.datum, nachricht: last?.commit?.message || kopf.nachricht };
      } catch {
        s.zkn3Stand = { datum: kopf.datum, nachricht: kopf.nachricht };
      }
    }
    const rueckSha = files.get(RUECKMELDUNG) || null;
    if (rueckSha !== s.rueckmeldungSha) {
      s.rueckmeldung = rueckSha ? leseRueckmeldung(await blob(rueckSha)) : {};
      s.rueckmeldungSha = rueckSha;
    }
    s.kopf = kopf;
    s.bekannteKoepfe.add(kopf.sha);
    s.material = materialListe([...files.keys()]).map((item) => ({ ...item, sha: files.get(item.path) }));
  }

  /** Die Änderungen im Zweig „unterwegs“: erst die alte Sammeldatei, dann die Einzeldateien nach Namen. */
  async function leseEintraege(dateien, { nurHier = false } = {}) {
    const pfade = [...dateien.keys()].filter((p) => p.startsWith(`${ORDNER}/`)).sort();
    const texte = await parallel(pfade.map((p) => () => blobText(dateien.get(p), { nurHier })), 6);
    const liste = [];
    const alt = new Set();
    if (dateien.has(ALTE_DATEI)) {
      try {
        for (const e of parseQueue(await blobText(dateien.get(ALTE_DATEI), { nurHier }))) {
          liste.push(e);
          alt.add(e.id);
        }
      } catch (err) {
        if (err instanceof GithubFehler) throw err;
        s.fehler = `${ALTE_DATEI} im Zweig „${ZWEIG}“ ist beschädigt.`;
      }
    }
    pfade.forEach((p, i) => {
      const e = parseEintrag(texte[i]);
      if (e) liste.push(e);
    });
    const seen = new Set();
    return { aenderungen: liste.filter((e) => (seen.has(e.id) ? false : seen.add(e.id))), alt };
  }

  async function leseSchlange(kopf, baum, datum) {
    const tree = await gh(`/repos/${repo()}/git/trees/${baum}?recursive=1`);
    const dateien = new Map();
    for (const t of tree.tree) {
      if (t.type === "blob" && (t.path === ALTE_DATEI || t.path === LIESMICH.path
        || (t.path.startsWith(`${ORDNER}/`) && t.path.endsWith(".json")))) dateien.set(t.path, t.sha);
    }
    const { aenderungen, alt } = await leseEintraege(dateien);
    return { kopf, baum, datum, dateien, alt, aenderungen, fehlt: false };
  }

  async function holeSchlange() {
    let branch;
    try {
      branch = await gh(`/repos/${repo()}/branches/${ZWEIG}`);
    } catch (err) {
      if (err.status === 404) return leereSchlange(true);
      throw err;
    }
    const kopf = branch.commit.sha;
    if (kopf === s.schlange.kopf && !s.schlange.fehlt) return s.schlange;
    return leseSchlange(kopf, branch.commit.commit.tree.sha, branch.commit.commit.committer?.date || null);
  }

  /** Neuer Stand des Zweigs. Liefert true, wenn Änderungen dazukamen, die dieses Fenster nicht kannte. */
  function setzeSchlange(neu) {
    const vorher = new Set(s.schlange.aenderungen.map((e) => e.id));
    const unbekannt = neu.aenderungen.some((e) => !vorher.has(e.id) && !s.eigene.has(e.id));
    s.schlange = neu;
    const oben = new Set(neu.aenderungen.map((e) => e.id));
    const anzahl = s.lokal.length;
    s.lokal = s.lokal.filter((e) => !oben.has(e.id)); // ist schon angekommen (etwa beim Schließen der Seite)
    if (s.lokal.length !== anzahl) speichereLokal();
    return unbekannt;
  }

  /** Ohne Verbindung: mit dem Stand öffnen, der zuletzt geladen wurde. */
  async function ladeOhneNetz(fehler) {
    const alt = store.get("stand", null);
    if (!alt?.zkn3Sha || alt.repo !== repo()) throw fehler;
    try {
      if (!s.modell) {
        s.modell = await leseZkn3(await blob(alt.zkn3Sha, { nurHier: true }), alt.zkn3Pfad);
        s.zkn3Sha = alt.zkn3Sha;
        s.zkn3Pfad = alt.zkn3Pfad;
        s.zkn3Stand = alt.zkn3Stand;
        s.kopf = alt.kopf;
        if (alt.kopf?.sha) s.bekannteKoepfe.add(alt.kopf.sha);
        s.rueckmeldungSha = alt.rueckSha;
        s.rueckmeldung = alt.rueckSha ? leseRueckmeldung(await blob(alt.rueckSha, { nurHier: true })) : {};
        s.material = alt.material || [];
      }
      const q = alt.schlange || {};
      const dateien = new Map(q.dateien || []);
      const { aenderungen } = await leseEintraege(dateien, { nurHier: true });
      setzeSchlange({ kopf: q.kopf || null, baum: q.baum || null, datum: q.datum || null, dateien, alt: new Set(q.alt || []),
        aenderungen, fehlt: Boolean(q.fehlt) });
    } catch (err) {
      throw err instanceof GithubFehler ? err : fehler;
    }
  }

  function laden() {
    if (!s.geladen) {
      s.geladen = nacheinander(async () => {
        try {
          await ladeStand(await ladeKopf());
          setzeSchlange(await holeSchlange());
          s.offline = false;
          s.ohneNetz = false;
          merkeStand();
          aufraeumenCache();
        } catch (err) {
          if (err.status !== 0) throw err;
          await ladeOhneNetz(err); // nur ohne Verbindung: der zuletzt geladene Stand
          s.offline = true;
          s.ohneNetz = true;
        }
      }).catch((err) => {
        s.geladen = null;
        throw err;
      });
      s.geladen.then(() => {
        if (s.lokal.length) planeHochladen();
        melde();
      }, () => {});
    }
    return s.geladen;
  }

  /** Hat sich auf GitHub etwas getan? (neuer Stand vom Laptop, Änderungen von einem anderen Gerät) */
  async function nachsehen() {
    if (s.zugangFehler) throw s.zugangFehler;
    const kopf = await ladeKopf();
    if (kopf.sha !== s.kopf?.sha && !s.bekannteKoepfe.has(kopf.sha)) await ladeStand(kopf);
    if (setzeSchlange(await holeSchlange())) s.fremd += 1;
    const warOhne = s.offline;
    s.offline = false;
    s.ohneNetz = false;
    merkeStand();
    if (warOhne) aufraeumenCache();
    if (s.lokal.length) planeHochladen();
    if (aufraeumenFaellig()) nacheinander(aufraeumenLauf);
  }

  // ---------------------------------------------------------------- offene Änderungen

  function offene() {
    const oben = new Set(s.schlange.aenderungen.map((e) => e.id));
    return [
      ...s.schlange.aenderungen.filter((e) => !NICHT_ANWENDEN.has(s.rueckmeldung[e.id]?.status)),
      ...s.lokal.filter((e) => !oben.has(e.id)),
    ];
  }

  /** Felder mit offenen Änderungen: Zettel -> { Feld: Text } (wie Werkstatt.overlay auf dem Laptop). */
  function overlay() {
    const groups = new Map();
    for (const change of offene()) {
      if (change.datei !== undefined) continue; // Material: siehe materialStand
      const key = `${change.zettel}\u0000${feldVon(change)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(change);
    }
    const result = {};
    s.konflikte = new Map();
    for (const [key, list] of groups) {
      const [zettel, feld] = key.split("\u0000");
      const z = s.modell.byId.get(zettel);
      if (!z || !FELDER.includes(feld)) {
        for (const change of list) s.konflikte.set(change.id, z ? `Das Feld „${feld}“ lässt sich nicht bearbeiten.` : `Zettel ${zettel} gibt es nicht.`);
        continue;
      }
      const { text, konflikte, applied } = applyList(z[feld], list);
      for (const [id, grund] of konflikte) s.konflikte.set(id, grund);
      if (applied) (result[zettel] ??= {})[feld] = text;
    }
    return result;
  }

  /** Text einer Material-Datei mit den offenen Änderungen daran (und welche nicht passen). */
  function materialStand(path, roh) {
    const list = offene().filter((e) => e.datei === path);
    return list.length ? applyList(roh, list) : { text: roh, konflikte: new Map(), applied: 0 };
  }

  function konfliktListe() {
    overlay();
    for (const [path, roh] of s.materialRoh) {
      for (const [id, grund] of materialStand(path, roh).konflikte) s.konflikte.set(id, grund);
    }
    return [...s.schlange.aenderungen, ...s.lokal]
      .filter((e) => s.konflikte.has(e.id) || s.rueckmeldung[e.id]?.status === "konflikt")
      .map((e) => ({ ...e, grund: s.konflikte.get(e.id) || s.rueckmeldung[e.id]?.grund || "" }));
  }

  /** Änderungen auf GitHub, die der Laptop noch nicht in die zkn3 übernommen hat. */
  const wartetAufLaptop = () => s.schlange.aenderungen.filter((e) => !NICHT_ANWENDEN.has(s.rueckmeldung[e.id]?.status));

  function zaehle() {
    return {
      offen: 0, konflikte: konfliktListe().length, verloren: 0, programm: false,
      fehler: s.fehler, hochladen: s.fehler || s.offline ? s.lokal.length : 0,
    };
  }

  const stand = () => `${(s.zkn3Sha || "").slice(0, 12)}-${(s.rueckmeldungSha || "0").slice(0, 8)}-${s.fremd}`;
  const zustand = () => ({ stand: stand(), bearbeitung: zaehle(), git: gitZustand() });

  function gitZustand() {
    return {
      ok: !s.zugangFehler, error: s.zugangFehler?.message || s.fehler, github: true,
      changeCount: s.lokal.length, ahead: 0,
      changes: s.lokal.map((e) => ({ path: e.titel || e.datei || `Zettel ${e.zettel}` })),
      laeuft: s.laeuft, offline: s.offline, ohneNetz: s.ohneNetz, fehler: s.fehler,
      zuletztOben: lokaleZeit(s.zuletztOben),
      standOben: neueste(s.zkn3Stand?.datum, s.schlange.datum, s.zuletztOben),
      wartetAufLaptop: wartetAufLaptop().length,
      lastCommit: s.zkn3Stand ? { time: lokaleZeit(s.zkn3Stand.datum), subject: s.zkn3Stand.nachricht } : null,
    };
  }

  /** Nimmt eine Bearbeitung an (wie Werkstatt.record auf dem Laptop), noch ohne Hochladen. */
  function erfasse({ zettel, feld = "content", start, vorher, nachher, sitzung, fertig }) {
    const id = String(zettel);
    const z = s.modell?.byId.get(id);
    if (!z) return { status: "fehler", meldung: `Zettel ${id} gibt es nicht.` };
    if (!FELDER.includes(feld)) return { status: "fehler", meldung: `Das Feld „${feld}“ lässt sich nicht bearbeiten.` };
    const own = s.lokal.find((e) => e.sitzung === sitzung && !e.versiegelt);
    const { text } = applyList(z[feld], offene().filter((e) => e !== own && String(e.zettel) === id && feldVon(e) === feld));
    // Was in dieser Eingabe bisher geschrieben wurde, ist schon unterwegs nach GitHub (und ändert sich
    // nicht mehr): der Reader rechnet die Änderung vom neuen Stand aus neu.
    if (!own && s.versiegelt.has(sitzung)) return { status: "neu-ansetzen", text };
    let pos;
    try {
      pos = locateIn(feld, text, vorher, Number.isInteger(start) ? start : -1);
    } catch (err) {
      if (!(err instanceof Konflikt)) throw err;
      return { status: "konflikt", meldung: err.message, text };
    }
    const clean = cleanNachher(feld, nachher);
    if (feld === "title" && !clean) return { status: "fehler", meldung: "Ein Titel darf nicht leer sein.", text };
    s.letzteEingabe = Date.now();
    if (clean === vorher) {
      if (own) s.lokal.splice(s.lokal.indexOf(own), 1);
      if (fertig) versiegeln(sitzung);
      speichereLokal();
      return { status: "unveraendert", text };
    }
    const entry = own || { id: neueId(), sitzung, zettel: id, ...(feld === "content" ? {} : { feld }), erstellt: ortsZeit(new Date()),
      geraet: GERAET, wer: "du", basis: s.modell.version, seit: Date.now() };
    Object.assign(entry, { titel: z.title, vorher, nachher: clean, start: pos, geaendert: ortsZeit(new Date()), fertig: Boolean(fertig) });
    if (fertig) {
      entry.versiegelt = true;
      versiegeln(sitzung);
    }
    if (!own) s.lokal.push(entry);
    speichereLokal();
    return { status: "offen", id: entry.id, text: applyChange(text, entry) };
  }

  /** Nimmt eine Bearbeitung an einer Material-Datei an (ein ganzer Block, beim Verlassen). */
  function erfasseDatei({ datei, start, vorher, nachher, sitzung }) {
    const path = String(datei || "");
    const roh = s.materialRoh.get(path);
    const item = s.material.find((m) => m.path === path);
    if (!item || roh === undefined) return { status: "fehler", meldung: "Diese Datei gehört nicht zum Material." };
    const own = s.lokal.find((e) => e.sitzung === sitzung && !e.versiegelt);
    const { text } = applyList(roh, offene().filter((e) => e !== own && e.datei === path));
    let pos;
    try {
      pos = locateIn("content", text, vorher, Number.isInteger(start) ? start : -1);
    } catch (err) {
      if (!(err instanceof Konflikt)) throw err;
      return { status: "konflikt", meldung: err.message, text };
    }
    const clean = cleanNachher("content", nachher);
    if (own) s.lokal.splice(s.lokal.indexOf(own), 1);
    if (clean === vorher) {
      speichereLokal();
      return { status: "unveraendert", text };
    }
    const entry = { id: neueId(), sitzung: sitzung || `datei-${Date.now()}`, datei: path, erstellt: ortsZeit(new Date()), geraet: GERAET,
      wer: "du", basis: s.modell.version, seit: Date.now(), titel: item.title || path, vorher, nachher: clean, start: pos,
      geaendert: ortsZeit(new Date()), fertig: true, versiegelt: true };
    versiegeln(entry.sitzung);
    s.lokal.push(entry);
    speichereLokal();
    return { status: "offen", id: entry.id, text: applyChange(text, entry) };
  }

  // ---------------------------------------------------------------- Hochladen

  const nachricht = (list) => {
    const titel = [...new Set(list.map((e) => e.titel).filter(Boolean))];
    return `${GERAET}: ${titel.slice(0, 3).join(", ") || "bearbeitet"}${titel.length > 3 ? ` und ${titel.length - 3} weitere` : ""}`;
  };

  /** Nach dem Hochladen: was jetzt im Zweig liegt (ohne ihn neu zu lesen). */
  async function uebernehme(neu, weg, { kopf, baum, vorherKopf }) {
    const dateien = new Map(s.schlange.dateien);
    for (const p of weg) dateien.delete(p);
    const wegIds = new Set(weg.map((p) => p.slice(ORDNER.length + 1, -5)));
    let aenderungen = s.schlange.aenderungen.filter((e) => !wegIds.has(e.id));
    const alt = new Set(s.schlange.alt);
    for (const item of neu) {
      const bytes = new TextEncoder().encode(item.text);
      const sha = await gitBlobSha(bytes);
      dateien.set(item.path, sha);
      cacheAblegen(sha, bytes); // auch ohne Netz wieder zu öffnen
      if (item.path === ALTE_DATEI) {
        const bleibt = new Set(parseQueue(item.text).map((e) => e.id));
        aenderungen = aenderungen.filter((e) => !alt.has(e.id) || bleibt.has(e.id));
        for (const id of [...alt]) if (!bleibt.has(id)) alt.delete(id);
      } else if (item.entry) {
        s.eigene.add(item.entry.id);
        if (!aenderungen.some((e) => e.id === item.entry.id)) aenderungen.push(item.entry);
      }
    }
    if (weg.includes(ALTE_DATEI)) {
      aenderungen = aenderungen.filter((e) => !alt.has(e.id));
      alt.clear();
    }
    // Hat inzwischen ein anderes Gerät geschrieben, wird der Zweig beim nächsten Nachsehen neu gelesen
    const vollstaendig = vorherKopf === s.schlange.kopf && !s.schlange.fehlt;
    s.schlange = { kopf: vollstaendig ? kopf : null, baum, datum: new Date().toISOString(), dateien, alt, aenderungen, fehlt: false };
    merkeStand();
  }

  async function erstelleZweig(neu) {
    neu = [...neu.filter((n) => n.path !== LIESMICH.path), LIESMICH];
    const tree = await gh(`/repos/${repo()}/git/trees`, { method: "POST",
      body: { tree: neu.map((n) => ({ path: n.path, mode: "100644", type: "blob", content: n.text })) } });
    const commit = await gh(`/repos/${repo()}/git/commits`, { method: "POST", body: { message: nachricht(neu.map((n) => n.entry || {})), tree: tree.sha, parents: [] } });
    await gh(`/repos/${repo()}/git/refs`, { method: "POST", body: { ref: `refs/heads/${ZWEIG}`, sha: commit.sha } });
    s.schlange.fehlt = false;
    s.schlange.kopf = null;
    await uebernehme(neu, [], { kopf: commit.sha, baum: tree.sha, vorherKopf: null });
  }

  /** Eine neue Änderung als Datei anlegen (eine Anfrage). */
  async function legeAn(item) {
    const vorherKopf = s.schlange.kopf;
    const r = await gh(`/repos/${repo()}/contents/${pfadUrl(item.path)}`, { method: "PUT",
      body: { message: nachricht([item.entry]), content: textBase64(item.text), branch: ZWEIG } });
    const parent = r?.commit?.parents?.[0]?.sha ?? null;
    await uebernehme([item], [], { kopf: r?.commit?.sha || null, baum: r?.commit?.tree?.sha || null,
      vorherKopf: parent === vorherKopf ? vorherKopf : "anders" });
  }

  /** Mehrere Dateien anlegen, ersetzen oder löschen – in einem Commit (Git-Daten-Schnittstelle). */
  async function stapel(neu, weg) {
    for (let versuch = 0; ; versuch += 1) {
      let branch;
      try {
        branch = await gh(`/repos/${repo()}/branches/${ZWEIG}`);
      } catch (err) {
        if (err.status !== 404) throw err;
        s.schlange = leereSchlange(true); // den Zweig gibt es nicht (mehr): neu anlegen
        if (neu.some((n) => n.entry)) await erstelleZweig(neu.filter((n) => n.entry));
        return;
      }
      const kopf = branch.commit.sha;
      const baum = branch.commit.commit.tree.sha;
      let dateien = s.schlange.dateien;
      if (weg.length && kopf !== s.schlange.kopf) dateien = (await leseSchlange(kopf, baum, null)).dateien;
      const wegDa = weg.filter((p) => dateien.has(p)); // nur löschen, was es gibt (sonst lehnt GitHub ab)
      const dazu = [...neu];
      // Ein Zweig ohne jede Datei geht nicht: dann bleibt ein kurzer Hinweis darin
      if (wegDa.length && !dazu.length && [...dateien.keys()].every((p) => wegDa.includes(p))) dazu.push(LIESMICH);
      if (!dazu.length && !wegDa.length) return;
      const tree = await gh(`/repos/${repo()}/git/trees`, { method: "POST", body: { base_tree: baum, tree: [
        ...dazu.map((n) => ({ path: n.path, mode: "100644", type: "blob", content: n.text })),
        ...wegDa.map((p) => ({ path: p, mode: "100644", type: "blob", sha: null })),
      ] } });
      neu = dazu;
      const titel = neu.filter((n) => n.entry).map((n) => n.entry);
      const commit = await gh(`/repos/${repo()}/git/commits`, { method: "POST",
        body: { message: titel.length ? nachricht(titel) : `${GERAET}: Erledigtes abgeräumt`, tree: tree.sha, parents: [kopf] } });
      try {
        await gh(`/repos/${repo()}/git/refs/heads/${ZWEIG}`, { method: "PATCH", body: { sha: commit.sha, force: false } });
      } catch (err) {
        if ((err.status === 422 || err.status === 409) && versuch < 3) continue; // inzwischen hat ein anderes Gerät geschrieben
        throw err;
      }
      await uebernehme(neu, wegDa, { kopf: commit.sha, baum: tree.sha, vorherKopf: kopf === s.schlange.kopf ? kopf : "anders" });
      return;
    }
  }

  async function schreibeEintraege(bereit, aufraeumen = null) {
    const neu = bereit.map((e) => ({ path: eintragPfad(e.id), text: eintragText(e), entry: queueEntry(e) }));
    const weg = aufraeumen?.weg || [];
    if (aufraeumen?.alt) neu.push(aufraeumen.alt);
    if (s.schlange.fehlt) {
      try {
        await erstelleZweig(neu);
        return;
      } catch (err) {
        if (err.status !== 422) throw err; // ein anderes Gerät hat den Zweig eben angelegt
        s.schlange.fehlt = false;
      }
    }
    if (neu.length === 1 && !weg.length && neu[0].entry) {
      try {
        await legeAn(neu[0]);
        return;
      } catch (err) {
        if (err.status === 422 && /sha/i.test(err.message)) {
          // Die Datei gibt es schon (etwa beim Schließen der Seite hochgeladen): sie ist angekommen
          s.schlange.kopf = null;
          s.eigene.add(neu[0].entry.id);
          return;
        }
        if (err.status === 404 || err.status === 422) {
          s.schlange = leereSchlange(true); // den Zweig gibt es nicht (mehr)
          await erstelleZweig(neu);
          return;
        }
        if (err.status !== 409) throw err;
        // 409: gleichzeitig hat ein anderes Gerät geschrieben – dann als Stapel
      }
    }
    await stapel(neu, weg);
  }

  /** Was der Laptop laut Rückmeldung (in der geladenen zkn3) schon berücksichtigt hat, darf aus dem Zweig. */
  function aufraeumListe() {
    const erledigt = new Set(s.schlange.aenderungen.filter((e) => ERLEDIGT.has(s.rueckmeldung[e.id]?.status)).map((e) => e.id));
    if (!erledigt.size) return null;
    const weg = [...erledigt].map(eintragPfad).filter((p) => s.schlange.dateien.has(p));
    let alt = null;
    if (s.schlange.dateien.has(ALTE_DATEI) && [...s.schlange.alt].some((id) => erledigt.has(id))) {
      const bleibt = s.schlange.aenderungen.filter((e) => s.schlange.alt.has(e.id) && !erledigt.has(e.id)).map(queueEntry);
      if (bleibt.length) alt = { path: ALTE_DATEI, text: queueText(bleibt) };
      else weg.push(ALTE_DATEI);
    }
    return weg.length || alt ? { weg, alt } : null;
  }

  const aufraeumenFaellig = () => !s.offline && !s.zugangFehler && !s.lokal.length && Date.now() - s.letztesAufraeumen > AUFRAEUMEN_ABSTAND
    && budgetWarte() === 0 && Boolean(aufraeumListe());

  async function aufraeumenLauf() {
    if (!aufraeumenFaellig()) return;
    const liste = aufraeumListe();
    s.letztesAufraeumen = Date.now();
    store.set("aufgeraeumt", s.letztesAufraeumen);
    try {
      await stapel(liste.alt ? [liste.alt] : [], liste.weg);
    } catch {
      /* nicht schlimm: beim nächsten Mal */
    }
  }

  /** Wann das nächste Hochladen dran ist (siehe oben: RUHE, LAENGSTENS, ABSTAND, GitHub-Grenzen). */
  function planeHochladen(sofort = false) {
    clearTimeout(s.timer);
    s.timer = null;
    if (!s.lokal.length || s.zugangFehler || !s.modell) return;
    const now = Date.now();
    const laufend = s.lokal.filter((e) => !e.versiegelt);
    let wann = now;
    if (!sofort && !s.lokal.some((e) => e.versiegelt)) {
      const beginn = Math.min(...laufend.map((e) => e.seit || now));
      wann = Math.max(Math.min(s.letzteEingabe + RUHE, beginn + LAENGSTENS), s.letzterLauf + ABSTAND);
    }
    if (!sofort && (s.offline || s.fehler)) {
      if (!s.lokal.some((e) => e.versiegelt)) return; // ohne Netz: erst, wenn wieder Verbindung besteht (siehe nachsehen)
      wann = Math.max(wann, s.naechsterVersuch);
    }
    wann = Math.max(wann, now + budgetWarte());
    s.timer = setTimeout(() => {
      s.timer = null;
      nacheinander(() => hochladenLauf());
    }, Math.max(0, wann - now));
  }

  async function hochladenLauf({ alles = false } = {}) {
    if (!s.lokal.length) return { status: "gespeichert" };
    if (s.zugangFehler) return { status: "lokal", meldung: s.zugangFehler.message };
    if (budgetWarte() > 0) {
      planeHochladen();
      return { status: "lokal", meldung: "GitHub erlaubt nur eine bestimmte Zahl von Anfragen – es geht gleich weiter." };
    }
    // Was jetzt hochgeht, ändert sich nicht mehr (ohne Netz bleiben laufende Eingaben offen)
    if (alles || !s.offline) {
      for (const e of s.lokal) {
        if (e.versiegelt) continue;
        e.versiegelt = true;
        e.fertig = true;
        versiegeln(e.sitzung);
      }
      speichereLokal();
    }
    const bereit = s.lokal.filter((e) => e.versiegelt);
    if (!bereit.length) return { status: "lokal" };
    const aufraeumen = Date.now() - s.letztesAufraeumen > AUFRAEUMEN_ABSTAND && bereit.length > 1 ? aufraeumListe() : null;
    s.laeuft = true;
    s.letzterLauf = Date.now();
    melde();
    try {
      await schreibeEintraege(bereit, aufraeumen);
      if (aufraeumen) {
        s.letztesAufraeumen = Date.now();
        store.set("aufgeraeumt", s.letztesAufraeumen);
      }
      const ids = new Set(bereit.map((e) => e.id));
      s.lokal = s.lokal.filter((e) => !ids.has(e.id));
      speichereLokal();
      s.fehler = null;
      s.offline = false;
      s.versuche = 0;
      s.naechsterVersuch = 0;
      s.zuletztOben = new Date().toISOString();
      store.set("zuletztOben", s.zuletztOben);
      return { status: "gespeichert" };
    } catch (err) {
      if (err.zugang) s.zugangFehler = err;
      s.offline = err.status === 0;
      if (err.warte) s.gesperrtBis = Date.now() + err.warte * 1000;
      s.fehler = s.offline ? null : err.message || "Das Hochladen hat nicht geklappt.";
      s.versuche += 1;
      s.naechsterVersuch = Date.now() + Math.min(60000, 5000 * 2 ** Math.min(s.versuche - 1, 4));
      return { status: "lokal", meldung: err.message || "" };
    } finally {
      s.laeuft = false;
      if (s.lokal.length) planeHochladen();
      melde();
    }
  }

  window.addEventListener("online", () => {
    if (!s.modell || !s.lokal.length) return;
    s.naechsterVersuch = 0;
    planeHochladen(true);
  });

  // ---------------------------------------------------------------- Schnittstelle für den Reader

  return {
    modus: "github",
    schluesselLink: SCHLUESSEL_ANLEGEN,
    geraet: GERAET,
    pause: { sichtbar: 45000, offline: 20000, versteckt: 300000 },
    texte: {
      offline: ["Keine Verbindung zu GitHub", "Du kannst weiterschreiben: Alles bleibt auf diesem Gerät und geht hoch, sobald wieder Verbindung besteht."],
      wieder: "Verbindung zu GitHub wieder da.",
      nichtErreichbar: "der Speicher dieses Geräts antwortet nicht",
    },

    /** Der Reader möchte erfahren, wenn sich der Stand ändert (Hochladen fertig, Verbindung weg …). */
    beobachten(fn) {
      s.beobachter = fn;
    },

    async bereit() {
      if (!s.zugang?.token || !s.zugang?.repo) return false;
      // Angefangene Bearbeitungen aus einer früheren Sitzung (Seite geschlossen, Akku leer) gelten als fertig.
      if (s.lokal.some((e) => !e.versiegelt)) {
        for (const e of s.lokal) {
          e.fertig = true;
          e.versiegelt = true;
          versiegeln(e.sitzung);
        }
        speichereLokal();
      }
      return true;
    },

    async verbinden(token, wunsch = "") {
      const key = String(token || "").trim();
      if (!key) return { ok: false, meldung: "Bitte den Schlüssel einfügen." };
      s.zugang = { token: key, repo: "", zweig: "main" };
      try {
        await gh("/user");
        let kandidaten = [];
        const gewuenscht = String(wunsch || "").trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "").replace(/\/+$/, "");
        if (gewuenscht) {
          kandidaten = [gewuenscht];
        } else {
          const repos = await gh("/user/repos?per_page=100&sort=pushed");
          for (const r of repos.filter((x) => x.private).slice(0, 20)) {
            try {
              const root = await gh(`/repos/${r.full_name}/contents`);
              if (Array.isArray(root) && root.some((f) => f.type === "file" && /\.zkn3$/i.test(f.name))) kandidaten.push(r.full_name);
            } catch {
              /* kein Zugriff mit diesem Schlüssel */
            }
          }
        }
        if (kandidaten.length !== 1) {
          s.zugang = null;
          return { ok: false, frageRepo: true, auswahl: kandidaten,
            meldung: kandidaten.length ? "Mehrere Repositorys kommen in Frage – welches ist es?"
              : "Mit diesem Schlüssel finde ich kein Repository mit einer zkn3. Hast du beim Anlegen unter „Repository access“ dein Roman-Repository ausgewählt?" };
        }
        const info = await gh(`/repos/${kandidaten[0]}`);
        s.zugang = { token: key, repo: info.full_name, zweig: info.default_branch || "main" };
        store.set("zugang", s.zugang);
        return { ok: true, repo: info.full_name };
      } catch (err) {
        s.zugang = null;
        return { ok: false, frageRepo: Boolean(wunsch), meldung: err.status === 401 ? "GitHub nimmt diesen Schlüssel nicht an."
          : err.status === 0 ? "Keine Verbindung zu GitHub – zum Einrichten braucht das Gerät einmal Internet." : err.message };
      }
    },

    abmelden() {
      s.zugang = null;
      store.remove("zugang");
      store.remove("stand");
      try {
        caches.delete(CACHE);
      } catch {
        /* nicht wichtig */
      }
    },

    async buch() {
      await laden();
      const payload = s.modell.bookPayload(overlay());
      payload.file.modified = lokaleZeit(s.zkn3Stand?.datum);
      payload.stand = stand();
      return payload;
    },

    async material() {
      await laden();
      return Promise.all(s.material.map(async (item) => {
        let title = item.path.split("/").pop().replace(/\.[^.]*$/, "");
        try {
          title = materialTitel(item.path, materialStand(item.path, await rohText(item)).text);
        } catch {
          /* dann eben der Dateiname */
        }
        item.title = title;
        return { path: item.path, title, group: item.group };
      }));
    },

    async materialText(path) {
      await laden();
      const item = s.material.find((m) => m.path === path);
      if (!item) throw new Error("Diese Datei gehört nicht zum Material.");
      return materialStand(path, await rohText(item)).text;
    },

    async materialAendern(body) {
      await laden();
      const item = s.material.find((m) => m.path === String(body.datei || ""));
      if (item) await rohText(item);
      const result = erfasseDatei(body);
      if (result.status === "offen") {
        result.einspielen = await nacheinander(() => hochladenLauf());
        result.text = materialStand(item.path, s.materialRoh.get(item.path)).text;
      }
      return { ...result, ...zustand() };
    },

    materialVerlassen(body) {
      if (!s.modell) return;
      if (erfasseDatei(body).status === "offen") this.verlassen([]);
    },

    async exportDaten() {
      await laden();
      const offen = overlay();
      const payload = s.modell.bookPayload(offen);
      const material = await Promise.all(s.material.map(async (item) => {
        let text = "";
        try {
          text = materialStand(item.path, await rohText(item)).text;
        } catch {
          /* ohne Netz und nicht zwischengespeichert */
        }
        return { path: item.path, title: item.title || item.path, group: item.group, text };
      }));
      const alle = new Map(offene().map((e) => [e.id, queueEntry(e)]));
      for (const e of konfliktListe()) alle.set(e.id, { ...queueEntry(e), status: "konflikt", grund: e.grund });
      return {
        geraet: GERAET, erstellt: ortsZeit(new Date()),
        stand: { datum: lokaleZeit(s.zkn3Stand?.datum), datei: payload.file.name },
        abschnitte: payload.sections.map(({ name, separator }) => ({ name, separator })),
        kapitel: payload.entries.map((e) => ({ pos: e.pos, id: e.id, title: e.title, kind: e.kind, section: e.section, text: e.text,
          misc: offen[e.id]?.misc ?? s.modell.byId.get(e.id)?.misc ?? "" })),
        material,
        aenderungen: [...alle.values()],
      };
    },

    async einlesen() {
      return { neu: 0, meldung: "Einlesen geht nur im Reader auf dem Laptop." };
    },

    async zettel(id) {
      await laden();
      const data = s.modell.zettelPayload(id, overlay());
      if (!data) throw new Error("Diesen Zettel gibt es nicht.");
      return data;
    },

    async suche(query) {
      await laden();
      return s.modell.search(query);
    },

    async aendern(body) {
      await laden();
      const result = erfasse(body);
      if (result.status === "offen" || result.status === "unveraendert") {
        if (body.fertig) result.einspielen = await nacheinander(() => hochladenLauf());
        else planeHochladen();
      }
      melde();
      return { ...result, ...zustand() };
    },

    /** Beim Schließen der Seite: festhalten und – wenn es noch geht – hochladen (ohne auf Antwort zu warten). */
    verlassen(bodies) {
      if (!s.modell) return;
      for (const body of bodies) erfasse({ ...body, fertig: true });
      for (const e of s.lokal) {
        e.fertig = true;
        e.versiegelt = true;
        versiegeln(e.sitzung);
      }
      speichereLokal();
      if (!s.lokal.length || !s.zugang || s.schlange.fehlt || s.offline) return;
      let platz = 60000; // mehr nimmt der Browser beim Schließen nicht mit
      for (const e of s.lokal) {
        const body = JSON.stringify({ message: nachricht([e]), content: textBase64(eintragText(e)), branch: ZWEIG });
        if (body.length > platz) continue; // zu groß zum Mitgeben – dann beim nächsten Öffnen
        platz -= body.length;
        try {
          fetch(`${apiBase}/repos/${repo()}/contents/${pfadUrl(eintragPfad(e.id))}`, {
            method: "PUT", keepalive: true, cache: "no-store", referrerPolicy: "no-referrer",
            headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${s.zugang.token}`, "Content-Type": "application/json" },
            body,
          }).catch(() => {});
        } catch {
          /* beim nächsten Öffnen */
        }
      }
    },

    async aenderungen() {
      await laden();
      const konflikte = konfliktListe();
      const strittig = new Set(konflikte.map((e) => e.id));
      return {
        github: true,
        offen: wartetAufLaptop().filter((e) => !strittig.has(e.id)),
        konflikte,
        verloren: [],
        hochladen: s.lokal.filter((e) => !strittig.has(e.id)),
        programm: false,
        fehler: s.fehler,
        offline: s.offline,
        ohneNetz: s.ohneNetz,
        laeuft: s.laeuft,
        geraet: GERAET,
        zuletztOben: lokaleZeit(s.zuletztOben),
        standOben: neueste(s.zkn3Stand?.datum, s.schlange.datum, s.zuletztOben),
        stand: { datum: lokaleZeit(s.zkn3Stand?.datum), nachricht: s.zkn3Stand?.nachricht || "" },
      };
    },

    async aktion() {
      return { ok: false, meldung: "Das geht nur im Reader auf dem Laptop." };
    },

    async sichern() {
      await laden();
      if (!s.lokal.length) return { ok: true, message: "Alles ist auf GitHub.", git: gitZustand() };
      const result = await nacheinander(() => hochladenLauf({ alles: true }));
      return result.status === "gespeichert"
        ? { ok: true, message: "Auf GitHub hochgeladen.", git: gitZustand() }
        : { ok: false, message: s.offline ? "Keine Verbindung zu GitHub – deine Änderungen bleiben auf diesem Gerät." : "Das Hochladen zu GitHub hat nicht geklappt.",
          detail: s.offline ? "Sie gehen von selbst hoch, sobald wieder Verbindung besteht." : result.meldung, git: gitZustand() };
    },

    gitZustand,

    async status() {
      await laden();
      try {
        await nacheinander(nachsehen);
      } catch (err) {
        if (err.status === 0) {
          s.offline = true;
          melde();
        }
        throw err;
      }
      return { stand: stand(), modified: lokaleZeit(s.zkn3Stand?.datum), error: null, git: gitZustand(), bearbeitung: zaehle() };
    },
  };
}
