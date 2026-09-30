#! /bin/sh
# Build sourcekitten against the Swift toolchain installed in this image.
#
# Swift evidence (`cdxgen -t swift --evidence`, `evinse -l swift`) drives
# SourceKit through sourcekitten. SourceKitten links the Swift runtime of the
# toolchain that builds it, and Linux Swift has no stable ABI, so a prebuilt
# binary only runs next to that exact toolchain. cdxgen-plugins-bin no longer
# ships one for Linux (cdxgen/cdxgen-plugins-bin#119); the images build their
# own and point SOURCEKITTEN_CMD at it.
#
# Environment variables honoured:
#   SOURCEKITTEN_VERSION - SourceKitten release to build (default 0.38.0)
#   SOURCEKITTEN_SHA256  - sha256 of that release tarball
#   GITHUB_URL           - GitHub mirror (default https://github.com)
#   SOURCEKITTEN_PREFIX  - install directory (default /usr/local/bin)

set -e

SOURCEKITTEN_VERSION="${SOURCEKITTEN_VERSION:-0.38.0}"
# The tarball builds arbitrary Swift on the build host, so its bytes are
# pinned, as in cdxgen-plugins-bin's thirdparty/sourcekitten/build.sh
SOURCEKITTEN_SHA256="${SOURCEKITTEN_SHA256:-7eaf0b7acaa2ae4bebf49c686641f9e50b0044c1a91d3c75121ecf698d7fbb91}"
GITHUB_URL="${GITHUB_URL:-https://github.com}"
SOURCEKITTEN_PREFIX="${SOURCEKITTEN_PREFIX:-/usr/local/bin}"

workdir="$(mktemp -d)"
# SwiftPM keeps its temporary directories and lock files in TMPDIR
mkdir -p "${workdir}/tmp"
export TMPDIR="${workdir}/tmp"
mkdir -p "${workdir}/src"
cd "${workdir}/src"
curl -fsSL -o sourcekitten.tar.gz \
  "${GITHUB_URL}/jpsim/SourceKitten/releases/download/${SOURCEKITTEN_VERSION}/SourceKitten-${SOURCEKITTEN_VERSION}.tar.gz"
echo "${SOURCEKITTEN_SHA256}  sourcekitten.tar.gz" | sha256sum -c -
tar -xzf sourcekitten.tar.gz --strip-components=1
rm sourcekitten.tar.gz
swift build -c release --product sourcekitten
mkdir -p "${SOURCEKITTEN_PREFIX}"
install -m 0755 .build/release/sourcekitten "${SOURCEKITTEN_PREFIX}/sourcekitten"
cd /
# SwiftPM and clang also leave package, module, and URL caches behind; none
# of them are needed at run time
rm -rf "${workdir}" "${HOME}/.swiftpm" "${HOME}/.cache/org.swift.swiftpm" \
  "${HOME}/.cache/org.swift.foundation.URLCache" "${HOME}/.cache/clang"

# `sourcekitten version` succeeds even when SourceKit cannot be loaded, so a
# syntax request is the check that the binary and the toolchain match
"${SOURCEKITTEN_PREFIX}/sourcekitten" syntax --text "import Swift" > /dev/null
"${SOURCEKITTEN_PREFIX}/sourcekitten" version
