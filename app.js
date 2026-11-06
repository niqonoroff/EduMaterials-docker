import { initializeApp } from "./vendor/firebase.js";
import {
  getDatabase,
  onValue,
  ref,
  runTransaction,
  serverTimestamp,
} from "./vendor/firebase.js";
import * as Y from "./vendor/yjs.js";

/* ------------------------------------------------------------------ */
/*  Settings                                                          */
/* ------------------------------------------------------------------ */

const PASSWORD = "2607";
const AUTH_KEY = "wall-unlocked";
const DB_PATH = "wall";
const SAVE_DELAY = 450;
const SAVE_TIMEOUT = 12000;

/*
 * The Firebase web config is public by design. Realtime Database only
 * needs `databaseURL`; the other values can be copied from the Firebase
 * console, but the placeholders below are enough for this project.
 */
const firebaseConfig = {
  apiKey: "AIzaSyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  authDomain: "wall-nq.firebaseapp.com",
  databaseURL: "https://wall-nq-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "wall-nq",
  storageBucket: "wall-nq.appspot.com",
  messagingSenderId: "723439864482",
  appId: "1:723439864482:web:0000000000000000000000",
};

/* ------------------------------------------------------------------ */
/*  Elements                                                          */
/* ------------------------------------------------------------------ */

const loginScreen = document.querySelector("#login-screen");
const loginForm = document.querySelector("#login-form");
const passwordInput = document.querySelector("#password");
const loginError = document.querySelector("#login-error");
const wallScreen = document.querySelector("#wall-screen");
const wallText = document.querySelector("#wall-text");
const saveButton = document.querySelector("#save-button");
const statusEl = document.querySelector("#status");

/* ------------------------------------------------------------------ */
/*  Shared document                                                   */
/* ------------------------------------------------------------------ */

const ydoc = new Y.Doc();
const ytext = ydoc.getText("notepad");

const clientId = createClientId();

let unlocked = false;
let ready = false;
let connectionStarted = false;
let connected = false;
let saving = false;
let saveAgain = false;
let dirty = false;
let lastSavedText = "";
let focusWhenReady = false;
let saveTimer = 0;
let retryTimer = 0;
let statusTimer = 0;

let database = null;
try {
  const app = initializeApp(firebaseConfig);
  database = getDatabase(app, firebaseConfig.databaseURL);
} catch (error) {
  console.error("Firebase could not start:", error);
}

/* ------------------------------------------------------------------ */
/*  Login                                                             */
/* ------------------------------------------------------------------ */

loginForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (unlocked) return;

  if (passwordInput.value === PASSWORD) {
    clearLoginError();
    openWall({ animate: true, focus: true });
  } else {
    passwordInput.value = "";
    showLoginError("Wrong password");
    passwordInput.focus();
  }
});

passwordInput.addEventListener("input", () => {
  const digits = passwordInput.value.replace(/\D+/g, "").slice(0, 4);
  if (passwordInput.value !== digits) passwordInput.value = digits;
  if (loginForm.classList.contains("has-error")) clearLoginError();
});

function showLoginError(message) {
  loginError.textContent = message;
  loginForm.classList.add("has-error");
  loginForm.classList.remove("is-shaking");
  void loginForm.offsetWidth;
  loginForm.classList.add("is-shaking");
  window.setTimeout(() => loginForm.classList.remove("is-shaking"), 400);
}

function clearLoginError() {
  loginForm.classList.remove("has-error");
  loginError.textContent = "";
}

function openWall({ animate = true, focus = false } = {}) {
  if (!unlocked) {
    unlocked = true;
    rememberUnlock();
  }

  focusWhenReady = focus;

  if (!animate) {
    loginScreen.hidden = true;
    wallScreen.hidden = false;
    wallScreen.classList.add("is-visible");
    connect();
    if (ready) focusWall();
    return;
  }

  loginScreen.classList.add("is-leaving");
  window.setTimeout(() => {
    loginScreen.hidden = true;
    wallScreen.hidden = false;
    requestAnimationFrame(() => wallScreen.classList.add("is-visible"));
    connect();
    if (ready) focusWall();
  }, 280);
}

function focusWall() {
  if (!ready) {
    focusWhenReady = true;
    return;
  }
  focusWhenReady = false;
  wallText.focus({ preventScroll: true });
  const end = wallText.value.length;
  wallText.setSelectionRange(end, end);
}

function rememberUnlock() {
  try {
    sessionStorage.setItem(AUTH_KEY, "1");
  } catch {
    /* Storage can be unavailable; the wall still works for this visit. */
  }
}

function wasUnlocked() {
  try {
    return sessionStorage.getItem(AUTH_KEY) === "1";
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/*  Firebase connection                                               */
/* ------------------------------------------------------------------ */

function connect() {
  if (connectionStarted) return;
  connectionStarted = true;

  if (!database) {
    markReady();
    setStatus("Firebase is unavailable");
    return;
  }

  setStatus("Connecting…");

  onValue(
    ref(database, ".info/connected"),
    (snapshot) => {
      connected = snapshot.val() === true;
      if (!connected && ready) {
        setStatus("Offline — retrying…");
      } else if (connected && ready && !saving && !dirty) {
        flashStatus("Connected");
      }
    },
    (error) => console.warn("Connection state unavailable:", error)
  );

  onValue(
    ref(database, DB_PATH),
    (snapshot) => {
      const data = snapshot.val();

      if (data && typeof data.state === "string") {
        applyRemoteState(data.state);
      }

      if (!ready) {
        markReady();
      } else if (!dirty && !saving) {
        lastSavedText = ytext.toString();
      }
    },
    (error) => {
      console.error("Firebase read failed:", error);
      if (!ready) markReady();
      setStatus("Connection problem — retrying…");
    }
  );
}

function markReady() {
  ready = true;
  wallText.value = ytext.toString();
  wallText.disabled = false;
  saveButton.disabled = false;
  lastSavedText = ytext.toString();
  dirty = false;
  setStatus(connected ? "" : "Offline — retrying…");

  if (focusWhenReady) focusWall();
}

function applyRemoteState(encoded) {
  try {
    Y.applyUpdate(ydoc, base64ToBytes(encoded), "firebase");
  } catch (error) {
    console.warn("Could not read the shared state:", error);
  }
}

/* ------------------------------------------------------------------ */
/*  Textarea <-> Yjs                                                  */
/* ------------------------------------------------------------------ */

ytext.observe(() => {
  renderSharedText();
});

wallText.addEventListener("input", () => {
  if (!ready) return;

  const next = wallText.value;
  const previous = ytext.toString();
  if (next === previous) return;

  const change = computeDiff(previous, next);
  ydoc.transact(() => {
    if (change.removed > 0) ytext.delete(change.start, change.removed);
    if (change.inserted) ytext.insert(change.start, change.inserted);
  }, "local");

  dirty = true;
  scheduleSave();
});

wallText.addEventListener("blur", () => {
  if (ready && dirty) saveNow();
});

function renderSharedText() {
  const next = ytext.toString();
  const previous = wallText.value;
  if (next === previous) return;

  const change = computeDiff(previous, next);
  const selectionStart = wallText.selectionStart;
  const selectionEnd = wallText.selectionEnd;
  const wasFocused = document.activeElement === wallText;
  const oldScrollTop = wallText.scrollTop;
  const wasAtBottom =
    wallText.scrollTop + wallText.clientHeight >= wallText.scrollHeight - 4;

  wallText.value = next;

  if (wasFocused) {
    const mapPosition = (position) => {
      if (position <= change.start) return position;
      if (position >= change.start + change.removed) {
        return position + change.inserted.length - change.removed;
      }
      return change.start + change.inserted.length;
    };
    wallText.setSelectionRange(
      mapPosition(selectionStart),
      mapPosition(selectionEnd)
    );
  }

  if (wasAtBottom) {
    wallText.scrollTop = wallText.scrollHeight;
  } else {
    wallText.scrollTop = oldScrollTop;
  }
}

function computeDiff(before, after) {
  let start = 0;
  const limit = Math.min(before.length, after.length);

  while (
    start < limit &&
    before.charCodeAt(start) === after.charCodeAt(start)
  ) {
    start += 1;
  }

  let beforeEnd = before.length;
  let afterEnd = after.length;

  while (
    beforeEnd > start &&
    afterEnd > start &&
    before.charCodeAt(beforeEnd - 1) === after.charCodeAt(afterEnd - 1)
  ) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }

  /* Keep emoji/surrogate pairs whole. */
  if (start > 0 && isHighSurrogate(before.charCodeAt(start - 1))) start -= 1;
  while (
    beforeEnd < before.length &&
    isLowSurrogate(before.charCodeAt(beforeEnd))
  ) {
    beforeEnd += 1;
  }
  while (
    afterEnd < after.length &&
    isLowSurrogate(after.charCodeAt(afterEnd))
  ) {
    afterEnd += 1;
  }

  return {
    start,
    removed: beforeEnd - start,
    inserted: after.slice(start, afterEnd),
  };
}

function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code) {
  return code >= 0xdc00 && code <= 0xdfff;
}

/* ------------------------------------------------------------------ */
/*  Saving                                                            */
/* ------------------------------------------------------------------ */

function scheduleSave(delay = SAVE_DELAY) {
  if (!ready) return;

  if (saving) {
    saveAgain = true;
    return;
  }

  if (retryTimer) {
    window.clearTimeout(retryTimer);
    retryTimer = 0;
  }

  window.clearTimeout(saveTimer);
  setStatus(connected ? "Saving…" : "Offline — retrying…");
  saveTimer = window.setTimeout(() => {
    saveTimer = 0;
    saveNow();
  }, delay);
}

async function saveNow(showStatus = true) {
  if (!ready) return false;

  if (saving) {
    saveAgain = true;
    return false;
  }

  if (!dirty && ytext.toString() === lastSavedText) {
    if (showStatus) setStatus("Saved", 1300);
    return true;
  }

  if (saveTimer) {
    window.clearTimeout(saveTimer);
    saveTimer = 0;
  }
  if (retryTimer) {
    window.clearTimeout(retryTimer);
    retryTimer = 0;
  }

  saving = true;
  saveAgain = false;
  setStatus(connected ? "Saving…" : "Offline — retrying…");

  if (!database) {
    saving = false;
    setStatus("Firebase is unavailable");
    return false;
  }

  let textAtCommit = ytext.toString();

  try {
    await withTimeout(
      runTransaction(ref(database, DB_PATH), (current) => {
        /* Merge anything other people wrote while we were typing. */
        if (current && typeof current.state === "string") {
          applyRemoteState(current.state);
        }

        textAtCommit = ytext.toString();

        return {
          state: encodeState(),
          updatedAt: serverTimestamp(),
          updatedBy: clientId,
        };
      }),
      SAVE_TIMEOUT
    );

    lastSavedText = textAtCommit;
    dirty = ytext.toString() !== lastSavedText;

    if (showStatus) {
      setStatus(connected ? "Saved" : "Saved — will sync", 1500);
    }
    return true;
  } catch (error) {
    console.error("Save failed:", error);
    setStatus("Couldn't save — retrying…");
    retryTimer = window.setTimeout(() => {
      retryTimer = 0;
      saveNow();
    }, connected ? 2500 : 5000);
    return false;
  } finally {
    saving = false;
    if (!retryTimer && (saveAgain || ytext.toString() !== lastSavedText)) {
      scheduleSave(150);
    }
  }
}

function encodeState() {
  return bytesToBase64(Y.encodeStateAsUpdate(ydoc));
}

const HEART_FILL_MS = 2000;

saveButton.addEventListener("click", () => {
  if (!ready || saveButton.disabled) return;

  saveButton.classList.remove("pop");
  void saveButton.offsetWidth;
  saveButton.classList.add("pop");

  const startedAt = Date.now();
  saveNow(false).then(
    (ok) => {
      /* Keep the heart filled for ~2 s, then confirm. */
      const wait = Math.max(0, HEART_FILL_MS - (Date.now() - startedAt));
      window.setTimeout(() => {
        saveButton.classList.remove("pop");
        if (ok) setStatus("Saved", 1500);
      }, wait);
    },
    () => {
      /* saveNow never rejects, but keep the heart state unchanged if it does. */
    }
  );
});

window.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    saveNow();
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && ready && dirty) saveNow();
});

window.addEventListener("pagehide", () => {
  if (ready && dirty) saveNow();
});

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function setStatus(message, hideAfter = 0) {
  window.clearTimeout(statusTimer);
  statusEl.textContent = message;
  statusEl.classList.toggle("is-visible", Boolean(message));

  if (message && hideAfter > 0) {
    statusTimer = window.setTimeout(() => {
      statusEl.classList.remove("is-visible");
    }, hideAfter);
  }
}

function flashStatus(message, duration = 1200) {
  if (saving || dirty) return;
  setStatus(message, duration);
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error("Firebase save timed out")),
      ms
    );
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(index, index + chunkSize)
    );
  }

  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function createClientId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

/* ------------------------------------------------------------------ */
/*  Start                                                             */
/* ------------------------------------------------------------------ */

if (wasUnlocked()) {
  openWall({ animate: false, focus: false });
} else {
  window.setTimeout(() => passwordInput.focus({ preventScroll: true }), 120);
}
