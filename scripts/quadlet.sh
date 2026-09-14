#!/usr/bin/env sh
# The quadlet units under docker/quadlet/ are GENERATED from the compose files
# by podlet (github.com/containers/podlet). Nobody edits them by hand: this
# script writes them, and the pre-push hook regenerates them and fails the push
# the moment the committed copy differs from a fresh run. M231 spec 02.
#
#   scripts/quadlet.sh generate            rewrite docker/quadlet/<scenario>/ for every scenario
#   scripts/quadlet.sh check               regenerate into a temp dir, diff against the committed copy
#   scripts/quadlet.sh check --self-test-drift
#                                          prove the check CAN fail: plant a wrong unit, expect drift
#   scripts/quadlet.sh --install <dir>     download the pinned podlet release into <dir> (for a CI runner)
#
# WHAT THE TRANSFORM DOES, and why each step exists. podlet reads plain compose
# YAML and refuses the parts of it that have no quadlet equivalent, so a small
# stdlib-only Python pass rewrites each file before podlet sees it:
#
#   * `${VAR:-default}` and `${VAR-default}` become `default`. podlet does not
#     interpolate, and systemd does not expand `${VAR}` inside Environment=,
#     so a literal would reach the container as the string "${VAR}".
#   * `${VAR:?message}` (a value the operator MUST supply) is dropped from
#     `environment:` and the service gains `env_file: <project>.env`, which
#     podlet turns into `EnvironmentFile=<project>.env`. Quadlet resolves that
#     path against the unit directory and refuses to start without the file,
#     which is the same "set it or nothing starts" contract compose enforces.
#   * `depends_on: { x: { condition: service_healthy } }` becomes the short
#     list form, which podlet accepts and turns into After= and Requires=. The
#     health wait comes back as `Notify=healthy` on every unit whose compose
#     service DECLARES a healthcheck: systemd then holds the dependants until
#     the check passes. Image-baked healthchecks are deliberately left alone;
#     openplate-inference's has a 60 minute start period, and Notify=healthy
#     on it would run into systemd's 90 second start timeout.
#   * `build:` is dropped and a commented `# image:` directly below it is
#     uncommented. The units run the published image; podlet cannot build.
#   * every service joins one named network, called after the compose
#     `name:`. Compose does this implicitly (the `<project>_default` network)
#     and it is what lets `sync` reach `postgres` by hostname; a bare quadlet
#     unit with no Network= lands on the default bridge, which has no DNS.
#
# Every unit starts with a header naming its source compose file and the
# podlet version, so a reader knows where a change has to be made. The output
# is byte-deterministic: podlet sorts its keys, and the transform is pure.
set -eu

cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

PODLET_VERSION=0.3.2
PODLET_TARBALL=podlet-x86_64-unknown-linux-gnu.tar.xz
PODLET_TARBALL_SHA256=d28975df717ce20374a6dc4176670ce6faf8dcb3ab4af761a39fdd2f863d03f6
PODLET_RELEASE_URL="https://github.com/containers/podlet/releases/download/v${PODLET_VERSION}"
OUT_ROOT=docker/quadlet

# The scenarios this repository owns, as "<scenario>=<compose file>". This
# table is the only thing that differs between the three copies of this script
# (openplate, openplate-core, openplate-inference).
SCENARIOS="
core=docker/compose.yml
"

fail() {
  echo "✖ quadlet: $1" >&2
  exit 1
}

usage() {
  echo "usage: scripts/quadlet.sh generate | check [--self-test-drift] | --install <dir>" >&2
  exit 2
}

# ── podlet itself ───────────────────────────────────────────────────────────

require_podlet() {
  command -v podlet >/dev/null 2>&1 || fail "podlet is not on PATH. Install podlet ${PODLET_VERSION}: 'brew install podlet' on this host, or 'scripts/quadlet.sh --install <dir>' on a runner."
  found=$(podlet --version 2>/dev/null | awk '{print $2}')
  [ "$found" = "$PODLET_VERSION" ] || fail "podlet ${PODLET_VERSION} is pinned, found ${found:-unknown}. The units name their generator version, so a different one drifts every file. Install ${PODLET_VERSION}: 'brew install podlet' or 'scripts/quadlet.sh --install <dir>'."
}

install_podlet() {
  dir=$1
  [ -n "$dir" ] || usage
  command -v curl >/dev/null 2>&1 || fail "--install needs curl."
  command -v sha256sum >/dev/null 2>&1 || fail "--install needs sha256sum."
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  echo "▶ quadlet: downloading podlet ${PODLET_VERSION} (${PODLET_TARBALL})"
  curl -fsSL -o "$work/$PODLET_TARBALL" "$PODLET_RELEASE_URL/$PODLET_TARBALL"
  curl -fsSL -o "$work/$PODLET_TARBALL.sha256" "$PODLET_RELEASE_URL/$PODLET_TARBALL.sha256"
  published=$(awk '{print $1}' "$work/$PODLET_TARBALL.sha256")
  [ "$published" = "$PODLET_TARBALL_SHA256" ] || fail "the published .sha256 (${published}) is not the pinned one (${PODLET_TARBALL_SHA256}). The release changed under the tag; stop and look."
  actual=$(sha256sum "$work/$PODLET_TARBALL" | awk '{print $1}')
  [ "$actual" = "$PODLET_TARBALL_SHA256" ] || fail "the tarball's sha256 (${actual}) does not match the pinned one. Refusing to install it."
  mkdir -p "$dir"
  tar -xJf "$work/$PODLET_TARBALL" -C "$work"
  install -m 0755 "$work/${PODLET_TARBALL%.tar.xz}/podlet" "$dir/podlet"
  echo "  installed $dir/podlet ($("$dir/podlet" --version))"
}

# ── the transform ───────────────────────────────────────────────────────────

# normalise <compose file> : the podlet-ready YAML on stdout.
normalise() {
  python3 - "$1" <<'PY'
import re
import sys

path = sys.argv[1]
lines = open(path, encoding="utf-8").read().split("\n")

DEFAULTED = re.compile(r"\$\{[A-Za-z_][A-Za-z0-9_]*:?-([^}]*)\}")
# `KEY: ${VAR:-}` means "set, and empty". Left as a bare `KEY:` it would be
# YAML null, which podlet writes as `Environment=KEY`, which podman reads as
# "copy KEY from the host if set": a different contract.
EMPTY_DEFAULT = re.compile(r"^(\s+[A-Za-z_][A-Za-z0-9_]*:\s+)\$\{[A-Za-z_][A-Za-z0-9_]*:?-\}\s*$")
REQUIRED = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*):\?[^}]*\}")


def indent(line):
    return len(line) - len(line.lstrip(" "))


def is_blank_or_comment(line):
    return line.strip() == "" or line.lstrip().startswith("#")


# The compose project name is what the shared network and the env file are
# called after. Every compose file here pins one.
name = None
for line in lines:
    m = re.match(r"^name:\s*([A-Za-z0-9_.-]+)\s*$", line)
    if m:
        name = m.group(1)
        break
if name is None:
    sys.exit(f"quadlet: {path} has no top-level name:, nothing to call the network after")

# Split into top-level blocks so services can be handled one at a time.
# A block starts at a line with no indent that is not blank or a comment.
blocks = []
current = []
for line in lines:
    if indent(line) == 0 and not is_blank_or_comment(line) and current:
        blocks.append(current)
        current = []
    current.append(line)
if current:
    blocks.append(current)


def transform_service(block):
    """block: the lines of one service, starting at its `  key:` line."""
    out = []
    needs_env_file = False
    i = 0
    n = len(block)
    while i < n:
        line = block[i]
        stripped = line.lstrip()
        ind = indent(line)

        # build: (scalar or mapping) is dropped, and a commented image directly
        # below it is uncommented so the service runs the published image.
        if ind == 4 and re.match(r"^build:(\s|$)", stripped):
            i += 1
            while i < n and (block[i].strip() == "" or indent(block[i]) > 4):
                i += 1
            while i < n and indent(block[i]) == 4 and block[i].lstrip().startswith("#"):
                m = re.match(r"^    # (image:\s*\S+)\s*$", block[i])
                if m:
                    out.append("    " + m.group(1))
                    i += 1
                    break
                out.append(block[i])
                i += 1
            continue

        # depends_on: long form to short list form.
        if ind == 4 and re.match(r"^depends_on:\s*$", stripped):
            out.append(line)
            i += 1
            while i < n and (block[i].strip() == "" or indent(block[i]) > 4):
                dep = block[i]
                m = re.match(r"^      ([A-Za-z0-9_.-]+):\s*$", dep)
                if m:
                    out.append(f"      - {m.group(1)}")
                elif indent(dep) >= 8 and not is_blank_or_comment(dep):
                    pass  # condition: service_healthy, expressed as Notify=healthy later
                else:
                    out.append(dep)
                i += 1
            continue

        # A required variable leaves the environment block; the env file
        # supplies it.
        if not stripped.startswith("#") and REQUIRED.search(line):
            needs_env_file = True
            i += 1
            continue

        out.append(DEFAULTED.sub(r"\1", EMPTY_DEFAULT.sub(r'\1""', line)))
        i += 1

    # Trailing blank lines belong between services, keep them last.
    trailing = []
    while out and out[-1].strip() == "":
        trailing.insert(0, out.pop())
    out.append(f"    networks: [{name}]")
    if needs_env_file:
        out.append(f"    env_file: [{name}.env]")
    return out + trailing


def transform_services(block):
    """block: the `services:` block. Services start at indent 2."""
    head = [block[0]]
    services = []
    current = None
    for line in block[1:]:
        if indent(line) == 2 and not is_blank_or_comment(line):
            if current is not None:
                services.append(current)
            current = []
        if current is None:
            head.append(line)
        else:
            current.append(line)
    if current is not None:
        services.append(current)
    out = head
    for service in services:
        out.extend(transform_service(service))
    return out


result = []
has_networks = False
for block in blocks:
    key = block[0].split(":")[0]
    if key == "services":
        result.extend(transform_services(block))
    elif key == "networks":
        has_networks = True
        result.extend(DEFAULTED.sub(r"\1", l) for l in block)
        result.append(f"  {name}: {{}}")
    else:
        result.extend(DEFAULTED.sub(r"\1", l) for l in block)

if not has_networks:
    if result and result[-1].strip() != "":
        result.append("")
    result.append("networks:")
    result.append(f"  {name}: {{}}")

sys.stdout.write("\n".join(result).rstrip("\n") + "\n")
PY
}

# finish <unit dir> <source compose file> : header and Notify=healthy, in place.
finish() {
  python3 - "$1" "$2" "$PODLET_VERSION" <<'PY'
import os
import sys

unit_dir, source, version = sys.argv[1:4]
for entry in sorted(os.listdir(unit_dir)):
    path = os.path.join(unit_dir, entry)
    body = open(path, encoding="utf-8").read().split("\n")
    out = []
    healthy_done = False
    for i, line in enumerate(body):
        out.append(line)
        if entry.endswith(".container") and line.startswith("Health") and not healthy_done:
            nxt = body[i + 1] if i + 1 < len(body) else ""
            if not nxt.startswith("Health"):
                out.append("Notify=healthy")
                healthy_done = True
    header = [
        f"# GENERATED by scripts/quadlet.sh from {source} with podlet {version}.",
        "# Do not edit by hand: change the compose file, run",
        "# `scripts/quadlet.sh generate`, and commit the result.",
        "",
    ]
    text = "\n".join(header + out).rstrip("\n") + "\n"
    open(path, "w", encoding="utf-8").write(text)
PY
}

# generate_into <root> : every scenario under <root>/<scenario>/.
generate_into() {
  root=$1
  for entry in $SCENARIOS; do
    scenario=${entry%%=*}
    source=${entry#*=}
    [ -f "$source" ] || fail "$scenario: $source does not exist."
    work=$(mktemp -d)
    normalise "$source" >"$work/compose.yml"
    mkdir -p "$work/units"
    if ! podlet --file "$work/units" --install --split-options Environment --skip-services-check \
      compose "$work/compose.yml" >"$work/podlet.log" 2>&1; then
      cat "$work/podlet.log" >&2
      rm -rf "$work"
      fail "$scenario: podlet rejected the normalised $source (above)."
    fi
    finish "$work/units" "$source"
    rm -rf "${root:?}/$scenario"
    mkdir -p "$root"
    mv "$work/units" "$root/$scenario"
    rm -rf "$work"
  done
}

# compare <fresh root> <committed root> : 0 when identical, 1 naming each file.
compare() {
  fresh=$1
  committed=$2
  status=0
  for entry in $SCENARIOS; do
    scenario=${entry%%=*}
    source=${entry#*=}
    if [ ! -d "$committed/$scenario" ]; then
      echo "✖ quadlet: $committed/$scenario is missing; run scripts/quadlet.sh generate and commit it." >&2
      status=1
      continue
    fi
    # -q names each file first (the line a reader acts on), then -u shows why.
    if ! diff -r -q "$committed/$scenario" "$fresh/$scenario" >"$fresh/.names.$scenario" 2>&1; then
      echo "✖ quadlet: $committed/$scenario differs from a fresh podlet run of $source:" >&2
      sed 's/^/  /' "$fresh/.names.$scenario" >&2
      diff -r -u "$committed/$scenario" "$fresh/$scenario" >&2 || true
      status=1
    fi
  done
  return $status
}

cmd_generate() {
  require_podlet
  generate_into "$OUT_ROOT"
  for entry in $SCENARIOS; do
    scenario=${entry%%=*}
    printf '  %s:' "$OUT_ROOT/$scenario"
    for unit in "$OUT_ROOT/$scenario"/*; do printf ' %s' "${unit##*/}"; done
    echo
  done
}

committed_scenarios() {
  for entry in $SCENARIOS; do
    scenario=${entry%%=*}
    [ -d "$OUT_ROOT/$scenario" ] && echo "$scenario"
  done
  return 0
}

cmd_check() {
  require_podlet
  if [ -z "$(committed_scenarios)" ]; then
    echo "  no scenario is committed under $OUT_ROOT yet; nothing to compare"
    return 0
  fi
  fresh=$(mktemp -d)
  trap 'rm -rf "$fresh"' EXIT
  generate_into "$fresh"
  if compare "$fresh" "$OUT_ROOT"; then
    echo "  $OUT_ROOT agrees with a fresh podlet ${PODLET_VERSION} run ($(committed_scenarios | wc -l | tr -d ' ') scenarios)"
    return 0
  fi
  echo "  Run scripts/quadlet.sh generate and commit docker/quadlet/. Never edit a unit by hand." >&2
  return 1
}

# The control case. The fresh generation is compared against a copy of itself
# in which one .container has been replaced by the bundled, deliberately wrong
# fixture. If that does not fail and name the file, the check proves nothing.
cmd_self_test_drift() {
  require_podlet
  fixture=scripts/quadlet-drift-fixture.container
  [ -f "$fixture" ] || fail "the drift fixture $fixture is missing."
  fresh=$(mktemp -d)
  planted=$(mktemp -d)
  trap 'rm -rf "$fresh" "$planted"' EXIT
  generate_into "$fresh"
  cp -R "$fresh"/. "$planted"/
  first=$(find "$planted" -name '*.container' | LC_ALL=C sort | head -n 1)
  [ -n "$first" ] || fail "self-test: no .container was generated, nothing to plant the fixture over."
  cp "$fixture" "$first"
  echo "▶ quadlet: self-test, planted $fixture over ${first#"$planted"/}"
  if compare "$fresh" "$planted"; then
    echo "✖ quadlet: self-test FAILED, the planted drift went unnoticed. The check cannot fail, so it proves nothing." >&2
    return 2
  fi
  echo "  self-test: the planted drift was caught (exit 1 is the expected outcome here)"
  return 1
}

case "${1:-}" in
  generate)
    [ $# -eq 1 ] || usage
    cmd_generate
    ;;
  check)
    case "${2:-}" in
      '') cmd_check ;;
      --self-test-drift) cmd_self_test_drift ;;
      *) usage ;;
    esac
    ;;
  --install)
    install_podlet "${2:-}"
    ;;
  *)
    usage
    ;;
esac
