// Threadside bridge: loaded by the proxy into T3 Code's own web app, before the app's module.
// It connects the app to the editor through the webview host page (window.parent) and never
// sees credentials. Messages from the host are accepted only from window.parent.
(function () {
  "use strict";
  if (window.__threadside) return;
  const HOST = "threadside-host";
  const BRIDGE = "threadside-bridge";
  const state = {
    shortcuts: [],
    // Ctrl+Tab and Ctrl+Shift+Tab move between threads with T3 Code's own thread.next / thread.previous keys.
    threadKeys: {},
    compact: true,
    compacted: false,
    openFilesInEditor: true,
    sendEditorContext: true,
    theme: readCookie("threadside_theme_" + location.port) === "light" ? "light" : "dark",
  };
  // The editor's webview that hosts this frame; nothing else may talk to the bridge.
  const parentOrigin = (location.ancestorOrigins && location.ancestorOrigins[0]) || "";
  const trustedParent = /^vscode-webview:\/\//.test(parentOrigin);
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  window.__threadside = { version: 1 };

  // T3 Code's thread list follows the editor window: the extension names the projects open in it,
  // and the list's project filter is set to them before the app reads its saved state. It is set
  // once per set of projects, so a filter chosen later in the list stays.
  applyProjectScope((window.__threadsideBoot || {}).projectScopeKeys);
  function applyProjectScope(keys) {
    if (!Array.isArray(keys) || !keys.length || keys.some((key) => typeof key !== "string")) return;
    try {
      const wanted = JSON.stringify(keys);
      if (localStorage.getItem("threadside:projectScope") === wanted) return;
      const raw = localStorage.getItem("t3code:ui-state:v1");
      const ui = raw ? JSON.parse(raw) : {};
      ui.sidebarProjectScopeKeys = keys;
      ui.sidebarProjectScopeKey = keys.length === 1 ? keys[0] : null;
      localStorage.setItem("t3code:ui-state:v1", JSON.stringify(ui));
      localStorage.setItem("threadside:projectScope", wanted);
    } catch {
      // storage unavailable: the list shows every project
    }
  }

  // A narrow docked list has no room for T3 Code's Working section, so it starts off. Each chat origin
  // keeps its own settings; this runs once per origin, so turning it on in Settings stays.
  foldWorkingSectionOnce();
  function foldWorkingSectionOnce() {
    try {
      if (localStorage.getItem("threadside:workingSectionDefault")) return;
      const raw = localStorage.getItem("t3code:client-settings:v1");
      const settings = raw ? JSON.parse(raw) : {};
      settings.sidebarWorkingShelfEnabled = false;
      localStorage.setItem("t3code:client-settings:v1", JSON.stringify(settings));
      localStorage.setItem("threadside:workingSectionDefault", "1");
    } catch {
      // storage unavailable: T3 Code's default applies
    }
  }

  function readCookie(name) {
    const match = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
    return match ? decodeURIComponent(match[1]) : undefined;
  }

  function post(message) {
    if (trustedParent && window.parent !== window) window.parent.postMessage(Object.assign({ source: BRIDGE }, message), parentOrigin);
  }

  // Notifications: a webview may not ask for the browser's notification permission, so T3 Code saw
  // it denied and kept "Thread notifications" off. Inside the editor the page gets a Notification that
  // is always granted and hands each one to the editor, which shows it natively; clicking it there
  // fires this notification's own click, so T3 Code opens the thread as it would in a browser.
  const notifications = new Map();
  let notificationSeq = 0;
  if (trustedParent && window.parent !== window) {
    class EditorNotification extends EventTarget {
      static get permission() {
        return "granted";
      }
      static requestPermission(callback) {
        if (typeof callback === "function") callback("granted");
        return Promise.resolve("granted");
      }
      constructor(title, options) {
        super();
        const opts = options || {};
        this.title = String(title || "");
        this.body = String(opts.body || "");
        this.tag = String(opts.tag || "");
        this.onclick = null;
        this.onclose = null;
        this.id = ++notificationSeq;
        notifications.set(this.id, this);
        post({ type: "notification", id: this.id, title: this.title, body: this.body, tag: this.tag, scopeKeys: projectScopeKeys() });
      }
      close() {
        if (!notifications.delete(this.id)) return;
        const event = new Event("close");
        this.dispatchEvent(event);
        if (typeof this.onclose === "function") this.onclose(event);
      }
    }
    window.Notification = EditorNotification;
  }
  function clickNotification(id) {
    const notification = notifications.get(id);
    if (!notification) return;
    const event = new Event("click");
    notification.dispatchEvent(event);
    if (typeof notification.onclick === "function") notification.onclick(event);
  }

  // The projects T3 Code's thread list is filtered to (empty: every project). Notifications follow it,
  // so a window filtered to one project only hears about that project.
  function projectScopeKeys() {
    try {
      const ui = JSON.parse(localStorage.getItem("t3code:ui-state:v1") || "{}");
      if (Array.isArray(ui.sidebarProjectScopeKeys)) return ui.sidebarProjectScopeKeys.filter((key) => typeof key === "string");
      return typeof ui.sidebarProjectScopeKey === "string" ? [ui.sidebarProjectScopeKey] : [];
    } catch {
      return [];
    }
  }

  // T3 Code's own notification choice (Settings → Thread notifications), so the extension's
  // notifications stay quiet while T3 Code's are on, and the list filter they follow.
  let reportedMode;
  function reportNotificationMode() {
    let mode = "off";
    try {
      mode = JSON.parse(localStorage.getItem("t3code:client-settings:v1") || "{}").notificationMode || mode;
    } catch {
      // unreadable settings: T3 Code's default
    }
    const scopeKeys = projectScopeKeys();
    const report = JSON.stringify([mode, scopeKeys]);
    if (report === reportedMode) return;
    reportedMode = report;
    post({ type: "notificationMode", mode, scopeKeys });
  }
  setInterval(reportNotificationMode, 3000);

  // T3 Code starts with notifications off because a browser has to grant them first, and saves that
  // "off" with its other settings. In the editor they were never grantable before, so a saved "off" is
  // not a choice: each chat turns them on once. A choice made in Settings afterwards stays.
  if (trustedParent) enableNotificationsOnce();
  function enableNotificationsOnce() {
    try {
      if (localStorage.getItem("threadside:notificationsDefault:v2")) return;
      const raw = localStorage.getItem("t3code:client-settings:v1");
      const settings = raw ? JSON.parse(raw) : {};
      if (!settings.notificationMode || settings.notificationMode === "off") settings.notificationMode = "notifications";
      localStorage.setItem("t3code:client-settings:v1", JSON.stringify(settings));
      localStorage.setItem("threadside:notificationsDefault:v2", "1");
    } catch {
      // storage unavailable: T3 Code keeps its own default
    }
  }

  // Theme: answer `(prefers-color-scheme: …)` with the editor's theme so T3 Code's "System"
  // appearance follows the editor. An explicit light or dark choice in T3 Code still wins.
  const colorQueries = new Set();
  const nativeMatchMedia = window.matchMedia.bind(window);
  window.matchMedia = function (query) {
    const scheme = /prefers-color-scheme:\s*(dark|light)/.exec(query);
    if (!scheme) return nativeMatchMedia(query);
    const listeners = new Set();
    const mql = {
      media: query,
      onchange: null,
      get matches() {
        return state.theme === scheme[1];
      },
      addEventListener(type, fn) {
        if (type === "change") listeners.add(fn);
      },
      removeEventListener(type, fn) {
        listeners.delete(fn);
      },
      addListener(fn) {
        listeners.add(fn);
      },
      removeListener(fn) {
        listeners.delete(fn);
      },
      dispatchEvent() {
        return true;
      },
      _notify() {
        const event = { matches: mql.matches, media: query };
        listeners.forEach((fn) => fn.call(mql, event));
        if (typeof mql.onchange === "function") mql.onchange(event);
      },
    };
    colorQueries.add(mql);
    return mql;
  };

  // Inside the editor this page is a cross-site frame, where the browser refuses T3 Code's default
  // SameSite=Strict cookies (it persists the sidebar's state that way). SameSite=None keeps them.
  if (window.cookieStore && typeof window.cookieStore.set === "function") {
    const nativeSet = window.cookieStore.set.bind(window.cookieStore);
    window.cookieStore.set = function (nameOrOptions, value) {
      const options = typeof nameOrOptions === "string" ? { name: nameOrOptions, value: value } : Object.assign({}, nameOrOptions);
      options.sameSite = "none";
      return nativeSet(options);
    };
  }

  // Route changes tell the host which thread the tab shows.
  function reportRoute() {
    post({ type: "route", path: location.pathname + location.search, title: document.title });
  }
  for (const method of ["pushState", "replaceState"]) {
    const original = history[method];
    history[method] = function () {
      const result = original.apply(this, arguments);
      queueMicrotask(reportRoute);
      return result;
    };
  }
  window.addEventListener("popstate", reportRoute);
  new MutationObserver(() => post({ type: "title", title: document.title })).observe(
    document.querySelector("title") || document.head || document.documentElement,
    { childList: true, subtree: true, characterData: true },
  );

  // Clicks: file links open in the editor at their line; web links open in the system browser.
  window.addEventListener(
    "click",
    (event) => {
      if (event.defaultPrevented || event.button !== 0) return;
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!anchor) return;
      if (anchor.classList.contains("chat-markdown-file-link")) {
        if (!state.openFilesInEditor || event.altKey) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        post({
          type: "openFile",
          href: anchor.getAttribute("href"),
          label: anchor.textContent || "",
          route: location.pathname,
          beside: event.metaKey || event.ctrlKey,
        });
        return;
      }
      const href = anchor.getAttribute("href") || "";
      let url;
      try {
        url = new URL(href, location.href);
      } catch {
        return;
      }
      if ((url.protocol === "http:" || url.protocol === "https:") && url.origin !== location.origin) {
        event.preventDefault();
        event.stopImmediatePropagation();
        post({ type: "openExternal", url: url.toString() });
      }
    },
    true,
  );
  const nativeOpen = window.open.bind(window);
  window.open = function (url, target, features) {
    try {
      const resolved = new URL(String(url), location.href);
      if (resolved.origin !== location.origin) {
        post({ type: "openExternal", url: resolved.toString() });
        return null;
      }
    } catch {
      // fall through to the browser's behavior
    }
    return nativeOpen(url, target, features);
  };

  // Keys: the editor drops key events that a page dispatches (only trusted keys reach its keybindings),
  // and keys typed inside this frame never reach it at all. So the shortcuts that must work from the
  // chat are mapped to editor commands by the extension; every other key belongs to T3 Code.
  // `mod` is ⌘ on macOS and Ctrl elsewhere; on macOS Ctrl stays `ctrl` (Ctrl+N is "next line" there).
  function chord(event) {
    const parts = [];
    if (isMac ? event.metaKey : event.ctrlKey) parts.push("mod");
    if (isMac && event.ctrlKey) parts.push("ctrl");
    if (event.altKey) parts.push("alt");
    if (event.shiftKey) parts.push("shift");
    parts.push(event.key.toLowerCase());
    return parts.join("+");
  }
  // T3 Code has no Ctrl+Tab binding; in the editor it is the usual key for the next tab, so here it
  // moves between threads the way T3 Code's own thread.next / thread.previous keys do.
  window.addEventListener(
    "keydown",
    (event) => {
      if (!event.isTrusted || event.key !== "Tab" || !event.ctrlKey || event.metaKey || event.altKey) return;
      const chordText = state.threadKeys[event.shiftKey ? "previous" : "next"];
      if (!chordText) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      runShortcut(chordText);
    },
    true,
  );

  window.addEventListener(
    "keydown",
    (event) => {
      // Shortcuts this bridge dispatches on T3 Code's behalf are untrusted: let T3 Code have them.
      if (!event.isTrusted || !(event.metaKey || event.ctrlKey || event.altKey)) return;
      const key = chord(event);
      if (!state.shortcuts.includes(key)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      post({ type: "shortcut", chord: key });
    },
    true,
  );

  // ⌘+ / ⌘= and ⌘- zoom the chat, ⌘0 resets it, like T3 Code's desktop app and a browser. The editor's
  // own zoom never sees keys typed in this frame. T3 Code sizes its interface in rem, so the root font
  // size scales text, spacing and icons together without changing the page's height. Kept per chat.
  const ZOOM_STEPS = [0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
  let zoom = 1;
  try {
    const saved = Number(localStorage.getItem("threadside:zoom"));
    if (ZOOM_STEPS.includes(saved)) zoom = saved;
  } catch {
    // storage unavailable: default size
  }
  applyZoom();
  function applyZoom() {
    if (zoom === 1) document.documentElement.style.removeProperty("font-size");
    else document.documentElement.style.setProperty("font-size", 16 * zoom + "px");
    try {
      localStorage.setItem("threadside:zoom", String(zoom));
    } catch {
      // storage unavailable: the zoom lasts for this page only
    }
  }
  window.addEventListener(
    "keydown",
    (event) => {
      if (!event.isTrusted || !(isMac ? event.metaKey : event.ctrlKey) || event.altKey) return;
      const index = ZOOM_STEPS.indexOf(zoom);
      let next;
      if (event.code === "Equal" || event.key === "+" || event.key === "=") next = ZOOM_STEPS[Math.min(index + 1, ZOOM_STEPS.length - 1)];
      else if (event.code === "Minus" || event.key === "-") next = ZOOM_STEPS[Math.max(index - 1, 0)];
      else if ((event.code === "Digit0" || event.key === "0") && !event.shiftKey) next = 1;
      else return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (next === zoom) return;
      zoom = next;
      applyZoom();
    },
    true,
  );

  // ⌘W first closes what T3 Code has open (a terminal, the right panel); T3 Code leaves the key alone
  // when nothing is, and then it closes the chat, as it would close any editor tab. T3 Code does not
  // count its empty "Open a surface" panel as open, so that one is closed here.
  window.addEventListener("keydown", (event) => {
    if (!event.isTrusted || event.repeat || chord(event) !== "mod+w") return;
    setTimeout(() => {
      if (!event.defaultPrevented) post({ type: "closeChat", launcherOpen: Boolean(document.querySelector("[data-surface-launcher-keys]")) });
    }, 0);
  });

  // T3 Code's desktop app opens Settings from its menu (⌘,); in the editor that key never reaches the
  // menu, so ⌘, and ⌘. open T3 Code's Settings here.
  window.addEventListener("keydown", (event) => {
    const key = chord(event);
    if (!event.isTrusted || (key !== "mod+," && key !== "mod+.")) return;
    event.preventDefault();
    if (!/^\/settings(\/|$)/.test(location.pathname)) navigate("/settings");
  });

  // Copy, cut, paste, select all, undo and redo are menu commands in the editor. They reach the
  // webview's outer page, never this frame, so here the keys do nothing unless the bridge runs them.
  // The browser's own paste keeps images and files from the clipboard.
  const EDITING = { "mod+c": "copy", "mod+x": "cut", "mod+v": "paste", "mod+a": "selectAll", "mod+z": "undo", "mod+shift+z": "redo" };
  window.addEventListener("keydown", (event) => {
    // Editors that handle a key themselves (undo in the composer) prevent its default first.
    if (!event.isTrusted || event.defaultPrevented) return;
    const command = EDITING[chord(event)];
    if (command && document.execCommand(command)) event.preventDefault();
  });

  // The clipboard API is refused to this frame inside the editor; copy buttons then write through
  // the editor's clipboard, which is the user's local one even over Remote-SSH.
  const clipboard = navigator.clipboard;
  if (clipboard && trustedParent) {
    const nativeWriteText = typeof clipboard.writeText === "function" ? clipboard.writeText.bind(clipboard) : undefined;
    const nativeWrite = typeof clipboard.write === "function" ? clipboard.write.bind(clipboard) : undefined;
    const viaEditor = (text) => post({ type: "copyText", text: String(text).slice(0, 4000000) });
    clipboard.writeText = function (text) {
      return (nativeWriteText ? nativeWriteText(text) : Promise.reject(new Error("unavailable"))).catch(() => viaEditor(text));
    };
    clipboard.write = function (items) {
      return (nativeWrite ? nativeWrite(items) : Promise.reject(new Error("unavailable"))).catch(async (error) => {
        for (const item of items || []) {
          if (item.types.includes("text/plain")) return viaEditor(await (await item.getType("text/plain")).text());
        }
        throw error;
      });
    };
  }

  // Editor context, like Cursor's active-file pill: when a message is sent, the file in focus, the
  // cursor or selection and the Problems the editor shows ride along as one of T3 Code's own context
  // chips. It is read from the editor at send time, and attached again in a thread only once it changed.
  const CONTEXT_MIME = "web application/x-t3-context-fragment+json";
  const sentContext = new Map();
  let pendingSend = null;
  let sendCount = 0;
  window.addEventListener(
    "keydown",
    (event) => {
      if (!trustedParent || !state.sendEditorContext || !event.isTrusted || event.key !== "Enter") return;
      if (event.isComposing || event.keyCode === 229 || event.altKey || event.shiftKey) return;
      const editor = composer();
      if (!editor || !(event.target instanceof Node) || !editor.contains(event.target)) return;
      // An open @ or / menu takes Enter for its own pick.
      if (pendingSend || document.querySelector("[data-composer-command-drawer]")) return;
      const text = editor.innerText || "";
      if (!text.trim() || !sendsOnEnter(event, text)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const id = "send-" + ++sendCount;
      const init = { key: "Enter", code: "Enter", keyCode: 13, which: 13, metaKey: event.metaKey, ctrlKey: event.ctrlKey, bubbles: true, cancelable: true };
      pendingSend = { id, target: event.target, init, timer: setTimeout(() => finishSend(null), 400) };
      post({ type: "ideContextRequest", requestId: id });
    },
    true,
  );

  // T3 Code's send setting: Enter, ⌘Enter, or ⌘Enter once the draft has several lines.
  function sendsOnEnter(event, text) {
    let shortcut = "enter";
    try {
      shortcut = JSON.parse(localStorage.getItem("t3code:client-settings:v1") || "{}").sendShortcut || "enter";
    } catch {
      // unreadable settings: T3 Code's default
    }
    const needsModifier = shortcut === "mod-enter" || (shortcut === "mod-enter-multiline" && /\n/.test(text.trim()));
    return !needsModifier || event.metaKey || event.ctrlKey;
  }

  function finishSend(context) {
    const send = pendingSend;
    if (!send) return;
    pendingSend = null;
    clearTimeout(send.timer);
    const thread = location.pathname;
    let attached = false;
    if (context && typeof context.text === "string" && sentContext.get(thread) !== context.text) {
      attached = attachContext(send.target, context);
      if (attached) sentContext.set(thread, context.text);
    }
    // The chip reaches the draft through React state; send once it has rendered.
    setTimeout(() => send.target.dispatchEvent(new KeyboardEvent("keydown", send.init)), attached ? 60 : 0);
  }

  function attachContext(target, context) {
    const contextId = "ide-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const record = {
      version: 1,
      kind: "terminal",
      contextId,
      label: context.label,
      terminalId: "threadside-editor",
      terminalLabel: context.label,
      lineStart: 1,
      lineEnd: context.lines,
      text: context.text,
    };
    const data = new DataTransfer();
    data.setData("text/plain", " [" + context.label + "](t3-context://v1/terminal/" + contextId + ")");
    data.setData(CONTEXT_MIME, JSON.stringify({ version: 1, source: { environmentId: context.environmentId }, records: [record] }));
    const paste = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
    target.dispatchEvent(paste);
    return paste.defaultPrevented;
  }

  // A middle click on a thread in T3 Code's list opens it in its own editor tab, like a browser tab.
  window.addEventListener(
    "auxclick",
    (event) => {
      if (event.button !== 1) return;
      const row = event.target instanceof Element ? event.target.closest("[data-thread-item]") : null;
      const key = row && row.getAttribute("data-thread-item");
      const split = key ? key.indexOf(":") : -1;
      if (split <= 0) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      post({ type: "openThreadInTab", environmentId: key.slice(0, split), threadId: key.slice(split + 1) });
    },
    true,
  );

  // Errors in the chat page go to the editor's log, so a blank or broken tab can be diagnosed.
  let reportedErrors = 0;
  function reportError(message, detail) {
    if (reportedErrors++ >= 20) return;
    post({ type: "clientError", message: String(message || "Unknown error").slice(0, 500), detail: String(detail || "").slice(0, 1500), path: location.pathname });
  }
  window.addEventListener("error", (event) => {
    const media = event.target;
    if (media instanceof HTMLMediaElement) {
      const error = media.error;
      reportError("Media failed to play", (error ? error.code + " " + error.message : "no MediaError") + " " + (media.currentSrc || media.src).split("?")[0]);
      return;
    }
    reportError(event.message, event.error && event.error.stack);
  }, true);
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    reportError(reason && reason.message ? reason.message : reason, reason && reason.stack);
  });

  // Files dragged from the editor (Explorer, tabs, search results) become file chips, like Cursor.
  // The editor delivers drops to a webview while Shift is held.
  const EDITOR_DRAG_TYPES = ["application/vnd.code.uri-list", "codefiles", "resourceurls", "text/uri-list"];
  function editorDrag(event) {
    const types = event.dataTransfer ? Array.from(event.dataTransfer.types) : [];
    return EDITOR_DRAG_TYPES.some((type) => types.includes(type)) && !types.includes("Files");
  }
  function droppedUris(data) {
    const out = [];
    const json = (type) => {
      try {
        const value = JSON.parse(data.getData(type) || "[]");
        return Array.isArray(value) ? value : [];
      } catch {
        return [];
      }
    };
    for (const path of json("codefiles")) if (typeof path === "string") out.push("file://" + encodeURI(path));
    for (const uri of json("resourceurls")) if (typeof uri === "string") out.push(uri);
    for (const type of ["application/vnd.code.uri-list", "text/uri-list"]) {
      for (const line of (data.getData(type) || "").split(/\r?\n/)) if (line && !line.startsWith("#")) out.push(line.trim());
    }
    return Array.from(new Set(out));
  }
  function setDropTarget(active) {
    const editor = composer();
    const box = editor && (editor.closest("form") || editor.parentElement);
    if (box) box.style.outline = active ? "2px solid var(--primary, #6b8cff)" : "";
  }
  let reportedDrag = false;
  window.addEventListener(
    "dragenter",
    (event) => {
      if (reportedDrag || !event.dataTransfer) return;
      reportedDrag = true;
      post({ type: "dragTypes", types: Array.from(event.dataTransfer.types) });
    },
    true,
  );
  window.addEventListener("drop", () => (reportedDrag = false), true);
  for (const type of ["dragenter", "dragover"]) {
    window.addEventListener(
      type,
      (event) => {
        if (!editorDrag(event)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        event.dataTransfer.dropEffect = "copy";
        setDropTarget(true);
      },
      true,
    );
  }
  window.addEventListener(
    "dragleave",
    (event) => {
      if (editorDrag(event) && !event.relatedTarget) setDropTarget(false);
    },
    true,
  );
  window.addEventListener(
    "drop",
    (event) => {
      if (!editorDrag(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setDropTarget(false);
      const uris = droppedUris(event.dataTransfer);
      if (uris.length) post({ type: "droppedUris", uris });
    },
    true,
  );

  function composer() {
    return document.querySelector('[data-testid="composer-editor"]');
  }

  function whenComposer(run, attempt) {
    // A long draft collapses the composer into a preview; open it before typing into it.
    const expand = document.querySelector('button[aria-label="Expand composer"]');
    if (expand) expand.click();
    const editor = composer();
    if (editor) return run(editor);
    if ((attempt || 0) < 50) setTimeout(() => whenComposer(run, (attempt || 0) + 1), 100);
  }

  // File chips go through the composer's own drop handler, the path T3 Code's file tree uses.
  // The paths (with line ranges) already in the composer, read from its ProseMirror document, else
  // from the chips it renders.
  function mentionedPaths(editor) {
    const paths = new Set();
    const doc = editor.pmViewDesc && editor.pmViewDesc.node;
    if (doc && typeof doc.descendants === "function") {
      doc.descendants((node) => {
        if (node.type && node.type.name === "composer-mention" && node.attrs && node.attrs.path) paths.add(node.attrs.path);
      });
    }
    editor.querySelectorAll("[data-composer-mention][path]").forEach((chip) => paths.add(chip.getAttribute("path")));
    return paths;
  }

  // `[label](destination)` → the path the composer stores for it.
  function mentionPath(mention) {
    const match = /\]\(([^)]*)\)$/.exec(mention);
    if (!match) return mention;
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }

  function insertMentions(mentions) {
    whenComposer((editor) => {
      // ⌘L on the same file or lines again focuses the composer instead of adding a second chip.
      const present = mentionedPaths(editor);
      mentions = mentions.filter((mention) => !present.has(mentionPath(mention)));
      if (!mentions.length) {
        editor.focus();
        return;
      }
      const transfer = new DataTransfer();
      transfer.setData("application/x-t3code-composer-mention", mentions.join(" "));
      // Only `drop`: a synthetic dragenter would reach the window and leave T3 Code's file-drop overlay up.
      const drop = new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true });
      editor.dispatchEvent(drop);
      const claimed = drop.defaultPrevented;
      if (!claimed) {
        editor.focus();
        document.execCommand("insertText", false, mentions.join(" ") + " ");
      }
      setTimeout(() => editor.focus(), 50);
    });
  }

  // Typing needs the frame to have focus, which arrives just after the editor reveals the chat.
  function whenFocused(run) {
    if (document.hasFocus()) return run();
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      window.removeEventListener("focus", go);
      run();
    };
    window.addEventListener("focus", go);
    setTimeout(go, 800);
  }

  function insertText(text) {
    whenComposer((editor) =>
      whenFocused(() => {
        editor.focus();
        document.execCommand("insertText", false, text);
      }),
    );
  }

  // Runs one of T3 Code's own shortcuts (for example `mod+n` for chat.new) inside the app.
  function runShortcut(chordText) {
    if (typeof chordText !== "string" || !chordText) return;
    const parts = chordText.toLowerCase().split("+");
    const key = parts.pop();
    const codes = { "[": "BracketLeft", "]": "BracketRight", "-": "Minus", "=": "Equal", ",": "Comma", ".": "Period", "/": "Slash", ";": "Semicolon", "'": "Quote", "`": "Backquote", "\\": "Backslash" };
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    const init = {
      key: key.length === 1 ? key : key.charAt(0).toUpperCase() + key.slice(1),
      code: key.length === 1 && /[a-z]/.test(key) ? "Key" + key.toUpperCase() : /^[0-9]$/.test(key) ? "Digit" + key : codes[key],
      metaKey: parts.includes("cmd") || parts.includes("meta") || (parts.includes("mod") && mac),
      ctrlKey: parts.includes("ctrl") || parts.includes("control") || (parts.includes("mod") && !mac),
      altKey: parts.includes("alt") || parts.includes("option"),
      shiftKey: parts.includes("shift"),
      bubbles: true,
      cancelable: true,
    };
    const target = document.activeElement && document.activeElement !== document.body ? document.activeElement : document.body;
    target.dispatchEvent(new KeyboardEvent("keydown", init));
    target.dispatchEvent(new KeyboardEvent("keyup", init));
  }

  // Editor colors over T3 Code's tokens, so the chat sits in the editor like a native panel.
  function applyPalette(vars) {
    let style = document.getElementById("threadside-palette");
    if (!vars) {
      if (style) style.remove();
      return;
    }
    const map = {
      "--background": vars.background,
      "--foreground": vars.foreground,
      "--card": vars.card,
      "--popover": vars.popover,
      "--sidebar": vars.sidebar,
      "--sidebar-stage-fade": vars.sidebar,
      "--border": vars.border,
      "--sidebar-border": vars.border,
      "--muted-foreground": vars.mutedForeground,
      "--font-sans": vars.fontSans,
      "--font-mono": vars.fontMono,
    };
    const rules = Object.keys(map)
      .filter((name) => typeof map[name] === "string" && map[name] && !/[;{}<>]/.test(map[name]))
      .map((name) => name + ": " + map[name] + " !important;")
      .join(" ");
    if (!style) {
      style = document.createElement("style");
      style.id = "threadside-palette";
      (document.head || document.documentElement).appendChild(style);
    }
    style.textContent = ":root, :root.dark { " + rules + " }";
  }

  // Answers a picker that a shortcut opened (such as chat.new's project list) by choosing the row
  // titled `text`. The palette clears its query as it mounts, so it types only once the rows are
  // there, and it picks only an exact title: with no exact match the palette stays open for the user
  // rather than starting the thread in the wrong project. The row is chosen the way a person would,
  // with Enter on the highlighted row, and the bridge lets go as soon as the user clicks or types.
  function pickInPalette(text) {
    let userActed = false;
    const yieldToUser = (event) => {
      if (event.isTrusted) userActed = true;
    };
    window.addEventListener("pointerdown", yieldToUser, true);
    window.addEventListener("keydown", yieldToUser, true);
    const finish = () => {
      window.removeEventListener("pointerdown", yieldToUser, true);
      window.removeEventListener("keydown", yieldToUser, true);
    };
    const titleOf = (item) => ((item.querySelector(".truncate") || item).textContent || "").trim();
    let attempt = 0;
    (function step() {
      if (userActed || attempt++ > 60) return finish();
      const input = document.activeElement;
      const rows = [...document.querySelectorAll('[data-slot="command-item"]')];
      if (!(input instanceof HTMLInputElement) || !rows.length) return void setTimeout(step, 50);
      if (input.value !== text) {
        input.select();
        document.execCommand("insertText", false, text);
        return void setTimeout(step, 50);
      }
      const row = rows.find((item) => titleOf(item) === text);
      if (!row) return void setTimeout(step, 50);
      finish();
      if (row.hasAttribute("data-highlighted")) {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
      } else {
        row.click();
      }
    })();
  }

  // Beside the code the column is narrow: start with T3 Code's own thread sidebar closed so the
  // conversation gets the room (⌘B, or full screen, brings it back). Once per page load, with
  // T3 Code's own toggle, so its saved preference stays its own.
  function compactSidebar(attempt) {
    if (!state.compact || state.compacted || window.innerWidth >= 1000) return;
    const wrapper = document.querySelector('[data-slot="sidebar-wrapper"]');
    if (!wrapper) {
      if ((attempt || 0) < 50) setTimeout(() => compactSidebar((attempt || 0) + 1), 100);
      return;
    }
    state.compacted = true;
    if (wrapper.getAttribute("data-sidebar-state") !== "expanded") return;
    const trigger = wrapper.querySelector('[data-sidebar="trigger"]');
    if (trigger) trigger.click();
  }

  function navigate(path) {
    if (location.pathname + location.search === path) return;
    history.pushState(history.state, "", path);
    window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
  }

  window.addEventListener("message", (event) => {
    if (!trustedParent || event.source !== window.parent || event.origin !== parentOrigin) return;
    const message = event.data;
    if (!message || message.source !== HOST) return;
    switch (message.type) {
      case "config":
        state.shortcuts = Array.isArray(message.shortcuts) ? message.shortcuts : [];
        state.threadKeys = message.threadKeys && typeof message.threadKeys === "object" ? message.threadKeys : {};
        state.compact = message.compactChat !== false;
        compactSidebar();
        state.openFilesInEditor = message.openFilesInEditor !== false;
        state.sendEditorContext = message.sendEditorContext !== false;
        break;
      case "theme":
        if (message.theme !== state.theme) {
          state.theme = message.theme === "light" ? "light" : "dark";
          colorQueries.forEach((mql) => mql._notify());
        }
        break;
      case "navigate":
        navigate(message.path);
        break;
      case "mentions":
        if (Array.isArray(message.mentions) && message.mentions.length) insertMentions(message.mentions);
        break;
      case "insert":
        insertText(String(message.text || ""));
        break;
      case "focusComposer": {
        const editor = composer();
        if (editor) editor.focus();
        break;
      }
      case "ideContext":
        if (pendingSend && pendingSend.id === message.requestId) finishSend(message.context);
        break;
      case "notificationClick":
        clickNotification(message.id);
        break;
      case "palette":
        applyPalette(message.enabled ? message.vars : null);
        break;
      case "shortcut":
        // Wait for the app to mount (its composer exists) so its shortcut handlers are registered.
        whenComposer(() => {
          runShortcut(message.chord);
          if (typeof message.pick === "string" && message.pick) pickInPalette(message.pick);
        });
        break;
      default:
        break;
    }
  });

  window.addEventListener("focus", () => post({ type: "focus" }));
  window.addEventListener("blur", () => post({ type: "blur" }));
  document.addEventListener("DOMContentLoaded", () => {
    reportRoute();
    post({ type: "ready" });
    // VS Code's media library lacks AAC; Cursor's has it. The editor converts only what this one cannot play.
    post({ type: "mediaSupport", aac: document.createElement("video").canPlayType('audio/mp4; codecs="mp4a.40.2"') !== "" });
    reportedMode = undefined;
    reportNotificationMode();
  });
})();
