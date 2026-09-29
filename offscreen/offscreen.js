// The hidden listener page. Turns speech into text with Chrome's on-device speech
// recognition, from two sources:
//
//   - the microphone, for a voice note (one short session at a time)
//   - a YouTube tab's sound, for Snips and ranges (one tab at a time)
//
// Privacy: recognition is required to run on this computer (processLocally). Text
// is kept in memory: for the tab only the last couple of minutes (longer while a
// range or Snip needs it). The tab's sound is never recorded: saving a video's
// audio would be close to downloading it, which YouTube's terms forbid. Only a
// voice note's own recording (the user's voice) may be kept, when "Keep audio" is
// on, in this browser (lib/audio-store.js); nothing is ever uploaded.
//
// This page can only use chrome.runtime, so everything goes through the service
// worker. Messages meant for this page carry target: "offscreen".

import * as audioStore from "../lib/audio-store.js";

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

// How much of the tab's text to keep: the longest Snip "before" setting (120 s),
// with a little slack.
const KEEP_MS = 125000;
// A voice note ends after this much quiet once something has been said...
const MIC_SILENCE_MS = 2500;
// ...or after this long if nothing is said at all...
const MIC_NOTHING_SAID_MS = 8000;
// ...and, when it only ends on Stop, never runs longer than this.
const MIC_LONGEST_MS = 5 * 60 * 1000;

// Errors after which restarting would only fail again.
const FATAL_ERRORS = ["not-allowed", "service-not-allowed", "language-not-supported", "audio-capture"];

let mic = null; // see startMic
let tab = null; // see startTab

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== "offscreen") {
    return false;
  }
  handle(message)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: error.message, code: error.code || "" }));
  return true;
});

async function handle(message) {
  switch (message.type) {
    case "state":
      return state();
    case "startMic":
      await startMic(message.tabId, message.lang, message);
      return state();
    case "stopMic":
      stopMic(true);
      return state();
    case "cancelMic":
      stopMic(false);
      return state();
    case "startTab":
      await startTab(message.tabId, message.streamId, message.lang);
      return state();
    case "stopTab":
      stopTab(null);
      return state();
    case "clearTranscript":
      if (tab && tab.tabId === message.tabId) {
        tab.segments = [];
        tab.interim = "";
        tab.startedAt = Date.now();
      }
      return state();
    case "hold":
      // Keep text from `since` on until released (an open range or a
      // Snip still waiting for its "after" seconds).
      if (tab && tab.tabId === message.tabId) {
        tab.holds.set(message.key, message.since);
      }
      return state();
    case "release":
      if (tab && tab.tabId === message.tabId) {
        tab.holds.delete(message.key);
      }
      return state();
    case "getTranscript":
      return getTranscript(message.tabId, message.since, message.until);
    default:
      throw new Error("unknown message " + message.type);
  }
}

function state() {
  return {
    micTabId: mic ? mic.tabId : null,
    listeningTabId: tab ? tab.tabId : null,
    active: Boolean(mic || tab)
  };
}

// Tells the service worker; it passes it on to the YouTube tab.
function notify(message) {
  chrome.runtime.sendMessage({ from: "offscreen", ...message }).catch(() => {});
}

function fail(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// A recogniser that must stay on this computer. If this Chrome can't promise that,
// we refuse rather than let audio go to Google.
function createRecognizer(lang) {
  if (!SpeechRecognition) {
    throw fail("This Chrome has no speech recognition.", "no-speech-api");
  }
  if (!("processLocally" in SpeechRecognition.prototype)) {
    throw fail("This Chrome can't keep speech recognition on this computer. Update Chrome.", "no-on-device");
  }
  const recognition = new SpeechRecognition();
  recognition.lang = lang;
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.processLocally = true;
  return recognition;
}

function describeError(code, lang) {
  const text = {
    "language-not-supported":
      "No on-device speech pack for " + lang + ". Install it in Kayt Settings, under Voice and listening.",
    "not-allowed": "Chrome blocked the microphone for Kayt.",
    "service-not-allowed": "Chrome refused on-device speech recognition.",
    "audio-capture": "No sound could be captured.",
    network: "Speech recognition tried to use the network, so it was stopped."
  };
  return text[code] || "Speech recognition stopped (" + code + ").";
}

// ---------------------------------------------------------------------------
// Microphone: one voice note
// ---------------------------------------------------------------------------

// options: { keepAudio, autoStop }
async function startMic(tabId, lang, { keepAudio, autoStop }) {
  stopMic(false);
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (error) {
    // This page can't show Chrome's permission question, so the service worker
    // opens a normal Kayt page to ask once.
    throw fail("Kayt needs permission to use the microphone.", "needs-permission");
  }
  let recognition;
  try {
    recognition = createRecognizer(lang);
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    throw error;
  }
  const session = {
    tabId,
    stream,
    recognition,
    lang,
    autoStop: autoStop !== false,
    recorder: keepAudio ? startRecorder(stream) : null,
    startedAt: Date.now(),
    finalText: "",
    interim: "",
    timer: null,
    stopped: false,
    error: ""
  };
  mic = session;
  // An old recording that never got its note is thrown away.
  await audioStore.deleteClip(audioStore.pendingMicKey(tabId)).catch(() => {});

  recognition.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const text = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        session.finalText = joinText(session.finalText, text);
      } else {
        interim += text;
      }
    }
    session.interim = interim.trim();
    notify({ type: "dictationUpdate", tabId, text: joinText(session.finalText, session.interim) });
    if (session.autoStop) {
      endAfter(session, MIC_SILENCE_MS);
    }
  };
  recognition.onerror = (event) => {
    if (event.error !== "no-speech" && event.error !== "aborted") {
      session.error = event.error;
    }
  };
  recognition.onend = () => {
    // Chrome sometimes stops after a pause; carry on unless we meant to stop.
    if (!session.stopped && !FATAL_ERRORS.includes(session.error) && mic === session) {
      try {
        recognition.start(session.stream.getAudioTracks()[0]);
        return;
      } catch (error) {
        session.error = session.error || "start-failed";
      }
    }
    endMic(session, true);
  };

  // Passing the track keeps the source explicit: this microphone stream, nothing else.
  recognition.start(stream.getAudioTracks()[0]);
  endAfter(session, session.autoStop ? MIC_NOTHING_SAID_MS : MIC_LONGEST_MS);
}

function startRecorder(stream) {
  try {
    const recorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
    const chunks = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    };
    recorder.start();
    return { recorder, chunks };
  } catch (error) {
    console.warn("Kayt: could not record the microphone; the note will have text only.", error);
    return null;
  }
}

// Stops a recorder and resolves with everything it recorded, as one Blob.
function finishRecorder({ recorder, chunks }) {
  return new Promise((resolve) => {
    if (recorder.state === "inactive") {
      resolve(new Blob(chunks, { type: "audio/webm" }));
      return;
    }
    recorder.onstop = () => resolve(new Blob(chunks, { type: "audio/webm" }));
    recorder.stop();
  });
}

function endAfter(session, delay) {
  clearTimeout(session.timer);
  session.timer = setTimeout(() => {
    session.stopped = true;
    try {
      session.recognition.stop(); // onend finishes the note
    } catch (error) {
      endMic(session, true);
    }
  }, delay);
}

// keep: send the text to the tab to be saved. Otherwise it was cancelled.
function stopMic(keep) {
  if (!mic) {
    return;
  }
  const session = mic;
  session.stopped = true;
  session.keep = keep;
  try {
    if (keep) {
      session.recognition.stop();
    } else {
      session.recognition.abort();
    }
  } catch (error) {
    endMic(session, keep);
  }
}

async function endMic(session, keep) {
  if (session.ended) {
    return;
  }
  session.ended = true;
  clearTimeout(session.timer);
  if (mic === session) {
    mic = null;
  }
  const shouldKeep = session.keep === undefined ? keep : session.keep;
  const text = shouldKeep ? joinText(session.finalText, session.interim) : "";

  // The recording is stored before the tab hears the note is done, so it is
  // there when the service worker saves the note.
  if (session.recorder) {
    const blob = await finishRecorder(session.recorder);
    if (text) {
      const seconds = (Date.now() - session.startedAt) / 1000;
      await audioStore.putClip(audioStore.pendingMicKey(session.tabId), blob, seconds).catch((error) => {
        console.warn("Kayt: could not keep the voice note's audio.", error);
      });
    }
  }
  for (const track of session.stream.getTracks()) {
    track.stop();
  }
  notify({
    type: "dictationEnded",
    tabId: session.tabId,
    text,
    error: session.error ? describeError(session.error, session.lang) : "",
    active: Boolean(mic || tab)
  });
}

// ---------------------------------------------------------------------------
// Tab sound: Snips and ranges
// ---------------------------------------------------------------------------

async function startTab(tabId, streamId, lang) {
  stopTab(null);
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
      video: false
    });
  } catch (error) {
    throw fail("Could not listen to the tab: " + error.message, "capture-failed");
  }

  // Capturing a tab silences it, so play its sound back out as normal.
  const audioContext = new AudioContext();
  audioContext.createMediaStreamSource(stream).connect(audioContext.destination);

  let recognition;
  try {
    recognition = createRecognizer(lang);
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    audioContext.close();
    throw error;
  }

  const session = {
    tabId,
    stream,
    audioContext,
    recognition,
    lang,
    segments: [], // { text, at } final results, at = when they arrived
    interim: "",
    holds: new Map(), // key -> since: keep everything from the earliest since on
    startedAt: Date.now(),
    stopped: false,
    error: ""
  };
  tab = session;

  recognition.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const text = event.results[i][0].transcript.trim();
      if (event.results[i].isFinal) {
        if (text) {
          session.segments.push({ text, at: Date.now() });
        }
      } else {
        interim += text + " ";
      }
    }
    session.interim = interim.trim();
    prune(session);
  };
  recognition.onerror = (event) => {
    if (event.error !== "no-speech" && event.error !== "aborted") {
      session.error = event.error;
    }
  };
  recognition.onend = () => {
    if (!session.stopped && !FATAL_ERRORS.includes(session.error) && tab === session) {
      session.error = "";
      try {
        recognition.start(session.stream.getAudioTracks()[0]);
        return;
      } catch (error) {
        session.error = "start-failed";
      }
    }
    if (tab === session) {
      stopTab(session.error ? describeError(session.error, lang) : "");
    }
  };

  // The sharing can end from outside, e.g. the tab was closed.
  stream.getAudioTracks()[0].addEventListener("ended", () => {
    if (tab === session) {
      stopTab("");
    }
  });

  recognition.start(stream.getAudioTracks()[0]);
}

// error: null when stopped on purpose, otherwise why it stopped ("" if unknown).
function stopTab(error) {
  if (!tab) {
    return;
  }
  const session = tab;
  tab = null;
  session.stopped = true;
  try {
    session.recognition.abort();
  } catch (ignored) {
    // already stopped
  }
  for (const track of session.stream.getTracks()) {
    track.stop();
  }
  session.audioContext.close().catch(() => {});
  // Wipe the text: nothing outlives listening.
  session.segments = [];
  notify({ type: "listeningEnded", tabId: session.tabId, error: error || "", active: Boolean(mic) });
}

// Keeps the last couple of minutes, or everything since the earliest hold.
function prune(session) {
  let keepFrom = Date.now() - KEEP_MS;
  for (const since of session.holds.values()) {
    keepFrom = Math.min(keepFrom, since - 2000);
  }
  if (session.segments.length && session.segments[0].at < keepFrom) {
    session.segments = session.segments.filter((segment) => segment.at >= keepFrom);
  }
}

// Text heard between since and until (wall-clock milliseconds). A result arrives
// when a phrase ends, so a phrase that started a little before "since" is included
// if it finished after it.
function getTranscript(tabId, since, until) {
  if (!tab || tab.tabId !== tabId) {
    throw fail("Kayt is not listening to this tab.", "not-listening");
  }
  const now = Date.now();
  const end = until || now;
  let text = tab.segments
    .filter((segment) => segment.at >= since && segment.at <= end)
    .map((segment) => segment.text)
    .join(" ");
  // Words still being recognised belong to the window if it reaches up to now.
  if (end >= now - 3000) {
    text = joinText(text, tab.interim);
  }
  // Where the heard part of the window starts, for pointing the note at it.
  return { text: text.trim(), heardFrom: Math.max(since, tab.startedAt) };
}

function joinText(first, second) {
  const a = (first || "").trim();
  const b = (second || "").trim();
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }
  return a + " " + b;
}
