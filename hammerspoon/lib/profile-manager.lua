-- lib/profile-manager.lua
-- Loads, activates, and tracks app profiles.
-- Active profile is in-memory only (cleared on Hammerspoon reload).
--
-- Public API:
--   start()                         -- enumerate profiles/ and prime the cache
--   reload()                        -- rescan profiles/
--   list()                          -- {{slug, name, icon, description}, ...}
--   get(slug)                       -- full profile table, or nil
--   activate(slug, boundary)        -- boundary = "quit" | "hide" | "additive"
--   reactivate()                    -- replay last activation
--   delete(slug)
--   getActive()                     -- {slug, name, lastBoundary} or nil
--   addAppToActive(app)             -- append given app to active profile's file
--   onChange(cb)                    -- register callback; fires after list mutates / active changes

local alwaysOn = dofile(hs.configdir .. "/lib/always-on.lua")
local wm = nil  -- lazily resolved to avoid require cycles
local function getWM()
    if not wm then
        local ok, mod = pcall(dofile, hs.configdir .. "/lib/window-manager.lua")
        if ok then wm = mod end
    end
    return wm
end

local M = {}

M.debug = false
M.launchTimeoutSec = 6.0
M.quitTimeoutSec = 4.0

local PROFILES_DIR = hs.configdir .. "/profiles"

-- slug -> profile table
local profiles = {}
-- {slug, name, lastBoundary} or nil
local active = nil
-- list of () -> () callbacks
local changeCallbacks = {}

local function log(msg)
    if M.debug then
        print("[profile-manager] " .. tostring(msg))
    end
end

local function alert(msg, dur)
    hs.alert.show(msg, dur or 3)
    log(msg)
end

local function notifyChange()
    for _, cb in ipairs(changeCallbacks) do
        local ok, err = pcall(cb)
        if not ok then log("change callback error: " .. tostring(err)) end
    end
end

local function slugify(name)
    local s = name:lower():gsub("[^%w]+", "-"):gsub("^%-+", ""):gsub("%-+$", "")
    if s == "" then s = "profile" end
    return s
end

-- ----------------------------------------------------------------------
-- Loading
-- ----------------------------------------------------------------------

local function profileFilePath(slug)
    return PROFILES_DIR .. "/" .. slug .. ".lua"
end

local function hooksFilePath(slug)
    return PROFILES_DIR .. "/" .. slug .. ".hooks.lua"
end

local function loadHooks(slug)
    local path = hooksFilePath(slug)
    local f = io.open(path, "r")
    if not f then return {} end
    f:close()
    local ok, hooks = pcall(dofile, path)
    if not ok then
        alert("Hooks file " .. slug .. ".hooks.lua failed to load:\n" .. tostring(hooks), 5)
        return {}
    end
    if type(hooks) ~= "table" then
        alert("Hooks file " .. slug .. ".hooks.lua did not return a table")
        return {}
    end
    return hooks
end

local function loadProfile(slug)
    local path = profileFilePath(slug)
    local ok, data = pcall(dofile, path)
    if not ok then
        alert("Profile " .. slug .. " failed to load:\n" .. tostring(data), 5)
        return nil
    end
    if type(data) ~= "table" then
        alert("Profile " .. slug .. " did not return a table")
        return nil
    end
    data.slug = slug
    data.name = data.name or slug
    data.icon = data.icon or ""
    data.description = data.description or ""
    data.iconBundle = data.iconBundle or nil
    data.apps = data.apps or {}
    data.commands = data.commands or {}
    return data
end

function M.reload()
    profiles = {}
    local ok, err = pcall(function()
        for entry in hs.fs.dir(PROFILES_DIR) do
            if entry:match("%.lua$") and not entry:match("%.hooks%.lua$") then
                local slug = entry:gsub("%.lua$", "")
                local p = loadProfile(slug)
                if p then profiles[slug] = p end
            end
        end
    end)
    if not ok then
        alert("Couldn't scan profiles/: " .. tostring(err), 5)
    end
    notifyChange()
end

function M.list()
    local out = {}
    for slug, p in pairs(profiles) do
        table.insert(out, {
            slug = slug,
            name = p.name,
            icon = p.icon,
            description = p.description,
        })
    end
    table.sort(out, function(a, b) return (a.name or ""):lower() < (b.name or ""):lower() end)
    return out
end

function M.get(slug)
    return profiles[slug]
end

-- ----------------------------------------------------------------------
-- Activation
-- ----------------------------------------------------------------------

local function bundleIDSet(profile)
    local set = {}
    for _, entry in ipairs(profile.apps or {}) do
        if entry.bundle then set[entry.bundle] = true end
    end
    return set
end

local function shellEscape(s)
    return "'" .. tostring(s):gsub("'", "'\\''") .. "'"
end

local function launchOne(entry, hooks)
    local bid = entry.bundle
    local name = entry.name or bid

    local existing = hs.application.find(bid)
    if existing then
        existing:activate()
        local hook = (hooks and hooks[bid]) or entry.on_launch
        if hook then
            local ok, err = pcall(hook, existing)
            if not ok then alert(name .. " hook failed:\n" .. tostring(err), 4) end
        end
        return true
    end

    local launched
    if entry.args and entry.args ~= "" then
        local cmd = "open -b " .. shellEscape(bid) .. " --args " .. entry.args
        local _, ok = hs.execute(cmd)
        launched = ok == true
    else
        launched = hs.application.launchOrFocusByBundleID(bid)
    end
    if not launched then
        alert("Couldn't launch " .. name .. " (not installed?)", 4)
        return false
    end

    local timeoutAt = hs.timer.secondsSinceEpoch() + M.launchTimeoutSec
    hs.timer.waitUntil(
        function()
            return hs.application.find(bid) ~= nil
                or hs.timer.secondsSinceEpoch() > timeoutAt
        end,
        function()
            local app = hs.application.find(bid)
            if not app then
                alert("Couldn't launch " .. name .. " (timed out)", 4)
                return
            end
            app:activate()
            local hook = (hooks and hooks[bid]) or entry.on_launch
            if hook then
                local ok, err = pcall(hook, app)
                if not ok then alert(name .. " hook failed:\n" .. tostring(err), 4) end
            end
        end,
        0.2
    )
    return true
end

local function applyBoundary(boundary, profileBundles)
    if boundary == "additive" then return 0 end

    local failed = 0
    for _, app in ipairs(hs.application.runningApplications()) do
        local ok, bid = pcall(function() return app:bundleID() end)
        if ok and bid and not profileBundles[bid] and not alwaysOn.shouldProtect(app) then
            if boundary == "quit" then
                local name = app:name() or bid
                local quitOK = pcall(function() app:kill() end)
                if not quitOK then
                    failed = failed + 1
                    alert(name .. " refused to quit", 3)
                else
                    -- Verify quit; if still alive after timeout, alert.
                    local deadline = hs.timer.secondsSinceEpoch() + M.quitTimeoutSec
                    hs.timer.waitUntil(
                        function()
                            return hs.application.find(bid) == nil
                                or hs.timer.secondsSinceEpoch() > deadline
                        end,
                        function()
                            if hs.application.find(bid) ~= nil then
                                alert(name .. " refused to quit (still running)", 3)
                            end
                        end,
                        0.25
                    )
                end
            elseif boundary == "hide" then
                pcall(function() app:hide() end)
            end
        end
    end
    return failed
end

function M.activate(slug, boundary)
    local profile = profiles[slug]
    if not profile then
        alert("No profile named " .. slug, 3)
        return false
    end
    boundary = boundary or "quit"
    if boundary ~= "quit" and boundary ~= "hide" and boundary ~= "additive" then
        alert("Unknown boundary: " .. tostring(boundary))
        return false
    end

    log("activate " .. slug .. " boundary=" .. boundary)

    local hooks = loadHooks(slug)
    local profileBundles = bundleIDSet(profile)

    applyBoundary(boundary, profileBundles)

    for _, entry in ipairs(profile.apps or {}) do
        if entry.bundle then
            launchOne(entry, hooks)
        end
    end

    for _, c in ipairs(profile.commands or {}) do
        if c.command and c.command ~= "" then
            -- Run in background so a long-running command doesn't block activation.
            local _, ok = hs.execute("(" .. c.command .. ") >/dev/null 2>&1 &")
            if not ok then
                alert("Command failed: " .. (c.name or c.command), 4)
            end
        end
    end

    active = { slug = slug, name = profile.name, lastBoundary = boundary }

    local wmMod = getWM()
    if wmMod and wmMod.resetCycle then wmMod.resetCycle() end

    notifyChange()
    return true
end

function M.reactivate()
    if not active then
        alert("No active profile to reactivate", 2)
        return false
    end
    return M.activate(active.slug, active.lastBoundary or "quit")
end

function M.getActive()
    if not active then return nil end
    return { slug = active.slug, name = active.name, lastBoundary = active.lastBoundary }
end

-- ----------------------------------------------------------------------
-- Mutation
-- ----------------------------------------------------------------------

local function serializeProfile(p)
    local lines = { "return {" }
    table.insert(lines, string.format("  name = %q,", p.name or ""))
    table.insert(lines, string.format("  icon = %q,", p.icon or ""))
    if p.description and p.description ~= "" then
        table.insert(lines, string.format("  description = %q,", p.description))
    end
    if p.iconBundle and p.iconBundle ~= "" then
        table.insert(lines, string.format("  iconBundle = %q,", p.iconBundle))
    end
    table.insert(lines, "  apps = {")
    for _, entry in ipairs(p.apps or {}) do
        if entry.args and entry.args ~= "" then
            table.insert(lines, string.format(
                "    { bundle = %q, name = %q, args = %q },",
                entry.bundle or "", entry.name or entry.bundle or "", entry.args
            ))
        else
            table.insert(lines, string.format(
                "    { bundle = %q, name = %q },",
                entry.bundle or "", entry.name or entry.bundle or ""
            ))
        end
    end
    table.insert(lines, "  },")
    if p.commands and #p.commands > 0 then
        table.insert(lines, "  commands = {")
        for _, c in ipairs(p.commands) do
            if c.command and c.command ~= "" then
                table.insert(lines, string.format(
                    "    { name = %q, command = %q },",
                    c.name or "", c.command
                ))
            end
        end
        table.insert(lines, "  },")
    end
    table.insert(lines, "}")
    table.insert(lines, "")
    return table.concat(lines, "\n")
end

function M.save(p)
    -- p: { slug?, name, icon, description, apps = {{bundle, name}, ...} }
    if not p.name or p.name == "" then
        alert("Profile needs a name")
        return false
    end
    local slug = p.slug or slugify(p.name)
    local path = profileFilePath(slug)
    local body = serializeProfile(p)
    local f, err = io.open(path, "w")
    if not f then
        alert("Couldn't write " .. path .. ":\n" .. tostring(err), 5)
        return false
    end
    f:write(body)
    f:close()
    M.reload()
    return slug
end

function M.delete(slug)
    if not profiles[slug] then
        alert("No profile named " .. slug)
        return false
    end
    local ok, err = os.remove(profileFilePath(slug))
    if not ok then
        alert("Couldn't delete " .. slug .. ":\n" .. tostring(err), 4)
        return false
    end
    -- Best-effort sidecar cleanup
    pcall(os.remove, hooksFilePath(slug))
    if active and active.slug == slug then
        active = nil
    end
    M.reload()
    return true
end

function M.addAppToActive(app)
    if not active then
        alert("No active profile")
        return false
    end
    local bid = app and app:bundleID() or nil
    if not bid then
        alert("Couldn't read app's bundle ID")
        return false
    end
    local profile = profiles[active.slug]
    if not profile then
        alert("Active profile " .. active.slug .. " missing on disk")
        return false
    end
    for _, entry in ipairs(profile.apps or {}) do
        if entry.bundle == bid then
            alert(app:name() .. " already in " .. profile.name, 2)
            return false
        end
    end
    table.insert(profile.apps, { bundle = bid, name = app:name() or bid })
    return M.save(profile) and true or false
end

-- ----------------------------------------------------------------------
-- Lifecycle
-- ----------------------------------------------------------------------

function M.onChange(cb)
    table.insert(changeCallbacks, cb)
end

function M.start()
    -- Ensure profiles dir exists
    if not hs.fs.attributes(PROFILES_DIR) then
        hs.fs.mkdir(PROFILES_DIR)
    end
    M.reload()
end

return M
