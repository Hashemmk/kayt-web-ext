// "Send to Obsidian": makes an obsidian:// link that asks the Obsidian app on this
// computer to create (or replace) a note. Nothing goes over the network: Chrome
// hands the link to Obsidian, the same way it opens a mailto: link.
//
// The note's text travels through the clipboard (Obsidian's "clipboard"
// parameter), because a long note won't fit in a link. The caller copies it first.

// Characters Obsidian (or Windows, macOS) don't allow in a file name, or that
// break links inside Obsidian.
const NOT_IN_FILE_NAMES = /[\\/:*?"<>|#^[\]]/g;

export function obsidianFileName(title) {
  const cleaned = (title || "").replace(NOT_IN_FILE_NAMES, " ").replace(/\s+/g, " ").trim();
  return (cleaned || "YouTube notes").slice(0, 120);
}

// vault: the vault's name, or "" for whichever vault Obsidian has open.
// folder: e.g. "Kayt", or "" for the vault's top level.
export function obsidianNewNoteUrl({ vault, folder, fileName }) {
  const cleanFolder = (folder || "")
    .split("/")
    .map((part) => part.replace(NOT_IN_FILE_NAMES, " ").trim())
    .filter(Boolean)
    .join("/");
  const path = cleanFolder ? cleanFolder + "/" + fileName : fileName;
  const params = [];
  if (vault && vault.trim()) {
    params.push("vault=" + encodeURIComponent(vault.trim()));
  }
  params.push("file=" + encodeURIComponent(path));
  // Sending the same video again brings the note up to date instead of making
  // "Title 1", "Title 2"…
  params.push("clipboard=true", "overwrite=true");
  return "obsidian://new?" + params.join("&");
}

// The Markdown export of one video, without the "# Kayt export / Exported …"
// lines at the top, which make no sense inside a single Obsidian note.
export function asObsidianNote(markdown) {
  const lines = markdown.split("\n");
  let start = 0;
  if (lines[0] === "# Kayt export") {
    start = 2;
    while (start < lines.length && lines[start] === "") {
      start++;
    }
  }
  return lines.slice(start).join("\n");
}
