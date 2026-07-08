-- init.lua
-- Entry point. Loads the three always-loaded modules:
--   lib/clamshell-sleep.lua       (lid closed: stay awake with an external display even on battery, sleep when unplugged)
--   lib/window-manager.lua        (Cmd+arrow tiling)
--   lib/scroll-direction.lua      (trackpad natural, mouse wheel conventional)

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

-- Debug handle (for `hs -c` introspection)
_G.HS = {
    wm = wm,
    scrollDirection = scrollDirection,
    clamshell = clamshell,
}

hs.alert.show("Hammerspoon config loaded", 1.5)
