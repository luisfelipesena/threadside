// Threadside bridge: loaded by the proxy into T3 Code's own web app, before the app's module.
// It connects the app to the editor through the webview host page (window.parent) and never
// sees credentials. Messages from the host are accepted only from window.parent.
(function () {
  "use strict";
  if (window.__threadside) return;
  const HOST = "threadside-host";
  const BRIDGE = "threadside-bridge";
  const state = {
    editorKeys: [],
    openFilesInEditor: true,
    theme: readCookie("threadside_theme") === "light" ? "light" : "dark",
  };
  window.__threadside = { version: 1 };

  function readCookie(name) {
    const match = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
    return match ? decodeURIComponent(match[1]) : undefined;
  }

  function post(message) {
    if (window.parent !== window) window.parent.postMessage(Object.assign({ source: BRIDGE }, message), "*");
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

  // Keys: T3 Code handles its own shortcuts first. Keys it leaves alone, and the editor's
  // reserved shortcuts, go to the editor so Cmd+P, Cmd+Shift+P and friends keep working.
  function chord(event) {
    const parts = [];
    if (event.metaKey || event.ctrlKey) parts.push("mod");
    if (event.altKey) parts.push("alt");
    if (event.shiftKey) parts.push("shift");
    parts.push(event.key.length === 1 ? event.key.toLowerCase() : event.key.toLowerCase());
    return parts.join("+");
  }
  function forwardKey(event) {
    post({
      type: "key",
      key: event.key,
      code: event.code,
      keyCode: event.keyCode,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      repeat: event.repeat,
    });
  }
  window.addEventListener(
    "keydown",
    (event) => {
      if (!(event.metaKey || event.ctrlKey || /^F\d+$/.test(event.key))) return;
      // ⌘N: the editor starts the thread, so it lands in the open thread's (or workspace's) repository.
      if (chord(event) === "mod+n") {
        event.preventDefault();
        event.stopImmediatePropagation();
        post({ type: "command", command: "newThread" });
        return;
      }
      if (state.editorKeys.includes(chord(event))) {
        event.preventDefault();
        event.stopImmediatePropagation();
        forwardKey(event);
        return;
      }
      setTimeout(() => {
        if (!event.defaultPrevented) forwardKey(event);
      }, 0);
    },
    true,
  );

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
  function insertMentions(mentions) {
    whenComposer((editor) => {
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

  function insertText(text) {
    whenComposer((editor) => {
      editor.focus();
      document.execCommand("insertText", false, text);
    });
  }

  // Runs one of T3 Code's own shortcuts (for example `mod+n` for chat.new) inside the app.
  function runShortcut(chordText) {
    if (typeof chordText !== "string" || !chordText) return;
    const parts = chordText.toLowerCase().split("+");
    const key = parts.pop();
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    const init = {
      key: key.length === 1 ? key : key.charAt(0).toUpperCase() + key.slice(1),
      code: key.length === 1 && /[a-z]/.test(key) ? "Key" + key.toUpperCase() : undefined,
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

  // Answers a picker that a shortcut opened (such as chat.new's project list) by typing and choosing.
  function pickInPalette(text, attempt) {
    const input = document.activeElement;
    if (!(input instanceof HTMLInputElement)) {
      if ((attempt || 0) < 20) setTimeout(() => pickInPalette(text, (attempt || 0) + 1), 50);
      return;
    }
    input.focus();
    document.execCommand("insertText", false, text);
    setTimeout(() => {
      const init = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
      input.dispatchEvent(new KeyboardEvent("keydown", init));
      input.dispatchEvent(new KeyboardEvent("keyup", init));
    }, 150);
  }

  function navigate(path) {
    if (location.pathname + location.search === path) return;
    history.pushState(history.state, "", path);
    window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (!message || message.source !== HOST) return;
    switch (message.type) {
      case "config":
        state.editorKeys = Array.isArray(message.editorKeys) ? message.editorKeys : [];
        state.openFilesInEditor = message.openFilesInEditor !== false;
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
  document.addEventListener("DOMContentLoaded", () => {
    reportRoute();
    post({ type: "ready" });
  });
})();
