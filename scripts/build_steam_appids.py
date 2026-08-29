"""從現有 Steam Meta 產生價格同步用的 App ID 清單。"""

from __future__ import annotations

import argparse
import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path


def _write_json_atomic(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(payload, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary_path, path)
    finally:
        temporary_path.unlink(missing_ok=True)


def build_appids(output_root: str = "outputs", output_file: str = "data/appids.json") -> Path:
    root = Path(output_root).resolve()
    destination = Path(output_file).resolve()
    meta_paths = sorted(root.glob("*/meta.json"))
    seen: set[int] = set()
    skipped = 0

    print(f"[*] 掃描 {len(meta_paths)} 份 Meta：{root}")
    for index, meta_path in enumerate(meta_paths, 1):
        try:
            with meta_path.open("r", encoding="utf-8") as stream:
                meta = json.load(stream)
            value = meta.get("appid") if isinstance(meta, dict) else None
            appid = int(value)
            if appid <= 0 or appid > 100_000_000:
                raise ValueError("App ID 超出範圍")
            seen.add(appid)
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            skipped += 1
        if index % 1000 == 0 or index == len(meta_paths):
            print(f"[{index}/{len(meta_paths)}] 已整理 {len(seen)} 個 App ID")

    if not seen:
        raise RuntimeError("沒有找到可用的 Steam App ID，拒絕覆寫清單")

    payload = {
        "version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "appids": sorted(seen),
    }
    _write_json_atomic(destination, payload)
    print(f"[+] App ID 清單：{destination}")
    print(f"[+] 共 {len(seen)} 個；跳過 {skipped} 份無效 Meta")
    return destination


def main() -> None:
    parser = argparse.ArgumentParser(description="產生 Steam 價格同步用的 App ID 清單")
    parser.add_argument("--output-root", default="outputs", help="既有 Meta 所在資料夾")
    parser.add_argument("--output", default="data/appids.json", help="App ID 清單輸出路徑")
    args = parser.parse_args()
    build_appids(args.output_root, args.output)


if __name__ == "__main__":
    main()
