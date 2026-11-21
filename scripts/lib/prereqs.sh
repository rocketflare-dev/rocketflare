# Prerequisite checks `scripts/bootstrap.sh` sources before Node exists — the parts that need a
# precise, platform-specific fix line: Windows through WSL2 above all, where three things stop a
# fresh machine before the bootstrap can run (a root-only distro, Docker Desktop's WSL integration
# switched off, no Node version manager) and one makes the failure message point at the wrong thing
# (Windows' PATH leaking into the distro, so `corepack`/`pnpm` resolve to Windows scripts).
#
# Functions only, no side effects on source. Each `*_hint` prints the fix lines and returns 0; the
# caller decides to fail. Bash 3.2 (macOS) compatible. Tested by
# `apps/web/tests/config/prereqs-sh.test.ts`, which sources this file with a fake environment:
# `ROCKETFLARE_PROC_VERSION` (default /proc/version) and `ROCKETFLARE_WINDOWS_ROOT` (default /mnt/c)
# exist for that and nothing else.

# True inside WSL: the distro name WSL exports, or "microsoft" in the kernel version string.
is_wsl() {
  [ -n "${WSL_DISTRO_NAME:-}" ] && return 0
  grep -qi microsoft "${ROCKETFLARE_PROC_VERSION:-/proc/version}" 2>/dev/null
}

# True when a resolved command path lives on a Windows drive (`/mnt/c/...`): a Windows program or
# script that WSL's shared PATH exposed, never the Linux tool the bootstrap wants.
is_windows_path() {
  case "${1:-}" in
    /mnt/[a-zA-Z]/*) return 0 ;;
    *) return 1 ;;
  esac
}

# `command -v`, but only for a Linux-side binary: a Windows one on the shared PATH counts as absent.
linux_command() {
  local found
  found="$(command -v "$1" 2>/dev/null)" || return 1
  is_windows_path "$found" && return 1
  printf '%s\n' "$found"
}

# Running as root inside WSL usually means the distro has no normal user yet.
wsl_root_hint() {
  local distro="${WSL_DISTRO_NAME:-Ubuntu}"
  printf '  This WSL distro (%s) is running as root, probably because it has no normal user yet.\n' "$distro"
  printf '  1. In this shell:             adduser <name> && usermod -aG sudo <name>\n'
  printf '  2. In Windows PowerShell:     wsl -d %s -u <name>\n' "$distro"
  printf '     (and to make it the default: wsl --manage %s --set-default-user <name>)\n' "$distro"
  printf '  3. Then, as <name>, clone the kit into your Linux home (~), not /mnt/c, and re-run.\n'
}

# True when Docker Desktop is installed on the Windows side of this WSL machine.
windows_docker_desktop() {
  local root="${ROCKETFLARE_WINDOWS_ROOT:-/mnt/c}"
  [ -e "$root/Program Files/Docker/Docker/Docker Desktop.exe" ] && return 0
  command -v docker.exe >/dev/null 2>&1
}

# `docker` is missing inside WSL: integration switched off, or Docker Desktop not installed.
wsl_docker_hint() {
  local distro="${WSL_DISTRO_NAME:-this distro}"
  if windows_docker_desktop; then
    printf '  Docker Desktop is installed on Windows but not reachable from %s.\n' "$distro"
    printf '  Docker Desktop → Settings → Resources → WSL integration → turn on %s → Apply,\n' "$distro"
    printf '  then QUIT Docker Desktop (tray icon → Quit) and start it again — restarting the\n'
    printf '  distro is not enough. Check with: docker version\n'
  else
    printf '  Install Docker Desktop for Windows (WSL 2 backend), turn on WSL integration for\n'
    printf '  %s in Settings → Resources, then quit and restart Docker Desktop.\n' "$distro"
  fi
}

# No Node of the right major and no version manager to install one.
node_install_hint() {
  local major="$1"
  if [ "$(uname -s)" = Darwin ]; then
    printf '  brew install fnm && fnm install %s   (or install nvm, then: nvm install %s)\n' "$major" "$major"
  else
    printf '  Install nvm (https://github.com/nvm-sh/nvm#installing-and-updating):\n'
    printf '    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash\n'
    printf '  then open a NEW shell and run: nvm install %s — and re-run this script.\n' "$major"
  fi
}
