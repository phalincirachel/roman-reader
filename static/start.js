// Läuft vor den Modulen: auch ein fehlgeschlagener Import darf keine endlose Ladeanzeige hinterlassen.
(() => {
  const doc = document.getElementById("doc");
  function hinweis(text) {
    if (document.body.dataset.bereit || document.body.dataset.einrichten) return;
    const p = document.createElement("p");
    p.className = "leer";
    p.textContent = text + " ";
    const button = document.createElement("button");
    button.className = "btn";
    button.type = "button";
    button.textContent = "Noch einmal laden";
    button.addEventListener("click", () => location.reload());
    p.append(button);
    doc.replaceChildren(p);
  }
  const timer = setTimeout(() => hinweis("Das Laden dauert ungewöhnlich lange. Bereits gespeicherte Texte bleiben auf diesem Gerät erhalten."), 45000);
  import("./reader.js").then((reader) => reader.bereit).catch((err) => {
    hinweis(`Der Reader konnte nicht starten: ${err.message || "Die Programmdateien sind nicht erreichbar."}`);
  }).finally(() => clearTimeout(timer));
})();
