# ~/.config/fish/functions/loadsshkeys.fish
# Purpose: Import SSH keys from clipboard with guided prompts and safe permissions.
# Usage: Copy each key when prompted, then run `loadsshkeys`.
function loadsshkeys --description "Load SSH private/public keys from clipboard (validated)"
    # Requirements
    if not command -q pbpaste
        echo "pbpaste is required on macOS to read clipboard content." >&2
        return 127
    end
    if not command -q ssh-keygen
        echo "ssh-keygen is required." >&2
        return 127
    end

    set -l ssh_dir "$HOME/.ssh"
    set -l private_key "$ssh_dir/id_ed25519"
    set -l public_key  "$ssh_dir/id_ed25519.pub"

    command mkdir -p "$ssh_dir"; or return 1
    command chmod 700 "$ssh_dir"; or return 1

    if test -e "$private_key"; or test -e "$public_key"
        echo "Existing key file(s) found in $ssh_dir." >&2
        read -P "Type YES to overwrite them: " -l overwrite_confirm
        if test "$overwrite_confirm" != "YES"
            echo "Canceled; existing keys were not modified."
            return 1
        end
    end

    set -l tmp_private "$private_key.tmp"
    set -l tmp_public  "$public_key.tmp"

    # --- PRIVATE KEY ---
    echo "Copy the PRIVATE key now, then press Enter."
    read -P "Ready for PRIVATE key: " -l _proceed_private
    set -e _proceed_private

    # Bitwarden and some UIs may copy the key as a single line.
    # Normalize and rebuild canonical OpenSSH armored block before validation.
    set -l private_compact (pbpaste | command tr -d '\r\n\t ')

    if not printf '%s\n' "$private_compact" | command grep -q -- '-----BEGINOPENSSHPRIVATEKEY-----.*-----ENDOPENSSHPRIVATEKEY-----'
        echo "Clipboard does not look like an OpenSSH private key block." >&2
        command rm -f "$tmp_private"
        return 1
    end

    set -l private_payload (printf '%s\n' "$private_compact" | command sed -E 's/^.*-----BEGINOPENSSHPRIVATEKEY-----//; s/-----ENDOPENSSHPRIVATEKEY-----.*$//')
    if test -z "$private_payload"
        echo "Could not extract private key payload from clipboard." >&2
        command rm -f "$tmp_private"
        return 1
    end
    if not printf '%s\n' "$private_payload" | command grep -Eq '^[A-Za-z0-9+/=]+$'
        echo "Private key payload contains unexpected characters. Aborting." >&2
        command rm -f "$tmp_private"
        return 1
    end

    begin
        echo "-----BEGIN OPENSSH PRIVATE KEY-----"
        printf '%s\n' "$private_payload" | command fold -w 70
        echo "-----END OPENSSH PRIVATE KEY-----"
    end > "$tmp_private"; or return 1
    command chmod 600 "$tmp_private"; or return 1

    # Validate key can be parsed (this is the critical check)
    ssh-keygen -y -f "$tmp_private" >/dev/null 2>/dev/null
    if test $status -ne 0
        echo "Private key is not valid (ssh-keygen could not parse it). Aborting." >&2
        echo "Tip: re-copy from a 'raw' export, not a rendered UI, or regenerate a new keypair." >&2
        command rm -f "$tmp_private"
        return 1
    end

    # --- PUBLIC KEY ---
    echo "Copy the PUBLIC key now, then press Enter."
    read -P "Ready for PUBLIC key: " -l _proceed_public
    set -e _proceed_public

    set -l public_compact (pbpaste | command tr -d '\r' | command tr '\n\t' ' ' | command sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')
    if not printf '%s\n' "$public_compact" | command grep -Eq '^ssh-[A-Za-z0-9-]+ [A-Za-z0-9+/=]+( [^[:space:]].*)?$'
        echo "Clipboard does not look like an SSH public key (expected starts with ssh-...)." >&2
        command rm -f "$tmp_private" "$tmp_public"
        return 1
    end

    printf '%s\n' "$public_compact" > "$tmp_public"; or return 1

    # Permissions on temp files first
    command chmod 600 "$tmp_private"; or return 1
    command chmod 644 "$tmp_public"; or return 1

    # Install atomically
    command mv -f "$tmp_private" "$private_key"; or return 1
    command mv -f "$tmp_public" "$public_key"; or return 1

    # Clear clipboard
    command pbcopy < /dev/null

    echo "SSH keys written:"
    echo "  $private_key (600) — validated by ssh-keygen"
    echo "  $public_key (644)"
    echo "Clipboard has been cleared."
end
