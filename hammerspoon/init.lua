-- init.lua
-- Entry point. Loads always-on modules and wires the app-profile manager.

-- Enable the `hs` shell IPC so external tools can introspect / reload.
pcall(require, "hs.ipc")
--
-- Always loaded:
--   lib/clamshell-sleep.lua       (untouched)
--   lib/window-manager.lua        (Cmd+arrow tiling)
--
-- App-profile manager:
--   lib/profile-manager.lua       (load + activate)
--   lib/profile-picker.lua        (hs.webview UI for new/edit)
--   lib/menubar.lua               (status item)
--
-- Global hotkeys:
--   ⌘⇧P  — activate-profile chooser (with modifier-driven boundary)
-- Chooser-only hotkeys (active while ⌘⇧P panel is open):
--   ⌘⇧R  — reactivate current profile

-- ----------------------------------------------------------------------
-- Always-on modules
-- ----------------------------------------------------------------------

local clamshellOk, clamshellErr = pcall(function()
    dofile(hs.configdir .. "/lib/clamshell-sleep.lua"):start()
end)
if not clamshellOk then
    hs.alert.show("Clamshell sleep failed: " .. tostring(clamshellErr), 5)
end

local wm = dofile(hs.configdir .. "/lib/window-manager.lua")
wm.start()

-- ----------------------------------------------------------------------
-- App-profile manager
-- ----------------------------------------------------------------------

local manager = dofile(hs.configdir .. "/lib/profile-manager.lua")
manager.start()

local picker = dofile(hs.configdir .. "/lib/profile-picker.lua")
picker.start(manager)

local menubar = dofile(hs.configdir .. "/lib/menubar.lua")

-- ----------------------------------------------------------------------
-- Chooser (⌘⇧P)
-- ----------------------------------------------------------------------

local HINT_TEXT = "⏎ additive  ·  ⇧⏎ hide  ·  ⌘⇧⏎ quit  ·  ⌘, edit  ·  ⌘⌫ delete"
local NEW_PROFILE_KEY = "__new__"

local profileChooser
local deleteTap

local function modifierBoundary(flags)
    local cmd   = flags and flags.cmd
    local shift = flags and flags.shift
    if cmd and shift then return "quit" end
    if shift then return "hide" end
    return "additive"
end

local function profileIconImage(profile)
    local p = manager.get(profile.slug)
    if not p or not p.apps or #p.apps == 0 then return nil end
    -- Honour an explicit iconBundle on the profile; otherwise fall back to the
    -- first app in the list.
    local bid = p.iconBundle
    if not bid or bid == "" then bid = p.apps[1].bundle end
    if not bid then return nil end
    local ok, img = pcall(hs.image.imageFromAppBundle, bid)
    if ok then return img end
    return nil
end

local function profileSubText(p)
    local full = manager.get(p.slug)
    if full and full.description and full.description ~= "" then
        return full.description
    end
    if full and full.apps and #full.apps > 0 then
        local names = {}
        for _, a in ipairs(full.apps) do
            table.insert(names, a.name or a.bundle or "?")
        end
        return table.concat(names, " + ")
    end
    return "Activate " .. p.name
end

local function newProfileIcon()
    local ok, img = pcall(hs.image.imageFromName, hs.image.systemImageNames.AddTemplate)
    if ok then return img end
    return nil
end

local currentChoices = {}

local function refreshChoices()
    if not profileChooser then return end
    currentChoices = {}
    for _, p in ipairs(manager.list()) do
        local label = (p.icon ~= "" and (p.icon .. "  ") or "") .. p.name
        table.insert(currentChoices, {
            text = label,
            subText = profileSubText(p),
            slug = p.slug,
            image = profileIconImage(p),
        })
    end
    table.insert(currentChoices, {
        text = "New profile…",
        subText = "Open the picker to create a new app context",
        slug = NEW_PROFILE_KEY,
        image = newProfileIcon(),
    })
    profileChooser:choices(currentChoices)
end

local function confirmDelete(slug, name)
    local button = hs.dialog.blockAlert(
        "Delete profile?",
        "This will remove profiles/" .. slug .. ".lua. Hooks sidecar (if any) is also removed.",
        "Delete",
        "Cancel",
        "warning"
    )
    if button == "Delete" then
        if manager.delete(slug) then
            hs.alert.show("Deleted " .. (name or slug), 2)
            refreshChoices()
        end
    end
end

local pickerCameFromChooser = false

profileChooser = hs.chooser.new(function(choice)
    -- Use the modifier state captured at Enter time (lastSubmitFlags), falling
    -- back to the live state if the user dismissed via mouse click.
    local flags = lastSubmitFlags or hs.eventtap.checkKeyboardModifiers() or {}
    lastSubmitFlags = nil
    if not choice then return end
    if choice.slug == NEW_PROFILE_KEY then
        pickerCameFromChooser = true
        picker.openNew()
        return
    end
    if flags.alt then
        pickerCameFromChooser = true
        picker.openEdit(choice.slug)
    else
        manager.activate(choice.slug, modifierBoundary(flags))
    end
end)
profileChooser:placeholderText(HINT_TEXT)
profileChooser:searchSubText(true)
profileChooser:width(28)
profileChooser:rows(8)
profileChooser:bgDark(true)
profileChooser:fgColor({ hex = "#f0f0f3" })
profileChooser:subTextColor({ hex = "#98989d" })

local KEY_DELETE   = 51  -- backspace
local KEY_COMMA    = 43
local KEY_RETURN   = 36
local KEY_KP_ENTER = 76
local KEY_R        = 15

-- Modifier state captured at the moment Enter is pressed.  Read it inside the
-- chooser's completion callback (where checkKeyboardModifiers() returns the
-- *current* state, which is typically empty by then — the user already
-- released the keys).
local lastSubmitFlags = nil

deleteTap = hs.eventtap.new({ hs.eventtap.event.types.keyDown }, function(e)
    local keyCode = e:getKeyCode()
    local flags   = e:getFlags()

    if keyCode == KEY_RETURN or keyCode == KEY_KP_ENTER then
        lastSubmitFlags = {
            cmd   = flags.cmd   or false,
            shift = flags.shift or false,
            alt   = flags.alt   or false,
            ctrl  = flags.ctrl  or false,
        }
        return false  -- let the chooser handle Enter normally
    end

    if keyCode == KEY_R
        and flags.cmd and flags.shift
        and not flags.alt and not flags.ctrl
    then
        profileChooser:hide()
        hs.timer.doAfter(0.05, function() manager.reactivate() end)
        return true
    end

    if keyCode ~= KEY_DELETE and keyCode ~= KEY_COMMA then return false end
    if not (flags.cmd and not flags.shift and not flags.alt and not flags.ctrl) then
        return false
    end
    local row = profileChooser:selectedRow()
    local entry = currentChoices[row]
    if not (entry and entry.slug and entry.slug ~= NEW_PROFILE_KEY) then
        return false
    end
    if keyCode == KEY_DELETE then
        profileChooser:hide()
        hs.timer.doAfter(0.05, function() confirmDelete(entry.slug, entry.text) end)
        return true
    elseif keyCode == KEY_COMMA then
        profileChooser:hide()
        pickerCameFromChooser = true
        hs.timer.doAfter(0.05, function() picker.openEdit(entry.slug) end)
        return true
    end
    return false
end)

profileChooser:showCallback(function() if deleteTap then deleteTap:start() end end)
profileChooser:hideCallback(function() if deleteTap then deleteTap:stop() end end)

local function openChooser()
    refreshChoices()
    profileChooser:query("")
    profileChooser:show()
end

manager.onChange(refreshChoices)
refreshChoices()

-- ----------------------------------------------------------------------
-- Menu bar
-- ----------------------------------------------------------------------

menubar.start({
    manager = manager,
    picker = picker,
    openChooser = openChooser,
})

-- ----------------------------------------------------------------------
-- Hotkeys
-- ----------------------------------------------------------------------

hs.hotkey.bind({ "cmd", "shift" }, "P", openChooser)

picker.onClose(function()
    if pickerCameFromChooser then
        pickerCameFromChooser = false
        hs.timer.doAfter(0.05, openChooser)
    end
end)

-- ----------------------------------------------------------------------
-- Debug handle (for `hs -c` introspection)
-- ----------------------------------------------------------------------

_G.AppProfileManager = {
    manager = manager,
    picker = picker,
    menubar = menubar,
    openChooser = openChooser,
    chooser = profileChooser,
    wm = wm,
}

-- ----------------------------------------------------------------------
-- Load notification
-- ----------------------------------------------------------------------

hs.alert.show("App-profile manager loaded\n⌘⇧P", 2)
