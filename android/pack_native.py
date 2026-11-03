#!/usr/bin/env python3
import argparse
import os
import zipfile


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", required=True)
    parser.add_argument("--ui", required=True)
    parser.add_argument("--dex", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    with zipfile.ZipFile(args.base, "r") as base, zipfile.ZipFile(args.out, "w") as out:
        for info in base.infolist():
            name = info.filename
            if name.upper() == "META-INF/MANIFEST.MF" or name.upper().endswith((".SF", ".RSA", ".DSA", ".EC")):
                continue
            out.writestr(info, base.read(name))

        dex_info = zipfile.ZipInfo("classes.dex")
        dex_info.compress_type = zipfile.ZIP_DEFLATED
        with open(args.dex, "rb") as handle:
            out.writestr(dex_info, handle.read())

        for root, _, names in os.walk(args.ui):
            for name in sorted(names):
                full = os.path.join(root, name)
                rel = os.path.relpath(full, args.ui).replace("\\", "/")
                info = zipfile.ZipInfo("assets/public/" + rel)
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o644 << 16
                with open(full, "rb") as handle:
                    out.writestr(info, handle.read())

    print("Packed native APK:", args.out)


if __name__ == "__main__":
    main()
