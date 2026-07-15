-- lib/fn-wasd.lua
-- Global remap: fn+W/A/S/D -> Up/Left/Down/Right.
--
-- An eventtap rewrites matching keyDown/keyUp events in place: the keycode is
-- swapped for the arrow key and the fn flag is stripped (so apps see a plain
-- arrow, not fn+arrow which macOS treats as Home/End/PageUp/PageDown). All
-- other modifiers (shift/cmd/alt/ctrl) are preserved, so selection and
-- word-jumps keep working. Autorepeat comes for free since the original
-- repeat events are rewritten too.
--
-- If fn is released before the letter key, the keyUp is still translated for
-- any key whose keyDown we rewrote, so apps never see a stuck arrow key.

local M = {}

local ev = hs.eventtap.event

local KEY_TO_ARROW = {
    [hs.keycodes.map.w] = hs.keycodes.map.up,
    [hs.keycodes.map.a] = hs.keycodes.map.left,
    [hs.keycodes.map.s] = hs.keycodes.map.down,
    [hs.keycodes.map.d] = hs.keycodes.map.right,
}

-- Keycodes whose keyDown we translated and whose keyUp is still pending.
local heldTranslatedKeys = {}

local function rewriteToArrow(event, arrowKeyCode)
    event:setKeyCode(arrowKeyCode)
    local flags = event:getFlags()
    flags.fn = nil
    event:setFlags(flags)
end

local tap = hs.eventtap.new({ ev.types.keyDown, ev.types.keyUp }, function(event)
    local keyCode = event:getKeyCode()
    local arrowKeyCode = KEY_TO_ARROW[keyCode]
    if not arrowKeyCode then return false end

    local isKeyDown = event:getType() == ev.types.keyDown

    if isKeyDown then
        if not event:getFlags().fn then return false end
        heldTranslatedKeys[keyCode] = true
        rewriteToArrow(event, arrowKeyCode)
        return false
    end

    -- keyUp: translate if the matching keyDown was translated, even if fn
    -- was already released.
    if not heldTranslatedKeys[keyCode] then return false end
    heldTranslatedKeys[keyCode] = nil
    rewriteToArrow(event, arrowKeyCode)
    return false
end)

-- macOS silently disables eventtaps it deems too slow; restart if needed.
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
    heldTranslatedKeys = {}
    return M
end

function M.status()
    return { tapEnabled = tap:isEnabled() }
end

return M
