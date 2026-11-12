// Datenquelle unterwegs (Chromebook): liest den Roman aus dem privaten GitHub-Repository – so,
// wie er zuletzt auf dem Laptop mit „Sichern“ hochgeladen wurde – und legt Bearbeitungen in den
// Zweig „unterwegs“ (Datei aenderungen.json). Auf dem Laptop holt der Reader-Dienst sie dort ab
// und spielt sie über das Schreibwerkzeug in die zkn3 ein (reader/unterwegs.py). Welche schon
// eingespielt sind, steht in aenderungsbuch/unterwegs.json; diese Datei kommt mit „Sichern“
// zusammen mit der zkn3 auf GitHub. So passen zkn3 und Rückmeldung immer zueinander.
import { leseZkn3, materialListe, materialTitel } from "./zkn3.js";
import { FELDER, Konflikt, applyChange, applyList, cleanNachher, feldVon, locateIn, mergeQueue, parseQueue, queueText } from "./aenderung.js";

const ZWEIG = "unterwegs";
const DATEI = "aenderungen.json";
const RUECKMELDUNG = "aenderungsbuch/unterwegs.json";
const ERLEDIGT = new Set(["eingespielt", "verworfen"]); // in dieser zkn3 schon berücksichtigt
const NICHT_ANWENDEN = new Set(["eingespielt", "verworfen", "konflikt"]);
const CACHE = "roman-reader-1";
const GERAET = /\bCrOS\b/.test(navigator.userAgent) ? "Chromebook" : "Browser";
export const SCHLUESSEL_ANLEGEN = "https://github.com/settings/personal-access-tokens/new"
  + "?name=Roman-Reader&description=Lesen+und+Bearbeiten+des+Romans+im+Reader&expires_in=366&contents=write";

class GithubFehler extends Error {
  constructor(status, message, { zugang = false } = {}) {
    super(message);
    this.status = status;
    this.zugang = zugang;
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

function neueId() {
  const now = new Date();
  const random = [...crypto.getRandomValues(new Uint8Array(3))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `u-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${random}`;
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

const hex = (buffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Git-Prüfsumme einer Datei – so lässt sich prüfen, dass sie vollständig angekommen ist. */
async function gitBlobSha(bytes) {
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const all = new Uint8Array(header.length + bytes.length);
  all.set(header);
  all.set(bytes, header.length);
  return hex(await crypto.subtle.digest("SHA-1", all));
}

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
    zkn3Sha: null,
    zkn3Stand: null, // wann die zkn3 zuletzt auf GitHub kam: { datum, nachricht }
    rueckmeldung: {},
    rueckmeldungSha: null,
    material: [],
    schlange: { sha: null, aenderungen: [], fehlt: false },
    bekannt: new Set(), // alle Fassungen der Warteschlange, die dieses Fenster schon kennt
    lokal: store.get("lokal", []), // Bearbeitungen, die noch nicht auf GitHub sind
    konflikte: new Map(),
    fremd: 0,
    fehler: null,
    offline: false,
    zugangFehler: null,
    geladen: null,
  };

  const repo = () => s.zugang.repo;
  const speichereLokal = () => {
    if (!store.set("lokal", s.lokal)) s.fehler = "Der Browser lässt nichts mehr speichern – bitte bald hochladen.";
  };

  async function gh(path, { method = "GET", body = null, accept = "application/vnd.github+json", bytes = false } = {}) {
    const headers = { Accept: accept };
    if (s.zugang?.token) headers.Authorization = `Bearer ${s.zugang.token}`;
    if (body) headers["Content-Type"] = "application/json";
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
      if (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") {
        throw new GithubFehler(403, "GitHub bremst gerade (zu viele Anfragen). In einer Stunde geht es wieder.");
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

  // ---------------------------------------------------------------- Lesen

  async function blob(sha) {
    const key = `${apiBase}/__zwischenspeicher/${encodeURIComponent(repo())}/${sha}`;
    let cache = null;
    try {
      cache = await caches.open(CACHE);
      const hit = await cache.match(key);
      if (hit) return new Uint8Array(await hit.arrayBuffer());
    } catch {
      cache = null;
    }
    const bytes = await gh(`/repos/${repo()}/git/blobs/${sha}`, { accept: "application/vnd.github.raw+json", bytes: true });
    if ((await gitBlobSha(bytes)) !== sha) throw new GithubFehler(0, "Eine Datei kam unvollständig von GitHub an.");
    try {
      await cache?.put(key, new Response(bytes));
    } catch {
      /* ohne Zwischenspeicher geht es auch */
    }
    return bytes;
  }

  async function aufraeumen(behalten) {
    try {
      const cache = await caches.open(CACHE);
      for (const request of await cache.keys()) {
        if (!behalten.has(request.url.split("/").pop())) await cache.delete(request);
      }
    } catch {
      /* nicht wichtig */
    }
  }

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
      throw new GithubFehler(0, zkn3.length ? `Im Repository liegen mehrere .zkn3-Dateien (${zkn3.join(", ")}).` : "Im Repository liegt keine .zkn3-Datei.");
    }
    const zkn3Sha = files.get(zkn3[0]);
    if (zkn3Sha !== s.zkn3Sha || !s.modell) {
      s.modell = await leseZkn3(await blob(zkn3Sha), zkn3[0]);
      s.zkn3Sha = zkn3Sha;
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
    aufraeumen(new Set([zkn3Sha, rueckSha, ...s.material.map((m) => m.sha)]));
  }

  async function holeSchlange() {
    try {
      const file = await gh(`/repos/${repo()}/contents/${DATEI}?ref=${ZWEIG}`);
      return { sha: file.sha, aenderungen: parseQueue(new TextDecoder().decode(base64ToBytes(file.content))), fehlt: false };
    } catch (err) {
      if (err.status === 404) return { sha: null, aenderungen: [], fehlt: true };
      throw err;
    }
  }

  function setzeSchlange(schlange) {
    s.schlange = schlange;
    s.bekannt.add(schlange.sha);
    const oben = new Set(schlange.aenderungen.map((e) => e.id));
    const vorher = s.lokal.length;
    s.lokal = s.lokal.filter((e) => !oben.has(e.id)); // ist schon angekommen (etwa beim Schließen der Seite)
    if (s.lokal.length !== vorher) speichereLokal();
  }

  function laden() {
    if (!s.geladen) {
      s.geladen = nacheinander(async () => {
        await ladeStand(await ladeKopf());
        setzeSchlange(await holeSchlange());
      }).catch((err) => {
        s.geladen = null;
        throw err;
      });
      s.geladen.then(() => {
        if (s.lokal.some((e) => e.fertig)) nacheinander(hochladenLauf);
      }, () => {});
    }
    return s.geladen;
  }

  /** Hat sich auf GitHub etwas getan? (neuer Stand vom Laptop, Warteschlange von einem anderen Gerät) */
  async function nachsehen() {
    if (s.zugangFehler) throw s.zugangFehler;
    const kopf = await ladeKopf();
    if (kopf.sha !== s.kopf?.sha && !s.bekannteKoepfe.has(kopf.sha)) await ladeStand(kopf);
    const schlange = await holeSchlange();
    if (schlange.sha !== s.schlange.sha && !s.bekannt.has(schlange.sha)) {
      setzeSchlange(schlange);
      s.fremd += 1;
    }
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

  function konfliktListe() {
    overlay();
    return [...s.schlange.aenderungen, ...s.lokal]
      .filter((e) => s.konflikte.has(e.id) || s.rueckmeldung[e.id]?.status === "konflikt")
      .map((e) => ({ ...e, grund: s.konflikte.get(e.id) || s.rueckmeldung[e.id]?.grund || "" }));
  }

  function zaehle() {
    const nichtOben = s.lokal.filter((e) => e.fertig).length;
    return {
      offen: 0, konflikte: konfliktListe().length, verloren: 0, programm: false,
      fehler: s.fehler, hochladen: s.fehler || s.offline ? nichtOben : 0,
    };
  }

  const stand = () => `${(s.zkn3Sha || "").slice(0, 12)}-${(s.rueckmeldungSha || "0").slice(0, 8)}-${s.fremd}`;
  const zustand = () => ({ stand: stand(), bearbeitung: zaehle(), git: gitZustand() });

  function gitZustand() {
    return {
      ok: !s.zugangFehler, error: s.zugangFehler?.message || s.fehler, github: true,
      changeCount: s.lokal.length, ahead: 0,
      changes: s.lokal.map((e) => ({ path: e.titel || `Zettel ${e.zettel}` })),
      lastCommit: s.zkn3Stand ? { time: lokaleZeit(s.zkn3Stand.datum), subject: s.zkn3Stand.nachricht } : null,
    };
  }

  /** Nimmt eine Bearbeitung an (wie Werkstatt.record auf dem Laptop), noch ohne Hochladen. */
  function erfasse({ zettel, feld = "content", start, vorher, nachher, sitzung, fertig }) {
    const id = String(zettel);
    const z = s.modell?.byId.get(id);
    if (!z) return { status: "fehler", meldung: `Zettel ${id} gibt es nicht.` };
    if (!FELDER.includes(feld)) return { status: "fehler", meldung: `Das Feld „${feld}“ lässt sich nicht bearbeiten.` };
    const own = s.lokal.find((e) => e.sitzung === sitzung);
    const { text } = applyList(z[feld], offene().filter((e) => e !== own && String(e.zettel) === id && feldVon(e) === feld));
    let pos;
    try {
      pos = locateIn(feld, text, vorher, Number.isInteger(start) ? start : -1);
    } catch (err) {
      if (!(err instanceof Konflikt)) throw err;
      return { status: "konflikt", meldung: err.message, text };
    }
    const clean = cleanNachher(feld, nachher);
    if (feld === "title" && !clean) return { status: "fehler", meldung: "Ein Titel darf nicht leer sein.", text };
    if (own) s.lokal.splice(s.lokal.indexOf(own), 1);
    if (clean === vorher) {
      speichereLokal();
      return { status: "unveraendert", text };
    }
    const entry = own || { id: neueId(), sitzung, zettel: id, ...(feld === "content" ? {} : { feld }), erstellt: ortsZeit(new Date()),
      geraet: GERAET, wer: "du", basis: s.modell.version };
    Object.assign(entry, { titel: z.title, vorher, nachher: clean, start: pos, geaendert: ortsZeit(new Date()), fertig: Boolean(fertig) });
    s.lokal.push(entry);
    speichereLokal();
    return { status: "offen", id: entry.id, text: applyChange(text, entry) };
  }

  // ---------------------------------------------------------------- Hochladen

  async function erstelleZweig(text, message) {
    const tree = await gh(`/repos/${repo()}/git/trees`, { method: "POST",
      body: { tree: [{ path: DATEI, mode: "100644", type: "blob", content: text }] } });
    const commit = await gh(`/repos/${repo()}/git/commits`, { method: "POST", body: { message, tree: tree.sha, parents: [] } });
    await gh(`/repos/${repo()}/git/refs`, { method: "POST", body: { ref: `refs/heads/${ZWEIG}`, sha: commit.sha } });
    return tree.tree.find((t) => t.path === DATEI).sha;
  }

  async function schreibeSchlange(text, bereit) {
    const titel = [...new Set(bereit.map((e) => e.titel).filter(Boolean))];
    const message = `Unterwegs bearbeitet: ${titel.slice(0, 3).join(", ")}${titel.length > 3 ? ` und ${titel.length - 3} weitere` : ""}`;
    const content = bytesToBase64(new TextEncoder().encode(text));
    const body = { message, content, branch: ZWEIG, ...(s.schlange.sha ? { sha: s.schlange.sha } : {}) };
    try {
      return (await gh(`/repos/${repo()}/contents/${DATEI}`, { method: "PUT", body })).content.sha;
    } catch (err) {
      if (!s.schlange.fehlt || (err.status !== 404 && err.status !== 422)) throw err;
      return erstelleZweig(text, message); // den Zweig gibt es noch nicht
    }
  }

  let wiederholung = null;
  function planeWiederholung() {
    if (wiederholung) return;
    wiederholung = setTimeout(() => {
      wiederholung = null;
      if (s.lokal.some((e) => e.fertig) && !s.zugangFehler) nacheinander(hochladenLauf);
    }, 30000);
  }

  async function hochladenLauf() {
    const bereit = s.lokal.filter((e) => e.fertig);
    if (!bereit.length) return { status: "gespeichert" };
    // Was der Laptop schon eingespielt hat (laut Rückmeldung in dieser zkn3), fällt bei der Gelegenheit heraus.
    const erledigt = new Set(s.schlange.aenderungen.filter((e) => ERLEDIGT.has(s.rueckmeldung[e.id]?.status)).map((e) => e.id));
    let letzter = null;
    for (let versuch = 0; versuch < 4; versuch += 1) {
      const neu = mergeQueue(s.schlange.aenderungen, bereit, erledigt);
      try {
        const sha = await schreibeSchlange(queueText(neu), bereit);
        s.schlange = { sha, aenderungen: neu, fehlt: false };
        s.bekannt.add(sha);
        const ids = new Set(bereit.map((e) => e.id));
        s.lokal = s.lokal.filter((e) => !ids.has(e.id));
        speichereLokal();
        s.fehler = null;
        s.offline = false;
        return { status: "gespeichert" };
      } catch (err) {
        letzter = err;
        if (![404, 409, 422].includes(err.status)) break;
        try {
          setzeSchlange(await holeSchlange()); // inzwischen anderswo geändert: neu lesen und zusammenführen
        } catch (again) {
          letzter = again;
          break;
        }
      }
    }
    if (letzter?.zugang) s.zugangFehler = letzter;
    s.offline = letzter?.status === 0;
    s.fehler = s.offline ? null : letzter?.message || "Das Hochladen hat nicht geklappt.";
    planeWiederholung();
    return { status: "lokal", meldung: letzter?.message || "" };
  }

  window.addEventListener("online", () => {
    if (s.lokal.some((e) => e.fertig) && s.modell) nacheinander(hochladenLauf);
  });

  // ---------------------------------------------------------------- Schnittstelle für den Reader

  return {
    modus: "github",
    schluesselLink: SCHLUESSEL_ANLEGEN,
    pause: { sichtbar: 60000, offline: 30000, versteckt: 300000 },
    texte: {
      offline: ["Keine Verbindung zu GitHub", "Deine Änderungen bleiben auf diesem Gerät und werden später hochgeladen."],
      wieder: "Verbindung zu GitHub wieder da.",
    },
    zustandTexte: {
      offen: " · zwischengespeichert",
      gespeichert: " · auf GitHub gespeichert ✓",
      lokal: " · auf diesem Gerät gespeichert, noch nicht hochgeladen",
    },

    async bereit() {
      if (!s.zugang?.token || !s.zugang?.repo) return false;
      // Angefangene Bearbeitungen aus einer früheren Sitzung (Seite geschlossen, Akku leer) gelten als fertig.
      if (s.lokal.some((e) => !e.fertig)) {
        for (const e of s.lokal) e.fertig = true;
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
        return { ok: false, frageRepo: Boolean(wunsch), meldung: err.status === 401 ? "GitHub nimmt diesen Schlüssel nicht an." : err.message };
      }
    },

    abmelden() {
      s.zugang = null;
      store.remove("zugang");
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
      const decoder = new TextDecoder("utf-8", { ignoreBOM: true }); // wie Python: das BOM gehört zum Text
      return Promise.all(s.material.map(async (item) => {
        let title = item.path.split("/").pop().replace(/\.[^.]*$/, "");
        try {
          title = materialTitel(item.path, decoder.decode(await blob(item.sha)));
        } catch {
          /* dann eben der Dateiname */
        }
        return { path: item.path, title, group: item.group };
      }));
    },

    async materialText(path) {
      await laden();
      const item = s.material.find((m) => m.path === path);
      if (!item) throw new Error("Diese Datei gehört nicht zum Material.");
      return new TextDecoder("utf-8", { ignoreBOM: true }).decode(await blob(item.sha));
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
      if (body.fertig && result.status !== "fehler" && result.status !== "konflikt") result.einspielen = await nacheinander(hochladenLauf);
      return { ...result, ...zustand() };
    },

    /** Beim Schließen der Seite: festhalten und – wenn es noch geht – hochladen (ohne auf Antwort zu warten). */
    verlassen(bodies) {
      if (!s.modell) return;
      for (const body of bodies) erfasse({ ...body, fertig: true });
      const bereit = s.lokal.filter((e) => e.fertig);
      if (!bereit.length || !s.zugang) return;
      try {
        const content = bytesToBase64(new TextEncoder().encode(queueText(mergeQueue(s.schlange.aenderungen, bereit))));
        fetch(`${apiBase}/repos/${repo()}/contents/${DATEI}`, {
          method: "PUT", keepalive: true, cache: "no-store", referrerPolicy: "no-referrer",
          headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${s.zugang.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ message: "Unterwegs bearbeitet", content, branch: ZWEIG, ...(s.schlange.sha ? { sha: s.schlange.sha } : {}) }),
        }).catch(() => {});
      } catch {
        /* zu groß zum Mitgeben – dann beim nächsten Öffnen */
      }
    },

    async aenderungen() {
      await laden();
      const konflikte = konfliktListe();
      const strittig = new Set(konflikte.map((e) => e.id));
      return {
        github: true,
        offen: s.schlange.aenderungen.filter((e) => !NICHT_ANWENDEN.has(s.rueckmeldung[e.id]?.status) && !strittig.has(e.id)),
        konflikte,
        verloren: [],
        hochladen: s.lokal.filter((e) => e.fertig && !strittig.has(e.id)),
        programm: false,
        fehler: s.fehler,
        stand: { datum: lokaleZeit(s.zkn3Stand?.datum), nachricht: s.zkn3Stand?.nachricht || "" },
      };
    },

    async aktion() {
      return { ok: false, meldung: "Das geht nur im Reader auf dem Laptop." };
    },

    async sichern() {
      await laden();
      if (!s.lokal.length) return { ok: true, message: "Alles ist auf GitHub gesichert.", git: gitZustand() };
      if (s.lokal.some((e) => !e.fertig)) {
        for (const e of s.lokal) e.fertig = true; // eine Eingabe läuft nicht mehr (der Klick hat sie beendet)
        speichereLokal();
      }
      const result = await nacheinander(hochladenLauf);
      return result.status === "gespeichert"
        ? { ok: true, message: "Auf GitHub gesichert.", git: gitZustand() }
        : { ok: false, message: "Das Hochladen zu GitHub hat nicht geklappt.", detail: result.meldung, git: gitZustand() };
    },

    async status() {
      await laden();
      await nacheinander(nachsehen);
      return { stand: stand(), modified: lokaleZeit(s.zkn3Stand?.datum), error: null, git: gitZustand(), bearbeitung: zaehle() };
    },
  };
}
