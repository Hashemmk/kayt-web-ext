// Runs on youtube.com. Reads the video ID and playback time when asked, shows the
// Kayt button, the note box, the range and listening bars, and answers the side
// panel (seek, current position).
//
// Content scripts can't use static imports, so the shared URL rules and the storage
// file (for settings and the note count) are loaded with dynamic imports as soon as
// the page starts.

let urlLib = null;
const urlLibLoading = import(chrome.runtime.getURL("lib/youtube-url.js"))
  .then((module) => {
    urlLib = module;
  })
  .catch((error) => {
    console.warn("Kayt: could not load URL rules; notes will be saved without a time.", error);
  });

// Until the settings have loaded, the same defaults as storage.js.
let settings = {
  lookBackSeconds: 10,
  rangeLookBackSeconds: 10,
  snipBeforeSeconds: 30,
  snipAfterSeconds: 0,
  voiceAutoStop: true,
  showListenTip: true,
  pauseForVoice: true,
  pagePosition: null,
  showPageButton: true
};
let storageLib = null;
const storageLoading = import(chrome.runtime.getURL("lib/storage.js"))
  .then(async (storage) => {
    storageLib = storage;
    settings = await storage.getSettings();
    storage.onSettingsChanged((changed) => {
      settings = changed;
      updatePageButton();
      queuePositionHost();
    });
    storage.onDataChanged(() => updateNoteCount());
  })
  .catch((error) => {
    console.warn("Kayt: could not load settings; using the defaults.", error);
  });

// ===========================================================================
// YouTube page reader.
// Everything that depends on YouTube's page lives in this section, so that when
// YouTube changes their site, this is the one place to fix. Every function here
// returns null instead of throwing when it can't find what it needs.
// ===========================================================================

// The video ID from the current address. Always read at the moment of capture,
// never cached: YouTube is a single-page app and the address changes without a
// page load when you click from one video to another.
async function readVideoId() {
  try {
    await urlLibLoading;
    return urlLib ? urlLib.parseVideoId(location.href) : null;
  } catch (error) {
    return null;
  }
}

// FRAGILE: depends on YouTube's page structure. YouTube marks its player's video
// with the class "html5-main-video". The page can hold other <video> elements too
// (hover previews, the miniplayer, neighbouring Shorts), so among the candidates we
// pick one that is visible, preferring one that is playing, then the largest.
function findMainVideo() {
  try {
    const mainVideos = Array.from(document.querySelectorAll("video.html5-main-video"));
    const allVideos = Array.from(document.querySelectorAll("video"));
    return pickBestVideo(mainVideos) || pickBestVideo(allVideos);
  } catch (error) {
    return null;
  }
}

// FRAGILE: depends on YouTube's page structure. The video the Kayt button sits
// on: only YouTube's own player ("html5-main-video"), never a hover preview in the
// recommendations (those live inside "ytd-video-preview" or an inline preview
// player). Unlike findMainVideo it may be off screen, so the button can hide
// instead of jumping onto another video. On Shorts, the one most in view.
function findPlayerVideo() {
  try {
    const candidates = Array.from(document.querySelectorAll("video.html5-main-video")).filter(
      (video) => !video.closest("ytd-video-preview, #inline-preview-player, #video-preview")
    );
    let best = null;
    let bestVisible = -1;
    for (const video of candidates) {
      const rect = video.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        continue;
      }
      const visibleWidth = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0));
      const visibleHeight = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
      const visible = visibleWidth * visibleHeight;
      if (visible > bestVisible) {
        best = video;
        bestVisible = visible;
      }
    }
    return best;
  } catch (error) {
    return null;
  }
}

function pickBestVideo(videos) {
  let best = null;
  let bestScore = -1;
  for (const video of videos) {
    const rect = video.getBoundingClientRect();
    const visible =
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < window.innerHeight &&
      rect.left < window.innerWidth;
    if (!visible || video.readyState === 0) {
      continue;
    }
    const area = rect.width * rect.height;
    // Playing beats paused; within each group, bigger wins.
    const score = (video.paused ? 0 : 1e9) + area;
    if (score > bestScore) {
      best = video;
      bestScore = score;
    }
  }
  return best;
}

// FRAGILE: YouTube adds the class "ad-showing" to its player while an ad plays.
// During an ad the <video> element's time is the ad's time, not the video's, so we
// report "no time" rather than a wrong one.
function isAdPlaying(video) {
  const player = video.closest(".html5-video-player");
  return Boolean(player && player.classList.contains("ad-showing"));
}

// Current playback position in whole seconds, or null.
function readCurrentSeconds() {
  try {
    const video = findMainVideo();
    if (!video || isAdPlaying(video)) {
      return null;
    }
    const seconds = video.currentTime;
    if (!Number.isFinite(seconds) || seconds < 0) {
      return null;
    }
    return Math.floor(seconds);
  } catch (error) {
    return null;
  }
}

// FRAGILE: depends on YouTube's page structure. When a video has chapters, the
// player's control bar shows the current chapter's name in an element with the class
// "ytp-chapter-title-content". It is empty or missing on videos without chapters.
// Returns the name, or null.
function readChapterTitle() {
  try {
    const video = findMainVideo();
    const player = video ? video.closest(".html5-video-player") : null;
    const title = player ? player.querySelector(".ytp-chapter-title-content") : null;
    const text = title ? title.textContent.trim() : "";
    // Anything longer is almost certainly not a chapter name.
    return text !== "" && text.length <= 120 ? text : null;
  } catch (error) {
    return null;
  }
}

// A seek the user asked for from the side panel. Returns false if this tab is not on
// that video, so the side panel can open the video's URL instead.
async function seekTo(videoId, seconds) {
  if ((await readVideoId()) !== videoId) {
    return false;
  }
  const video = findMainVideo();
  if (!video || isAdPlaying(video)) {
    return false;
  }
  video.currentTime = seconds;
  return true;
}

// Pauses the video while a voice note is spoken, if it is playing, so nothing is
// missed. Returns the video to resume afterwards, or null if it wasn't playing.
function pauseForVoice() {
  try {
    const video = findMainVideo();
    if (!video || video.paused || isAdPlaying(video)) {
      return null;
    }
    video.pause();
    return video;
  } catch (error) {
    return null;
  }
}

function resumeAfterVoice(video) {
  try {
    if (video && video.isConnected && video.paused) {
      video.play().catch(() => {});
    }
  } catch (error) {
    // The user can press play themselves.
  }
}

// FRAGILE: depends on YouTube's page events. YouTube moves between pages without
// reloading and fires "yt-navigate-finish" on the document when a new page is
// shown. We only use it to show or hide the Kayt button; the note itself always
// reads the address at the moment of capture.
function onYouTubeNavigation(callback) {
  document.addEventListener("yt-navigate-finish", callback);
  window.addEventListener("popstate", callback);
}

// FRAGILE: YouTube's control bar (play, volume, settings, fullscreen) takes about
// this much of the bottom of the video. Kayt sits just above it so it never covers
// those buttons.
const PLAYER_CONTROLS_HEIGHT = 56;

// ===========================================================================
// Kayt's own interface on the page: the Kayt button and its menu, the note box,
// the listening and range bars, and short messages.
// Drawn inside a shadow root so YouTube's CSS can't reach it and ours can't leak
// out. It is shown as a "popover", which puts it in the browser's top layer: it
// floats above the page, even in fullscreen, without being placed inside YouTube's
// own layout.
// ===========================================================================

const TOAST_DURATION_MS = 2500;
const LONG_TOAST_MS = 5000;

// One-click labels. Each saves a marker.
const QUICK_LABELS = ["Important", "Confusing", "Revisit", "Disagree"];

let host = null;
let ui = null; // references to the elements inside the shadow root
let pendingStamp = null; // from readStamp(), captured when the box opened
let isSaving = false;
let toastTimer = null;

// Voice note in progress in the box: { base } is what was typed before speaking.
let dictation = null;
let boxUsedVoice = false;

// Whether Kayt is listening to this tab's sound, and whether only because a Snip or
// range turned it on (auto: it goes off again when they are done). Listening the
// user turned on shows its own bar; automatic listening is shown on the Snip's or
// range's bar instead, so the two never look like one thing.
let listening = false;
let listeningAuto = false;

// The open range, if any: { videoId, startSeconds, chapterTitle, key,
// transcriptSince }. transcriptSince is the wall-clock time its words start from,
// or null while Kayt can't hear the tab. Lives only in this tab, and is dropped
// when the tab moves to another video.
let activeRange = null;
let rangeTimer = null;

// The Snip being taken, if any: { key, pressAt, pressSeconds, videoId, chapterTitle,
// since, until, waiting }. waiting: Kayt can't hear the tab yet (needs Alt+L).
let activeSnip = null;
let snipTimer = null;

// Keys typed into our box must never reach YouTube, or typing "k" pauses the video
// and "f" goes fullscreen. These listeners are registered at document_start, before
// any of YouTube's scripts run, on the very first stop of every key event (window,
// capture phase). So they see each key first and can stop it from going any further.
// Stopping propagation doesn't stop the key from typing into our text field.
for (const eventType of ["keydown", "keypress", "keyup"]) {
  window.addEventListener(eventType, onAnyKeyEvent, true);
}

function onAnyKeyEvent(event) {
  if (event.type === "keydown" && event.key === "Escape" && ui && !ui.menu.hidden) {
    closeMenu();
  }
  if (!host || !event.composedPath().includes(host)) {
    return;
  }
  event.stopImmediatePropagation();
  if (event.type === "keydown" && event.composedPath()[0] === ui.textarea) {
    onTextareaKeydown(event);
  }
}

function onTextareaKeydown(event) {
  if (event.isComposing) {
    return; // still choosing characters in an input method (e.g. Japanese)
  }
  // Alt+1 to Alt+4 pick a label without reaching for the mouse. event.code is the
  // physical key, so this works whatever the keyboard layout types there.
  const labelIndex = ["Digit1", "Digit2", "Digit3", "Digit4"].indexOf(event.code);
  if (event.altKey && !event.ctrlKey && !event.metaKey && labelIndex !== -1) {
    event.preventDefault();
    saveNote("label", QUICK_LABELS[labelIndex]);
  } else if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    saveNote(boxUsedVoice ? "voice" : "text");
  } else if (event.key === "Escape") {
    event.preventDefault();
    closeBox();
  }
}

// The moment a note points at: the time the shortcut was pressed, minus the
// look-back, never below zero. The time is read first, before anything can delay it.
// at is the wall-clock time of the press, used to line up the tab's transcript.
async function readStamp(lookBackSeconds = settings.lookBackSeconds) {
  const at = Date.now();
  const rawSeconds = readCurrentSeconds();
  const chapterTitle = readChapterTitle();
  const videoId = await readVideoId();
  if (!videoId) {
    return { videoId: null, seconds: null, rawSeconds: null, chapterTitle: null, at };
  }
  const seconds = rawSeconds === null ? null : Math.max(0, rawSeconds - lookBackSeconds);
  return { videoId, seconds, rawSeconds, chapterTitle, at };
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts. The user can change them at chrome://extensions/shortcuts,
// and content scripts can't read them, so the service worker is asked each time
// the menu opens. Until then, the defaults from manifest.json.
// ---------------------------------------------------------------------------

let shortcuts = {
  "open-capture": "Alt+N",
  "voice-note": "Alt+V",
  "toggle-range": "Alt+R",
  "toggle-listening": "Alt+L",
  snip: ""
};

async function refreshShortcuts() {
  try {
    shortcuts = { ...shortcuts, ...(await sendToKayt({ type: "getShortcuts" })) };
  } catch (error) {
    // Keep what we had.
  }
  updateShortcutLabels();
}

// "Alt+L", or a description when the user removed that shortcut.
function listenKey() {
  return shortcuts["toggle-listening"] || "the Listen to video shortcut (set one at chrome://extensions/shortcuts)";
}

// " (Alt+V)" for a button's tooltip, or nothing if there is no shortcut.
function keyHint(command) {
  return shortcuts[command] ? " (" + shortcuts[command] + ")" : "";
}

function updateShortcutLabels() {
  if (!ui) {
    return;
  }
  for (const [command, kbd] of Object.entries(ui.menuKeys)) {
    kbd.textContent = shortcuts[command] || "";
    kbd.hidden = !shortcuts[command];
  }
  ui.voiceButton.title = "Speak your note" + keyHint("voice-note");
  ui.dictationStop.title = "Stop speaking and save the note" + keyHint("voice-note");
  ui.rangeButton.title = "Mark where an explanation starts; end it to save the whole stretch" + keyHint("toggle-range");
  ui.endButton.title = "Save the range" + keyHint("toggle-range");
  ui.snipButton.title = "Save what the video says around this moment (set the seconds in Settings)" + keyHint("snip");
}

// ---------------------------------------------------------------------------
// The note box
// ---------------------------------------------------------------------------

async function openCapture({ voice } = {}) {
  const stamp = await readStamp();

  ensureUi();
  closeMenu();

  if (ui.box.hidden) {
    pendingStamp = stamp;
    ui.stamp.textContent = describeStamp(pendingStamp);
    // Jade is only for a moment we actually captured; anything else is flagged.
    ui.stamp.classList.toggle("flagged", pendingStamp.seconds === null);
    ui.textarea.value = "";
    ui.error.hidden = true;
    boxUsedVoice = false;
    updateBoxButtons();
    resizeTextarea();
    hideToast();
    ui.box.hidden = false;
    showHost();
  }
  // Already open: keep the original stamp, just bring the cursor back.
  ui.textarea.focus();

  if (voice) {
    if (dictation) {
      stopDictation();
    } else {
      startDictation();
    }
  }
}

function describeStamp({ videoId, seconds }) {
  if (!videoId) {
    return "No video found — note will be saved without a time";
  }
  if (seconds === null) {
    return "Note on this video (time not available)";
  }
  return "Note at " + urlLib.formatTimestamp(seconds);
}

function closeBox() {
  if (!ui) {
    return;
  }
  if (dictation) {
    cancelDictation();
  }
  ui.box.hidden = true;
  ui.textarea.blur();
  pendingStamp = null;
  hideHostIfEmpty();
}

// kind is "text", "voice" or "label" (then label says which one).
async function saveNote(kind, label) {
  if (isSaving || !pendingStamp) {
    return;
  }
  if (dictation) {
    // Save what is in the box now; don't wait for the microphone to finish.
    cancelDictation();
  }
  isSaving = true;
  try {
    const note = await sendToKayt({
      type: "saveNote",
      kind,
      label,
      videoId: pendingStamp.videoId,
      timestampSeconds: pendingStamp.seconds,
      chapterTitle: pendingStamp.chapterTitle,
      text: ui.textarea.value
    });
    closeBox();
    showSavedToast(note);
  } catch (error) {
    // Keep the text in the box so the note is never lost.
    console.error("Kayt: could not save the note.", error);
    showBoxError(
      "Could not save. Copy your note, refresh this page and try again " +
        "(this happens after the extension is updated)."
    );
  } finally {
    isSaving = false;
  }
}

// Sends a message to the service worker and returns its result, or throws.
async function sendToKayt(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response || !response.ok) {
    const error = new Error(response ? response.error : "Kayt did not answer. Refresh this page and try again.");
    error.code = response ? response.code : "";
    throw error;
  }
  return response.result;
}

function showBoxError(text) {
  ui.error.textContent = text;
  ui.error.hidden = false;
}

function updateBoxButtons() {
  if (!ui) {
    return;
  }
  ui.voiceButton.textContent = dictation ? "Stop" : "Voice";
  ui.voiceButton.classList.toggle("active", Boolean(dictation));
  ui.rangeButton.textContent = activeRange ? "End range" : "Start range";
}

// ---------------------------------------------------------------------------
// Voice notes: the microphone is turned into text on this computer by Kayt's
// hidden listener page. The words appear in the box as they are recognised, and
// the note saves itself after a short pause.
// ---------------------------------------------------------------------------

// The video paused for the voice note being spoken, to play again when it ends.
let videoPausedForVoice = null;

async function startDictation() {
  ensureUi();
  ui.error.hidden = true;
  dictation = { base: ui.textarea.value, waitingForMic: false };
  boxUsedVoice = true;
  ui.dictationText.textContent =
    settings.voiceAutoStop === false
      ? "Listening… speak now. Press Stop" + keyHint("voice-note").replace(" (", " (or ") + " when you're done."
      : "Listening… speak now. It saves itself when you pause, or press Stop.";
  ui.dictationStatus.hidden = false;
  updateBoxButtons();
  // Paused while speaking (Settings can turn this off); it plays on afterwards.
  if (settings.pauseForVoice !== false && !videoPausedForVoice) {
    videoPausedForVoice = pauseForVoice();
  }
  try {
    await sendToKayt({ type: "startDictation" });
  } catch (error) {
    if (error.code === "asking-permission" && dictation) {
      // Chrome is asking in a small Kayt window; the note starts by itself once
      // the microphone is allowed.
      dictation.waitingForMic = true;
      ui.dictationText.textContent = "Allow the microphone in the small Kayt window. Your voice note starts right after.";
      return;
    }
    dictation = null;
    ui.dictationStatus.hidden = true;
    updateBoxButtons();
    showBoxError(error.message);
    endVoicePause();
  }
}

function endVoicePause() {
  resumeAfterVoice(videoPausedForVoice);
  videoPausedForVoice = null;
}

// Stop listening and save what was heard.
function stopDictation() {
  if (dictation && dictation.waitingForMic) {
    cancelDictation();
    return;
  }
  chrome.runtime.sendMessage({ type: "stopDictation" }).catch(() => {});
}

// Stop listening and keep the box as it is.
function cancelDictation() {
  dictation = null;
  chrome.runtime.sendMessage({ type: "cancelDictation" }).catch(() => {});
  if (ui) {
    ui.dictationStatus.hidden = true;
    updateBoxButtons();
  }
  endVoicePause();
}

function onDictationUpdate(text) {
  if (!dictation || ui.box.hidden) {
    return;
  }
  if (dictation.waitingForMic) {
    // The microphone was allowed and the note has started.
    dictation.waitingForMic = false;
    ui.dictationText.textContent = "Listening… speak now.";
  }
  ui.textarea.value = joinText(dictation.base, text);
  resizeTextarea();
}

function onDictationEnded(text, error) {
  if (!dictation) {
    return;
  }
  const base = dictation.base;
  dictation = null;
  ui.dictationStatus.hidden = true;
  updateBoxButtons();
  endVoicePause();
  if (text) {
    ui.textarea.value = joinText(base, text);
    saveNote("voice");
  } else if (error) {
    showBoxError(error);
  } else {
    showBoxError("Nothing was heard. Click Voice to try again, or type your note.");
  }
}

function joinText(first, second) {
  const a = (first || "").trim();
  const b = (second || "").trim();
  return a && b ? a + " " + b : a || b;
}

// ---------------------------------------------------------------------------
// Listening to the video. The user can turn it on (Alt+L, "Listen to video") so
// Kayt always has the last couple of minutes ready for a Snip or a range's
// look-back. A Snip or range also turns it on by itself when needed, and that
// automatic listening goes off again once they are done.
// ---------------------------------------------------------------------------

async function toggleListeningFromPage() {
  closeMenu();
  try {
    await sendToKayt({ type: "toggleListening" });
  } catch (error) {
    showMessage(error.message, { flagged: true, long: true });
  }
}

// heldKeys: Snips or ranges that were waiting for Alt+L and are now heard from
// `since` on.
function onListeningState(on, error, auto, heldKeys, since) {
  ensureUi();
  const wasListening = listening;
  const wasUsers = listening && !listeningAuto;
  listening = on;
  listeningAuto = on && Boolean(auto);
  ui.listen.hidden = !on || listeningAuto;
  updateBoxButtons();
  if (on) {
    showHost();
  } else {
    hideHostIfEmpty();
  }

  const held = heldKeys || [];
  if (on && activeSnip && activeSnip.waiting && held.includes(activeSnip.key)) {
    beginSnipWindow(since, true);
  }
  if (on && activeRange && held.includes(activeRange.key)) {
    activeRange.transcriptSince = since;
    showListenTip("range");
  } else if (on && !listeningAuto && activeRange && activeRange.transcriptSince === null) {
    // Listening was just turned on while a range is open: its words start now.
    askToTranscribeRange(activeRange, Date.now());
  }
  updateRangeBar();

  if (error) {
    showMessage(error, { flagged: true, long: true });
  } else if (on && !listeningAuto && !wasUsers) {
    showMessage("Listening to this video. Its words stay on this computer.", { flagged: false });
  } else if (!on && wasListening && !auto) {
    showMessage("Stopped listening. What was heard has been wiped.", { flagged: false });
  }
}

// Shown when a Snip or range had to turn listening on itself, because then it
// couldn't hear anything from before the press. Stays until closed.
function showListenTip(kind) {
  if (settings.showListenTip === false) {
    return;
  }
  ensureUi();
  let text;
  if (kind === "snip") {
    const total = settings.snipBeforeSeconds + settings.snipAfterSeconds;
    text =
      "Kayt wasn't listening before your Snip, so it couldn't hear the " +
      settings.snipBeforeSeconds +
      " seconds before it. This Snip records the next " +
      total +
      " seconds instead.";
  } else {
    text =
      "Kayt wasn't listening before this range started, so its words start now, not " +
      settings.rangeLookBackSeconds +
      " seconds back.";
  }
  ui.tipText.textContent =
    text +
    " Kayt can only transcribe while it is listening. To reach back next time, turn on Listen to video" +
    " (" + listenKey() + ") first. Listening turned on by a Snip or range stops again when it is done.";
  ui.tip.hidden = false;
  showHost();
}

function closeListenTip() {
  ui.tip.hidden = true;
  hideHostIfEmpty();
}

async function neverShowListenTip() {
  closeListenTip();
  settings = { ...settings, showListenTip: false };
  try {
    await storageLib.setSettings({ showListenTip: false });
  } catch (error) {
    // Only hidden on this page; it will show again after a reload.
  }
}

// ---------------------------------------------------------------------------
// Snip: saves what the video said around this moment, as set in Settings
// (seconds before and after). If Kayt was already listening it reaches back; if
// not, it starts listening now and records the same length from here on.
// ---------------------------------------------------------------------------

async function snip() {
  closeMenu();
  ensureUi();
  if (activeSnip) {
    showMessage("A Snip is already being taken", { flagged: true });
    return;
  }
  const pressAt = Date.now();
  const pressSeconds = readCurrentSeconds();
  const chapterTitle = readChapterTitle();
  const videoId = await readVideoId();
  const snipState = {
    key: "snip:" + pressAt,
    pressAt,
    pressSeconds,
    videoId,
    chapterTitle,
    since: null,
    until: null,
    waiting: false
  };
  activeSnip = snipState;
  ui.snipText.textContent = "Snip · starting…";
  ui.snip.hidden = false;
  showHost();

  let result;
  try {
    result = await sendToKayt({
      type: "needListening",
      key: snipState.key,
      since: pressAt - settings.snipBeforeSeconds * 1000
    });
  } catch (error) {
    stopSnip({ release: false });
    showMessage(error.message, { flagged: true });
    return;
  }
  if (activeSnip !== snipState) {
    return; // cancelled meanwhile
  }
  if (result.listening) {
    beginSnipWindow(result.since, result.startedNow);
  } else {
    // Chrome wants a shortcut before Kayt may hear the tab. The Snip waits, and
    // starts by itself as soon as Alt+L is pressed.
    snipState.waiting = true;
    ui.snipText.textContent = "Snip waiting — press " + listenKey() + " to let Kayt hear this video";
    showMessage(
      "Chrome needs one keypress before Kayt can hear this tab: press " +
        listenKey() +
        ". Your Snip starts as soon as you do.",
      { flagged: true, long: true }
    );
  }
}

// startedNow: listening only began at `since`, so nothing before it was heard;
// the Snip then covers its whole length from there.
function beginSnipWindow(since, startedNow) {
  if (!activeSnip) {
    return;
  }
  const lengthMs = (settings.snipBeforeSeconds + settings.snipAfterSeconds) * 1000;
  activeSnip.waiting = false;
  activeSnip.since = since;
  activeSnip.until = startedNow ? since + lengthMs : activeSnip.pressAt + settings.snipAfterSeconds * 1000;
  if (startedNow) {
    showListenTip("snip");
  }
  // A second timer on the page, only while a Snip waits for its "after" seconds:
  // the bar counts down, and moving to another video drops the Snip.
  clearInterval(snipTimer);
  snipTimer = setInterval(tickSnip, 500);
  tickSnip();
}

async function tickSnip() {
  const snipState = activeSnip;
  if (!snipState || snipState.until === null) {
    return;
  }
  if ((await readVideoId()) !== snipState.videoId) {
    stopSnip({ release: true });
    showMessage("Snip dropped — you moved to another video", { flagged: true });
    return;
  }
  const left = Math.ceil((snipState.until - Date.now()) / 1000);
  if (left > 0) {
    ui.snipText.textContent = "Snip · recording, " + urlLib.formatTimestamp(left) + " left";
    return;
  }
  if (snipState.saving) {
    return;
  }
  snipState.saving = true;
  clearInterval(snipTimer);
  ui.snipText.textContent = "Snip · saving…";
  try {
    const note = await sendToKayt({
      type: "saveSnip",
      key: snipState.key,
      since: snipState.since,
      until: snipState.until,
      pressAt: snipState.pressAt,
      pressSeconds: snipState.pressSeconds,
      videoId: snipState.videoId,
      chapterTitle: snipState.chapterTitle
    });
    stopSnip({ release: false });
    showSavedToast(note, "Snip saved");
  } catch (error) {
    stopSnip({ release: false }); // saveSnip releases listening itself
    showMessage(error.message, { flagged: true, long: true });
  }
}

// release: tell Kayt the Snip no longer needs listening (not needed after a save).
function stopSnip({ release }) {
  if (activeSnip && release) {
    chrome.runtime.sendMessage({ type: "releaseListening", key: activeSnip.key }).catch(() => {});
  }
  activeSnip = null;
  clearInterval(snipTimer);
  snipTimer = null;
  if (ui) {
    ui.snip.hidden = true;
    hideHostIfEmpty();
  }
}

// ---------------------------------------------------------------------------
// Ranges: the first press marks where an explanation starts (the range look-back
// before it), the second saves one note covering the whole stretch. The range's
// words and sound fill the note a couple of seconds after End. If Kayt wasn't
// listening, the first press turns listening on, so the words start there.
// ---------------------------------------------------------------------------

async function toggleRange() {
  closeMenu();
  if (activeRange) {
    await endRange();
  } else {
    startRange(await readStamp(settings.rangeLookBackSeconds));
  }
}

// stamp is the start, with the range look-back applied, from readStamp().
function startRange(stamp) {
  ensureUi();
  if (!stamp.videoId || stamp.seconds === null) {
    showMessage("No video time found, so a range can't start here", { flagged: true });
    return;
  }
  // The wall-clock moment the range starts, look-back included, to line up the
  // tab's words with it.
  const lookedBack = stamp.rawSeconds === null ? 0 : stamp.rawSeconds - stamp.seconds;
  const since = stamp.at - lookedBack * 1000;
  activeRange = {
    videoId: stamp.videoId,
    startSeconds: stamp.seconds,
    chapterTitle: stamp.chapterTitle,
    key: "range:" + stamp.at,
    transcriptSince: null
  };
  askToTranscribeRange(activeRange, since);
  ui.rangeStart.textContent = urlLib.formatTimestamp(stamp.seconds);
  ui.rangeElapsed.textContent = "0:00";
  ui.range.hidden = false;
  updateRangeBar();
  showHost();
  updateBoxButtons();
  updatePageButton();
  // The one place we read the player on a timer, and only while a range is open:
  // the bar counts up so the range can't be forgotten, and moving to another video
  // drops the range.
  clearInterval(rangeTimer);
  rangeTimer = setInterval(tickRange, 1000);
  tickRange();
}

// Kayt keeps the tab's words from `since` for the range, turning listening on if
// it was off. Chrome only allows that after a shortcut, so after a click the range
// waits for Alt+L.
async function askToTranscribeRange(range, since) {
  let result;
  try {
    result = await sendToKayt({ type: "needListening", key: range.key, since });
  } catch (error) {
    return; // the range still works; it just won't get words
  }
  if (activeRange !== range) {
    return;
  }
  if (result.listening) {
    range.transcriptSince = result.since;
    if (result.startedNow) {
      showListenTip("range");
    }
  } else if (result.needsShortcut) {
    showMessage(
      "Range started. To transcribe it, press " +
        listenKey() +
        ": Chrome needs one keypress before Kayt can hear this tab.",
      { flagged: true, long: true }
    );
  }
  updateRangeBar();
}

function updateRangeBar() {
  if (ui) {
    ui.rangeListening.textContent =
      activeRange && activeRange.transcriptSince !== null && listening ? " · transcribing" : "";
  }
}

async function tickRange() {
  if (!activeRange) {
    return;
  }
  const videoId = await readVideoId();
  if (!activeRange) {
    return; // ended while we were reading
  }
  if (videoId !== activeRange.videoId) {
    dropRange("Range dropped — you moved to another video");
    return;
  }
  const seconds = readCurrentSeconds();
  if (seconds !== null) {
    const length = Math.max(0, seconds - activeRange.startSeconds);
    ui.rangeElapsed.textContent = urlLib.formatTimestamp(length);
  }
}

async function endRange() {
  if (!activeRange || isSaving) {
    return;
  }
  const range = activeRange;
  // The end is not moved back: it is where the explanation finished.
  const until = Date.now();
  const endSeconds = readCurrentSeconds();
  const videoId = await readVideoId();
  if (videoId !== range.videoId) {
    dropRange("Range dropped — you moved to another video");
    return;
  }
  const transcribing = range.transcriptSince !== null && listening;
  isSaving = true;
  try {
    const note = await sendToKayt({
      type: "saveNote",
      kind: "range",
      videoId: range.videoId,
      timestampSeconds: range.startSeconds,
      endTimestampSeconds: endSeconds,
      chapterTitle: range.chapterTitle,
      key: range.key,
      since: range.transcriptSince,
      until
    });
    stopRange({ tellKayt: false });
    showSavedToast(note, "Saved", transcribing ? " · transcript coming" : "");
  } catch (error) {
    // Leave the range open so the user can try again.
    console.error("Kayt: could not save the range.", error);
    showMessage("Could not save the range. Refresh this page and try again", { flagged: true });
  } finally {
    isSaving = false;
  }
}

function dropRange(message) {
  stopRange({ tellKayt: true });
  showMessage(message, { flagged: true });
}

// tellKayt: let the listener stop keeping the range's words (not needed after a
// save, which does that itself once the transcript is taken).
function stopRange({ tellKayt }) {
  if (activeRange && tellKayt) {
    chrome.runtime.sendMessage({ type: "releaseListening", key: activeRange.key }).catch(() => {});
  }
  activeRange = null;
  clearInterval(rangeTimer);
  rangeTimer = null;
  if (ui) {
    ui.range.hidden = true;
    updateBoxButtons();
    updatePageButton();
    hideHostIfEmpty();
  }
}

// The box's range button starts a range from the moment the box opened, or ends one.
function onRangeButton() {
  if (activeRange) {
    closeBox();
    endRange();
    return;
  }
  const stamp = pendingStamp;
  closeBox();
  if (stamp) {
    // The box's stamp used the notes' look-back; a range uses its own.
    const seconds =
      stamp.rawSeconds === null ? null : Math.max(0, stamp.rawSeconds - settings.rangeLookBackSeconds);
    startRange({ ...stamp, seconds });
  }
}

// ---------------------------------------------------------------------------
// The Kayt button and its menu. Shown on video pages only; floats above the page
// like everything else here, never inside YouTube's layout.
// ---------------------------------------------------------------------------

async function updatePageButton() {
  const videoId = await readVideoId();
  const show = Boolean(videoId) && settings.showPageButton !== false;
  if (!show && !ui) {
    return;
  }
  ensureUi();
  ui.fab.hidden = !show;
  // Saffron while something is waiting on the user (an open range).
  ui.fab.classList.toggle("flagged", Boolean(activeRange));
  if (!show) {
    closeMenu();
    hideHostIfEmpty();
  } else {
    showHost();
    updateNoteCount();
  }
}

async function updateNoteCount() {
  if (!ui || ui.fab.hidden || !storageLib) {
    return;
  }
  const videoId = await readVideoId();
  let count = 0;
  try {
    const { notes } = await storageLib.getAll();
    count = notes.filter((note) => note.videoId === videoId).length;
  } catch (error) {
    // Leave the badge empty.
  }
  ui.badge.textContent = count > 99 ? "99+" : String(count);
  ui.badge.hidden = count === 0;
  ui.fab.title = count === 1 ? "Kayt — 1 note on this video" : "Kayt — " + count + " notes on this video";
}

function toggleMenu() {
  if (!ui.menu.hidden) {
    closeMenu();
    return;
  }
  ui.menuRange.firstChild.textContent = activeRange ? "End range" : "Start range";
  // Listening a Snip or range turned on is theirs; the menu only offers to stop
  // listening the user turned on.
  ui.menuListen.firstChild.textContent = listening && !listeningAuto ? "Stop listening" : "Listen to video";
  ui.menuVoice.firstChild.textContent = dictation ? "Stop voice note" : "Voice note";
  ui.menuResetPosition.hidden = !settings.pagePosition;
  updateShortcutLabels();
  refreshShortcuts();
  ui.menu.hidden = false;
  ui.fab.setAttribute("aria-expanded", "true");
  showHost();
}

function closeMenu() {
  if (!ui || ui.menu.hidden) {
    return;
  }
  ui.menu.hidden = true;
  ui.fab.setAttribute("aria-expanded", "false");
}

// A click anywhere outside Kayt closes the menu.
window.addEventListener(
  "pointerdown",
  (event) => {
    if (ui && !ui.menu.hidden && !event.composedPath().includes(host)) {
      closeMenu();
    }
  },
  true
);

// Hiding turns the setting off, so the Settings checkbox always shows the truth and
// ticking it brings the button back straight away, on every YouTube tab.
async function hidePageButton() {
  closeMenu();
  settings = { ...settings, showPageButton: false };
  updatePageButton();
  try {
    await storageLib.setSettings({ showPageButton: false });
  } catch (error) {
    console.warn("Kayt: could not save the setting; the button is hidden on this page only.", error);
  }
  showMessage(
    "Kayt button hidden. To bring it back: Kayt toolbar icon → Settings → Kayt button on YouTube." +
      (shortcuts["open-capture"] ? " " + shortcuts["open-capture"] + " still works." : ""),
    { flagged: false, long: true }
  );
}

// ---------------------------------------------------------------------------
// Messages under the box
// ---------------------------------------------------------------------------

function showSavedToast(note, prefix, suffix) {
  ensureUi();
  ui.toastText.replaceChildren(prefix || "Saved");
  ui.toast.classList.remove("flagged");
  if (note.timestampSeconds !== null) {
    const label = urlLib.formatTimestampLabel(note.timestampSeconds, note.endTimestampSeconds);
    ui.toastText.append(" at ", el("span", "time", label));
  }
  if (suffix) {
    ui.toastText.append(suffix);
  }
  ui.undo.hidden = false;
  ui.undo.onclick = () => undoSave(note.id);
  showToastNow(TOAST_DURATION_MS);
}

// A message with no Undo. Flagged (saffron) when something needs attention.
function showMessage(text, { flagged, long }) {
  ensureUi();
  ui.toastText.textContent = text;
  ui.toast.classList.toggle("flagged", Boolean(flagged));
  ui.undo.hidden = true;
  showToastNow(long ? LONG_TOAST_MS : TOAST_DURATION_MS);
}

function showToastNow(duration) {
  ui.toast.hidden = false;
  showHost();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, duration);
}

async function undoSave(noteId) {
  clearTimeout(toastTimer);
  ui.undo.hidden = true;
  try {
    await chrome.runtime.sendMessage({ type: "undoSave", noteId });
    ui.toastText.textContent = "Note removed";
  } catch (error) {
    ui.toastText.textContent = "Could not undo — delete it from the notes panel";
  }
  toastTimer = setTimeout(hideToast, TOAST_DURATION_MS);
}

function hideToast() {
  if (!ui) {
    return;
  }
  clearTimeout(toastTimer);
  ui.toast.hidden = true;
  hideHostIfEmpty();
}

function showHost() {
  if (!host.isConnected) {
    document.documentElement.appendChild(host);
  }
  positionHost();
  // Re-showing puts us back on top, e.g. after the video went fullscreen.
  try {
    if (host.matches(":popover-open")) {
      host.hidePopover();
    }
    host.showPopover();
  } catch (error) {
    // Popover not available: the fixed positioning below still floats the box.
  }
}

// The Kayt button floats over the video: at first in its bottom-right corner, just
// above the player's controls, or wherever the user dragged it (kept in Settings as
// a fraction of the video's width and height, so it stays put in theatre mode and
// fullscreen). It is never put inside the player: it only follows where the video
// is on screen. When the video is scrolled out of view the button hides, so it
// never sits over other videos; open bars and messages go to the window corner.
const PAGE_CORNER = { right: 20, bottom: 72 };
const VIDEO_INSET = 12;
const FAB_SIZE = 44;
let positionQueued = false;
let observedVideo = null;
let dragPosition = null; // { x, y } while the button is being dragged
const videoResizeObserver = new ResizeObserver(() => queuePositionHost());

// Where the button's centre goes, in window pixels, or null if that spot on the
// video isn't on screen.
function fabCentre(rect) {
  const position = dragPosition || settings.pagePosition;
  let x;
  let y;
  if (position && Number.isFinite(position.x) && Number.isFinite(position.y)) {
    x = rect.left + position.x * rect.width;
    y = rect.top + position.y * rect.height;
  } else {
    x = rect.right - VIDEO_INSET - FAB_SIZE / 2;
    y = rect.bottom - PLAYER_CONTROLS_HEIGHT - FAB_SIZE / 2;
  }
  const margin = FAB_SIZE / 2 + 4;
  const onScreen =
    x >= margin && x <= window.innerWidth - margin && y >= margin && y <= window.innerHeight - margin;
  return onScreen ? { x, y } : null;
}

function positionHost() {
  if (!host) {
    return;
  }
  let centre = null;
  try {
    const video = findPlayerVideo();
    if (video !== observedVideo) {
      // Theatre mode, the window size or the video changing all resize it.
      videoResizeObserver.disconnect();
      if (video) {
        videoResizeObserver.observe(video);
      }
      observedVideo = video;
    }
    const rect = video ? video.getBoundingClientRect() : null;
    if (rect && rect.width >= 200 && rect.height >= 120) {
      centre = fabCentre(rect);
    }
  } catch (error) {
    // Treated as no video on screen.
  }

  if (ui) {
    ui.fab.classList.toggle("away", !centre);
    if (!centre) {
      closeMenu();
    }
  }
  if (!centre) {
    host.dataset.h = "right";
    host.dataset.v = "bottom";
    host.style.setProperty("inset", "auto " + PAGE_CORNER.right + "px " + PAGE_CORNER.bottom + "px auto", "important");
    return;
  }
  // Everything opens towards the middle of the window, so the box and menu fit
  // wherever the button is.
  const half = FAB_SIZE / 2;
  const onRight = centre.x > window.innerWidth / 2;
  const onBottom = centre.y > window.innerHeight / 2;
  host.dataset.h = onRight ? "right" : "left";
  host.dataset.v = onBottom ? "bottom" : "top";
  const top = onBottom ? "auto" : centre.y - half + "px";
  const right = onRight ? window.innerWidth - centre.x - half + "px" : "auto";
  const bottom = onBottom ? window.innerHeight - centre.y - half + "px" : "auto";
  const left = onRight ? "auto" : centre.x - half + "px";
  host.style.setProperty("inset", [top, right, bottom, left].join(" "), "important");
}

// Dragging the Kayt button moves it (and everything that opens from it) over the
// video. A press that doesn't move is a normal click and opens the menu.
let drag = null; // { pointerId, startX, startY, moved }
let ignoreNextClick = false;

function onFabPointerDown(event) {
  if (event.button !== 0) {
    return;
  }
  drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false };
  ui.fab.setPointerCapture(event.pointerId);
}

function onFabPointerMove(event) {
  if (!drag || event.pointerId !== drag.pointerId) {
    return;
  }
  if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) {
    return;
  }
  drag.moved = true;
  closeMenu();
  const video = findPlayerVideo();
  const rect = video ? video.getBoundingClientRect() : null;
  if (!rect || rect.width === 0 || rect.height === 0) {
    return;
  }
  // Kept fully on the video.
  const margin = FAB_SIZE / 2 + 4;
  const x = Math.min(Math.max(event.clientX, rect.left + margin), rect.right - margin);
  const y = Math.min(Math.max(event.clientY, rect.top + margin), rect.bottom - margin);
  dragPosition = { x: (x - rect.left) / rect.width, y: (y - rect.top) / rect.height };
  ui.fab.classList.add("dragging");
  positionHost();
}

async function onFabPointerUp(event) {
  if (!drag || event.pointerId !== drag.pointerId) {
    return;
  }
  const moved = drag.moved;
  drag = null;
  ui.fab.classList.remove("dragging");
  if (!moved || !dragPosition) {
    return;
  }
  ignoreNextClick = true;
  const position = dragPosition;
  dragPosition = null;
  settings = { ...settings, pagePosition: position };
  positionHost();
  try {
    await storageLib.setSettings({ pagePosition: position });
  } catch (error) {
    // Only moved on this page.
  }
}

function onFabClick() {
  if (ignoreNextClick) {
    ignoreNextClick = false;
    return;
  }
  toggleMenu();
}

async function resetPagePosition() {
  closeMenu();
  settings = { ...settings, pagePosition: null };
  positionHost();
  try {
    await storageLib.setSettings({ pagePosition: null });
  } catch (error) {
    // Only moved back on this page.
  }
}

// Scrolling fires many events; move at most once per frame.
function queuePositionHost() {
  if (positionQueued || !host || !host.isConnected) {
    return;
  }
  positionQueued = true;
  requestAnimationFrame(() => {
    positionQueued = false;
    positionHost();
  });
}

window.addEventListener("scroll", queuePositionHost, { passive: true, capture: true });
window.addEventListener("resize", queuePositionHost);
document.addEventListener("fullscreenchange", queuePositionHost);
// After moving to another video, its player isn't ready at first; move once it is.
// Media events don't bubble, so they are caught on the way down.
document.addEventListener("loadedmetadata", queuePositionHost, true);
document.addEventListener("play", queuePositionHost, true);

function hideHostIfEmpty() {
  if (!ui) {
    return;
  }
  const parts = [ui.tip, ui.box, ui.listen, ui.range, ui.snip, ui.toast, ui.menu, ui.fab];
  if (parts.some((part) => !part.hidden)) {
    return;
  }
  try {
    if (host.matches(":popover-open")) {
      host.hidePopover();
    }
  } catch (error) {
    // ignore
  }
  host.remove();
}

// A fullscreen video goes on top of everything shown before it; show Kayt again
// so it stays above.
document.addEventListener("fullscreenchange", () => {
  if (host && host.isConnected) {
    showHost();
  }
});

function resizeTextarea() {
  ui.textarea.style.height = "auto";
  ui.textarea.style.height = Math.min(ui.textarea.scrollHeight, 160) + "px";
}

// ---------------------------------------------------------------------------
// Building the interface, once. Uses createElement rather than innerHTML because
// YouTube enforces Trusted Types, which rejects innerHTML.
// ---------------------------------------------------------------------------

function ensureUi() {
  if (ui) {
    return;
  }

  host = document.createElement("kayt-capture");
  host.setAttribute("popover", "manual");
  // Neutralise anything YouTube's CSS or the popover defaults might apply to us.
  // Kept clear of the bottom edge so a fullscreen player's own buttons stay free.
  const hostStyles = {
    position: "fixed",
    inset: "auto " + PAGE_CORNER.right + "px " + PAGE_CORNER.bottom + "px auto",
    margin: "0",
    padding: "0",
    border: "0",
    background: "transparent",
    overflow: "visible",
    width: "auto",
    height: "auto",
    "max-width": "none",
    "max-height": "none",
    "z-index": "2147483647",
    color: "inherit"
  };
  for (const [property, value] of Object.entries(hostStyles)) {
    host.style.setProperty(property, value, "important");
  }

  const shadow = host.attachShadow({ mode: "open" });
  loadStyles(shadow);

  // Clicking our buttons must not take the keyboard away from where it was:
  // otherwise, after a click on the Kayt button, space and "k" would stop reaching
  // YouTube, and a click on a label would take the cursor out of the note.
  shadow.addEventListener("mousedown", (event) => {
    if (event.target.closest && event.target.closest("button")) {
      event.preventDefault();
    }
  });

  const wrapper = el("div", "wrapper");

  // --- The note box
  const box = el("div", "box");
  box.hidden = true;
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", "Add a note");

  const header = el("div", "header");
  const stamp = el("span", "stamp");
  const panelButton = button("link-button", "All notes", openSidePanel);
  const closeButton = button("close-button", "×", closeBox);
  closeButton.title = "Close (Esc)";
  closeButton.setAttribute("aria-label", "Close");
  const headerActions = el("div", "header-actions");
  headerActions.append(panelButton, closeButton);
  header.append(stamp, headerActions);

  const textarea = el("textarea", "input");
  textarea.rows = 1;
  // Short on purpose: the box starts one line tall, so a long placeholder is clipped.
  textarea.placeholder = "Type a note…";
  textarea.setAttribute("aria-label", "Note text");
  textarea.addEventListener("input", () => {
    // Typing while speaking: stop the microphone and keep what's there.
    if (dictation) {
      cancelDictation();
    }
    resizeTextarea();
  });

  // While speaking: what is happening, and a Stop that saves what was said.
  const dictationStatus = el("div", "dictation");
  dictationStatus.hidden = true;
  dictationStatus.setAttribute("role", "status");
  const dictationText = el("span", "dictation-text");
  const dictationStop = button("bar-button", "Stop and save", stopDictation);
  dictationStatus.append(dictationText, dictationStop);

  const chips = el("div", "chips");
  QUICK_LABELS.forEach((label, index) => {
    const chip = button("chip", label, () => saveNote("label", label));
    chip.title = "Save as " + label + " (Alt+" + (index + 1) + ")";
    chips.append(chip);
  });
  const voiceButton = button("chip", "Voice", () => (dictation ? stopDictation() : startDictation()));
  const rangeButton = button("chip", "Start range", onRangeButton);
  const snipButton = button("chip", "Snip", () => {
    closeBox();
    snip();
  });
  chips.append(voiceButton, rangeButton, snipButton);

  const hint = el(
    "div",
    "hint",
    "Enter to save · Shift+Enter for a new line · Esc to cancel · Enter on an empty note marks the moment"
  );
  const error = el("div", "error");
  error.hidden = true;
  error.setAttribute("role", "alert");

  box.append(header, textarea, dictationStatus, chips, hint, error);

  // --- Listening bar. Shown the whole time Kayt listens to the tab, so it is
  // never on without the user knowing. Saffron: a state, not a captured thing.
  const listen = el("div", "bar listen");
  listen.hidden = true;
  listen.setAttribute("role", "status");
  const listenText = el("span", "bar-text");
  listenText.append(el("span", "dot"), "Listening to this video");
  listen.append(
    listenText,
    button("bar-button", "Snip", snip),
    button("link-button", "Stop", toggleListeningFromPage)
  );

  // --- The open range. Saffron, because it is waiting on the user to end it.
  const range = el("div", "bar range");
  range.hidden = true;
  range.setAttribute("role", "status");
  const rangeText = el("span", "bar-text");
  const rangeStart = el("span", "bar-time");
  const rangeElapsed = el("span", "bar-time");
  const rangeListening = el("span", "");
  rangeText.append("Range from ", rangeStart, " · ", rangeElapsed, rangeListening);
  const endButton = button("bar-button", "End", endRange);
  range.append(rangeText, endButton, button("link-button", "Cancel", () => stopRange({ tellKayt: true })));

  // --- A Snip being recorded (or waiting for Alt+L). Saffron, like the range.
  const snipBar = el("div", "bar range");
  snipBar.hidden = true;
  snipBar.setAttribute("role", "status");
  const snipText = el("span", "bar-text");
  snipBar.append(snipText, button("link-button", "Cancel", () => stopSnip({ release: true })));

  // --- Why a Snip or range could not reach back. Stays until closed.
  const tip = el("div", "tip");
  tip.hidden = true;
  tip.setAttribute("role", "note");
  const tipText = el("p", "tip-text");
  const tipActions = el("div", "tip-actions");
  tipActions.append(
    button("bar-button", "Got it", closeListenTip),
    button("link-button", "Don't show again", neverShowListenTip)
  );
  tip.append(tipText, tipActions);

  // --- Messages
  const toast = el("div", "toast");
  toast.hidden = true;
  toast.setAttribute("role", "status");
  const toastText = el("span", "toast-text");
  const undo = button("link-button", "Undo", null);
  toast.append(toastText, undo);

  // --- The Kayt button's menu
  const menu = el("div", "menu");
  menu.hidden = true;
  menu.setAttribute("role", "menu");
  const menuKeys = {};
  const menuItem = (text, command, action) => {
    const item = button("menu-item", text, action);
    item.setAttribute("role", "menuitem");
    if (command) {
      const kbd = el("kbd", "");
      menuKeys[command] = kbd;
      item.append(kbd);
    }
    menu.append(item);
    return item;
  };
  menuItem("Note", "open-capture", () => openCapture());
  const menuVoice = menuItem("Voice note", "voice-note", () => openCapture({ voice: true }));
  const menuRange = menuItem("Start range", "toggle-range", toggleRange);
  menuItem("Snip", "snip", snip);
  const menuListen = menuItem("Listen to video", "toggle-listening", toggleListeningFromPage);
  menu.append(el("div", "menu-divider"));
  menuItem("All notes", "", () => {
    closeMenu();
    openSidePanel();
  });
  menuItem("Manage notes", "", () => {
    closeMenu();
    chrome.runtime.sendMessage({ type: "openManage" }).catch(() => {});
  });
  const menuResetPosition = menuItem("Move button back to the corner", "", resetPagePosition);
  menuItem("Hide this button", "", hidePageButton);

  // --- The Kayt button
  const fab = button("fab", "", onFabClick);
  fab.title = "Kayt — click for the menu, drag to move";
  fab.addEventListener("pointerdown", onFabPointerDown);
  fab.addEventListener("pointermove", onFabPointerMove);
  fab.addEventListener("pointerup", onFabPointerUp);
  fab.addEventListener("pointercancel", onFabPointerUp);
  fab.hidden = true;
  fab.setAttribute("aria-label", "Kayt");
  fab.setAttribute("aria-haspopup", "menu");
  fab.setAttribute("aria-expanded", "false");
  fab.append(buildMark());
  const badge = el("span", "badge");
  badge.hidden = true;
  fab.append(badge);

  wrapper.append(tip, box, listen, range, snipBar, toast, menu, fab);
  shadow.append(wrapper);

  ui = {
    box,
    stamp,
    textarea,
    dictationStatus,
    dictationText,
    voiceButton,
    rangeButton,
    error,
    listen,
    range,
    rangeStart,
    rangeElapsed,
    rangeListening,
    snip: snipBar,
    snipText,
    tip,
    tipText,
    toast,
    toastText,
    undo,
    menu,
    menuRange,
    menuListen,
    menuVoice,
    menuResetPosition,
    menuKeys,
    dictationStop,
    endButton,
    snipButton,
    fab,
    badge
  };
  updateShortcutLabels();
}

function openSidePanel() {
  chrome.runtime.sendMessage({ type: "openSidePanel" }).catch(() => {});
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

function button(className, text, onClick) {
  const element = el("button", className, text);
  element.type = "button";
  if (onClick) {
    element.addEventListener("click", onClick);
  }
  return element;
}

// The Kayt mark (brand/kayt-mark-mono.svg), drawn in the current colour.
function buildMark() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 72 72");
  svg.setAttribute("aria-hidden", "true");
  const bars = [
    [2, 30, 14],
    [13, 17, 40],
    [24, 25, 24],
    [35, 32, 10]
  ];
  for (const [x, y, height] of bars) {
    const rect = document.createElementNS(ns, "rect");
    rect.setAttribute("x", x);
    rect.setAttribute("y", y);
    rect.setAttribute("width", "8");
    rect.setAttribute("height", height);
    rect.setAttribute("rx", "4");
    rect.setAttribute("fill", "currentColor");
    svg.append(rect);
  }
  const paths = [
    "M60.65,12.43 L62.61,10.11 A3.8,3.8 0 0 1 68.43,14.99 L66.47,17.32 Z",
    "M58.94,14.47 L64.76,19.36 L52.31,34.2 L46.49,29.32 Z",
    "M46.49,29.32 L52.31,34.2 L45.77,37.15 a0.91,0.91 0 0 1 -1.05,-0.88 Z"
  ];
  for (const d of paths) {
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "currentColor");
    svg.append(path);
  }
  return svg;
}

// A constructed stylesheet isn't affected by YouTube's content security policy,
// unlike a <style> or <link> tag added to their page.
async function loadStyles(shadow) {
  try {
    const response = await fetch(chrome.runtime.getURL("content/capture.css"));
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(await response.text());
    shadow.adoptedStyleSheets = [sheet];
  } catch (error) {
    console.warn("Kayt: could not load capture box styles.", error);
  }
}

// ===========================================================================
// Start-up, and messages from the service worker and the side panel.
// ===========================================================================

async function start() {
  await Promise.all([urlLibLoading, storageLoading]);
  updatePageButton();
  refreshShortcuts();
  onYouTubeNavigation(() => updatePageButton());
  // After a page reload, find out whether this tab is still being listened to.
  try {
    const state = await sendToKayt({ type: "getListeningState" });
    if (state.on && state.auto) {
      // It was listening for a Snip or range, and a fresh page has none open.
      await sendToKayt({ type: "stopListening" });
    } else if (state.on) {
      onListeningState(true, "");
    }
  } catch (error) {
    // Not listening, or Kayt was just updated.
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start);
} else {
  start();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case "openCapture":
      openCapture({ voice: Boolean(message.voice) });
      return false;
    case "toggleRange":
      toggleRange();
      return false;
    case "snip":
      snip();
      return false;
    case "dictationUpdate":
      onDictationUpdate(message.text);
      return false;
    case "dictationStarted":
      // After the microphone was allowed in Kayt's small window.
      if (dictation && dictation.waitingForMic) {
        dictation.waitingForMic = false;
        ui.dictationText.textContent = "Listening… speak now.";
      }
      return false;
    case "dictationEnded":
      onDictationEnded(message.text, message.error);
      return false;
    case "listeningState":
      onListeningState(message.on, message.error, message.auto, message.heldKeys, message.since);
      return false;
    case "rangeTranscribed":
      showMessage(
        message.ok ? "Transcript added to the range" : "No speech was heard during the range",
        { flagged: !message.ok }
      );
      return false;
    case "seek":
      seekTo(message.videoId, message.seconds)
        .then((ok) => sendResponse({ ok }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    case "getPosition":
      // For the side panel's review mode: where the video is right now, no look-back.
      readVideoId()
        .then((videoId) => sendResponse({ videoId, seconds: readCurrentSeconds() }))
        .catch(() => sendResponse({ videoId: null, seconds: null }));
      return true;
    default:
      return false;
  }
});
