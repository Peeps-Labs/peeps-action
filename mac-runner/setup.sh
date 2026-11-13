#!/usr/bin/env bash
# Offers this Mac as a GitHub Actions runner for iOS simulator jobs.
#
#   ./setup.sh                  install and register it (about 15 minutes the first time)
#   mac-runner status           is it running, connected, busy?
#   mac-runner off | on         pause it (a demo, a call, on battery) and resume it
#   mac-runner remove           unregister it from GitHub and uninstall it
#
# Settings, as environment variables. RUNNER_SCOPE and RUNNER_LABEL are required:
#   RUNNER_SCOPE   "owner/repo" for one repository, or an org name for the whole org
#   RUNNER_LABEL   the label every Mac shares; the workflow's runs-on names it (e.g. ios-mac)
#   RUNNER_GROUP   org runner group to join (org scope only; empty = Default)
#   RUNNER_NAME    defaults to <your user>-<this Mac's local hostname>, also added as a label
#   RUNNER_TOKEN   registration token; otherwise made with `gh` (needs admin) or asked for
#   RUNNER_BREW    Homebrew packages the jobs need (default: jq)
set -euo pipefail

RUNNER_SCOPE="${RUNNER_SCOPE:-}"
RUNNER_LABEL="${RUNNER_LABEL:-}"
RUNNER_GROUP="${RUNNER_GROUP:-}"
RUNNER_BREW="${RUNNER_BREW:-jq}"
MIN_DISK_GB=30
MIN_RAM_GB=16

say() { printf '%s\n' "$*"; }
die() { printf '\nmac-runner: %s\n' "$*" >&2; exit 1; }

# A later `mac-runner <command>` reads the settings saved at install time.
SELF="$(cd "$(dirname "$(readlink "${BASH_SOURCE[0]}" || echo "${BASH_SOURCE[0]}")")" && pwd)"
if [[ -f "$SELF/.mac-runner.env" ]]; then
  # shellcheck disable=SC1091
  source "$SELF/.mac-runner.env"
fi
RUNNER_DIR="${RUNNER_DIR:-$HOME/actions-runner-$RUNNER_LABEL}"

scope_api() { # $1 = registration-token | remove-token
  if [[ "$RUNNER_SCOPE" == */* ]]; then
    echo "repos/$RUNNER_SCOPE/actions/runners/$1"
  else
    echo "orgs/$RUNNER_SCOPE/actions/runners/$1"
  fi
}

settings_page() {
  if [[ "$RUNNER_SCOPE" == */* ]]; then
    echo "https://github.com/$RUNNER_SCOPE/settings/actions/runners"
  else
    echo "https://github.com/organizations/$RUNNER_SCOPE/settings/actions/runners"
  fi
}

token() { # $1 = registration-token | remove-token, $2 = env var that may hold it
  local t
  if [[ -n "${!2:-}" ]]; then echo "${!2}"; return; fi
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    if t=$(gh api -X POST "$(scope_api "$1")" -q .token 2>/dev/null) && [[ -n "$t" ]]; then
      echo "$t"; return
    fi
    say "Your gh login can't make a $1 for $RUNNER_SCOPE (that needs admin)." >&2
  fi
  say "Ask an admin of $RUNNER_SCOPE for a runner token: $(settings_page)" >&2
  say "(New self-hosted runner shows it after --token; it is good for one hour.)" >&2
  read -rsp "Paste the token: " t </dev/tty; echo >&2
  [[ -n "$t" ]] || die "no token given"
  echo "$t"
}

need_installed() {
  [[ -f "$RUNNER_DIR/.runner" ]] || die "no runner installed in $RUNNER_DIR; run ./setup.sh first"
  cd "$RUNNER_DIR"
}

preflight() {
  say "Checking this Mac..."
  [[ "$(uname -s)" == Darwin ]] || die "this script is for macOS"
  [[ "$(uname -m)" == arm64 ]] || die "this needs an Apple silicon Mac"

  local ram disk
  ram=$(( $(sysctl -n hw.memsize) / 1073741824 ))
  (( ram >= MIN_RAM_GB )) || die "this Mac has ${ram} GB of RAM; simulator jobs need at least ${MIN_RAM_GB} GB"
  (( ram >= 24 )) || say "  Warning: ${ram} GB of RAM. Jobs will slow the Mac down while they run."
  disk=$(df -g / | awk 'NR==2 {print $4}')
  (( disk >= MIN_DISK_GB )) || die "only ${disk} GB free; free up at least ${MIN_DISK_GB} GB first"

  command -v brew >/dev/null 2>&1 || die "install Homebrew first: https://brew.sh"
  eval "$(brew shellenv)"
  local pkg
  for pkg in $RUNNER_BREW; do
    brew list --formula "$pkg" >/dev/null 2>&1 || brew install "$pkg"
  done

  xcodebuild -version >/dev/null 2>&1 \
    || die "install Xcode from the App Store, open it once, then run this again"
  if ! xcodebuild -license check >/dev/null 2>&1; then
    say "  Xcode's licence needs accepting (asks for your password once)."
    sudo xcodebuild -license accept
  fi
  if ! xcodebuild -checkFirstLaunchStatus >/dev/null 2>&1; then
    say "  Xcode needs its first-launch setup (asks for your password once)."
    sudo xcodebuild -runFirstLaunch
  fi
  if ! xcrun simctl list runtimes -j \
      | jq -e '[.runtimes[] | select(.platform == "iOS" and .isAvailable)] | length > 0' >/dev/null; then
    say "  Downloading the iOS simulator runtime (about 8 GB)..."
    xcodebuild -downloadPlatform iOS
  fi
  say "  OK: $(xcodebuild -version | head -1), ${ram} GB RAM, ${disk} GB free."
}

install() {
  [[ -n "$RUNNER_SCOPE" && -n "$RUNNER_LABEL" ]] \
    || die "set RUNNER_SCOPE (owner/repo or org) and RUNNER_LABEL, e.g. RUNNER_SCOPE=acme/ios RUNNER_LABEL=ios-mac ./setup.sh"
  [[ "$RUNNER_LABEL" =~ ^[A-Za-z0-9._-]+$ ]] || die "RUNNER_LABEL may hold only letters, digits, '.', '_' and '-'"
  if [[ -f "$RUNNER_DIR/.runner" ]]; then
    say "A runner is already installed in $RUNNER_DIR."
    say "Use 'mac-runner status', or 'mac-runner remove' and run this again."
    exit 0
  fi
  preflight

  local name="${RUNNER_NAME:-$(id -un)-$(scutil --get LocalHostName)}"
  local reg_token
  reg_token=$(token registration-token RUNNER_TOKEN)

  say "Downloading the GitHub Actions runner..."
  mkdir -p "$RUNNER_DIR"
  cd "$RUNNER_DIR"
  local release ver sha
  release=$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest)
  ver=$(jq -r .tag_name <<<"$release"); ver="${ver#v}"
  sha=$(jq -r .body <<<"$release" \
    | sed -n 's/.*<!-- BEGIN SHA osx-arm64 -->\([0-9a-f]\{64\}\)<!-- END SHA osx-arm64 -->.*/\1/p')
  [[ -n "$sha" ]] || die "could not read the checksum for runner v$ver; nothing installed"
  curl -fsSL -o runner.tar.gz \
    "https://github.com/actions/runner/releases/download/v$ver/actions-runner-osx-arm64-$ver.tar.gz"
  echo "$sha  runner.tar.gz" | shasum -a 256 -c - >/dev/null || die "runner download failed its checksum"
  tar xzf runner.tar.gz
  rm runner.tar.gz

  say "Registering $name with $RUNNER_SCOPE..."
  local args=(--url "https://github.com/$RUNNER_SCOPE" --token "$reg_token" --name "$name"
    --labels "$RUNNER_LABEL,$name" --work _work --unattended)
  if [[ -n "$RUNNER_GROUP" && "$RUNNER_SCOPE" != */* ]]; then
    args+=(--runnergroup "$RUNNER_GROUP")
  fi
  # No --replace: a name clash should fail, not take over someone else's runner.
  ./config.sh "${args[@]}"
  # The service starts without a locale, and CocoaPods and other Ruby tools need UTF-8.
  grep -q '^LANG=' .env 2>/dev/null || echo 'LANG=en_US.UTF-8' >> .env

  # Runs as you, in your login session, where simulators work; starts again after a restart.
  ./svc.sh install
  ./svc.sh start

  cp "${BASH_SOURCE[0]}" "$RUNNER_DIR/mac-runner"
  chmod +x "$RUNNER_DIR/mac-runner"
  printf 'RUNNER_SCOPE=%q\nRUNNER_LABEL=%q\nRUNNER_DIR=%q\n' \
    "$RUNNER_SCOPE" "$RUNNER_LABEL" "$RUNNER_DIR" > "$RUNNER_DIR/.mac-runner.env"
  ln -sf "$RUNNER_DIR/mac-runner" "$(brew --prefix)/bin/mac-runner"

  say ""
  say "Done. $name now takes jobs labelled $RUNNER_LABEL (or $name) from $RUNNER_SCOPE."
  say "  mac-runner status   check it"
  say "  mac-runner off      pause it; 'mac-runner on' resumes"
  say "  mac-runner remove   uninstall it"
  say "Runners page: $(settings_page)"
}

status() {
  need_installed
  local name log
  name=$(jq -r .agentName .runner 2>/dev/null || echo "?")
  say "Runner $name for $RUNNER_SCOPE, label $RUNNER_LABEL, in $RUNNER_DIR"
  ./svc.sh status | grep -E 'Started|Stopped|not installed' || true
  log=$(ls -t _diag/Runner_*.log 2>/dev/null | head -1 || true)
  if [[ -n "$log" ]] && grep -q 'Listening for Jobs' "$log"; then
    say "Connected to GitHub."
  else
    say "Not connected to GitHub yet (see $RUNNER_DIR/_diag)."
  fi
  if pgrep -f "$RUNNER_DIR/bin/Runner.Worker" >/dev/null; then
    say "Running a job now."
  else
    say "Idle."
  fi
}

off() {
  need_installed
  ./svc.sh stop
  say "Paused. Jobs go to another Mac, or wait until one is online. 'mac-runner on' resumes."
}

on() {
  need_installed
  ./svc.sh start
  say "Resumed."
}

remove() {
  need_installed
  local rm_token
  rm_token=$(token remove-token RUNNER_REMOVE_TOKEN)
  ./svc.sh stop || true
  ./svc.sh uninstall || true
  ./config.sh remove --token "$rm_token"
  local link
  link="$(brew --prefix 2>/dev/null)/bin/mac-runner"
  if [[ "$(readlink "$link" 2>/dev/null)" == "$RUNNER_DIR/mac-runner" ]]; then rm -f "$link"; fi
  cd "$HOME"
  if [[ "$RUNNER_DIR" == "$HOME"/actions-runner-* ]]; then rm -rf "$RUNNER_DIR"; fi
  say "Removed. Appium's cache in ~/.appium-ci is kept; delete it if you like."
}

case "${1:-install}" in
  install) install ;;
  status) status ;;
  off) off ;;
  on) on ;;
  remove) remove ;;
  *) die "usage: setup.sh [install] | mac-runner status|off|on|remove" ;;
esac
