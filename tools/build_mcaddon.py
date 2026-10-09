# -*- coding: utf-8 -*-
"""
BP と RP を 1 つの .mcaddon にまとめる。

    python tools/build_mcaddon.py

出力: dist/redstone_extensions.mcaddon
"""

import os
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, "dist")
OUT = os.path.join(DIST, "redstone_extensions.mcaddon")

PACKS = ["RedstoneExtBP", "RedstoneExtRP"]

# パックに含めないもの（ビルド専用スクリプト・作業ファイル）
EXCLUDE_NAMES = {"generate_wire_permutations.js"}
EXCLUDE_DIRS = {"__pycache__", "node_modules"}


def main():
    os.makedirs(DIST, exist_ok=True)
    count = 0
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as zf:
        for pack in PACKS:
            base = os.path.join(ROOT, pack)
            for dirpath, dirnames, filenames in os.walk(base):
                dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
                for name in filenames:
                    if name in EXCLUDE_NAMES:
                        continue
                    full = os.path.join(dirpath, name)
                    arc = os.path.join(pack, os.path.relpath(full, base))
                    zf.write(full, arc.replace("\\", "/"))
                    count += 1
    print("built %s (%d files, %.1f KB)" % (OUT, count, os.path.getsize(OUT) / 1024))


if __name__ == "__main__":
    main()
