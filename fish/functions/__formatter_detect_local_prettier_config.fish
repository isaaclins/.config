# ~/.config/fish/functions/__formatter_detect_local_prettier_config.fish
# Purpose: Determine whether the current working directory has a repo-local Prettier config.
# Inputs: None (uses current working directory).
# Outputs: Exit code only (0 = local config detected, 1 = no local config).
# Examples: __formatter_detect_local_prettier_config; and echo local

function __formatter_detect_local_prettier_config --description "Detect local Prettier config files in current directory"
    # Explicit config file names supported by Prettier.
    set -l explicit_candidates \
        .prettierrc \
        .prettierrc.json \
        .prettierrc.yaml \
        .prettierrc.yml \
        .prettierrc.js \
        .prettierrc.cjs \
        .prettierrc.mjs \
        .prettierrc.toml \
        prettier.config.js \
        prettier.config.cjs \
        prettier.config.mjs \
        prettier.config.ts \
        prettier.config.cts \
        prettier.config.mts

    for candidate in $explicit_candidates
        if test -f "$candidate"
            return 0
        end
    end

    # Catch uncommon `.prettierrc.<custom>` variants without listing every extension.
    for wildcard_candidate in .prettierrc.*
        if test -f "$wildcard_candidate"
            return 0
        end
    end

    # Prettier also supports config embedded in package.json under the top-level
    # `prettier` key. Use Node for robust JSON parsing.
    if test -f package.json; and command -q node
        command node -e '
const fs = require("fs");
try {
  const parsed = JSON.parse(fs.readFileSync("package.json", "utf8"));
  process.exit(Object.prototype.hasOwnProperty.call(parsed, "prettier") ? 0 : 1);
} catch {
  process.exit(1);
}
' >/dev/null 2>&1
        if test $status -eq 0
            return 0
        end
    end

    return 1
end
