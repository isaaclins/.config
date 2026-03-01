-- Function to extract metadata from profile file
local function getProfileMetadata(filePath)
    local metadata = {
        icon = nil,
        name = nil,
        description = nil
    }

    local file = io.open(filePath, "r")
    if file then
        -- Read first 10 lines to find metadata definitions
        for i = 1, 10 do
            local line = file:read("*line")
            if not line then break end

            -- Look for pattern: -- ICON: emoji
            local icon = line:match("^%-%-%s*ICON:%s*(.+)$")
            if icon then
                metadata.icon = icon:match("^%s*(.-)%s*$") -- trim whitespace
            end

            -- Look for pattern: -- NAME: custom name
            local name = line:match("^%-%-%s*NAME:%s*(.+)$")
            if name then
                metadata.name = name:match("^%s*(.-)%s*$") -- trim whitespace
            end

            -- Look for pattern: -- DESCRIPTION: custom description
            local description = line:match("^%-%-%s*DESCRIPTION:%s*(.+)$")
            if description then
                metadata.description = description:match("^%s*(.-)%s*$") -- trim whitespace
            end
        end
        file:close()
    end

    return metadata
end

-- Function to scan profiles folder and return available profiles
local function getAvailableProfiles()
    local profiles = {}
    local profilesPath = hs.configdir .. "/profiles"

    -- Get all .lua files from the profiles directory
    for file in hs.fs.dir(profilesPath) do
        if file:match("%.lua$") then
            -- Remove .lua extension and convert to readable format (fallback)
            local profileName = file:gsub("%.lua$", "")
            local fallbackName = profileName:gsub("-", " "):gsub("(%a)([%w_']*)", function(first, rest)
                return first:upper() .. rest
            end)

            -- Get custom metadata from profile file
            local profilePath = profilesPath .. "/" .. file
            local metadata = getProfileMetadata(profilePath)

            -- Use custom name or fallback to filename
            local displayName = metadata.name or fallbackName

            -- Use custom description or fallback to default
            local subText = metadata.description or ("Load " .. displayName .. " profile")

            local profileEntry = {
                text = displayName,
                subText = subText,
                fileName = file,
                profileName = profileName
            }

            -- Add icon if defined in profile
            if metadata.icon then
                profileEntry.image = hs.image.imageFromName(hs.image.systemImageNames.ActionTemplate)
                profileEntry.text = metadata.icon .. " " .. displayName
            end

            table.insert(profiles, profileEntry)
        end
    end

    -- Sort profiles alphabetically
    table.sort(profiles, function(a, b) return a.text < b.text end)

    -- Add reload option at the bottom
    table.insert(profiles, {
        text = "🔄 Reload Hammerspoon",
        subText = "Reload the Hammerspoon configuration",
        action = "reload"
    })

    return profiles
end

-- Create the profile chooser
local profileChooser = hs.chooser.new(function(choice)
    if choice then
        if choice.action == "reload" then
            hs.reload()
        else
            dofile(hs.configdir .. "/profiles/" .. choice.fileName)
        end
    end
end)

-- Configure the chooser
profileChooser:placeholderText("Type to filter profiles...")
profileChooser:searchSubText(true)
profileChooser:width(30)

-- Function to refresh and show the profile selector
local function showProfileSelector()
    local availableProfiles = getAvailableProfiles()
    profileChooser:choices(availableProfiles)
    profileChooser:show()
end

-- Bind keyboard shortcut: Cmd + Shift + P to show profile selector
hs.hotkey.bind({ "cmd", "shift" }, "P", function()
    showProfileSelector()
end)

-- Show success message on load
hs.alert.show("Press ⌘⇧P to select a profile")
