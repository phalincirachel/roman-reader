// Datenquelle auf dem Laptop: der lokale Dienst (reader/server.py) mit Schreibwerkzeug,
// Änderungsbuch und „Sichern“.

async function api(url, options = {}) {
  const response = await fetch(url, { cache: "no-store", ...options });
  if (!response.ok) {
    let message = `Fehler ${response.status}`;
    try {
      message = (await response.json()).error || message;
    } catch {
      /* keine JSON-Antwort */
    }
    throw new Error(message);
  }
  return response.json();
}

const HEADERS = { "X-Reader": "1", "Content-Type": "application/json" };

function post(url, body) {
  return api(url, { method: "POST", headers: HEADERS, body: JSON.stringify(body) });
}

const pad = (n) => String(n).padStart(2, "0");
const ortsZeit = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

async function apiText(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Fehler ${response.status}`);
  return response.text();
}

export function lokaleQuelle() {
  return {
    modus: "lokal",
    async bereit() {
      return true;
    },
    buch: () => api("/api/book"),
    material: () => api("/api/material"),
    materialText: (path) => apiText(`/api/material/${path.split("/").map(encodeURIComponent).join("/")}`),
    zettel: (id) => api(`/api/zettel/${encodeURIComponent(id)}`),
    suche: (query) => api(`/api/suche?q=${encodeURIComponent(query)}`),
    aendern: (body) => post("/api/aendern", body),
    /** Beim Schließen der Seite: noch laufende Bearbeitungen abschicken (ohne auf Antwort zu warten). */
    verlassen(bodies) {
      for (const body of bodies) {
        fetch("/api/aendern", { method: "POST", keepalive: true, headers: HEADERS, body: JSON.stringify(body) });
      }
    },
    aenderungen: () => api("/api/aenderungen"),
    aktion: (aktion, id) => post("/api/aenderungen/aktion", { aktion, id }),
    sichern: () => post("/api/sichern", {}),
    status: () => api("/api/status"),
    /** Material (Handlung, Figuren …): einen Block ändern; die Datei wird gleich geschrieben. */
    materialAendern: (body) => post("/api/material/aendern", body),
    materialVerlassen(body) {
      fetch("/api/material/aendern", { method: "POST", keepalive: true, headers: HEADERS, body: JSON.stringify(body) });
    },
    /** Das letzte Fenster schließt: der Dienst lädt dann bald selbst auf GitHub hoch. */
    fensterZu() {
      fetch("/api/fenster-zu", { method: "POST", keepalive: true, headers: HEADERS, body: "{}" }).catch(() => {});
    },
    async exportDaten() {
      const daten = await api("/api/export");
      return { ...daten, geraet: "Laptop", erstellt: ortsZeit(new Date()) };
    },
    einlesen: (aenderungen) => post("/api/einlesen", { aenderungen }),
    pause: { sichtbar: 5000, offline: 8000, versteckt: 60000 },
    texte: {
      offline: ["Keine Verbindung zum Reader-Dienst", "Über die Verknüpfung „Roman“ startet er neu."],
      wieder: "Verbindung zum Reader-Dienst wieder da.",
    },
  };
}
