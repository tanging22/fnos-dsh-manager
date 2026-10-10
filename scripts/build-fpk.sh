#!/bin/bash
# build-fpk.sh — assemble the installable fnOS package with fnpack 1.2.3.
#
# fnpack specifics (verified against fnpack 1.2.3 on Windows):
#  - Commands are `fnpack create <name>` and `fnpack build` (run inside the
#    staged directory); there is NO --directory flag and NO `pack` subcommand.
#  - It writes temp files under $TMP/$TEMP — point them at a writable dir or
#    the build fails with "Access is denied" (seen under a locked-down TEMP).
#  - It cannot store symlinks; delete them before packing.
#  - The staged dir must contain: manifest, ICON.PNG (64), ICON_256.PNG (256),
#    config/{privilege,resource}, cmd/*, wizard/*, and the ui entry under
#    ui/ (or app/ui/) per manifest desktop_uidir.
#
# Usage: bash scripts/build-fpk.sh [fnpack-binary]
set -eu

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
STAGE="${WORK}/dsh-console"
TMPDIR="${WORK}/tmp"

trap 'rm -rf "${WORK}"' EXIT
mkdir -p "${TMPDIR}"

# fnpack writes its own temp files; give it a directory we control.
export TMP="${TMPDIR}"
export TEMP="${TMPDIR}"

VERSION="$(sed -n 's/^version=//p' "${ROOT}/manifest" | head -n1)"
if [ -z "${VERSION}" ]; then
    echo "error: manifest has no version" >&2
    exit 1
fi

echo "packing dsh-console ${VERSION}"

mkdir -p "${STAGE}"

# Copy only what the suite needs at runtime.
# `app/` is the fnpack gateway entry: fnpack requires app/ui/config (per
# manifest desktop_uidir) and bundles app/ into app.tgz, which fnOS unpacks to
# /var/apps/<name>/target/. The panel serves its static files from there, so
# app/ui must be a FULL mirror of the repo-root ui/ (index.html + assets +
# images), not just config+icons — otherwise the panel 404s after install.
for entry in manifest VERSION CHANGELOG.md LICENSE README.md ui cmd config wizard app ICON.PNG ICON_256.PNG; do
    [ -e "${ROOT}/${entry}" ] || continue
    cp -a "${ROOT}/${entry}" "${STAGE}/"
done

# Mirror the full ui/ into the staged app/ gateway tree (idempotent; keeps
# app/ui/config which only exists there).
mkdir -p "${STAGE}/app"
cp -a "${ROOT}/ui/." "${STAGE}/app/ui/"

# Development-only files must not ship.
rm -rf "${STAGE}/cmd/node_modules" "${STAGE}/ui/node_modules"

# fnpack cannot represent symlinks; drop them rather than ship broken ones.
find "${STAGE}" -type l -delete

# Shell scripts must be executable or fnOS will fail to run the lifecycle.
find "${STAGE}/cmd" -type f ! -name '*.py' ! -name '*.js' -exec chmod 755 {} +
find "${STAGE}/cmd" -type f -name '*.py' -exec chmod 644 {} +

# The lifecycle scripts and the Python bridge must be LF, or the kernel
# refuses to execute them ("bad interpreter").
if command -v python3 >/dev/null 2>&1; then
    STAGE="${STAGE}" python3 - <<'PY'
import os
for root, _, files in os.walk(os.path.join(os.environ['STAGE'], 'cmd')):
    for name in files:
        path = os.path.join(root, name)
        with open(path, 'rb') as handle:
            data = handle.read()
        if b'\r\n' in data:
            with open(path, 'wb') as handle:
                handle.write(data.replace(b'\r\n', b'\n'))
PY
fi

OUT="${ROOT}/dist"
mkdir -p "${OUT}"

# Locate fnpack: explicit arg, PATH, or the pinned 1.2.3 release binary.
PACKER="${1:-}"
if [ -z "${PACKER}" ]; then
    if command -v fnpack >/dev/null 2>&1; then
        PACKER="fnpack"
    elif [ -x "${ROOT}/tools/fnpack" ] || [ -x "${ROOT}/tools/fnpack.exe" ]; then
        PACKER="$( [ -x "${ROOT}/tools/fnpack" ] && echo "${ROOT}/tools/fnpack" || echo "${ROOT}/tools/fnpack.exe" )"
    else
        echo "error: fnpack not found; pass its path as \$1" >&2
        exit 1
    fi
fi

ARCH="$(uname -m)"
case "${ARCH}" in
    x86_64|amd64) ARCH=x86_64 ;;
    aarch64|arm64) ARCH=aarch64 ;;
    *) ARCH="${ARCH}" ;;
esac

# fnpack build runs in the staged directory and emits *.fpk in that same
# working directory ("The output file dsh-console.fpk can be found in the
# working directory"), NOT in $WORK. Collect it from $STAGE.
( cd "${STAGE}" && "${PACKER}" build )
for candidate in "${STAGE}"/*.fpk; do
    [ -e "${candidate}" ] || continue
    target="${OUT}/dsh-console-${VERSION}-${ARCH}.fpk"
    mv "${candidate}" "${target}"
    echo "wrote ${target}"
done

if [ -z "$(ls "${OUT}"/dsh-console-"${VERSION}"-*.fpk 2>/dev/null || true)" ]; then
    echo "error: fnpack build produced no .fpk" >&2
    exit 1
fi
