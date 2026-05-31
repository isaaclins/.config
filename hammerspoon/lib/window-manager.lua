-- lib/window-manager.lua
-- Cmd+arrow tiling window manager. Always loaded from init.lua, never a profile.
--
-- Public API:
--   start()        -- bind hotkeys (Cmd+arrows, Cmd+Shift+Down)
--   stop()         -- unbind hotkeys
--   resetCycle()   -- reset Cmd+Down preset cycle to first slot
--   left(win)      -- move win to left half  (helpful for profile on_launch hooks)
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

local cycleIndex = 1
local hasCycled = false
local tweenTimer = nil
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

local function stopActiveTween()
    if tweenTimer then
        tweenTimer:stop()
        tweenTimer = nil
    end
end

local function windowAlive(w)
    if not w then
        return false
    end
    local ok = pcall(function() w:frame() end)
    return ok
end

local function animateWindowTo(win, targetFrame, duration)
    if not win then return end
    if duration == nil then duration = M.animationDuration end
    if duration <= 0 then
        stopActiveTween()
        win:setFrame(roundRect(targetFrame), 0)
        return
    end

    targetFrame = roundRect(targetFrame)
    stopActiveTween()

    local startFrame = roundRect(win:frame())
    local dx = targetFrame.x - startFrame.x
    local dy = targetFrame.y - startFrame.y
    local dw = targetFrame.w - startFrame.w
    local dh = targetFrame.h - startFrame.h

    if math.abs(dx) < 0.5 and math.abs(dy) < 0.5 and math.abs(dw) < 0.5 and math.abs(dh) < 0.5 then
        win:setFrame(targetFrame, 0)
        return
    end

    local startTime = hs.timer.secondsSinceEpoch()
    local interval = 1 / M.tweenFps

    local function tick()
        if not windowAlive(win) then
            stopActiveTween()
            return
        end
        local elapsed = hs.timer.secondsSinceEpoch() - startTime
        local t = math.min(1, elapsed / duration)
        local e = easeInOutCubic(t)
        local nf = roundRect({
            x = startFrame.x + dx * e,
            y = startFrame.y + dy * e,
            w = startFrame.w + dw * e,
            h = startFrame.h + dh * e,
        })
        win:setFrame(nf, 0)
        if t >= 1 then
            stopActiveTween()
            win:setFrame(targetFrame, 0)
        end
    end

    tick()
    tweenTimer = hs.timer.doEvery(interval, tick)
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

local function moveWindow(direction, duration)
    if duration == nil then duration = M.animationDuration end
    local win = hs.window.focusedWindow()
    if not win then return end

    local screen = win:screen()
    local f = getUsableFrame(screen)

    if direction == "left" then
        local newFrame = { x = f.x, y = f.y, w = f.w / 2, h = f.h }
        if isAtFrame(win:frame(), newFrame) then
            local nextScreen = screen:toWest()
            if nextScreen then
                screen = nextScreen
                f = getUsableFrame(screen)
                newFrame = { x = f.x + f.w / 2, y = f.y, w = f.w / 2, h = f.h }
            end
        end
        animateWindowTo(win, newFrame, duration)

    elseif direction == "right" then
        local newFrame = { x = f.x + f.w / 2, y = f.y, w = f.w / 2, h = f.h }
        if isAtFrame(win:frame(), newFrame) then
            local nextScreen = screen:toEast()
            if nextScreen then
                screen = nextScreen
                f = getUsableFrame(screen)
                newFrame = { x = f.x, y = f.y, w = f.w / 2, h = f.h }
            end
        end
        animateWindowTo(win, newFrame, duration)

    elseif direction == "up" then
        if win:isMinimized() then
            win:unminimize()
            hs.timer.doAfter(0.1, function() win:focus() end)
        else
            local currentFrame = win:frame()
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
        end

    elseif direction == "down" then
        if cycleIndex == 1 and hasCycled then
            local nextScreen = screen:next()
            if nextScreen then screen = nextScreen end
        end
        hasCycled = true
        local newFrame = cornerPositions[cycleIndex](screen)
        animateWindowTo(win, newFrame, duration)
        cycleIndex = (cycleIndex % #cornerPositions) + 1

    elseif direction == "down_reverse" then
        local n = #cornerPositions
        local idx = cycleIndex - 2
        if idx < 1 then idx = idx + n end
        hasCycled = true
        local newFrame = cornerPositions[idx](screen)
        animateWindowTo(win, newFrame, duration)
        cycleIndex = (idx % n) + 1
    end
end

local function moveWindowRepeat(direction)
    return function() moveWindow(direction, 0) end
end

-- Public API for hooks
function M.left(win)
    win = win or hs.window.focusedWindow()
    if not win then return end
    local f = getUsableFrame(win:screen())
    animateWindowTo(win, { x = f.x, y = f.y, w = f.w / 2, h = f.h })
end

function M.right(win)
    win = win or hs.window.focusedWindow()
    if not win then return end
    local f = getUsableFrame(win:screen())
    animateWindowTo(win, { x = f.x + f.w / 2, y = f.y, w = f.w / 2, h = f.h })
end

function M.maximize(win)
    win = win or hs.window.focusedWindow()
    if not win then return end
    local f = getUsableFrame(win:screen())
    animateWindowTo(win, f)
end

function M.center90(win)
    win = win or hs.window.focusedWindow()
    if not win then return end
    local f = getUsableFrame(win:screen())
    local w, h = f.w * 0.9, f.h * 0.9
    animateWindowTo(win, { x = f.x + (f.w - w) / 2, y = f.y + (f.h - h) / 2, w = w, h = h })
end

function M.corner(win, n)
    win = win or hs.window.focusedWindow()
    if not win or not cornerPositions[n] then return end
    animateWindowTo(win, cornerPositions[n](win:screen()))
end

function M.resetCycle()
    cycleIndex = 1
    hasCycled = false
end

function M.stop()
    for _, hk in ipairs(hotkeys) do
        hk:delete()
    end
    hotkeys = {}
    stopActiveTween()
end

function M.start()
    M.stop()
    table.insert(hotkeys, hs.hotkey.bind({ "cmd" }, "left",
        function() moveWindow("left") end, nil, moveWindowRepeat("left")))
    table.insert(hotkeys, hs.hotkey.bind({ "cmd" }, "right",
        function() moveWindow("right") end, nil, moveWindowRepeat("right")))
    table.insert(hotkeys, hs.hotkey.bind({ "cmd" }, "up",
        function() moveWindow("up") end, nil, moveWindowRepeat("up")))
    table.insert(hotkeys, hs.hotkey.bind({ "cmd" }, "down",
        function() moveWindow("down") end, nil, moveWindowRepeat("down")))
    table.insert(hotkeys, hs.hotkey.bind({ "cmd", "shift" }, "down",
        function() moveWindow("down_reverse") end, nil, moveWindowRepeat("down_reverse")))
end

return M
