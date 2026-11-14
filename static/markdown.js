// Material als durchgehendes, formatiertes Schreibfeld. Markdown bleibt das Speicherformat.
// Unberührte Teile werden wortgetreu übernommen, auch Referenzen und besondere Schreibweisen.
import { marked } from "./vendor/marked.esm.js";
import { escapeHtml } from "./textsatz.js";
import { OHNE_FARBE } from "./format.js";

const original = new WeakMap();
const escapeText = (s) => s.replace(/\u00a0/g, " ").replace(/&/g, "&amp;").replace(/([\\`*_~[\]<>])/g, "\\$1")
  .replace(/^(\s*)(#{1,6} |[-+>] |\d+\. )/gm, "$1\\$2");
const trim = (s) => s.replace(/^\n+|\n+$/g, "");

function inline(node) {
  if (node.nodeType === 3) return escapeText(node.nodeValue);
  if (node.nodeType !== 1) return "";
  const tag = node.tagName;
  if (tag === "BR") return node.hasAttribute("data-ende") ? "" : "\n";
  if (tag === "IMG") return `![${node.getAttribute("alt") || ""}](${node.getAttribute("src") || ""})`;
  if (tag === "INPUT") return "";
  let text = [...node.childNodes].map(inline).join("");
  if (tag === "CODE") {
    const fence = "`".repeat(Math.max(0, ...(node.textContent.match(/`+/g) || []).map((s) => s.length)) + 1);
    return `${fence} ${node.textContent} ${fence}`;
  }
  if (tag === "A") {
    const href = node.dataset.mdHref ?? node.getAttribute("href") ?? "";
    const title = node.getAttribute("title");
    return `[${text}](<${href.replace(/>/g, "%3E")}>${title ? ` "${title.replace(/"/g, "&quot;")}"` : ""})`;
  }
  // Inline-HTML ist gültiges Markdown und bleibt auch bei direkt benachbarten oder
  // verschachtelten Formatierungen eindeutig ("**a****b**" wäre es nicht).
  const semantic = { B: "strong", STRONG: "strong", I: "em", EM: "em", S: "del", STRIKE: "del", DEL: "del", U: "u", SUB: "sub", SUP: "sup" }[tag];
  if (semantic) text = `<${semantic}>${text}</${semantic}>`;
  const color = node.getAttribute("color") || node.style.color;
  const styles = [color && ![OHNE_FARBE, "rgb(1, 2, 3)"].includes(color) ? `color:${color}` : "",
    ...["font-weight", "font-style", "text-decoration-line"].map((name) => node.style.getPropertyValue(name) ? `${name}:${node.style.getPropertyValue(name)}` : "")].filter(Boolean);
  if (styles.length) text = `<span style="${escapeHtml(styles.join(';'))}">${text}</span>`;
  if (tag === "DIV" || tag === "P") return `\n${text}\n`;
  return text;
}

function blocks(root) {
  return [...root.childNodes].map(block).join("");
}

function block(node) {
    if (node.nodeType !== 1) return inline(node);
    const tag = node.tagName;
    const text = () => trim([...node.childNodes].map(inline).join(""));
    if (/^H[1-6]$/.test(tag)) return `${"#".repeat(Number(tag[1]))} ${text()}\n\n`;
    if (tag === "P") return `${text()}\n\n`;
    if (tag === "DIV") return blocks(node) + "\n\n";
    if (tag === "HR") return "---\n\n";
    if (tag === "BLOCKQUOTE") return trim(blocks(node)).replace(/^/gm, "> ") + "\n\n";
    if (tag === "PRE") {
      const code = node.querySelector("code");
      const lang = code?.className.match(/language-([^\s]+)/)?.[1] || "";
      const value = (code || node).textContent.replace(/\n$/, "");
      const fence = "`".repeat(Math.max(2, ...(value.match(/`+/g) || []).map((s) => s.length)) + 1);
      return `${fence}${lang}\n${value}\n${fence}\n\n`;
    }
    if (tag === "UL" || tag === "OL") {
      return [...node.children].map((li, i) => {
        const prefix = tag === "UL" ? "- " : `${Number(node.getAttribute("start") || 1) + i}. `;
        const checkbox = li.querySelector(':scope > input[type="checkbox"]');
        const task = checkbox ? `[${checkbox.checked ? "x" : " "}] ` : "";
        const value = trim([...li.childNodes].map((child) => {
          const value = block(child);
          return child.nodeType === 1 && /^(UL|OL)$/.test(child.tagName) ? "\n" + value : value;
        }).join("")).trimStart();
        return prefix + task + value.replace(/\n/g, "\n" + " ".repeat(prefix.length));
      }).join("\n") + "\n\n";
    }
    if (tag === "TABLE") {
      const rows = [...node.querySelectorAll("tr")].map((tr) => [...tr.children]
        .map((cell) => trim([...cell.childNodes].map(inline).join("")).replace(/\|/g, "\\|").replace(/\n/g, "<br>")));
      if (!rows.length) return "";
      const heads = [...node.querySelector("tr").children];
      rows.splice(1, 0, heads.map((cell) => ({ left: ":---", center: ":---:", right: "---:" }[cell.getAttribute("align") || cell.style.textAlign] || "---")));
      return rows.map((row) => `| ${row.join(" | ")} |`).join("\n") + "\n\n";
    }
    return inline(node);
}

export function markdownSetzen(ed, source, links = () => {}) {
  const text = String(source ?? "").replace(/\r\n?/g, "\n");
  const tokens = marked.lexer(text, { gfm: true });
  const pieces = [];
  let pos = 0;
  for (const token of tokens) {
    const at = text.indexOf(token.raw, pos);
    if (at < pos) throw new Error("Die Markdown-Datei lässt sich nicht verlustfrei öffnen.");
    if (at > pos) pieces.push({ raw: text.slice(pos, at), html: "" });
    pos = at + token.raw.length;
    if (token.type === "space" && pieces.length) pieces[pieces.length - 1].raw += token.raw;
    else pieces.push({ raw: token.raw, html: marked.parser(Object.assign([token], { links: tokens.links }), { gfm: true }).trimEnd() });
  }
  if (pos < text.length) pieces.push({ raw: text.slice(pos), html: "" });
  ed.replaceChildren();
  for (const piece of pieces) {
    const node = document.createElement("div");
    node.dataset.md = "";
    node.innerHTML = piece.html;
    if (!piece.html) { node.hidden = true; node.contentEditable = "false"; }
    ed.append(node);
    // Ein umgeschriebener Reader-Link muss beim Speichern wieder seinen Dateipfad bekommen.
    for (const a of node.querySelectorAll("a[href]")) a.dataset.mdHref = a.getAttribute("href");
    links(node);
    original.set(node, { raw: piece.raw, html: node.innerHTML });
  }
}

export function markdownLesen(ed) {
  let text = "";
  for (const node of ed.childNodes) {
    const old = original.get(node);
    if (old && old.html === node.innerHTML) { text += old.raw; continue; }
    const value = trim(block(node));
    if (!value) continue;
    if (text && !text.endsWith("\n\n")) text += text.endsWith("\n") ? "\n" : "\n\n";
    text += value + (old ? old.raw.match(/\n*$/)[0] : "\n\n");
  }
  return text;
}

export function markdownKlartext(ed) {
  // innerText entspricht der sichtbaren Auswahl, einschließlich Listen, Tabellen und Absätzen.
  return ed.innerText.replace(/\u00a0/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}
