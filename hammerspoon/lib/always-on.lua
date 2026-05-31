-- lib/always-on.lua
-- "Never quit / never hide" allow-list. Smart defaults + user overrides.
--
-- Public API:
--   M.userExtras       -- table of bundle IDs OR display names the user wants protected
--   M.shouldProtect(app)
--   M.isUserFacing(app)  -- helper used by the picker to filter the catalog

local M = {}

-- Add bundle IDs (preferred) or display names you never want quit/hidden.
-- Examples:
--   "com.1password.1password",
--   "com.spotify.client",
--   "1Password",
M.userExtras = {}

local HAMMERSPOON_BUNDLE_ID = "org.hammerspoon.Hammerspoon"

local function safeBundle(app)
    if not app then return nil end
    local ok, bid = pcall(function() return app:bundleID() end)
    if ok then return bid end
    return nil
end

local function safeName(app)
    if not app then return nil end
    local ok, name = pcall(function() return app:name() end)
    if ok then return name end
    return nil
end

local function safePath(app)
    if not app then return nil end
    local ok, path = pcall(function() return app:path() end)
    if ok then return path end
    return nil
end

local function safeKind(app)
    if not app then return 0 end
    local ok, k = pcall(function() return app:kind() end)
    if ok then return k end
    return 0  -- on error, err on the side of "menu-bar-only" → protected
end

local function isHammerspoon(app)
    return safeBundle(app) == HAMMERSPOON_BUNDLE_ID
end

local function isSystemApp(app)
    local path = safePath(app)
    if not path then return false end
    return path:sub(1, 8) == "/System/"
end

-- hs.application:kind():
--   1  = Regular Dock app (user-facing GUI)
--   0  = Background app with UI elements
--  -1  = Background-only / no UI
-- Treat anything != 1 as menu-bar-only / agent — protected.
local function isMenuBarOnly(app)
    return safeKind(app) ~= 1
end

local function inUserExtras(app)
    local bid = safeBundle(app)
    local name = safeName(app)
    for _, entry in ipairs(M.userExtras) do
        if entry == bid or entry == name then return true end
    end
    return false
end

function M.shouldProtect(app)
    if not app then return true end
    if isHammerspoon(app) then return true end
    if isSystemApp(app) then return true end
    if isMenuBarOnly(app) then return true end
    if safeName(app) == "Finder" then return true end
    if inUserExtras(app) then return true end
    return false
end

-- Used by the picker to decide whether to show an app at all in the catalog.
-- Excludes system apps + menu-bar-only utilities. Hammerspoon stays excluded too.
function M.isUserFacing(app)
    if isHammerspoon(app) then return false end
    if isSystemApp(app) then return false end
    if isMenuBarOnly(app) then return false end
    return true
end

return M
