#!/usr/bin/env python3
"""Replace the Capacitor web assets in a base APK with the current ui/ build."""
import argparse
import os
import sys
import zipfile


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", required=True)
    parser.add_argument("--ui", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    base = os.path.abspath(args.base)
    ui = os.path.abspath(args.ui)
    out = os.path.abspath(args.out)

    if not os.path.isfile(base):
        raise SystemExit("Base APK not found: " + base)
    if not os.path.isdir(ui):
        raise SystemExit("UI directory not found: " + ui)

    files = []
    for root, _, names in os.walk(ui):
        for name in names:
            full = os.path.join(root, name)
            rel = os.path.relpath(full, ui).replace("\\", "/")
            files.append((rel, full))
    files.sort()

    with zipfile.ZipFile(base, "r") as src, zipfile.ZipFile(out, "w") as dst:
        for info in src.infolist():
            name = info.filename
            upper = name.upper()
            if name.startswith("assets/public/"):
                continue
            if upper.startswith("META-INF/") and upper.endswith((".RSA", ".DSA", ".EC", ".SF")):
                continue
            if upper == "META-INF/MANIFEST.MF":
                continue
            dst.writestr(info, src.read(name))

        for rel, full in files:
            arcname = "assets/public/" + rel
            info = zipfile.ZipInfo(arcname)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            with open(full, "rb") as handle:
                dst.writestr(info, handle.read())

    print("Packed", len(files), "web assets into", out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
