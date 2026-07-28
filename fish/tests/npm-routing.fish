#!/usr/bin/env fish

set -l test_root (mktemp -d "/tmp/npm-routing.XXXXXX")
function cleanup --on-event fish_exit
    rm -rf "$test_root"
end

set -l mock_bin "$test_root/bin"
mkdir -p "$mock_bin"
for manager in npm pnpm
    printf '#!/bin/sh\nprintf "%%s" "%s"\nprintf " %%s" "$@"\nprintf "\\n"\n' "$manager" >"$mock_bin/$manager"
    chmod +x "$mock_bin/$manager"
end
set -gx PATH "$mock_bin" $PATH

source (path dirname (path dirname (status filename)))/functions/npm.fish

function assert_output --argument-names expected directory
    set -l actual (cd "$directory"; npm $argv[3..-1])
    if test $status -ne 0; or test "$actual" != "$expected"
        echo "FAIL: expected '$expected', got '$actual' in $directory" >&2
        exit 1
    end
end

set -l explicit_npm "$test_root/explicit-npm"
mkdir -p "$explicit_npm/nested"
printf '{"packageManager":"npm@11.11.0"}\n' >"$explicit_npm/package.json"
touch "$explicit_npm/pnpm-lock.yaml"
assert_output "npm install" "$explicit_npm/nested" install

set -l explicit_pnpm "$test_root/explicit-pnpm"
mkdir -p "$explicit_pnpm/nested"
printf '{"packageManager":"pnpm@11.15.1"}\n' >"$explicit_pnpm/package.json"
touch "$explicit_pnpm/package-lock.json"
assert_output "pnpm run build" "$explicit_pnpm/nested" run build

set -l nearest_lock "$test_root/nearest-lock"
mkdir -p "$nearest_lock/packages/app/src"
touch "$nearest_lock/pnpm-lock.yaml" "$nearest_lock/packages/app/package-lock.json"
assert_output "npm install" "$nearest_lock/packages/app/src" install

set -l pnpm_lock "$test_root/pnpm-lock"
mkdir -p "$pnpm_lock/src"
touch "$pnpm_lock/pnpm-lock.yaml"
assert_output "pnpm install" "$pnpm_lock/src" install

set -l no_marker "$test_root/no-marker"
mkdir -p "$no_marker/nested"
assert_output "pnpm run check" "$no_marker/nested" run check

set -l ambiguous "$test_root/ambiguous"
mkdir -p "$ambiguous"
touch "$ambiguous/package-lock.json" "$ambiguous/pnpm-lock.yaml"
begin
    cd "$ambiguous"
    npm install >/dev/null 2>/dev/null
end
if test $status -ne 2
    echo "FAIL: ambiguous lockfiles should return status 2" >&2
    exit 1
end

echo "npm routing tests passed"
