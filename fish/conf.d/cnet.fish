# ~/.config/fish/conf.d/cnet.fish
# Purpose: Make the vendored `cnet` binary available on PATH.
# Provenance: `cnet` is a personal Rust tool built from ~/Projects/cnet on the
# isaaclins account (arm64 Mach-O, ~6.6MB). It is committed to this repo on
# purpose as the cross-account/cross-machine distribution mechanism; rebuild
# from source and replace fish/bin/cnet to update (note: arm64-only).
fish_add_path $HOME/.config/fish/bin
