-- lib/scroll-direction.lua
-- Per-device scroll direction: trackpad scrolls natural, mouse wheel does not.
--
-- macOS exposes a single global toggle (com.apple.swipescrolldirection) that
-- applies to trackpad AND mouse at once, so it cannot be configured per device.
-- This module fixes it at the event level instead: an eventtap inspects every
-- scroll event and inverts the deltas for whichever device the global setting
-- gets wrong.
--
--   global natural ON  -> invert discrete events   (mouse wheel)
--   global natural OFF -> invert continuous events (trackpad, incl. momentum)
--
-- Either way the end state is: trackpad natural, mouse wheel conventional.
-- The global setting is re-read whenever .GlobalPreferences.plist changes, so
-- flipping the checkbox in System Settings keeps working without a reload.

local M = {}

local ev    = hs.eventtap.event
local props = ev.properties

local DELTA_PROPS = {
    props.scrollWheelEventDeltaAxis1,
    props.scrollWheelEventDeltaAxis2,
    props.scrollWheelEventPointDeltaAxis1,
    props.scrollWheelEventPointDeltaAxis2,
    props.scrollWheelEventFixedPtDeltaAxis1,
    props.scrollWheelEventFixedPtDeltaAxis2,
}

local naturalScrollingOn = true

local function readGlobalSetting()
    local out = hs.execute("/usr/bin/defaults read -g com.apple.swipescrolldirection 2>/dev/null")
    if out == nil or out:match("%d") == nil then
        -- Key absent means the macOS default, which is natural ON.
        naturalScrollingOn = true
        return
    end
    naturalScrollingOn = out:match("1") ~= nil
end

local tap = hs.eventtap.new({ ev.types.scrollWheel }, function(event)
    local isTrackpad = event:getProperty(props.scrollWheelEventIsContinuous) == 1
    local invert = (naturalScrollingOn and not isTrackpad)
        or (not naturalScrollingOn and isTrackpad)
    if not invert then return false end
    for _, p in ipairs(DELTA_PROPS) do
        event:setProperty(p, -event:getProperty(p))
    end
    return true, { event }
end)

-- macOS silently disables eventtaps that it decides were too slow; restart it
-- if that ever happens so scrolling never falls back to the wrong direction.
local watchdog
local prefsWatcher

function M.start()
    readGlobalSetting()
    tap:start()
    watchdog = hs.timer.doEvery(10, function()
        if not tap:isEnabled() then tap:start() end
    end)
    prefsWatcher = hs.pathwatcher.new(
        os.getenv("HOME") .. "/Library/Preferences/.GlobalPreferences.plist",
        readGlobalSetting
    ):start()
    return M
end

function M.stop()
    tap:stop()
    if watchdog then watchdog:stop(); watchdog = nil end
    if prefsWatcher then prefsWatcher:stop(); prefsWatcher = nil end
    return M
end

function M.status()
    return {
        tapEnabled = tap:isEnabled(),
        naturalScrollingOn = naturalScrollingOn,
        inverting = naturalScrollingOn and "mouse" or "trackpad",
    }
end

return M
