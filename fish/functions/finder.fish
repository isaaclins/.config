# ~/.config/fish/functions/finder.fish
# Purpose: Open Finder at a directory, or reveal a file in Finder.
# Usage: finder  or  finder -i  or  finder .  or  finder /path/to/dir  or  finder zoxide-keywords
function _finder_open --description 'Change to a path and open it in Finder'
    set -l target $argv[1]

    if not test -e "$target"
        echo "finder: '$target' does not exist" >&2
        return 1
    end

    if test -d "$target"
        if not cd "$target"
            return 1
        end
        command open .
    else
        set -l parent (command dirname -- "$target")
        if not cd "$parent"
            return 1
        end
        command open -R "$target"
    end
end

function _finder_zoxide_interactive --description 'Pick a directory with zoxide and open it in Finder'
    if not command -q zoxide
        echo "finder: zoxide is required for interactive lookup." >&2
        return 127
    end

    set -l resolved (command zoxide query -i $argv 2>/dev/null)
    if test $status -ne 0 -o -z "$resolved"
        echo "finder: no zoxide match selected" >&2
        return 1
    end

    _finder_open "$resolved"
end

function finder --description 'Jump to a path and open it in Finder'
  if test -t 0; and test (count $argv) -eq 0
    _finder_zoxide_interactive
    return $status
  end

  if not test -t 0; and test (count $argv) -eq 0
    set -l piped_path
    read -l piped_path

    if test -z "$piped_path"
      echo "finder: expected a path on stdin" >&2
      return 1
    end

    _finder_open "$piped_path"
    return $status
  end

  set -l use_interactive 0
  set -l args $argv

  if test (count $args) -gt 0
    switch $args[1]
      case -i --interactive
        set use_interactive 1
        set args $args[2..-1]
    end
  end

  if test (count $args) -eq 0
    _finder_zoxide_interactive
    return $status
  end

  set -l target $args[1]

  if test (count $args) -eq 1; and test -e "$target"
    _finder_open "$target"
    return $status
  end

  if not command -q zoxide
    echo "finder: zoxide is required to resolve '$args'" >&2
    return 127
  end

  set -l query_args $args
  if test $use_interactive -eq 1
    set query_args -i $query_args
  end

  set -l resolved (command zoxide query $query_args 2>/dev/null)
  if test $status -ne 0 -o -z "$resolved"
    echo "finder: no zoxide match for '$args'" >&2
    return 1
  end

  _finder_open "$resolved"
end
