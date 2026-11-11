// Woher der Reader seine Daten hat:
// - auf dem Laptop (Adresse 127.0.0.1 oder localhost) vom lokalen Dienst,
// - sonst (Chromebook, Seite auf GitHub Pages) direkt aus dem privaten GitHub-Repository.
// Nur auf dem eigenen Rechner lässt sich zum Testen eine andere GitHub-Adresse angeben (?api=…).

export const LOKALER_RECHNER = ["127.0.0.1", "localhost", "[::1]"].includes(location.hostname);

export async function waehleQuelle() {
  const params = new URLSearchParams(location.search);
  if (LOKALER_RECHNER && !params.has("api")) {
    const { lokaleQuelle } = await import("./quelle-lokal.js");
    return lokaleQuelle();
  }
  const apiBase = LOKALER_RECHNER ? new URL(params.get("api"), location.href).href.replace(/\/+$/, "") : "https://api.github.com";
  const { githubQuelle } = await import("./quelle-github.js");
  return githubQuelle({ apiBase, test: LOKALER_RECHNER });
}
