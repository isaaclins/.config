-- init.lua
-- Entry point. Loads the always-on modules:
--   lib/clamshell-sleep.lua       (lid closed: stay awake with an external display even on battery, sleep when unplugged)
--   lib/window-manager.lua        (Cmd+arrow tiling)
--   lib/scroll-direction.lua      (trackpad natural, mouse wheel conventional)
--   lib/fn-wasd.lua               (fn+WASD -> arrow keys)
--   lib/ghostty-link-click.lua    (Cmd+click links through tmux mouse mode)

-- Enable the `hs` shell IPC so external tools can introspect / reload.
pcall(require, "hs.ipc")

local clamshell
local clamshellOk, clamshellErr = pcall(function()
    clamshell = dofile(hs.configdir .. "/lib/clamshell-sleep.lua"):start()
end)
if not clamshellOk then
    hs.alert.show("Clamshell sleep failed: " .. tostring(clamshellErr), 5)
end

local wm = dofile(hs.configdir .. "/lib/window-manager.lua")
wm.start()

-- Trackpad scrolls natural, mouse wheel conventional (per-event inversion).
local scrollDirection
local scrollOk, scrollErr = pcall(function()
    scrollDirection = dofile(hs.configdir .. "/lib/scroll-direction.lua"):start()
end)
if not scrollOk then
    hs.alert.show("Scroll direction fix failed: " .. tostring(scrollErr), 5)
end

-- fn+W/A/S/D act as arrow keys everywhere.
local fnWasd
local fnWasdOk, fnWasdErr = pcall(function()
    fnWasd = dofile(hs.configdir .. "/lib/fn-wasd.lua"):start()
end)
if not fnWasdOk then
    hs.alert.show("fn+WASD remap failed: " .. tostring(fnWasdErr), 5)
end

-- Cmd+click opens links in Ghostty even when tmux captures plain mouse input.
local ghosttyLinkClick
local ghosttyLinkClickOk, ghosttyLinkClickErr = pcall(function()
    ghosttyLinkClick = dofile(hs.configdir .. "/lib/ghostty-link-click.lua"):start()
end)
if not ghosttyLinkClickOk then
    hs.alert.show("Ghostty link click failed: " .. tostring(ghosttyLinkClickErr), 5)
end

-- Debug handle (for `hs -c` introspection)
_G.HS = {
    wm = wm,
    scrollDirection = scrollDirection,
    clamshell = clamshell,
    fnWasd = fnWasd,
    ghosttyLinkClick = ghosttyLinkClick,
}

hs.alert.show("Hammerspoon config loaded", 1.5)
