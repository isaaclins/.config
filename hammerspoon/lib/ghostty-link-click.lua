-- lib/ghostty-link-click.lua
-- Preserve macOS-style Cmd+click links while tmux mouse mode is enabled.
--
-- Ghostty requires Cmd+Shift+click for links when an alternate-screen app
-- such as tmux captures mouse input. This eventtap adds Shift to Cmd+click
-- gestures only while Ghostty is focused, keeping the familiar Cmd+click UI
-- without changing mouse behavior in any other application.

local M = {}

local ev = hs.eventtap.event
local GHOSTTY_BUNDLE_ID = "com.mitchellh.ghostty"
local rewritingGesture = false

local function ghosttyIsFocused()
    local app = hs.application.frontmostApplication()
    return app and app:bundleID() == GHOSTTY_BUNDLE_ID
end

local function addShift(event)
    local flags = event:getFlags()
    flags.shift = true
    event:setFlags(flags)
end

local tap = hs.eventtap.new({
    ev.types.leftMouseDown,
    ev.types.leftMouseDragged,
    ev.types.leftMouseUp,
}, function(event)
    local eventType = event:getType()

    if eventType == ev.types.leftMouseDown then
        local flags = event:getFlags()
        rewritingGesture = ghosttyIsFocused() and flags.cmd and not flags.shift
        if not rewritingGesture then return false end
        addShift(event)
        return false
    end

    if not rewritingGesture then return false end
    addShift(event)
    if eventType == ev.types.leftMouseUp then rewritingGesture = false end
    return false
end)

local watchdog

function M.start()
    tap:start()
    watchdog = hs.timer.doEvery(10, function()
        if not tap:isEnabled() then tap:start() end
    end)
    return M
end

function M.stop()
    tap:stop()
    if watchdog then watchdog:stop(); watchdog = nil end
    rewritingGesture = false
    return M
end

function M.status()
    return { tapEnabled = tap:isEnabled(), rewritingGesture = rewritingGesture }
end

return M
