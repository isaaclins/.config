# ~/.config/fish/functions/npu.fish
# Purpose: Create a new public GitHub repo in the current directory.
# Usage: npu <repo|owner/repo> [gh repo create flags...]
function npu --description "Create new public GitHub repository here"
    if test (count $argv) -lt 1
        echo "Usage: npu <repo|owner/repo> [gh repo create flags...]" >&2
        return 2
    end

    __new_gh_repo public $argv
end
