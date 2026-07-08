-- Clamshell sleep policy:
--   lid closed + external display(s) -> no system sleep, even on battery
--   lid closed + no external displays -> request system sleep
--   lid open                          -> normal macOS behavior, do nothing
--
-- Power assertions cannot block lid-close sleep on battery, so the awake
-- policy is enforced with `pmset -a disablesleep 1` instead.
--
-- Loaded unconditionally from init.lua (independent of optional profiles).

local M = {}

M.debounceSec = 0.8
M.lidPollSec = 1.0
-- Set true to log policy changes to the Hammerspoon console
M.debug = false

local settingsKey = "clamshellSleep.ownsDisablesleep"
-- Persisted so an hs.reload() or Hammerspoon restart does not orphan the flag.
local ownsDisablesleep = hs.settings.get(settingsKey) == true

local lastPolicy = nil
local debounceTimer = nil
local sleepRequestTimer = nil
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

local function externalDisplayCount()
    -- With the lid closed macOS removes the built-in display from the list,
    -- so counting non-built-in screens is correct in both lid states: when no
    -- screen matches "Built-in", every listed screen is external.
    local externals = 0
    for _, screen in ipairs(hs.screen.allScreens()) do
        local ok, name = pcall(screen.name, screen)
        if not (ok and name and name:match("Built%-in")) then
            externals = externals + 1
        end
    end
    return externals
end

-- Returns true/false, or nil when the state could not be read (e.g. pmset
-- output missing during a busy reload). Callers must treat nil as "unknown"
-- and never claim ownership or request sleep based on it.
local function readSleepDisabled()
    local out = hs.execute("/usr/bin/pmset -g")
    if out == nil then
        return nil
    end
    local value = out:match("SleepDisabled%s+(%d)")
    if value == nil then
        return nil
    end
    return value == "1"
end

-- Relies on the NOPASSWD sudoers drop-in at /etc/sudoers.d/cc-pmset-disablesleep
-- covering exactly these two commands; `sudo -n` plus the absolute pmset path
-- guarantees this can never hang on a password prompt.
local function writeSleepDisabled(enabled)
    hs.execute("/usr/bin/sudo -n /usr/bin/pmset -a disablesleep " .. (enabled and "1" or "0"))
end

local function setOwnership(owned)
    ownsDisablesleep = owned
    hs.settings.set(settingsKey, owned)
end

-- Ownership rule: only ever clear a disablesleep flag this module set itself.
-- Other tools (e.g. the user's `cc` fish function) also use disablesleep.
local function claimSleepDisabled()
    local sleepDisabled = readSleepDisabled()
    if sleepDisabled == nil then
        log("SleepDisabled state unknown, not claiming")
        return
    end
    if sleepDisabled then
        -- Already set: either ours from before a reload (marker persisted) or
        -- a foreign owner. Change nothing and keep the recorded ownership.
        log("SleepDisabled already 1, ownership=" .. tostring(ownsDisablesleep))
        return
    end
    writeSleepDisabled(true)
    setOwnership(true)
    log("set disablesleep=1 (owned)")
end

local function releaseSleepDisabledIfOwned()
    if not ownsDisablesleep then
        return
    end
    writeSleepDisabled(false)
    setOwnership(false)
    log("restored disablesleep=0 (was owned)")
end

local function computePolicy()
    local lidClosed = isLidClosed()
    if not lidClosed then
        return "normal"
    end
    if externalDisplayCount() > 0 then
        return "clamshell_awake"
    end
    return "clamshell_sleep"
end

local function requestSleepAfterDebounce(reason)
    if sleepRequestTimer then
        sleepRequestTimer:stop()
    end
    sleepRequestTimer = hs.timer.doAfter(M.debounceSec, function()
        if computePolicy() ~= "clamshell_sleep" then
            return
        end
        if readSleepDisabled() ~= false then
            log("skipping sleep request: SleepDisabled is 1 or unknown (would be refused)")
            return
        end
        log("requesting system sleep (" .. (reason or "?") .. ")")
        hs.caffeinate.systemSleep()
    end)
end

local function applyPolicy(reason)
    local policy = computePolicy()
    if policy == lastPolicy then
        return
    end
    local prevPolicy = lastPolicy
    lastPolicy = policy

    if prevPolicy == "clamshell_awake" and policy ~= "clamshell_awake" then
        releaseSleepDisabledIfOwned()
    end
    if policy == "clamshell_awake" then
        claimSleepDisabled()
    elseif policy == "clamshell_sleep" then
        requestSleepAfterDebounce(reason)
    end

    log(string.format(
        "policy=%s lid=%s externals=%d reason=%s",
        policy,
        isLidClosed() and "closed" or "open",
        externalDisplayCount(),
        reason or "?"
    ))
end

local function scheduleApply(reason)
    if debounceTimer then
        debounceTimer:stop()
    end
    debounceTimer = hs.timer.doAfter(M.debounceSec, function()
        applyPolicy(reason)
    end)
end

local function stopTimers()
    if debounceTimer then
        debounceTimer:stop()
        debounceTimer = nil
    end
    if sleepRequestTimer then
        sleepRequestTimer:stop()
        sleepRequestTimer = nil
    end
    if lidPollTimer then
        lidPollTimer:stop()
        lidPollTimer = nil
    end
    if screenWatcher then
        screenWatcher:stop()
        screenWatcher = nil
    end
end

function M.status()
    return {
        policy = computePolicy(),
        lidClosed = isLidClosed(),
        externalDisplays = externalDisplayCount(),
        sleepDisabled = readSleepDisabled(),
        ownsDisablesleep = ownsDisablesleep,
    }
end

function M.stop()
    stopTimers()
    releaseSleepDisabledIfOwned()
    lastPolicy = nil
end

function M.start()
    stopTimers()

    screenWatcher = hs.screen.watcher.new(function()
        scheduleApply("screen")
    end)
    screenWatcher:start()

    lidPollTimer = hs.timer.doEvery(M.lidPollSec, function()
        if computePolicy() ~= lastPolicy then
            scheduleApply("lid")
            return
        end
        -- Re-assert while awake: another tool (e.g. cc's exit trap) can drop
        -- the flag under a stable policy, and transitions alone would never
        -- restore it. Only acts on an explicit 0 read, never on unknown.
        if lastPolicy == "clamshell_awake" and readSleepDisabled() == false then
            log("disablesleep dropped externally, re-asserting")
            claimSleepDisabled()
        end
    end)

    applyPolicy("init")
    log("started")
    return M
end

return M
