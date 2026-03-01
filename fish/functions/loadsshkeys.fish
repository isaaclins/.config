# ~/.config/fish/functions/loadsshkeys.fish
# Purpose: Import SSH keys from clipboard with guided prompts and safe permissions.
# Usage: Copy each key when prompted, then run `loadsshkeys`.
function loadsshkeys --description "Load SSH private/public keys from clipboard"
    if not command -q pbpaste
        echo "pbpaste is required on macOS to read clipboard content." >&2
        return 127
    end

    set -l ssh_dir "$HOME/.ssh"
    set -l private_key "$ssh_dir/id_ed25519"
    set -l public_key "$ssh_dir/id_ed25519.pub"

    command mkdir -p "$ssh_dir"; or return 1
    command chmod 700 "$ssh_dir"

    if test -e "$private_key"; or test -e "$public_key"
        echo "Existing key file(s) found in $ssh_dir." >&2
        read -P "Type YES to overwrite them: " -l overwrite_confirm
        if test "$overwrite_confirm" != "YES"
            echo "Canceled; existing keys were not modified."
            return 1
        end
    end

    echo "Copy the PRIVATE key now, then press Enter."
    read -P "Ready for PRIVATE key: " -l proceed_private
    set -e proceed_private
    set -l private_content (pbpaste)
    if test -z "$private_content"
        echo "Clipboard is empty; expected a private key." >&2
        return 1
    end
    if not string match -q '*BEGIN*PRIVATE KEY*' -- "$private_content"
        echo "Clipboard does not look like a private key PEM block." >&2
        return 1
    end

    echo "Copy the PUBLIC key now, then press Enter."
    read -P "Ready for PUBLIC key: " -l proceed_public
    set -e proceed_public
    set -l public_content (pbpaste)
    if test -z "$public_content"
        echo "Clipboard is empty; expected a public key." >&2
        return 1
    end
    if not string match -qr '^ssh-[A-Za-z0-9-]+ ' -- "$public_content"
        echo "Clipboard does not look like an SSH public key (expected starts with ssh-...)." >&2
        return 1
    end
    set -l tmp_private "$private_key.tmp"
    set -l tmp_public "$public_key.tmp"

    printf '%s\n' "$private_content" > "$tmp_private"; or return 1
    printf '%s\n' "$public_content" > "$tmp_public"; or return 1

    command chmod 600 "$tmp_private"; or return 1
    command chmod 644 "$tmp_public"; or return 1

    command mv -f "$tmp_private" "$private_key"; or return 1
    command mv -f "$tmp_public" "$public_key"; or return 1
    command pbcopy < /dev/null

    echo "SSH keys written:"
    echo "  $private_key (600)"
    echo "  $public_key (644)"
    echo "Clipboard has been cleared."
end
