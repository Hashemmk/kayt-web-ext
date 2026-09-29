// The side panel: Library (videos with notes), Video notes (one video's notes, with
// review mode), and Settings (shortcuts, look-back, export, clear all data, privacy).

import * as storage from "../lib/storage.js";
import * as audioStore from "../lib/audio-store.js";
import { buildMarkdown, buildNoteShareText, sortNotesByTimestamp } from "../lib/markdown.js";
import { obsidianFileName, obsidianNewNoteUrl, asObsidianNote } from "../lib/obsidian.js";
import { parseVideoId, watchUrl, formatTimestamp, formatTimestampLabel } from "../lib/youtube-url.js";

// Notes with no video are shown as one extra library entry under this key.
const UNSORTED = "__unsorted__";
const TOAST_DURATION_MS = 5000;
const REVIEW_INTERVAL_MS = 1000;

const state = {
  view: "library", // "library" | "video" | "settings"
  videoKey: null, // videoId, or UNSORTED, when view is "video"
  query: "",
  data: { videos: {}, notes: [] },
  editingNoteId: null,
  renderWhenEditDone: false,
  // Review mode: where the active tab's video is, when it is the video shown here.
  positionSeconds: null,
  currentNoteId: null
};

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Start-up
// ---------------------------------------------------------------------------

init();

async function init() {
  $("back-button").addEventListener("click", () => showView("library"));
  $("settings-button").addEventListener("click", () => showView("settings"));
  $("search-input").addEventListener("input", (event) => {
    state.query = event.target.value;
    renderLibrary();
  });
  $("export-button").addEventListener("click", exportAll);
  $("clear-button").addEventListener("click", () => {
    $("clear-confirm").hidden = false;
  });
  $("clear-confirm-no").addEventListener("click", () => {
    $("clear-confirm").hidden = true;
  });
  $("clear-confirm-yes").addEventListener("click", clearAllData);
  $("change-shortcut-button").addEventListener("click", () => {
    // Chrome only lets the user change shortcuts on this built-in page.
    chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
  });

  $("manage-button").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("manage/manage.html") });
  });

  showShortcuts();
  setUpLookBack();
  setUpRangeLookBack();
  setUpSnipSettings();
  setUpPageButtonSetting();
  setUpSpeechSettings();
  setUpVoiceExtras();
  setUpObsidian();
  initClipPlayer();
  showDevtoolsIfPresent();

  // Review mode reads the tab's position only while the panel is actually visible.
  document.addEventListener("visibilitychange", updateReviewTimer);

  // Keep the panel in sync with notes saved from the YouTube tab.
  storage.onDataChanged(reload);
  await reload();

  // Try again for any video whose title lookup failed earlier.
  chrome.runtime.sendMessage({ type: "refreshMissingTitles" }).catch(() => {});
}

async function reload() {
  state.data = await storage.getAll();
  if (state.editingNoteId) {
    // Don't throw away what the user is typing; redraw once they finish.
    state.renderWhenEditDone = true;
    return;
  }
  render();
}

async function showShortcuts() {
  try {
    const commands = await chrome.commands.getAll();
    const labels = {
      "open-capture": "shortcut-label",
      "voice-note": "voice-shortcut-label",
      "toggle-range": "range-shortcut-label",
      "toggle-listening": "listen-shortcut-label",
      "snip": "snip-shortcut-label"
    };
    for (const command of commands) {
      if (labels[command.name]) {
        $(labels[command.name]).textContent = command.shortcut || "not set";
      }
    }
  } catch (error) {
    // Leave the default text.
  }
}

async function setUpPageButtonSetting() {
  const checkbox = $("page-button-checkbox");
  checkbox.checked = (await storage.getSettings()).showPageButton !== false;
  checkbox.addEventListener("change", async () => {
    await storage.setSettings({ showPageButton: checkbox.checked });
  });
  // "Hide this button" on the YouTube page changes the setting while this is open.
  storage.onSettingsChanged((changed) => {
    checkbox.checked = changed.showPageButton !== false;
  });
}

// Languages offered for speech. Only those Chrome has an on-device pack for will
// work; the status line under the list says which.
const SPEECH_LANGUAGES = [
  "en-US", "en-GB", "en-AU", "en-IN", "ar-EG", "ar-SA", "ar", "fr-FR", "de-DE", "es-ES",
  "es-MX", "it-IT", "pt-BR", "nl-NL", "tr-TR", "ru-RU", "hi-IN", "ja-JP", "ko-KR", "zh-CN"
];

async function setUpSpeechSettings() {
  const select = $("speech-lang-select");
  let names = null;
  try {
    names = new Intl.DisplayNames([navigator.language], { type: "language" });
  } catch (error) {
    // Show the codes alone.
  }
  const current = (await storage.getSettings()).speechLang;
  const codes = SPEECH_LANGUAGES.includes(current) ? SPEECH_LANGUAGES : [current, ...SPEECH_LANGUAGES];
  for (const code of codes) {
    const option = document.createElement("option");
    option.value = code;
    option.textContent = names ? names.of(code) + " (" + code + ")" : code;
    select.append(option);
  }
  select.value = current;
  select.addEventListener("change", async () => {
    await storage.setSettings({ speechLang: select.value });
    checkSpeechPack();
  });
  $("speech-install-button").addEventListener("click", installSpeechPack);
  $("mic-permission-button").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("permission/permission.html") });
  });
  checkSpeechPack();
}

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

function setSpeechStatus(text, flagged) {
  const status = $("speech-lang-status");
  status.textContent = text;
  status.classList.toggle("flagged", flagged);
}

async function checkSpeechPack() {
  const lang = $("speech-lang-select").value;
  const install = $("speech-install-button");
  install.hidden = true;
  if (!SpeechRecognition || typeof SpeechRecognition.available !== "function") {
    setSpeechStatus("This Chrome can't turn speech into text on this computer. Update Chrome to use voice.", true);
    return;
  }
  try {
    const result = await SpeechRecognition.available({ langs: [lang], processLocally: true });
    if (result === "available") {
      setSpeechStatus("Ready: the speech pack is on this computer.", false);
    } else if (result === "downloadable") {
      setSpeechStatus("The speech pack isn't downloaded yet.", true);
      install.hidden = false;
    } else if (result === "downloading") {
      setSpeechStatus("Downloading the speech pack… check back in a minute.", true);
    } else {
      setSpeechStatus("Chrome has no on-device speech for this language yet. Voice won't work in it.", true);
    }
  } catch (error) {
    setSpeechStatus("Could not check: " + error.message, true);
  }
}

async function installSpeechPack() {
  const lang = $("speech-lang-select").value;
  setSpeechStatus("Downloading the speech pack… this can take a few minutes.", true);
  $("speech-install-button").hidden = true;
  try {
    const ok = await SpeechRecognition.install({ langs: [lang], processLocally: true });
    if (!ok) {
      setSpeechStatus("Chrome could not download a speech pack for this language.", true);
      return;
    }
  } catch (error) {
    setSpeechStatus("Download failed: " + error.message, true);
    return;
  }
  checkSpeechPack();
}

// The devtools/ folder exists only in the owner's copy; package.ps1 leaves it out.
async function showDevtoolsIfPresent() {
  const url = chrome.runtime.getURL("devtools/speech-test.html");
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return;
    }
  } catch (error) {
    return;
  }
  $("devtools-group").hidden = false;
  $("speech-test-button").addEventListener("click", () => chrome.tabs.create({ url }));
}

async function setUpLookBack() {
  const select = $("look-back-select");
  fillSecondsSelect(select, storage.LOOK_BACK_CHOICES, "Don't look back");
  select.value = String((await storage.getSettings()).lookBackSeconds);
  select.addEventListener("change", async () => {
    const seconds = Number(select.value);
    await storage.setSettings({ lookBackSeconds: seconds });
    showToast(
      seconds === 0
        ? "Saved. New notes point at the moment you press the shortcut."
        : "Saved. New notes point " + seconds + " seconds before you press the shortcut.",
      null
    );
  });
}

async function setUpRangeLookBack() {
  const select = $("range-look-back-select");
  fillSecondsSelect(select, storage.RANGE_LOOK_BACK_CHOICES);
  select.value = String((await storage.getSettings()).rangeLookBackSeconds);
  select.addEventListener("change", async () => {
    await storage.setSettings({ rangeLookBackSeconds: Number(select.value) });
  });
}

async function setUpSnipSettings() {
  const beforeSelect = $("snip-before-select");
  const afterSelect = $("snip-after-select");
  fillSecondsSelect(beforeSelect, storage.SNIP_BEFORE_CHOICES);
  fillSecondsSelect(afterSelect, storage.SNIP_AFTER_CHOICES);

  const settings = await storage.getSettings();
  beforeSelect.value = String(settings.snipBeforeSeconds);
  afterSelect.value = String(settings.snipAfterSeconds);
  updateSnipSummary();

  beforeSelect.addEventListener("change", () => changeSnipSeconds(beforeSelect, afterSelect, "snipBeforeSeconds"));
  afterSelect.addEventListener("change", () => changeSnipSeconds(afterSelect, beforeSelect, "snipAfterSeconds"));
}

// A Snip with nothing before and nothing after would save silence, so the pair is
// never allowed to both be zero: whichever select just changed reverts.
async function changeSnipSeconds(changedSelect, otherSelect, key) {
  if (Number(changedSelect.value) === 0 && Number(otherSelect.value) === 0) {
    changedSelect.value = String((await storage.getSettings())[key]);
    setSnipHint("A Snip needs at least one second, before or after. Kept the old value.", true);
    return;
  }
  await storage.setSettings({ [key]: Number(changedSelect.value) });
  updateSnipSummary();
}

async function updateSnipSummary() {
  const settings = await storage.getSettings();
  setSnipHint(
    "A Snip covers " + settings.snipBeforeSeconds + " s before and " + settings.snipAfterSeconds + " s after.",
    false
  );
}

function setSnipHint(text, flagged) {
  const hint = $("snip-summary");
  hint.textContent = text;
  hint.classList.toggle("flagged", flagged);
}

async function setUpVoiceExtras() {
  const keepAudio = $("keep-audio-checkbox");
  const autoStop = $("voice-auto-stop-checkbox");
  const listenTip = $("listen-tip-checkbox");
  const pauseForVoice = $("pause-for-voice-checkbox");
  const settings = await storage.getSettings();
  pauseForVoice.checked = settings.pauseForVoice !== false;
  pauseForVoice.addEventListener("change", () => storage.setSettings({ pauseForVoice: pauseForVoice.checked }));
  keepAudio.checked = settings.keepAudio !== false;
  autoStop.checked = settings.voiceAutoStop !== false;
  listenTip.checked = settings.showListenTip !== false;

  keepAudio.addEventListener("change", () => storage.setSettings({ keepAudio: keepAudio.checked }));
  autoStop.addEventListener("change", () => storage.setSettings({ voiceAutoStop: autoStop.checked }));
  listenTip.addEventListener("change", () => storage.setSettings({ showListenTip: listenTip.checked }));
}

function fillSecondsSelect(select, choices, zeroLabel) {
  for (const seconds of choices) {
    const option = document.createElement("option");
    option.value = String(seconds);
    option.textContent = seconds === 0 ? zeroLabel || "0 seconds" : seconds + " seconds";
    select.append(option);
  }
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function showView(view, videoKey) {
  if (state.view === "video" && (view !== "video" || videoKey !== state.videoKey)) {
    revokeClipUrls();
  }
  state.view = view;
  state.videoKey = videoKey || null;
  state.editingNoteId = null;
  state.positionSeconds = null;
  state.currentNoteId = null;
  $("clear-confirm").hidden = true;
  render();
  window.scrollTo(0, 0);
  updateReviewTimer();
}

function render() {
  $("library-view").hidden = state.view !== "library";
  $("video-view").hidden = state.view !== "video";
  $("settings-view").hidden = state.view !== "settings";
  $("back-button").hidden = state.view === "library";
  $("settings-button").hidden = state.view === "settings";
  // The mark stands next to "Kayt", not next to a video's title.
  $("brand-mark").hidden = state.view !== "library";

  if (state.view === "library") {
    $("view-title").textContent = "Kayt";
    renderLibrary();
  } else if (state.view === "video") {
    renderVideo();
  } else {
    $("view-title").textContent = "Settings";
  }
}

// One entry per video that has notes, plus "Unsorted notes" if any.
function buildLibraryEntries() {
  const entries = new Map();
  for (const note of state.data.notes) {
    const key = note.videoId || UNSORTED;
    if (!entries.has(key)) {
      const video = note.videoId ? state.data.videos[note.videoId] : null;
      entries.set(key, { key, video, notes: [], lastNotedAt: 0 });
    }
    const entry = entries.get(key);
    entry.notes.push(note);
    entry.lastNotedAt = Math.max(entry.lastNotedAt, note.createdAt);
  }
  for (const entry of entries.values()) {
    if (entry.video && entry.video.lastNotedAt) {
      entry.lastNotedAt = entry.video.lastNotedAt;
    }
  }
  return [...entries.values()].sort((a, b) => b.lastNotedAt - a.lastNotedAt);
}

function entryTitle(entry) {
  if (entry.key === UNSORTED) {
    return "Unsorted notes";
  }
  return entry.video && entry.video.title ? entry.video.title : "Video " + entry.key;
}

function matchesQuery(entry, query) {
  if (!query) {
    return true;
  }
  if (entryTitle(entry).toLowerCase().includes(query)) {
    return true;
  }
  return entry.notes.some((note) => note.text.toLowerCase().includes(query));
}

function renderLibrary() {
  const list = $("library-list");
  const empty = $("library-empty");
  list.replaceChildren();

  const query = state.query.trim().toLowerCase();
  const allEntries = buildLibraryEntries();
  const entries = allEntries.filter((entry) => matchesQuery(entry, query));

  if (allEntries.length === 0) {
    empty.textContent =
      "No notes yet. On a YouTube video, press " +
      $("shortcut-label").textContent +
      ", type a note and press Enter. The video keeps playing.";
    empty.hidden = false;
    return;
  }
  if (entries.length === 0) {
    empty.textContent = "No notes or titles match “" + state.query.trim() + "”.";
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  for (const entry of entries) {
    const button = el("button", "library-item");
    button.type = "button";
    button.addEventListener("click", () => showView("video", entry.key));

    button.append(buildThumbnail(entry));

    const text = el("div", "library-text");
    text.append(el("div", "library-title", entryTitle(entry)));
    const channel = entry.video && entry.video.channelName ? entry.video.channelName + " · " : "";
    const count = entry.notes.length === 1 ? "1 note" : entry.notes.length + " notes";
    text.append(el("div", "library-meta", channel + count));
    button.append(text);

    const item = document.createElement("li");
    item.append(button);
    list.append(item);
  }
}

function buildThumbnail(entry) {
  if (entry.key === UNSORTED) {
    const placeholder = el("div", "thumbnail placeholder", "✎");
    placeholder.setAttribute("aria-hidden", "true");
    return placeholder;
  }
  const image = document.createElement("img");
  image.className = "thumbnail";
  image.alt = "";
  image.loading = "lazy";
  // YouTube's standard thumbnail address works even before oEmbed has answered.
  image.src =
    entry.video && entry.video.thumbnailUrl
      ? entry.video.thumbnailUrl
      : "https://i.ytimg.com/vi/" + entry.key + "/mqdefault.jpg";
  return image;
}

function renderVideo() {
  const key = state.videoKey;
  const notes = state.data.notes.filter((note) => (note.videoId || UNSORTED) === key);

  if (notes.length === 0) {
    // Last note was deleted (or data cleared): nothing left to show here.
    showView("library");
    return;
  }

  const entry = { key, video: key === UNSORTED ? null : state.data.videos[key], notes };
  $("view-title").textContent = entryTitle(entry);

  const header = $("video-header");
  header.replaceChildren();
  if (key !== UNSORTED) {
    if (entry.video && entry.video.channelName) {
      header.append(el("div", "channel", entry.video.channelName));
    }
  } else {
    header.append(el("div", "channel", "Notes taken when no video was playing."));
  }
  const links = el("div", "header-links");
  if (key !== UNSORTED) {
    const link = el("a", "", "Open on YouTube");
    link.href = watchUrl(key);
    link.addEventListener("click", (event) => {
      event.preventDefault();
      openInActiveTab(watchUrl(key));
    });
    links.append(link);
  }
  const copyAll = el("button", "link-button", "Copy notes");
  copyAll.type = "button";
  copyAll.title = "Copy this video's notes as Markdown";
  copyAll.addEventListener("click", () => {
    const videos = entry.video ? { [key]: entry.video } : {};
    copyText(buildMarkdown({ videos, notes }), "Notes copied as Markdown");
  });
  links.append(copyAll);
  const toObsidian = el("button", "link-button", "Send to Obsidian");
  toObsidian.type = "button";
  toObsidian.title = "Create a note with these notes in your Obsidian vault";
  toObsidian.addEventListener("click", () => {
    const videos = entry.video ? { [key]: entry.video } : {};
    sendToObsidian(entryTitle(entry), buildMarkdown({ videos, notes }));
  });
  links.append(toObsidian);
  header.append(links);

  const list = $("note-list");
  list.replaceChildren();
  const sorted = key === UNSORTED ? [...notes].sort((a, b) => a.createdAt - b.createdAt) : sortNotesByTimestamp(notes);
  // A heading each time a new chapter starts, like the export.
  let previousChapter = null;
  for (const note of sorted) {
    const chapter = note.chapterTitle || null;
    if (chapter && chapter !== previousChapter) {
      list.append(el("li", "chapter-heading", chapter));
    }
    previousChapter = chapter;
    list.append(buildNoteItem(note));
  }
  applyReviewHighlight(false);
}

function buildNoteItem(note) {
  const item = el("li", "note");
  item.dataset.noteId = note.id;
  const row = el("div", "note-row");

  if (note.videoId && note.timestampSeconds !== null) {
    const label = formatTimestampLabel(note.timestampSeconds, note.endTimestampSeconds);
    const time = el("button", "timestamp", label);
    time.type = "button";
    time.title = Number.isInteger(note.endTimestampSeconds)
      ? "Jump to the start of this range"
      : "Jump to this moment";
    time.addEventListener("click", () => seek(note.videoId, note.timestampSeconds));
    row.append(time);
  } else if (note.videoId) {
    const time = el("span", "timestamp none", "–:––");
    time.title = "No time was recorded for this note";
    row.append(time);
  }

  if (state.editingNoteId === note.id) {
    row.append(buildEditor(note));
    item.append(row);
    return item;
  }

  const text = el("div", "note-text");
  if (note.source === "MARKER") {
    // The star marks a moment the user captured, so it carries the accent.
    text.append(el("span", "marker", "★ "));
  } else if (note.source === "VOICE" || note.source === "PRESENTER") {
    text.append(el("span", "source-tag", note.source === "VOICE" ? "Voice" : "Snip"));
  }
  text.append(note.text);
  row.append(text);
  item.append(row);

  const actions = el("div", "note-actions");
  if (!note.videoId) {
    actions.style.paddingLeft = "0";
  }
  const editButton = el("button", "link-button", "Edit");
  editButton.type = "button";
  editButton.addEventListener("click", () => {
    state.editingNoteId = note.id;
    renderVideo();
  });
  const copyButton = el("button", "link-button", "Copy");
  copyButton.type = "button";
  copyButton.title = "Copy this note with a link to its moment";
  copyButton.addEventListener("click", () => {
    const video = note.videoId ? state.data.videos[note.videoId] : null;
    copyText(buildNoteShareText(note, video ? video.title : ""), "Note copied");
  });
  const deleteButton = el("button", "link-button", "Delete");
  deleteButton.type = "button";
  deleteButton.addEventListener("click", () => deleteNote(note.id));
  actions.append(editButton, copyButton, deleteButton);

  if (note.hasAudio) {
    const playButton = el("button", "link-button clip-play", "Play");
    playButton.type = "button";
    playButton.hidden = true; // shown once setUpClipControls finds the clip
    const downloadLink = el("a", "link-button", "Download audio");
    downloadLink.hidden = true;
    actions.append(playButton, downloadLink);
    setUpClipControls(note, playButton, downloadLink);
  }

  item.append(actions);

  return item;
}

function buildEditor(note) {
  const wrapper = el("div", "note-text");
  const textarea = el("textarea", "edit-area");
  textarea.value = note.text;
  textarea.setAttribute("aria-label", "Edit note");

  const save = el("button", "button primary", "Save");
  save.type = "button";
  const cancel = el("button", "button", "Cancel");
  cancel.type = "button";

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

  save.addEventListener("click", () => finish(true));
  cancel.addEventListener("click", () => finish(false));
  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      finish(false);
    }
  });

  const buttons = el("div", "edit-buttons");
  buttons.append(save, cancel);
  wrapper.append(textarea, buttons);
  // Focus once it's on the page.
  setTimeout(() => {
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, 0);
  return wrapper;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function deleteNote(noteId) {
  const removed = await storage.deleteNote(noteId);
  showToast("Note deleted", async () => {
    await storage.restoreNote(removed);
  });
}

// If the active tab is already on this video, move its player there (a seek the
// user asked for). Otherwise open the video at that moment in the active tab.
async function seek(videoId, seconds) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    return;
  }
  // tab.url is only visible to us on YouTube, which is all we need.
  if (tab.url && parseVideoId(tab.url) === videoId) {
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { type: "seek", videoId, seconds });
      if (response && response.ok) {
        return;
      }
    } catch (error) {
      // The tab doesn't have our script (opened before install); fall through.
    }
  }
  await chrome.tabs.update(tab.id, { url: watchUrl(videoId, seconds) });
}

// ---------------------------------------------------------------------------
// Audio clips: voice notes can keep a recording of the user's voice (lib/audio-store.js).
// One shared <audio> element plays whichever clip's Play button was pressed last, so
// starting another clip always pauses the one already playing.
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

// Called when leaving a video's notes, so clip URLs don't pile up over a long session.
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
// Review mode: while the active tab plays the video shown here, the note the video
// has reached is highlighted. Reads the tab's position once a second, only while
// this video's notes are on screen.
// ---------------------------------------------------------------------------

let reviewTimer = null;

function updateReviewTimer() {
  const wanted =
    state.view === "video" && state.videoKey !== UNSORTED && document.visibilityState === "visible";
  if (wanted && !reviewTimer) {
    reviewTimer = setInterval(reviewTick, REVIEW_INTERVAL_MS);
    reviewTick();
  } else if (!wanted && reviewTimer) {
    clearInterval(reviewTimer);
    reviewTimer = null;
  }
}

async function reviewTick() {
  const videoKey = state.videoKey;
  let seconds = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && parseVideoId(tab.url) === videoKey) {
      const response = await chrome.tabs.sendMessage(tab.id, { type: "getPosition" });
      if (response && response.videoId === videoKey && Number.isInteger(response.seconds)) {
        seconds = response.seconds;
      }
    }
  } catch (error) {
    // The tab has no script (opened before install) or is loading: no review.
  }
  if (state.view !== "video" || state.videoKey !== videoKey) {
    return; // the user moved on while we were asking
  }
  state.positionSeconds = seconds;
  applyReviewHighlight(true);
}

// The current note is the last one whose moment the video has passed.
function applyReviewHighlight(scrollToIt) {
  const status = $("review-status");
  const seconds = state.positionSeconds;

  let current = null;
  if (seconds !== null) {
    const notes = sortNotesByTimestamp(
      state.data.notes.filter((note) => note.videoId === state.videoKey && note.timestampSeconds !== null)
    );
    for (const note of notes) {
      if (note.timestampSeconds <= seconds) {
        current = note;
      }
    }
    status.textContent = "Video is at " + formatTimestamp(seconds);
  }
  status.hidden = seconds === null;

  const changed = (current ? current.id : null) !== state.currentNoteId;
  state.currentNoteId = current ? current.id : null;
  for (const item of document.querySelectorAll("#note-list .note")) {
    item.classList.toggle("current", item.dataset.noteId === state.currentNoteId);
  }
  // Follow the video, but never pull the list away from a note being edited.
  if (scrollToIt && changed && current && !state.editingNoteId) {
    const item = document.querySelector('#note-list .note[data-note-id="' + current.id + '"]');
    if (item) {
      item.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }
}

async function copyText(text, doneMessage) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(doneMessage, null);
  } catch (error) {
    showToast("Could not copy. Click inside the panel and try again.", null);
  }
}

// The note goes to Obsidian through the clipboard (see lib/obsidian.js), then the
// obsidian:// link opens the app. Chrome asks once whether to open Obsidian.
async function sendToObsidian(title, markdown) {
  const { obsidianVault, obsidianFolder } = await storage.getSettings();
  try {
    await navigator.clipboard.writeText(asObsidianNote(markdown));
  } catch (error) {
    showToast("Could not copy the notes. Click inside the panel and try again.", null);
    return;
  }
  const link = document.createElement("a");
  link.href = obsidianNewNoteUrl({
    vault: obsidianVault,
    folder: obsidianFolder,
    fileName: obsidianFileName(title)
  });
  link.click();
  showToast("Sent to Obsidian. Nothing happened? Check Obsidian is installed and open.", null);
}

async function setUpObsidian() {
  const vault = $("obsidian-vault-input");
  const folder = $("obsidian-folder-input");
  const settings = await storage.getSettings();
  vault.value = settings.obsidianVault;
  folder.value = settings.obsidianFolder;
  vault.addEventListener("change", () => storage.setSettings({ obsidianVault: vault.value.trim() }));
  folder.addEventListener("change", () => storage.setSettings({ obsidianFolder: folder.value.trim() }));
}

async function openInActiveTab(url) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    await chrome.tabs.update(tab.id, { url });
  } else {
    await chrome.tabs.create({ url });
  }
}

async function exportAll() {
  const data = await storage.getAll();
  const markdown = buildMarkdown(data);
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const today = new Date();
  const dateLabel =
    today.getFullYear() +
    "-" +
    String(today.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(today.getDate()).padStart(2, "0");

  // A plain download link, so we don't need the "downloads" permission.
  const link = document.createElement("a");
  link.href = url;
  link.download = "kayt-export-" + dateLabel + ".md";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function clearAllData() {
  await storage.clearAll();
  await audioStore.clearAllClips();
  $("clear-confirm").hidden = true;
  state.query = "";
  $("search-input").value = "";
  showToast("All notes deleted", null);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let toastTimer = null;

function showToast(message, onUndo) {
  const toast = $("toast");
  const undo = $("toast-undo");
  $("toast-text").textContent = message;
  undo.hidden = !onUndo;
  undo.onclick = async () => {
    hideToast();
    await onUndo();
  };
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, TOAST_DURATION_MS);
}

function hideToast() {
  clearTimeout(toastTimer);
  $("toast").hidden = true;
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
