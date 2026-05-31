-- lib/menubar.lua
-- Menu bar indicator for the active profile.
--
-- Public API:
--   start({ manager, picker, openChooser })
--   stop()
--   refresh()
--
-- The menu rebuilds on every open via the dynamic-menu function form, so it always
-- reflects current state without us having to wire change callbacks for the menu items.

local M = {}

local item = nil
local mgr = nil
local picker = nil
local openChooser = nil

local INACTIVE_TITLE = "◯"

local function decoratedTitle(active)
    local icon = (active.icon ~= nil and active.icon ~= "") and active.icon or "●"
    local name = active.name or active.slug or "?"
    return icon .. " " .. name
end

local function buildMenu()
    local items = {}
    local active = mgr and mgr.getActive() or nil

    if active then
        local profile = mgr.get(active.slug)
        local icon = (profile and profile.icon ~= "" and profile.icon) or "●"
        table.insert(items, {
            title = "Active: " .. icon .. " " .. (profile and profile.name or active.slug),
            disabled = true,
        })
        table.insert(items, {
            title = "Reactivate (⌘⇧R)",
            fn = function() mgr.reactivate() end,
        })
        local front = hs.application.frontmostApplication()
        if front then
            local fname = front:name() or "frontmost app"
            table.insert(items, {
                title = "Add " .. fname .. " to this profile",
                fn = function() mgr.addAppToActive(front) end,
            })
        end
    else
        table.insert(items, { title = "No active profile", disabled = true })
    end

    table.insert(items, { title = "-" })
    table.insert(items, {
        title = "Open chooser…  ⌘⇧P",
        fn = function() if openChooser then openChooser() end end,
    })
    table.insert(items, {
        title = "New profile…  ⌘⇧N",
        fn = function() if picker then picker.openNew() end end,
    })

    local profiles = mgr and mgr.list() or {}
    if #profiles > 0 then
        table.insert(items, { title = "-" })
        local subItems = {}
        for _, p in ipairs(profiles) do
            local label = (p.icon ~= "" and (p.icon .. " ") or "") .. p.name
            table.insert(subItems, {
                title = label,
                fn = function() mgr.activate(p.slug, "additive") end,
            })
        end
        table.insert(items, { title = "Activate (additive)", menu = subItems })
    end

    table.insert(items, { title = "-" })
    table.insert(items, {
        title = "Reload Hammerspoon",
        fn = function() hs.reload() end,
    })
    return items
end

function M.refresh()
    if not item then return end
    local active = mgr and mgr.getActive() or nil
    if active then
        local profile = mgr.get(active.slug)
        if profile then
            item:setTitle(decoratedTitle({ icon = profile.icon, name = profile.name }))
            return
        end
    end
    item:setTitle(INACTIVE_TITLE)
end

function M.start(opts)
    M.stop()
    mgr = opts.manager
    picker = opts.picker
    openChooser = opts.openChooser

    item = hs.menubar.new()
    if not item then
        hs.alert.show("Couldn't create menu bar item")
        return
    end
    item:setMenu(buildMenu)
    M.refresh()

    if mgr and mgr.onChange then
        mgr.onChange(function() M.refresh() end)
    end
end

function M.stop()
    if item then
        pcall(function() item:delete() end)
        item = nil
    end
end

return M
