// Manage notes: every note on one wide page. Filter by text, video and type, pick
// several notes, and copy, export or delete them together. Opened from the side
// panel's top bar or the Kayt button's menu on YouTube.

import * as storage from "../lib/storage.js";
import * as audioStore from "../lib/audio-store.js";
import { buildMarkdown, sortNotesByTimestamp } from "../lib/markdown.js";
import { watchUrl, formatTimestampLabel } from "../lib/youtube-url.js";

const UNSORTED = "__unsorted__";
const QUICK_LABELS = ["Important", "Confusing", "Revisit", "Disagree"];
const TOAST_DURATION_MS = 6000;

const state = {
  data: { videos: {}, notes: [] },
  query: "",
  video: "all", // "all", a videoId, or UNSORTED
  type: "all",
  sort: "newest",
  selected: new Set(),
  editingNoteId: null,
  renderWhenEditDone: false
};

const $ = (id) => document.getElementById(id);

init();

async function init() {
  $("search-input").addEventListener("input", (event) => {
    state.query = event.target.value;
    render();
  });
  $("video-filter").addEventListener("change", (event) => {
    state.video = event.target.value;
    render();
  });
  $("type-filter").addEventListener("change", (event) => {
    state.type = event.target.value;
    render();
  });
  $("sort-select").addEventListener("change", (event) => {
    state.sort = event.target.value;
    render();
  });
  $("select-all").addEventListener("change", (event) => {
    for (const note of visibleNotes()) {
      if (event.target.checked) {
        state.selected.add(note.id);
      } else {
        state.selected.delete(note.id);
      }
    }
    render();
  });
  $("copy-selected").addEventListener("click", copySelected);
  $("export-selected").addEventListener("click", exportSelected);
  $("delete-selected").addEventListener("click", deleteSelected);

  initClipPlayer();
  storage.onDataChanged(reload);
  await reload();
}

async function reload() {
  state.data = await storage.getAll();
  // Forget selections of notes that no longer exist.
  const ids = new Set(state.data.notes.map((note) => note.id));
  for (const id of state.selected) {
    if (!ids.has(id)) {
      state.selected.delete(id);
    }
  }
  if (state.editingNoteId) {
    state.renderWhenEditDone = true;
    return;
  }
  render();
}

// ---------------------------------------------------------------------------
// Filtering and sorting
// ---------------------------------------------------------------------------

function videoTitle(videoId) {
  if (!videoId) {
    return "Unsorted notes";
  }
  const video = state.data.videos[videoId];
  return video && video.title ? video.title : "Video " + videoId;
}

function isRange(note) {
  return Number.isInteger(note.endTimestampSeconds);
}

function matchesType(note) {
  switch (state.type) {
    case "all":
      return true;
    case "RANGE":
      return isRange(note);
    case "LABEL":
      return note.source === "MARKER" && QUICK_LABELS.includes(note.text);
    case "BOOKMARK":
      return note.source === "MARKER" && !isRange(note) && !QUICK_LABELS.includes(note.text);
    default:
      return note.source === state.type;
  }
}

function visibleNotes() {
  const query = state.query.trim().toLowerCase();
  const notes = state.data.notes.filter((note) => {
    if (state.video !== "all" && (note.videoId || UNSORTED) !== state.video) {
      return false;
    }
    if (!matchesType(note)) {
      return false;
    }
    if (query) {
      const haystack = (note.text + " " + videoTitle(note.videoId) + " " + (note.chapterTitle || "")).toLowerCase();
      if (!haystack.includes(query)) {
        return false;
      }
    }
    return true;
  });

  if (state.sort === "oldest") {
    return notes.sort((a, b) => a.createdAt - b.createdAt);
  }
  if (state.sort === "video") {
    // Videos most recently noted first, then each video's notes in timestamp order.
    const groups = new Map();
    for (const note of notes) {
      const key = note.videoId || UNSORTED;
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key).push(note);
    }
    const lastNoted = (key) => {
      const video = state.data.videos[key];
      return video ? video.lastNotedAt : 0;
    };
    return [...groups.keys()]
      .sort((a, b) => lastNoted(b) - lastNoted(a))
      .flatMap((key) => sortNotesByTimestamp(groups.get(key)));
  }
  return notes.sort((a, b) => b.createdAt - a.createdAt);
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

function render() {
  // Rows are rebuilt from scratch below, so any clip URLs from the last render go too.
  revokeClipUrls();
  renderVideoFilter();
  const notes = visibleNotes();
  const total = state.data.notes.length;
  $("total-count").textContent = total === 1 ? "1 note" : total + " notes";

  const list = $("rows");
  list.replaceChildren();
  const empty = $("empty");
  if (total === 0) {
    empty.textContent = "No notes yet. On a YouTube video, press Alt+N, type a note and press Enter.";
    empty.hidden = false;
  } else if (notes.length === 0) {
    empty.textContent = "No notes match these filters.";
    empty.hidden = false;
  } else {
    empty.hidden = true;
  }
  for (const note of notes) {
    list.append(buildRow(note));
  }
  renderSelectionBar(notes);
}

function renderVideoFilter() {
  const select = $("video-filter");
  const options = [["all", "All videos"]];
  const videoIds = [...new Set(state.data.notes.map((note) => note.videoId || UNSORTED))];
  videoIds.sort((a, b) => videoTitle(a === UNSORTED ? null : a).localeCompare(videoTitle(b === UNSORTED ? null : b)));
  for (const key of videoIds) {
    options.push([key, videoTitle(key === UNSORTED ? null : key)]);
  }
  if (!options.some(([value]) => value === state.video)) {
    state.video = "all";
  }
  select.replaceChildren(
    ...options.map(([value, label]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      return option;
    })
  );
  select.value = state.video;
}

function renderSelectionBar(notes) {
  const count = state.selected.size;
  const allShownSelected = notes.length > 0 && notes.every((note) => state.selected.has(note.id));
  const someShownSelected = notes.some((note) => state.selected.has(note.id));
  const selectAll = $("select-all");
  selectAll.checked = allShownSelected;
  selectAll.indeterminate = someShownSelected && !allShownSelected;
  $("selection-label").textContent = count === 0 ? "Select all shown" : count + " selected";
  for (const id of ["copy-selected", "export-selected", "delete-selected"]) {
    $(id).disabled = count === 0;
  }
}

function buildRow(note) {
  const row = el("li", "row");
  row.classList.toggle("selected", state.selected.has(note.id));

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = state.selected.has(note.id);
  checkbox.setAttribute("aria-label", "Select note");
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) {
      state.selected.add(note.id);
    } else {
      state.selected.delete(note.id);
    }
    row.classList.toggle("selected", checkbox.checked);
    renderSelectionBar(visibleNotes());
  });
  row.append(checkbox);

  // Video
  const video = el("div", "row-video");
  if (note.videoId) {
    const image = document.createElement("img");
    image.alt = "";
    image.loading = "lazy";
    const stored = state.data.videos[note.videoId];
    image.src = stored && stored.thumbnailUrl ? stored.thumbnailUrl : "https://i.ytimg.com/vi/" + note.videoId + "/mqdefault.jpg";
    video.append(image);
  }
  video.append(el("span", "", videoTitle(note.videoId)));
  row.append(video);

  // Time
  const timeCell = el("div", "row-time");
  if (note.videoId && note.timestampSeconds !== null) {
    const time = el("button", "timestamp", formatTimestampLabel(note.timestampSeconds, note.endTimestampSeconds));
    time.type = "button";
    time.title = "Open the video at this moment";
    time.addEventListener("click", () => {
      chrome.tabs.create({ url: watchUrl(note.videoId, note.timestampSeconds) });
    });
    timeCell.append(time);
  } else if (note.videoId) {
    const time = el("span", "timestamp none", "–:––");
    time.title = "No time was recorded for this note";
    timeCell.append(time);
  }
  row.append(timeCell);

  // Text
  const body = el("div", "row-body");
  if (state.editingNoteId === note.id) {
    body.append(buildEditor(note));
  } else {
    const text = el("div", "note-text");
    if (note.source === "MARKER") {
      text.append(el("span", "marker", "★ "));
    } else if (note.source === "VOICE" || note.source === "PRESENTER") {
      text.append(el("span", "source-tag", note.source === "VOICE" ? "Voice" : "Snip"));
    }
    text.append(note.text);
    body.append(text);
  }
  const meta = [new Date(note.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })];
  if (note.chapterTitle) {
    meta.push("Chapter: " + note.chapterTitle);
  }
  body.append(el("div", "row-meta", meta.join(" · ")));
  row.append(body);

  // Actions
  const actions = el("div", "row-actions");
  if (state.editingNoteId !== note.id) {
    actions.append(
      linkButton("Edit", () => {
        state.editingNoteId = note.id;
        render();
      }),
      linkButton("Delete", () => deleteNotes([note.id]))
    );
    if (note.hasAudio) {
      const playButton = el("button", "link-button clip-play", "Play");
      playButton.type = "button";
      playButton.hidden = true; // shown once setUpClipControls finds the clip
      const downloadLink = el("a", "link-button", "Download audio");
      downloadLink.hidden = true;
      actions.append(playButton, downloadLink);
      setUpClipControls(note, playButton, downloadLink);
    }
  }
  row.append(actions);
  return row;
}

function buildEditor(note) {
  const wrapper = el("div", "");
  const textarea = el("textarea", "edit-area");
  textarea.value = note.text;
  textarea.setAttribute("aria-label", "Edit note");

  const finish = async (shouldSave) => {
    if (shouldSave) {
      const text = textarea.value.trim();
      if (text !== "" && text !== note.text) {
        await storage.updateNoteText(note.id, text);
      }
    }
    state.editingNoteId = null;
    state.renderWhenEditDone = false;
    await reload();
  };

  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      finish(false);
    }
  });

  const save = el("button", "button primary", "Save");
  save.type = "button";
  save.addEventListener("click", () => finish(true));
  const cancel = el("button", "button", "Cancel");
  cancel.type = "button";
  cancel.addEventListener("click", () => finish(false));
  const buttons = el("div", "edit-buttons");
  buttons.append(save, cancel);

  wrapper.append(textarea, buttons);
  setTimeout(() => {
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, 0);
  return wrapper;
}

// ---------------------------------------------------------------------------
// Audio clips: voice notes can keep a recording of the user's voice (lib/audio-store.js).
// One shared <audio> element plays whichever clip's Play button was pressed last, so
// starting another clip always pauses the one already playing. Deleting a note here
// needs nothing extra: the service worker cleans up any clip left with no note.
// ---------------------------------------------------------------------------

const clipUrls = new Map(); // noteId -> object URL, so we can revoke it later
let currentClipNoteId = null;

function initClipPlayer() {
  const audio = $("clip-player");
  audio.addEventListener("play", updatePlayButtons);
  audio.addEventListener("pause", updatePlayButtons);
  audio.addEventListener("ended", updatePlayButtons);
}

function updatePlayButtons() {
  const audio = $("clip-player");
  const playingNoteId = !audio.paused ? currentClipNoteId : null;
  for (const button of document.querySelectorAll(".clip-play")) {
    button.textContent = button.dataset.noteId === playingNoteId ? "Pause" : "Play";
  }
}

function toggleClipPlayback(noteId, url) {
  const audio = $("clip-player");
  if (currentClipNoteId === noteId && !audio.paused) {
    audio.pause();
    return;
  }
  currentClipNoteId = noteId;
  audio.src = url;
  audio.play();
}

// Looks up a note's clip and wires up its buttons once found. Hides them quietly
// (they start hidden) if there is no clip, e.g. "Keep audio" was off when it was saved.
async function setUpClipControls(note, playButton, downloadLink) {
  const clip = await audioStore.getClip(note.id);
  if (!clip) {
    return;
  }
  const url = URL.createObjectURL(clip.blob);
  clipUrls.set(note.id, url);

  playButton.hidden = false;
  playButton.dataset.noteId = note.id;
  playButton.addEventListener("click", () => toggleClipPlayback(note.id, url));

  downloadLink.hidden = false;
  downloadLink.href = url;
  downloadLink.download = audioStore.clipFileName(note, clip);

  updatePlayButtons();
}

function revokeClipUrls() {
  const audio = $("clip-player");
  audio.pause();
  audio.removeAttribute("src");
  currentClipNoteId = null;
  for (const url of clipUrls.values()) {
    URL.revokeObjectURL(url);
  }
  clipUrls.clear();
}

// ---------------------------------------------------------------------------
// Actions on selected notes
// ---------------------------------------------------------------------------

function selectedData() {
  const notes = state.data.notes.filter((note) => state.selected.has(note.id));
  const videos = {};
  for (const note of notes) {
    if (note.videoId && state.data.videos[note.videoId]) {
      videos[note.videoId] = state.data.videos[note.videoId];
    }
  }
  return { videos, notes };
}

async function copySelected() {
  const data = selectedData();
  try {
    await navigator.clipboard.writeText(buildMarkdown(data));
    showToast(countLabel(data.notes.length) + " copied as Markdown", null);
  } catch (error) {
    showToast("Could not copy. Click on the page and try again.", null);
  }
}

function exportSelected() {
  const data = selectedData();
  const blob = new Blob([buildMarkdown(data)], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const today = new Date();
  const dateLabel =
    today.getFullYear() + "-" + String(today.getMonth() + 1).padStart(2, "0") + "-" + String(today.getDate()).padStart(2, "0");
  // A plain download link, so we don't need the "downloads" permission.
  const link = document.createElement("a");
  link.href = url;
  link.download = "kayt-notes-" + dateLabel + ".md";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function deleteSelected() {
  deleteNotes([...state.selected]);
}

async function deleteNotes(noteIds) {
  const removed = await storage.deleteNotes(noteIds);
  for (const id of noteIds) {
    state.selected.delete(id);
  }
  showToast(countLabel(removed.notes.length) + " deleted", async () => {
    await storage.restoreNotes(removed);
  });
}

function countLabel(count) {
  return count === 1 ? "1 note" : count + " notes";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let toastTimer = null;

function showToast(message, onUndo) {
  $("toast-text").textContent = message;
  const undo = $("toast-undo");
  undo.hidden = !onUndo;
  undo.onclick = async () => {
    hideToast();
    await onUndo();
  };
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, TOAST_DURATION_MS);
}

function hideToast() {
  clearTimeout(toastTimer);
  $("toast").hidden = true;
}

function linkButton(text, onClick) {
  const button = el("button", "link-button", text);
  button.type = "button";
  button.addEventListener("click", onClick);
  return button;
}

function el(tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) {
    element.className = className;
  }
  if (text) {
    element.textContent = text;
  }
  return element;
}
