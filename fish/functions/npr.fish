# ~/.config/fish/functions/npr.fish
# Purpose: Create a new private GitHub repo in the current directory.
# Usage: npr <repo|owner/repo> [gh repo create flags...]
function npr --description "Create new private GitHub repository here"
    if test (count $argv) -lt 1
        echo "Usage: npr <repo|owner/repo> [gh repo create flags...]" >&2
        return 2
    end

    __new_gh_repo private $argv
end
