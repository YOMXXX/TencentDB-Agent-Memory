# `vec0.dll` — sqlite-vec for Windows ARM64 (build provenance)

This directory ships a **precompiled `vec0.dll`** (the [sqlite-vec](https://github.com/asg017/sqlite-vec)
loadable extension) for **Windows on ARM64 (`win32-arm64`)**.

Upstream sqlite-vec publishes prebuilt binaries for macOS, Linux, and Windows
**x86_64** — but **not** for Windows ARM64. Without this extension, SQLite cannot
create the `vec0` virtual tables that power semantic vector search, so on ARM64
the memory gateway silently falls back to keyword-only search. This binary closes
that gap; it is what makes semantic search work on ARM64 out of the box.

> It is a **locally compiled, unofficial** build. It is not produced or endorsed
> by the sqlite-vec project. The provenance below lets you verify it or rebuild
> an equivalent binary yourself.

## What is shipped

| Field | Value |
|---|---|
| File | `vec0.dll` |
| Size | `252416` bytes |
| SHA-256 | `d1e996e5c1670db85dc0f54794b714a32de276b64984ea669c63a0636509f89b` |
| sqlite-vec version | `v0.1.7-alpha.2` (reported by `select vec_version();`) |
| Target | `aarch64-windows` (Windows ARM64) |
| Compiler | `zig` `0.14.1` (used `zig cc` as the C cross-compiler) |
| Source | [asg017/sqlite-vec](https://github.com/asg017/sqlite-vec), tag `v0.1.7-alpha.2` |

> **Honesty note.** The version, source tag, and zig version above are the
> build-time record for this binary. I did **not** keep the exact shell
> invocation, so the commands in [Rebuild it yourself](#rebuild-it-yourself)
> below are the **canonical sqlite-vec build procedure** adapted for the
> `aarch64-windows` zig target — they reproduce a functionally identical
> extension (`vec_version` `v0.1.7-alpha.2`). Byte-for-byte identity is not
> guaranteed across machines (it depends on the exact zig point release, build
> paths, and toolchain determinism); use the SHA-256 above to compare, and
> `vec_version()` + the KNN check below to confirm functional equivalence.

## Verify this binary

```powershell
# 1. Hash
Get-FileHash .\vec0.dll -Algorithm SHA256
# -> d1e996e5c1670db85dc0f54794b714a32de276b64984ea669c63a0636509f89b

# 2. Version + KNN round-trip (Node 22+, which has node:sqlite)
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(':memory:',{allowExtension:true});db.loadExtension('./vec0.dll');console.log('vec_version',db.prepare('select vec_version() v').get().v);db.exec('create virtual table t using vec0(e float[4])');db.exec(\"insert into t(rowid,e) values (1,'[1,2,3,4]'),(2,'[9,9,9,9]')\");console.log('knn',db.prepare(\"select rowid,distance from t where e match '[1,2,3,4]' order by distance limit 1\").all());"
# -> vec_version v0.1.7-alpha.2
# -> knn [ { rowid: 1, distance: 0 } ]
```

## Rebuild it yourself

You need [zig](https://ziglang.org/) (the build above used `0.14.1`) and a POSIX
shell (Git Bash / WSL / msys2 work on Windows).

```sh
git clone https://github.com/asg017/sqlite-vec
cd sqlite-vec
git checkout v0.1.7-alpha.2

# Vendor the SQLite amalgamation (provides vendor/sqlite3ext.h)
./scripts/vendor.sh

# Cross-compile the loadable extension for Windows ARM64 with zig as CC.
# (Windows DLLs omit -fPIC; this mirrors the Makefile's `loadable` rule.)
zig cc -target aarch64-windows \
  -shared -Wall -Wextra -Ivendor/ -O3 \
  sqlite-vec.c -o vec0.dll
```

Equivalently, via the project's Makefile (it honours a `CC` override):

```sh
make loadable CC="zig cc -target aarch64-windows"
# output: dist/vec0.dll
```

Then compare with `Get-FileHash` / `vec_version()` as shown above.

## License & attribution

`sqlite-vec` is authored by **Alex Garcia** ([asg017/sqlite-vec](https://github.com/asg017/sqlite-vec))
and is dual-licensed **MIT OR Apache-2.0**. This redistributed binary is covered
by that same upstream license; all copyright remains with the sqlite-vec authors.
See the upstream [LICENSE](https://github.com/asg017/sqlite-vec/blob/main/LICENSE).
This fork only compiled and repackaged the extension for the `win32-arm64`
target that upstream does not yet provide.
