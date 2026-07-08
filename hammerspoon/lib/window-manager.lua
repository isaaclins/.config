-- lib/window-manager.lua
-- Cmd+arrow tiling window manager. Always loaded from init.lua.
--
-- Public API:
--   start()        -- bind hotkeys (Cmd+arrows, Cmd+Shift+Down)
--   stop()         -- unbind hotkeys and cancel in-flight animations
--   resetCycle()   -- reset Cmd+Down preset cycle to first slot
--   left(win)      -- move win to left half
--   right(win)
--   maximize(win)
--   center90(win)
--   corner(win, n) -- snap win to corner preset n (1..8)
--
-- Hotkeys:
--   Cmd+Left/Right        snap to half; repeat to jump to adjacent screen
--   Cmd+Up                unminimize / maximize / shrink-maximized
--   Cmd+Down              cycle through 8 corner presets; wraps to next screen
--   Cmd+Shift+Down        reverse direction through the cycle

local M = {}

M.animationDuration = 0.42
M.tweenFps = 60
M.debug = false
-- When true, Cmd+Left/Right wraps around the far edge of the screen
-- arrangement instead of stopping: past the right edge of the rightmost
-- screen it jumps to the left half of the leftmost screen, and vice versa.
-- On a single screen this just toggles between left and right halves forever.
M.wrapHorizontal = true

-- Cmd+Down cycle state, scoped to one window at a time.
local cycleIndex = 1
local hasCycled = false
local cycleWindowId = nil

-- In-flight animations, keyed by window id so windows tween independently.
local activeTweens = {}
local hotkeys = {}

local function roundRect(r)
    return {
        x = math.floor(r.x + 0.5),
        y = math.floor(r.y + 0.5),
        w = math.max(1, math.floor(r.w + 0.5)),
        h = math.max(1, math.floor(r.h + 0.5)),
    }
end

local function easeInOutCubic(t)
    if t < 0.5 then
        return 4 * t * t * t
    end
    return 1 - ((-2 * t + 2) ^ 3) / 2
end

local function windowAlive(w)
    if not w then
        return false
    end
    local ok = pcall(function() w:frame() end)
    return ok
end

local function windowId(win)
    local ok, id = pcall(function() return win:id() end)
    if ok then return id end
    return nil
end

local function stopTween(winId)
    if winId == nil then return end
    local timer = activeTweens[winId]
    if timer then
        timer:stop()
        activeTweens[winId] = nil
    end
end

local function stopAllTweens()
    for winId, timer in pairs(activeTweens) do
        timer:stop()
        activeTweens[winId] = nil
    end
end

local function setFrameSafely(win, frame)
    return pcall(function() win:setFrame(frame, 0) end)
end

local function animateWindowTo(win, targetFrame, duration)
    if not windowAlive(win) then return end
    if duration == nil then duration = M.animationDuration end
    targetFrame = roundRect(targetFrame)

    local winId = windowId(win)
    stopTween(winId)

    -- Without an id there is no way to track the tween; snap immediately.
    if duration <= 0 or winId == nil then
        setFrameSafely(win, targetFrame)
        return
    end

    local okFrame, startFrame = pcall(function() return roundRect(win:frame()) end)
    if not okFrame or not startFrame then return end

    local dx = targetFrame.x - startFrame.x
    local dy = targetFrame.y - startFrame.y
    local dw = targetFrame.w - startFrame.w
    local dh = targetFrame.h - startFrame.h

    if math.abs(dx) < 0.5 and math.abs(dy) < 0.5 and math.abs(dw) < 0.5 and math.abs(dh) < 0.5 then
        setFrameSafely(win, targetFrame)
        return
    end

    local startTime = hs.timer.secondsSinceEpoch()
    local interval = 1 / M.tweenFps

    local function tick()
        if not windowAlive(win) then
            stopTween(winId)
            return
        end
        local elapsed = hs.timer.secondsSinceEpoch() - startTime
        local t = math.min(1, elapsed / duration)
        if t >= 1 then
            stopTween(winId)
            setFrameSafely(win, targetFrame)
            return
        end
        local e = easeInOutCubic(t)
        local nf = roundRect({
            x = startFrame.x + dx * e,
            y = startFrame.y + dy * e,
            w = startFrame.w + dw * e,
            h = startFrame.h + dh * e,
        })
        if not setFrameSafely(win, nf) then
            stopTween(winId)
        end
    end

    activeTweens[winId] = hs.timer.doEvery(interval, tick)
    tick()
end

local function isAtFrame(winFrame, targetFrame)
    return math.abs(winFrame.x - targetFrame.x) < 20 and
           math.abs(winFrame.y - targetFrame.y) < 20 and
           math.abs(winFrame.w - targetFrame.w) < 20 and
           math.abs(winFrame.h - targetFrame.h) < 20
end

local function getUsableFrame(screen)
    return screen:frame()
end

-- Screen can be nil mid display-reconfiguration; returns nil then.
local function usableFrameFor(win)
    local ok, screen = pcall(function() return win:screen() end)
    if not ok or not screen then return nil end
    return getUsableFrame(screen)
end

local function leftHalfFrame(f)
    return { x = f.x, y = f.y, w = f.w / 2, h = f.h }
end

local function rightHalfFrame(f)
    return { x = f.x + f.w / 2, y = f.y, w = f.w / 2, h = f.h }
end

-- Return the leftmost ("west") or rightmost ("east") screen in the current
-- arrangement, by horizontal origin. Used for horizontal wraparound.
local function horizontalEdgeScreen(edge)
    local best = nil
    for _, s in ipairs(hs.screen.allScreens()) do
        if not best then
            best = s
        else
            local bx, sx = best:frame().x, s:frame().x
            if edge == "west" and sx < bx then best = s end
            if edge == "east" and sx > bx then best = s end
        end
    end
    return best
end

local cornerPositions = {
    function(screen) local f = getUsableFrame(screen); return { x = f.x,             y = f.y,             w = f.w / 2, h = f.h / 2 } end, -- top-left
    function(screen) local f = getUsableFrame(screen); return { x = f.x,             y = f.y,             w = f.w,     h = f.h / 2 } end, -- top
    function(screen) local f = getUsableFrame(screen); return { x = f.x + f.w / 2,   y = f.y,             w = f.w / 2, h = f.h / 2 } end, -- top-right
    function(screen) local f = getUsableFrame(screen); return { x = f.x + f.w / 2,   y = f.y,             w = f.w / 2, h = f.h     } end, -- right
    function(screen) local f = getUsableFrame(screen); return { x = f.x + f.w / 2,   y = f.y + f.h / 2,   w = f.w / 2, h = f.h / 2 } end, -- bottom-right
    function(screen) local f = getUsableFrame(screen); return { x = f.x,             y = f.y + f.h / 2,   w = f.w,     h = f.h / 2 } end, -- bottom
    function(screen) local f = getUsableFrame(screen); return { x = f.x,             y = f.y + f.h / 2,   w = f.w / 2, h = f.h / 2 } end, -- bottom-left
    function(screen) local f = getUsableFrame(screen); return { x = f.x,             y = f.y,             w = f.w / 2, h = f.h     } end, -- left
}

function M.resetCycle()
    cycleIndex = 1
    hasCycled = false
    cycleWindowId = nil
end

-- The Cmd+Down cycle belongs to one window; targeting another window restarts it.
local function syncCycleToWindow(winId)
    if winId == cycleWindowId then return end
    M.resetCycle()
    cycleWindowId = winId
end

local function moveWindow(direction, duration)
    if duration == nil then duration = M.animationDuration end
    local win = hs.window.focusedWindow()
    if not windowAlive(win) then return end

    -- setFrame misbehaves on native-fullscreen windows; leave them alone.
    local fsOk, isFullScreen = pcall(function() return win:isFullScreen() end)
    if not fsOk or isFullScreen then return end

    local screenOk, screen = pcall(function() return win:screen() end)
    if not screenOk or not screen then return end
    local f = getUsableFrame(screen)

    local frameOk, currentFrame = pcall(function() return win:frame() end)
    if not frameOk or not currentFrame then return end

    if direction == "left" then
        M.resetCycle()
        local newFrame = leftHalfFrame(f)
        if isAtFrame(currentFrame, newFrame) then
            local nextScreen = screen:toWest()
            if not nextScreen and M.wrapHorizontal then
                nextScreen = horizontalEdgeScreen("east")
            end
            if nextScreen then
                newFrame = rightHalfFrame(getUsableFrame(nextScreen))
            end
        end
        animateWindowTo(win, newFrame, duration)

    elseif direction == "right" then
        M.resetCycle()
        local newFrame = rightHalfFrame(f)
        if isAtFrame(currentFrame, newFrame) then
            local nextScreen = screen:toEast()
            if not nextScreen and M.wrapHorizontal then
                nextScreen = horizontalEdgeScreen("west")
            end
            if nextScreen then
                newFrame = leftHalfFrame(getUsableFrame(nextScreen))
            end
        end
        animateWindowTo(win, newFrame, duration)

    elseif direction == "up" then
        M.resetCycle()
        if win:isMinimized() then
            win:unminimize()
            hs.timer.doAfter(0.1, function()
                pcall(function() win:focus() end)
            end)
            return
        end
        local isMaximized = math.abs(currentFrame.x - f.x) < 10 and
            math.abs(currentFrame.y - f.y) < 10 and
            math.abs(currentFrame.w - f.w) < 10 and
            math.abs(currentFrame.h - f.h) < 10
        if isMaximized then
            local scale = 0.90
            local w = f.w * scale
            local h = f.h * scale
            local x = f.x + (f.w - w) / 2
            local y = f.y + (f.h - h) / 2
            animateWindowTo(win, { x = x, y = y, w = w, h = h }, duration)
        else
            animateWindowTo(win, { x = f.x, y = f.y, w = f.w, h = f.h }, duration)
        end

    elseif direction == "down" then
        syncCycleToWindow(windowId(win))
        if cycleIndex == 1 and hasCycled then
            local nextScreen = screen:next()
            if nextScreen then screen = nextScreen end
        end
        hasCycled = true
        local newFrame = cornerPositions[cycleIndex](screen)
        animateWindowTo(win, newFrame, duration)
        cycleIndex = (cycleIndex % #cornerPositions) + 1

    elseif direction == "down_reverse" then
        syncCycleToWindow(windowId(win))
        local n = #cornerPositions
        local idx = cycleIndex - 2
        if idx < 1 then idx = idx + n end
        hasCycled = true
        local newFrame = cornerPositions[idx](screen)
        animateWindowTo(win, newFrame, duration)
        cycleIndex = (idx % n) + 1
    end
end

-- A dying window mid-hotkey must never surface a Lua error alert.
local function moveWindowSafely(direction, duration)
    local ok, err = pcall(moveWindow, direction, duration)
    if not ok and M.debug then
        print("window-manager: moveWindow failed: " .. tostring(err))
    end
end

local function moveWindowHandler(direction)
    return function() moveWindowSafely(direction) end
end

local function moveWindowRepeatHandler(direction)
    return function() moveWindowSafely(direction, 0) end
end

-- Public API
function M.left(win)
    win = win or hs.window.focusedWindow()
    if not windowAlive(win) then return end
    local f = usableFrameFor(win)
    if not f then return end
    animateWindowTo(win, leftHalfFrame(f))
end

function M.right(win)
    win = win or hs.window.focusedWindow()
    if not windowAlive(win) then return end
    local f = usableFrameFor(win)
    if not f then return end
    animateWindowTo(win, rightHalfFrame(f))
end

function M.maximize(win)
    win = win or hs.window.focusedWindow()
    if not windowAlive(win) then return end
    local f = usableFrameFor(win)
    if not f then return end
    animateWindowTo(win, f)
end

function M.center90(win)
    win = win or hs.window.focusedWindow()
    if not windowAlive(win) then return end
    local f = usableFrameFor(win)
    if not f then return end
    local w, h = f.w * 0.9, f.h * 0.9
    animateWindowTo(win, { x = f.x + (f.w - w) / 2, y = f.y + (f.h - h) / 2, w = w, h = h })
end

function M.corner(win, n)
    win = win or hs.window.focusedWindow()
    if not windowAlive(win) or not cornerPositions[n] then return end
    local ok, screen = pcall(function() return win:screen() end)
    if not ok or not screen then return end
    animateWindowTo(win, cornerPositions[n](screen))
end

function M.stop()
    for _, hk in ipairs(hotkeys) do
        hk:delete()
    end
    hotkeys = {}
    stopAllTweens()
end

function M.start()
    M.stop()
    table.insert(hotkeys, hs.hotkey.bind({ "cmd" }, "left",
        moveWindowHandler("left"), nil, moveWindowRepeatHandler("left")))
    table.insert(hotkeys, hs.hotkey.bind({ "cmd" }, "right",
        moveWindowHandler("right"), nil, moveWindowRepeatHandler("right")))
    table.insert(hotkeys, hs.hotkey.bind({ "cmd" }, "up",
        moveWindowHandler("up"), nil, moveWindowRepeatHandler("up")))
    table.insert(hotkeys, hs.hotkey.bind({ "cmd" }, "down",
        moveWindowHandler("down"), nil, moveWindowRepeatHandler("down")))
    table.insert(hotkeys, hs.hotkey.bind({ "cmd", "shift" }, "down",
        moveWindowHandler("down_reverse"), nil, moveWindowRepeatHandler("down_reverse")))
end

return M
