#!/bin/sh
# SessionVault installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/rush-skills/sessionvault/main/install.sh | sh
#
# It installs the CLI with npm, then runs the guided setup.

set -eu

RED=''; GREEN=''; BOLD=''; RESET=''
if [ -t 1 ]; then
  RED=$(printf '\033[31m'); GREEN=$(printf '\033[32m')
  BOLD=$(printf '\033[1m'); RESET=$(printf '\033[0m')
fi

say()  { printf '%s\n' "$*"; }
ok()   { printf '%s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
die()  { printf '%s✗%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }

say "${BOLD}SessionVault${RESET} — back up every AI agent session on this machine"
say

# 1. Node
if ! command -v node >/dev/null 2>&1; then
  die "Node is not installed. Install Node 18 or later from https://nodejs.org, then run this again."
fi
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 18 ]; then
  die "Node $NODE_MAJOR is too old. SessionVault needs Node 18 or later."
fi
ok "Node $(node -v)"

# 2. The CLI
if ! command -v npm >/dev/null 2>&1; then
  die "npm is not on the PATH. Install it with Node, then run this again."
fi
say "› Installing sessionvault…"
if npm install -g sessionvault >/dev/null 2>&1; then
  ok "Installed sessionvault"
else
  die "npm could not install sessionvault. Try: sudo npm install -g sessionvault"
fi

# 3. Wrangler, for the default backend
if command -v wrangler >/dev/null 2>&1; then
  ok "Wrangler $(wrangler --version 2>/dev/null | tail -1)"
else
  say "› Installing wrangler, which SessionVault uses to reach R2…"
  npm install -g wrangler >/dev/null 2>&1 && ok "Installed wrangler" \
    || say "  Could not install wrangler. Install it later with: npm install -g wrangler"
fi

say
say "${BOLD}Next${RESET}"
say "  1. wrangler login      ${RESET}# once, if you have no Cloudflare login yet"
say "  2. sessionvault init   ${RESET}# creates the bucket and runs the first backup"
say
say "On a second machine, point it at the same bucket:"
say "  sessionvault init --bucket ai-sessions --yes"
