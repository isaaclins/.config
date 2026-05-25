-- Clamshell sleep policy:
--   lid closed + external display(s) -> stay awake
--   lid closed + no external displays  -> sleep (e.g. after unplugging monitors)
--
-- Loaded unconditionally from init.lua (independent of optional profiles).

local M = {}

M.debounceSec = 0.8
M.lidPollSec = 1.0
-- Set true to log policy changes to the Hammerspoon console
M.debug = false

local builtinScreen = nil
local lastPolicy = nil
local debounceTimer = nil
local lidPollTimer = nil
local screenWatcher = nil

local function log(msg)
    if M.debug then
        print("[clamshell-sleep] " .. msg)
    end
end

local function isLidClosed()
    local out = hs.execute(
        "ioreg -r -k AppleClamshellState -d 4 | grep AppleClamshellState | head -1",
        true
    )
    return out ~= nil and out:find("Yes") ~= nil
end

local function getBuiltin()
    if builtinScreen == nil then
        builtinScreen = hs.screen.find("Built%-in")
    end
    return builtinScreen
end

local function externalDisplayCount()
    local screens = hs.screen.allScreens()
    local builtin = getBuiltin()
    if not builtin then
        return math.max(0, #screens - 1)
    end
    local count = 0
    for _, screen in ipairs(screens) do
        if screen:id() ~= builtin:id() then
            count = count + 1
        end
    end
    return count
end

-- Returns: policy name, whether to prevent system sleep, whether to request sleep now
local function computePolicy()
    local lidClosed = isLidClosed()
    local externals = externalDisplayCount()

    if lidClosed and externals > 0 then
        return "clamshell_awake", true, false
    end
    if lidClosed and externals == 0 then
        return "clamshell_sleep", false, true
    end
    return "normal", false, false
end

local function applyPolicy(reason)
    local policy, preventSleep, requestSleep = computePolicy()
    if policy == lastPolicy then
        return
    end

    local prevPolicy = lastPolicy
    local externals = externalDisplayCount()
    local lidClosed = isLidClosed()

    if preventSleep then
        hs.caffeinate.set("system", true)
        hs.caffeinate.set("displayIdle", true)
    else
        hs.caffeinate.set("system", false)
        hs.caffeinate.set("displayIdle", false)
    end

    if requestSleep and prevPolicy ~= "clamshell_sleep" then
        hs.timer.doAfter(M.debounceSec, function()
            local p, _, sleepNow = computePolicy()
            if sleepNow and p == "clamshell_sleep" then
                log("requesting system sleep (" .. (reason or "?") .. ")")
                hs.caffeinate.systemSleep()
            end
        end)
    end

    log(string.format(
        "policy=%s lid=%s externals=%d reason=%s",
        policy,
        lidClosed and "closed" or "open",
        externals,
        reason or "?"
    ))
    lastPolicy = policy
end

local function scheduleApply(reason)
    if debounceTimer then
        debounceTimer:stop()
    end
    debounceTimer = hs.timer.doAfter(M.debounceSec, function()
        applyPolicy(reason)
    end)
end

function M.stop()
    if debounceTimer then
        debounceTimer:stop()
        debounceTimer = nil
    end
    if lidPollTimer then
        lidPollTimer:stop()
        lidPollTimer = nil
    end
    if screenWatcher then
        screenWatcher:stop()
        screenWatcher = nil
    end
    hs.caffeinate.set("system", false)
    hs.caffeinate.set("displayIdle", false)
    lastPolicy = nil
    builtinScreen = nil
end

function M.start()
    M.stop()

    screenWatcher = hs.screen.watcher.new(function()
        builtinScreen = nil
        scheduleApply("screen")
    end)
    screenWatcher:start()

    lidPollTimer = hs.timer.doEvery(M.lidPollSec, function()
        local policy = computePolicy()
        if policy ~= lastPolicy then
            scheduleApply("lid")
        end
    end)

    applyPolicy("init")
    log("started")
end

return M
