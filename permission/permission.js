// Asks Chrome for the microphone once, on behalf of the hidden listener page, which
// can't show Chrome's permission question itself.
//
// Opened two ways:
//   - as a small window when a voice note needs the microphone (?tab=<id>): it asks
//     straight away, tells Kayt the answer, and closes itself so the voice note
//     starts on the YouTube page without pressing anything again;
//   - as a normal tab from Settings ("Allow microphone"): it waits for the button.

const status = document.getElementById("status");
const button = document.getElementById("allow-button");
const forVoiceNote = new URLSearchParams(location.search).has("tab");

function show(text, good) {
  status.textContent = text;
  status.classList.toggle("good", good);
  status.classList.toggle("bad", !good);
}

async function currentState() {
  try {
    return (await navigator.permissions.query({ name: "microphone" })).state;
  } catch (error) {
    return "prompt"; // can't tell; asking still works
  }
}

async function ask() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // We only needed the permission, not the sound.
    for (const track of stream.getTracks()) {
      track.stop();
    }
    return true;
  } catch (error) {
    return false;
  }
}

function tellKayt(granted) {
  return chrome.runtime.sendMessage({ type: "micPermissionResult", granted }).catch(() => {});
}

async function askForVoiceNote() {
  button.hidden = true;
  show("Chrome is asking: choose Allow.", true);
  if (await ask()) {
    show("Allowed. Your voice note is starting…", true);
    await tellKayt(true);
    window.close();
    return;
  }
  const state = await currentState();
  show(
    state === "denied"
      ? "The microphone is blocked for Kayt. Click the icon at the right end of the address bar, allow the microphone, then click the button."
      : "Not allowed. Click the button and choose Allow.",
    false
  );
  button.hidden = false;
}

button.addEventListener("click", async () => {
  if (forVoiceNote) {
    askForVoiceNote();
    return;
  }
  if (await ask()) {
    show("Done. Voice notes can use the microphone now. You can close this tab.", true);
  } else {
    show("Not allowed. Click the button and choose Allow.", false);
  }
});

async function start() {
  const state = await currentState();
  if (forVoiceNote) {
    if (state === "granted") {
      await tellKayt(true);
      window.close();
      return;
    }
    askForVoiceNote();
    return;
  }
  if (state === "granted") {
    show("Already allowed. You can close this tab and press Alt+V on a YouTube video.", true);
  } else if (state === "denied") {
    show(
      "The microphone is blocked for Kayt. Click the icon at the right end of the address bar, " +
        "allow the microphone, then click the button again.",
      false
    );
  }
}

start();
