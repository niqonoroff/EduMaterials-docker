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
const TEST_MODE = new URLSearchParams(window.location.search).has("nofirebase");

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
const themeButton = document.querySelector("#theme-button");
const scrollBottomButton = document.querySelector("#scroll-bottom-button");
const downloadButton = document.querySelector("#download-button");
const signatureModal = document.querySelector("#signature-modal");
const signatureForm = document.querySelector("#signature-form");
const signatureInput = document.querySelector("#signature-name");
const signatureCancel = document.querySelector("#signature-cancel");

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

/* ------------------------------------------------------------------ */
/*  Theme                                                             */
/* ------------------------------------------------------------------ */

const THEME_KEY = "wall-theme";
const themeColorMeta = document.querySelector('meta[name="theme-color"]');

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;

  if (themeColorMeta) {
    themeColorMeta.setAttribute(
      "content",
      theme === "light" ? "#f7f1e6" : "#333333"
    );
  }
}

function storedTheme() {
  try {
    return window.localStorage.getItem(THEME_KEY);
  } catch {
    return null;
  }
}

function rememberTheme(theme) {
  try {
    window.localStorage.setItem(THEME_KEY, theme);
  } catch {
  }
}

themeButton.addEventListener("click", () => {
  const next =
    document.documentElement.dataset.theme === "light" ? "dark" : "light";

  applyTheme(next);
  rememberTheme(next);
});

if (document.documentElement.dataset.theme === "light") {
  applyTheme("light");
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
  editorSetCaret(ytext.length);
}

function rememberUnlock() {
  try {
    sessionStorage.setItem(AUTH_KEY, "1");
  } catch {
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

  if (TEST_MODE) {
    markReady();
    return;
  }

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
  wallText.contentEditable = "true";
  renderSharedText();
  saveButton.disabled = false;
  lastSavedText = ytext.toString();
  dirty = false;
  setStatus(connected ? "" : "Offline — retrying…");
  scrollToBottom();

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
/*  Editor (contenteditable) <-> Yjs                                  */
/* ------------------------------------------------------------------ */

ytext.observe(() => {
  renderSharedText();
});

wallText.addEventListener("input", () => {
  if (!ready) return;

  const next = serializeWall();
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

wallText.addEventListener("keydown", (event) => {
  if (!ready || event.key !== "Enter") return;

  event.preventDefault();
  document.execCommand("insertLineBreak");
});

wallText.addEventListener("paste", (event) => {
  if (!ready) {
    event.preventDefault();
    return;
  }
  event.preventDefault();
  const transfer = event.clipboardData;
  let pasted = transfer ? transfer.getData("text/plain") : "";
  pasted = pasted.replace(/\r\n?/g, "\n");
  if (pasted) editorApplyEdit(pasted);
});

function editorApplyEdit(inserted) {
  const selection = editorSelectionOffsets();
  const from = selection ? Math.min(selection.anchor, selection.focus) : ytext.length;
  const to = selection ? Math.max(selection.anchor, selection.focus) : ytext.length;

  if (from === to && inserted) {
    editorInsertDom(from, inserted);
  }

  ydoc.transact(() => {
    if (to > from) ytext.delete(from, to - from);
    if (inserted) ytext.insert(from, inserted);
  }, "local");

  dirty = true;
  scheduleSave();
  editorSetSelection(from + inserted.length, from + inserted.length);
}

function editorInsertDom(offset, text) {
  const fragment = document.createDocumentFragment();
  const template = document.createElement("template");
  template.innerHTML = markupText(text);
  while (template.content.firstChild) {
    fragment.appendChild(template.content.firstChild);
  }

  const [node, localOffset] = editorPosition(offset);

  if (node === wallText && localOffset === 0 && !wallText.firstChild) {
    wallText.appendChild(fragment);
    return;
  }

  if (node.nodeType === Node.TEXT_NODE) {
    let split;
    if (localOffset === 0) {
      node.parentNode.insertBefore(fragment, node);
      return;
    }
    split = node.splitText(localOffset);
    node.parentNode.insertBefore(fragment, split);
    return;
  }

  wallText.appendChild(fragment);
}

wallText.addEventListener("blur", () => {
  if (ready && dirty) saveNow();
});

function renderSharedText() {
  const next = ytext.toString();
  const previous = serializeWall();
  if (next === previous) return;

  const change = computeDiff(previous, next);
  const selection = editorSelectionOffsets();
  const oldScrollTop = wallText.scrollTop;
  const wasAtBottom =
    wallText.scrollTop + wallText.clientHeight >= wallText.scrollHeight - 4;

  wallText.innerHTML = markupText(next);

  if (selection) {
    const mapPosition = (position) => {
      if (position <= change.start) return position;
      if (position >= change.start + change.removed) {
        return position + change.inserted.length - change.removed;
      }
      return change.start + change.inserted.length;
    };
    editorSetSelection(
      mapPosition(selection.anchor),
      mapPosition(selection.focus)
    );
  }

  if (wasAtBottom) {
    wallText.scrollTop = wallText.scrollHeight;
  } else {
    wallText.scrollTop = oldScrollTop;
  }
}

function serializeWall() {
  let text = "";
  const walker = document.createTreeWalker(
    wallText,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    null
  );

  let node;
  while ((node = walker.nextNode())) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.data;
    } else if (node.nodeName === "BR") {
      if (text && !text.endsWith("\n")) text += "\n";
    } else if (node.nodeName === "DIV" || node.nodeName === "P") {
      if (text && !text.endsWith("\n")) text += "\n";
    }
  }

  return text;
}

function markupText(text) {
  let html = "";
  let cursor = 0;

  SIGNATURE_PATTERN.lastIndex = 0;
  let match;
  while ((match = SIGNATURE_PATTERN.exec(text)) !== null) {
    html += escapeHtml(text.slice(cursor, match.index));
    html += `<span class="signature-mark">${escapeHtml(match[0])}</span>`;
    cursor = match.index + match[0].length;
  }
  html += escapeHtml(text.slice(cursor));

  return html;
}

function editorSelectionOffsets() {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;

  const range = selection.getRangeAt(0);
  if (
    !wallText.contains(range.startContainer) ||
    !wallText.contains(range.endContainer)
  ) {
    return null;
  }

  return {
    anchor: editorRangeOffset(range.startContainer, range.startOffset),
    focus: editorRangeOffset(range.endContainer, range.endOffset),
  };
}

function editorRangeOffset(node, offset) {
  const probe = document.createRange();
  probe.setStart(wallText, 0);
  try {
    probe.setEnd(node, offset);
  } catch {
    return fallbackOffset(node);
  }
  return probe.toString().length;
}

function fallbackOffset(node) {
  let count = 0;
  const walker = document.createTreeWalker(wallText, NodeFilter.SHOW_TEXT, null);
  let current;
  while ((current = walker.nextNode())) {
    if (current === node && node.data) return count;
    count += current.data.length;
  }
  return count;
}

function editorTextNodes() {
  const nodes = [];
  const walker = document.createTreeWalker(wallText, NodeFilter.SHOW_TEXT, null);
  let node;
  while ((node = walker.nextNode())) nodes.push(node);
  return nodes;
}

function editorSetSelection(anchor, focus) {
  const selection = window.getSelection();
  if (!selection) return;

  selection.removeAllRanges();
  const range = document.createRange();

  if (anchor !== focus) {
    const start = Math.min(anchor, focus);
    const end = Math.max(anchor, focus);
    range.setStart(...editorPosition(start));
    range.setEnd(...editorPosition(end));
  } else {
    range.collapse(false);
    range.setStart(...editorPosition(anchor));
    range.collapse(true);
  }

  selection.addRange(range);
}

function editorPosition(offset) {
  const nodes = editorTextNodes();
  if (nodes.length === 0) return [wallText, 0];

  let remaining = offset;
  let last = nodes[nodes.length - 1];

  for (const node of nodes) {
    if (remaining <= node.data.length) return [node, remaining];
    remaining -= node.data.length;
  }

  return [last, last.data.length];
}

function editorSetCaret(offset) {
  editorSetSelection(offset, offset);
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
/*  Signatures                                                        */
/* ------------------------------------------------------------------ */

const SIGNATURE_PATTERN = /\[Signed by[^\n]*/g;

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatStamp(date) {
  return `${pad2(date.getDate())}.${pad2(date.getMonth() + 1)}.${date.getFullYear()} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function askSignatureName() {
  return new Promise((resolve) => {
    signatureModal.hidden = false;
    signatureInput.value = "";

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        signatureInput.focus();
        signatureInput.select();
      });
    });

    let settled = false;
    const close = (value) => {
      if (settled) return;
      settled = true;
      signatureModal.hidden = true;
      signatureForm.removeEventListener("submit", onSubmit);
      signatureCancel.removeEventListener("click", onCancel);
      signatureModal.removeEventListener("click", onBackdrop);
      document.removeEventListener("keydown", onKey);
      resolve(value);
    };

    const onSubmit = (event) => {
      event.preventDefault();
      close(signatureInput.value.trim() || "Anonymous");
    };

    const onCancel = () => close(null);
    const onBackdrop = (event) => {
      if (event.target === signatureModal) close(null);
    };
    const onKey = (event) => {
      if (event.key === "Escape") close(null);
    };

    signatureForm.addEventListener("submit", onSubmit);
    signatureCancel.addEventListener("click", onCancel);
    signatureModal.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onKey);
  });
}

function addSignature(name) {
  const current = ytext.toString();
  const prefix = !current || current.endsWith("\n") ? "" : "\n";

  const mark = `${prefix}[Signed by ${name}; ${formatStamp(new Date())}]\n\u200B`;

  ydoc.transact(() => {
    ytext.insert(ytext.length, mark);
  }, "local");

  dirty = true;
  scheduleSave();

  editorSetCaret(ytext.length);
  scrollToBottom();
}

function scrollToBottom() {
  const go = () => {
    wallText.scrollTop = wallText.scrollHeight;
  };

  go();
  window.requestAnimationFrame(go);
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(go).catch(go);
  }
  window.setTimeout(go, 300);
}

scrollBottomButton.addEventListener("click", () => {
  scrollToBottom();
});

/* ------------------------------------------------------------------ */
/*  Download                                                          */
/* ------------------------------------------------------------------ */

function downloadChat() {
  const text = ytext.toString().replace(/\u200B/g, "");
  if (!text) {
    setStatus("Nothing to download", 1500);
    return;
  }

  const blob = new Blob(["\uFEFF" + text], {
    type: "text/plain;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);

  const date = new Date().toISOString().slice(0, 10);
  const a = document.createElement("a");
  a.href = url;
  a.download = `wall-${date}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus("Downloaded", 1500);
}

downloadButton.addEventListener("click", downloadChat);

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

  if (TEST_MODE) {
    lastSavedText = ytext.toString();
    dirty = false;
    setStatus("Test mode — not saving", 1600);
    return true;
  }

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

saveButton.addEventListener("click", async () => {
  if (!ready || saveButton.disabled) return;

  saveButton.classList.remove("pop");
  void saveButton.offsetWidth;
  saveButton.classList.add("pop");

  const signedBy = await askSignatureName();
  if (signedBy === null) {
    saveButton.classList.remove("pop");
    return;
  }
  addSignature(signedBy);

  const startedAt = Date.now();
  saveNow(false).then(
    (ok) => {
      const wait = Math.max(0, HEART_FILL_MS - (Date.now() - startedAt));
      window.setTimeout(() => {
        saveButton.classList.remove("pop");
        if (ok) setStatus("Saved", 1500);
      }, wait);
    },
    () => {
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