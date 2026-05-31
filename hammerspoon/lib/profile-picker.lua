-- lib/profile-picker.lua
-- hs.webview-based UI for creating and editing app profiles.
--
-- Public API:
--   start(mgr)       -- wire to profile-manager module
--   openNew()        -- empty picker for a new profile
--   openEdit(slug)   -- picker pre-populated from profiles/<slug>.lua
--   close()
--
-- The webview hosts an HTML/CSS/JS UI. Communication is two-way:
--   Lua → JS: webview:evaluateJavaScript("...")
--   JS  → Lua: window.webkit.messageHandlers.picker.postMessage({...})

local alwaysOn = dofile(hs.configdir .. "/lib/always-on.lua")

local M = {}

M.debug = false

local mgr = nil
local webview = nil
local controller = nil
local catalogCache = nil
local closeCallbacks = {}

local function log(msg)
    if M.debug then print("[profile-picker] " .. tostring(msg)) end
end

-- ----------------------------------------------------------------------
-- App catalog (installed user-facing apps)
-- ----------------------------------------------------------------------

local function readBundleInfo(path)
    local plistPath = path .. "/Contents/Info.plist"
    local ok, info = pcall(hs.plist.read, plistPath)
    if not ok or type(info) ~= "table" then return nil end
    if info.LSUIElement == true or info.LSUIElement == "1" then return nil end
    if info.LSBackgroundOnly == true or info.LSBackgroundOnly == "1" then return nil end
    local bundle = info.CFBundleIdentifier
    if not bundle then return nil end
    local name = info.CFBundleDisplayName
        or info.CFBundleName
        or path:match("([^/]+)%.app$")
        or bundle
    return { bundle = bundle, name = name, path = path }
end

local function scanAppsIn(dir)
    local results = {}
    local attrs = hs.fs.attributes(dir)
    if not attrs then return results end
    for entry in hs.fs.dir(dir) do
        if entry:match("%.app$") then
            local appPath = dir .. "/" .. entry
            local info = readBundleInfo(appPath)
            if info then table.insert(results, info) end
        end
    end
    return results
end

local function buildCatalog()
    local apps = {}
    local seen = {}
    local home = os.getenv("HOME") or ""

    for _, dir in ipairs({ "/Applications", home .. "/Applications" }) do
        for _, app in ipairs(scanAppsIn(dir)) do
            if not seen[app.bundle] then
                seen[app.bundle] = true
                table.insert(apps, app)
            end
        end
    end

    -- Catch user-facing running apps not on disk (rare, e.g. /System/Applications).
    for _, runApp in ipairs(hs.application.runningApplications()) do
        if alwaysOn.isUserFacing(runApp) then
            local ok, bid = pcall(function() return runApp:bundleID() end)
            if ok and bid and not seen[bid] then
                seen[bid] = true
                table.insert(apps, {
                    bundle = bid,
                    name = runApp:name() or bid,
                    path = runApp:path() or "",
                })
            end
        end
    end

    table.sort(apps, function(a, b)
        return (a.name or ""):lower() < (b.name or ""):lower()
    end)
    return apps
end

local function isInUserExtras(bundle, name)
    for _, entry in ipairs(alwaysOn.userExtras) do
        if entry == bundle or entry == name then return true end
    end
    return false
end

-- ----------------------------------------------------------------------
-- HTML/CSS/JS
-- ----------------------------------------------------------------------

local HTML_TEMPLATE = [[<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Profile</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f6f6f7;
    --fg: #1a1a1c;
    --muted: #6b6b70;
    --border: #d8d8db;
    --accent: #007aff;
    --row-hover: rgba(0,0,0,0.04);
    --row-selected: rgba(0,122,255,0.12);
    --field-bg: #ffffff;
    --button-bg: #ffffff;
    --button-fg: #1a1a1c;
    --button-primary-bg: #007aff;
    --button-primary-fg: #ffffff;
    --shadow: 0 1px 0 rgba(0,0,0,0.06), 0 0 0 1px rgba(0,0,0,0.04);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #1e1e20;
      --fg: #f0f0f3;
      --muted: #98989d;
      --border: #3a3a3d;
      --accent: #0a84ff;
      --row-hover: rgba(255,255,255,0.05);
      --row-selected: rgba(10,132,255,0.20);
      --field-bg: #2c2c2f;
      --button-bg: #38383c;
      --button-fg: #f0f0f3;
      --button-primary-bg: #0a84ff;
      --button-primary-fg: #ffffff;
      --shadow: 0 1px 0 rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.05);
    }
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    height: 100%;
    background: var(--bg);
    color: var(--fg);
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Helvetica Neue", sans-serif;
    font-size: 13px;
    -webkit-font-smoothing: antialiased;
    -webkit-user-select: none;
    user-select: none;
  }
  .root {
    display: flex;
    flex-direction: column;
    height: 100%;
    padding: 20px 22px 16px 22px;
    gap: 14px;
  }
  h1 {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  .meta {
    display: grid;
    grid-template-columns: 80px 1fr;
    gap: 10px 14px;
    align-items: center;
  }
  .meta label {
    color: var(--muted);
    font-size: 12px;
    text-align: right;
  }
  .meta input[type="text"] {
    background: var(--field-bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 7px 9px;
    font-size: 13px;
    font-family: inherit;
    outline: none;
  }
  .meta input[type="text"]:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px rgba(10,132,255,0.20);
  }
  #icon { width: 60px; text-align: center; font-size: 18px; }
  .filter-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: nowrap;
  }
  #filter {
    flex: 1;
    background: var(--field-bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 7px 9px;
    font-size: 13px;
    font-family: inherit;
    outline: none;
    min-width: 100px;
  }
  #filter:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px rgba(10,132,255,0.20);
  }
  .toggle-btn {
    appearance: none;
    border: 1px solid var(--border);
    background: var(--button-bg);
    color: var(--button-fg);
    border-radius: 6px;
    padding: 6px 10px;
    font-size: 12px;
    font-family: inherit;
    cursor: pointer;
    white-space: nowrap;
  }
  .toggle-btn:hover { filter: brightness(1.08); }
  .toggle-btn.active {
    background: var(--accent);
    color: white;
    border-color: var(--accent);
  }
  .toggle-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .counter {
    color: var(--muted);
    font-size: 11px;
    white-space: nowrap;
    margin-left: 4px;
  }
  .list-wrap {
    flex: 1;
    min-height: 0;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--field-bg);
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .list {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
  }
  .row {
    display: flex;
    flex-direction: column;
    cursor: pointer;
    border-bottom: 1px solid rgba(127,127,127,0.08);
  }
  .row-main {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 12px;
  }
  .row:last-child { border-bottom: none; }
  .row:hover { background: var(--row-hover); }
  .row.checked { background: var(--row-selected); }
  .row.disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }
  .row.disabled:hover { background: transparent; }
  .row-args {
    display: none;
    padding: 0 12px 8px 38px;
  }
  .row.checked:not(.disabled) .row-args { display: flex; }
  .row-args input {
    flex: 1;
    background: var(--field-bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 5px 8px;
    font-size: 12px;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    outline: none;
  }
  .row-args input:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px rgba(10,132,255,0.18);
  }
  .check {
    width: 16px; height: 16px;
    flex: 0 0 16px;
    border: 1.5px solid var(--muted);
    border-radius: 4px;
    display: flex; align-items: center; justify-content: center;
    background: transparent;
  }
  .row.checked .check {
    background: var(--accent);
    border-color: var(--accent);
  }
  .row.checked .check::after {
    content: "✓";
    color: white;
    font-size: 11px;
    font-weight: 700;
    line-height: 1;
  }
  .row.disabled .check {
    border-style: dashed;
  }
  .name { flex: 1; }
  .bundle {
    color: var(--muted);
    font-size: 11px;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    text-align: right;
    max-width: 260px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .always-on-tag {
    color: var(--muted);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 1px 5px;
  }
  .star {
    width: 20px; height: 20px;
    line-height: 20px;
    text-align: center;
    font-size: 14px;
    cursor: pointer;
    color: var(--muted);
    opacity: 0;
    transition: opacity 0.12s ease, color 0.12s ease, transform 0.08s ease;
    user-select: none;
    flex: 0 0 20px;
  }
  .row.checked .star { opacity: 0.35; }
  .row.checked .star:hover { opacity: 0.85; transform: scale(1.15); }
  .row.checked .star.active { opacity: 1; color: #f5b400; }
  .row.disabled .star { display: none; }
  .commands-wrap {
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--field-bg);
    max-height: 180px;
    overflow-y: auto;
  }
  .commands-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 10px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
    border-bottom: 1px solid rgba(127,127,127,0.10);
    position: sticky;
    top: 0;
    background: var(--field-bg);
    z-index: 1;
  }
  .commands-header button {
    appearance: none;
    background: transparent;
    border: 1px solid var(--border);
    color: var(--fg);
    border-radius: 5px;
    padding: 3px 8px;
    font-size: 11px;
    cursor: pointer;
  }
  .commands-header button:hover { filter: brightness(1.1); }
  .commands-empty {
    padding: 12px;
    color: var(--muted);
    font-size: 12px;
    text-align: center;
  }
  .command-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 10px;
    border-bottom: 1px solid rgba(127,127,127,0.06);
  }
  .command-row:last-child { border-bottom: none; }
  .command-row input {
    background: transparent;
    color: var(--fg);
    border: 1px solid transparent;
    border-radius: 5px;
    padding: 4px 7px;
    font-size: 12px;
    font-family: inherit;
    outline: none;
  }
  .command-row input:hover { border-color: rgba(127,127,127,0.18); }
  .command-row input:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px rgba(10,132,255,0.18);
    background: var(--bg);
  }
  .command-row .cmd-name {
    flex: 0 0 140px;
  }
  .command-row .cmd-text {
    flex: 1;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
  }
  .command-row .cmd-remove {
    appearance: none;
    background: transparent;
    border: none;
    color: var(--muted);
    cursor: pointer;
    font-size: 16px;
    line-height: 16px;
    padding: 0 4px;
  }
  .command-row .cmd-remove:hover { color: #ff453a; }
  .footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 10px;
  }
  .hint {
    color: var(--muted);
    font-size: 11px;
  }
  .buttons {
    display: flex;
    gap: 8px;
  }
  button {
    appearance: none;
    border: 1px solid var(--border);
    background: var(--button-bg);
    color: var(--button-fg);
    border-radius: 6px;
    padding: 6px 14px;
    font-size: 13px;
    font-family: inherit;
    cursor: pointer;
  }
  button:hover { filter: brightness(0.96); }
  button.primary {
    background: var(--button-primary-bg);
    color: var(--button-primary-fg);
    border-color: var(--button-primary-bg);
    font-weight: 500;
  }
  button.primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
</head>
<body>
<div class="root">
  <h1 id="title">New Profile</h1>
  <div class="meta">
    <label for="name">Name</label>
    <input id="name" type="text" placeholder="Learn">
    <label for="icon">Icon</label>
    <input id="icon" type="text" placeholder="📖" maxlength="4">
    <label for="description">Description</label>
    <input id="description" type="text" placeholder="Optional — shown in the chooser">
  </div>
  <div class="filter-row">
    <input id="filter" type="text" placeholder="Filter apps…">
    <button id="show-selected" class="toggle-btn" type="button">Show selected</button>
    <button id="deselect-all" class="toggle-btn" type="button">Deselect all</button>
    <span id="counter" class="counter">0 selected</span>
  </div>
  <div class="list-wrap">
    <div class="list" id="list"></div>
  </div>
  <div class="commands-wrap">
    <div class="commands-header">
      <span>Custom commands</span>
      <button id="add-command" type="button">+ Add command</button>
    </div>
    <div id="commands-list"></div>
  </div>
  <div class="footer">
    <span class="hint">Click ★ on a selected app to use its icon for the profile.</span>
    <div class="buttons">
      <button id="cancel">Cancel</button>
      <button id="save" class="primary">Save</button>
    </div>
  </div>
</div>
<script>
"use strict";
const STATE = __INITIAL__;
const post = (msg) => window.webkit.messageHandlers.picker.postMessage(msg);

const $ = (id) => document.getElementById(id);
const nameInput = $("name");
const iconInput = $("icon");
const descInput = $("description");
const filterInput = $("filter");
const counterEl = $("counter");
const listEl = $("list");
const saveBtn = $("save");
const cancelBtn = $("cancel");
const titleEl = $("title");

const selected = new Set(STATE.selectedBundles || []);
const argsByBundle = Object.assign({}, STATE.argsByBundle || {});
const commands = (STATE.commands || []).map(c => ({ name: c.name || "", command: c.command || "" }));
let iconBundle = STATE.iconBundle || null;
let filterText = "";
let showSelectedOnly = false;

function render() {
  listEl.innerHTML = "";
  const ft = filterText.trim().toLowerCase();
  const rows = STATE.apps.filter(a => {
    if (showSelectedOnly && !selected.has(a.bundle)) return false;
    if (!ft) return true;
    return (a.name || "").toLowerCase().includes(ft)
        || (a.bundle || "").toLowerCase().includes(ft);
  });
  for (const a of rows) {
    const row = document.createElement("div");
    row.className = "row";
    if (a.alwaysOn) row.classList.add("disabled");
    if (selected.has(a.bundle)) row.classList.add("checked");
    row.dataset.bundle = a.bundle;

    const main = document.createElement("div");
    main.className = "row-main";

    const check = document.createElement("div");
    check.className = "check";
    main.appendChild(check);

    const name = document.createElement("div");
    name.className = "name";
    name.textContent = a.name;
    main.appendChild(name);

    if (a.alwaysOn) {
      const tag = document.createElement("span");
      tag.className = "always-on-tag";
      tag.textContent = "always on";
      main.appendChild(tag);
    } else {
      const bid = document.createElement("div");
      bid.className = "bundle";
      bid.textContent = a.bundle;
      main.appendChild(bid);

      const star = document.createElement("div");
      star.className = "star" + (iconBundle === a.bundle ? " active" : "");
      star.textContent = "★";
      star.title = "Use this app's icon for the profile";
      star.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (!selected.has(a.bundle)) return;
        iconBundle = (iconBundle === a.bundle) ? null : a.bundle;
        render();
      });
      main.appendChild(star);
    }

    main.addEventListener("click", () => {
      if (a.alwaysOn) return;
      if (selected.has(a.bundle)) {
        selected.delete(a.bundle);
        if (iconBundle === a.bundle) iconBundle = null;
      } else {
        selected.add(a.bundle);
      }
      updateCounter();
      render();
    });
    row.appendChild(main);

    if (!a.alwaysOn) {
      const argsRow = document.createElement("div");
      argsRow.className = "row-args";
      const argsInput = document.createElement("input");
      argsInput.type = "text";
      argsInput.placeholder = "launch args (e.g. --minimized) — only used on first launch";
      argsInput.value = argsByBundle[a.bundle] || "";
      argsInput.addEventListener("click", (ev) => ev.stopPropagation());
      argsInput.addEventListener("input", (ev) => {
        const v = ev.target.value;
        if (v) argsByBundle[a.bundle] = v;
        else delete argsByBundle[a.bundle];
      });
      argsRow.appendChild(argsInput);
      row.appendChild(argsRow);
    }

    listEl.appendChild(row);
  }
  updateCounter();
}

function updateCounter() {
  const n = selected.size;
  counterEl.textContent = n + " selected";
  saveBtn.disabled = !nameInput.value.trim();
}

filterInput.addEventListener("input", (e) => {
  filterText = e.target.value;
  render();
});
nameInput.addEventListener("input", updateCounter);

const commandsListEl = $("commands-list");
const addCommandBtn = $("add-command");

function renderCommands() {
  commandsListEl.innerHTML = "";
  if (commands.length === 0) {
    const empty = document.createElement("div");
    empty.className = "commands-empty";
    empty.textContent = "No custom commands. Click “+ Add command” to run shell commands when this profile activates.";
    commandsListEl.appendChild(empty);
    return;
  }
  commands.forEach((c, idx) => {
    const row = document.createElement("div");
    row.className = "command-row";

    const nameInp = document.createElement("input");
    nameInp.className = "cmd-name";
    nameInp.type = "text";
    nameInp.placeholder = "Name";
    nameInp.value = c.name;
    nameInp.addEventListener("input", (ev) => { commands[idx].name = ev.target.value; });

    const cmdInp = document.createElement("input");
    cmdInp.className = "cmd-text";
    cmdInp.type = "text";
    cmdInp.placeholder = "Shell command (e.g. open -na Ghostty --args -e fish -ic mycmd)";
    cmdInp.value = c.command;
    cmdInp.addEventListener("input", (ev) => { commands[idx].command = ev.target.value; });

    const remove = document.createElement("button");
    remove.className = "cmd-remove";
    remove.type = "button";
    remove.textContent = "×";
    remove.title = "Remove this command";
    remove.addEventListener("click", () => {
      commands.splice(idx, 1);
      renderCommands();
    });

    row.appendChild(nameInp);
    row.appendChild(cmdInp);
    row.appendChild(remove);
    commandsListEl.appendChild(row);
  });
}

addCommandBtn.addEventListener("click", () => {
  commands.push({ name: "", command: "" });
  renderCommands();
  const inputs = commandsListEl.querySelectorAll(".command-row input.cmd-name");
  if (inputs.length) inputs[inputs.length - 1].focus();
});

const showSelectedBtn = $("show-selected");
const deselectAllBtn = $("deselect-all");

function syncToggleButtons() {
  showSelectedBtn.classList.toggle("active", showSelectedOnly);
  showSelectedBtn.textContent = showSelectedOnly ? "Show all" : "Show selected";
  deselectAllBtn.disabled = selected.size === 0;
}

showSelectedBtn.addEventListener("click", () => {
  showSelectedOnly = !showSelectedOnly;
  syncToggleButtons();
  render();
});

deselectAllBtn.addEventListener("click", () => {
  selected.clear();
  iconBundle = null;
  showSelectedOnly = false;
  syncToggleButtons();
  render();
});

cancelBtn.addEventListener("click", () => post({ action: "cancel" }));
saveBtn.addEventListener("click", () => {
  const apps = STATE.apps
    .filter(a => selected.has(a.bundle) && !a.alwaysOn)
    .map(a => {
      const out = { bundle: a.bundle, name: a.name };
      const argv = (argsByBundle[a.bundle] || "").trim();
      if (argv) out.args = argv;
      return out;
    });
  let outIconBundle = iconBundle;
  if (outIconBundle && !apps.some(a => a.bundle === outIconBundle)) {
    outIconBundle = null;
  }
  const cleanCommands = commands
    .map(c => ({ name: (c.name || "").trim(), command: (c.command || "").trim() }))
    .filter(c => c.command !== "");
  post({
    action: "save",
    slug: STATE.slug || null,
    name: nameInput.value.trim(),
    icon: iconInput.value.trim(),
    description: descInput.value.trim(),
    iconBundle: outIconBundle,
    apps: apps,
    commands: cleanCommands,
  });
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { post({ action: "cancel" }); }
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { saveBtn.click(); }
});

// Init
titleEl.textContent = STATE.slug ? ("Edit " + (STATE.name || STATE.slug)) : "New Profile";
nameInput.value = STATE.name || "";
iconInput.value = STATE.icon || "";
descInput.value = STATE.description || "";
syncToggleButtons();
render();
renderCommands();
setTimeout(() => nameInput.focus(), 30);
</script>
</body>
</html>
]]

local function renderHTML(state)
    local json = hs.json.encode(state, true) or "{}"
    -- gsub replacement is interpreted (% has meaning); use a function replacement to keep json verbatim.
    return (HTML_TEMPLATE:gsub("__INITIAL__", function() return json end))
end

-- ----------------------------------------------------------------------
-- Webview lifecycle
-- ----------------------------------------------------------------------

local function buildState(existing)
    if not catalogCache then catalogCache = buildCatalog() end
    local selectedBundles = {}
    if existing and existing.apps then
        for _, entry in ipairs(existing.apps) do
            if entry.bundle then table.insert(selectedBundles, entry.bundle) end
        end
    end
    local apps = {}
    for _, a in ipairs(catalogCache) do
        table.insert(apps, {
            bundle = a.bundle,
            name = a.name,
            alwaysOn = isInUserExtras(a.bundle, a.name),
        })
    end
    -- Ensure any selected bundle we don't have in the catalog (uninstalled?) still shows up.
    if existing and existing.apps then
        local seen = {}
        for _, a in ipairs(apps) do seen[a.bundle] = true end
        for _, entry in ipairs(existing.apps) do
            if entry.bundle and not seen[entry.bundle] then
                table.insert(apps, {
                    bundle = entry.bundle,
                    name = (entry.name or entry.bundle) .. "  (not installed)",
                    alwaysOn = false,
                })
            end
        end
        table.sort(apps, function(a, b) return (a.name or ""):lower() < (b.name or ""):lower() end)
    end

    local argsByBundle = {}
    if existing and existing.apps then
        for _, entry in ipairs(existing.apps) do
            if entry.bundle and entry.args and entry.args ~= "" then
                argsByBundle[entry.bundle] = entry.args
            end
        end
    end

    local commands = {}
    if existing and existing.commands then
        for _, c in ipairs(existing.commands) do
            table.insert(commands, { name = c.name or "", command = c.command or "" })
        end
    end

    return {
        slug = existing and existing.slug or nil,
        name = existing and existing.name or "",
        icon = existing and existing.icon or "",
        description = existing and existing.description or "",
        iconBundle = existing and existing.iconBundle or nil,
        apps = apps,
        selectedBundles = selectedBundles,
        argsByBundle = argsByBundle,
        commands = commands,
    }
end

local function handleMessage(payload)
    if type(payload) ~= "table" then return end
    local body = payload.body
    if type(body) ~= "table" then return end

    if body.action == "cancel" then
        M.close()
    elseif body.action == "save" then
        if not mgr then
            hs.alert.show("Profile manager not wired", 3)
            M.close()
            return
        end
        local saved = mgr.save({
            slug = body.slug,
            name = body.name,
            icon = body.icon,
            description = body.description,
            iconBundle = body.iconBundle,
            apps = body.apps or {},
            commands = body.commands or {},
        })
        if saved then
            hs.alert.show("Saved profile: " .. (body.name or saved), 2)
            M.close()
        end
    end
end

local function activeScreenFrame()
    -- Prefer the screen of the focused window; fall back to the one with the
    -- mouse cursor; finally hs.screen.mainScreen(). Picks the screen the user
    -- is actually looking at, not whichever display Hammerspoon chose.
    local fw = hs.window.focusedWindow()
    if fw then
        local s = fw:screen()
        if s then return s:frame() end
    end
    local mouseScreen = hs.mouse.getCurrentScreen and hs.mouse.getCurrentScreen() or nil
    if mouseScreen then return mouseScreen:frame() end
    return hs.screen.mainScreen():frame()
end

local function centeredFrame(w, h)
    local screen = activeScreenFrame()
    return {
        x = screen.x + (screen.w - w) / 2,
        y = screen.y + (screen.h - h) / 2,
        w = w, h = h,
    }
end

local function open(state)
    M.close()

    controller = hs.webview.usercontent.new("picker")
    controller:setCallback(handleMessage)

    local prefs = { developerExtrasEnabled = false }
    webview = hs.webview.new(centeredFrame(620, 560), prefs, controller)
        :windowStyle({ "titled", "closable" })
        :windowTitle("Profile Picker")
        :allowTextEntry(true)
        :level(hs.drawing.windowLevels.modalPanel)
        :shadow(true)
        :html(renderHTML(state))
        :show()

    -- Bring focus.
    hs.timer.doAfter(0.05, function()
        if webview then webview:bringToFront(true) end
    end)
end

function M.openNew()
    open(buildState(nil))
end

function M.openEdit(slug)
    if not mgr then
        hs.alert.show("Profile manager not wired")
        return
    end
    local p = mgr.get(slug)
    if not p then
        hs.alert.show("No profile named " .. tostring(slug))
        return
    end
    open(buildState(p))
end

function M.close()
    local wasOpen = webview ~= nil
    if webview then
        pcall(function() webview:delete() end)
        webview = nil
    end
    controller = nil
    if wasOpen then
        for _, cb in ipairs(closeCallbacks) do
            pcall(cb)
        end
    end
end

function M.onClose(cb)
    table.insert(closeCallbacks, cb)
end

function M.refreshCatalog()
    catalogCache = nil
end

function M.start(profileManager)
    mgr = profileManager
end

return M
