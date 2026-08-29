"""從 Steam AppDetails API 產生完整、可公開讀取的價格快照。

只有全部批次成功且輸出內容可以重新讀取時，才會以原子方式替換 price.json。
任何網路、HTTP、JSON 或回傳缺漏都會讓程式失敗並保留舊檔案。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests


STEAM_APPDETAILS_URL = "https://store.steampowered.com/api/appdetails/"
DEFAULT_APPIDS_FILE = "data/appids.json"
DEFAULT_OUTPUT_FILE = "data/price.json"
DEFAULT_BATCH_SIZE = 500
DEFAULT_RETRIES = 3
DEFAULT_RETRY_DELAY_SECONDS = 5.0
USER_AGENT = "steam-portal-price-updater/1.0 (+GitHub Actions)"
_PRICE_RE = re.compile(r"\d[\d,.]*")


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _isoformat(value: datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")


def _load_appids(path: Path) -> list[int]:
    with path.open("r", encoding="utf-8") as stream:
        raw = json.load(stream)
    values = raw.get("appids") if isinstance(raw, dict) else raw
    if not isinstance(values, list):
        raise ValueError(f"{path} 必須是 App ID 陣列或包含 appids 陣列的 JSON 物件")

    result: set[int] = set()
    for value in values:
        try:
            appid = int(value)
        except (TypeError, ValueError) as error:
            raise ValueError(f"App ID 無法轉成整數：{value!r}") from error
        if appid <= 0 or appid > 100_000_000:
            raise ValueError(f"App ID 超出範圍：{appid}")
        result.add(appid)
    if not result:
        raise ValueError(f"{path} 沒有可用的 App ID")
    return sorted(result)


def _number_from_text(value: Any) -> float | None:
    match = _PRICE_RE.search(str(value or "").replace(" ", ""))
    if not match:
        return None
    try:
        return float(match.group(0).replace(",", ""))
    except ValueError:
        return None


def _price_value(price: dict[str, Any], cents_key: str, formatted_key: str) -> float | None:
    cents = price.get(cents_key)
    if cents is not None:
        try:
            value = float(cents) / 100
            if value >= 0:
                return value
        except (TypeError, ValueError):
            pass
    return _number_from_text(price.get(formatted_key))


def _unavailable_record(synced_at: int, error: str = "") -> dict[str, Any]:
    record: dict[str, Any] = {
        "status": "unavailable",
        "saleEnd": None,
        "priceCurrent": "",
        "priceOriginal": "",
        "priceValue": None,
        "originalValue": None,
        "discountPercent": 0,
        "syncedAt": synced_at,
    }
    if error:
        record["error"] = error
    return record


def _normalize_entry(entry: Any, synced_at: int) -> dict[str, Any]:
    if not isinstance(entry, dict) or not entry.get("success"):
        return _unavailable_record(synced_at)

    data = entry.get("data")
    if not isinstance(data, dict):
        return _unavailable_record(synced_at, "Steam 回傳資料缺少 data")

    is_free = bool(data.get("is_free"))
    price = data.get("price_overview")
    if is_free:
        return {
            "status": "not_sale",
            "saleEnd": None,
            "priceCurrent": "免費",
            "priceOriginal": "免費",
            "priceValue": 0,
            "originalValue": 0,
            "discountPercent": 0,
            "syncedAt": synced_at,
        }
    if not isinstance(price, dict):
        return _unavailable_record(synced_at)

    current = str(price.get("final_formatted") or "")
    original = str(price.get("initial_formatted") or current)
    current_value = _price_value(price, "final", "final_formatted")
    original_value = _price_value(price, "initial", "initial_formatted")
    discount = max(0, min(100, int(price.get("discount_percent") or 0)))
    expiration = price.get("discount_expiration") if discount > 0 else None
    try:
        sale_end = int(expiration) if expiration else None
    except (TypeError, ValueError):
        sale_end = None

    if not current and current_value is None:
        return _unavailable_record(synced_at)
    if original_value is None:
        original_value = current_value
    return {
        "status": "sale" if discount > 0 else "not_sale",
        "saleEnd": sale_end,
        "priceCurrent": current,
        "priceOriginal": original,
        "priceValue": current_value,
        "originalValue": original_value,
        "discountPercent": discount,
        "syncedAt": synced_at,
    }


def _request_batch(
    session: requests.Session,
    batch: list[int],
    batch_number: int,
    total_batches: int,
    retries: int,
    retry_delay_seconds: float,
) -> dict[str, Any]:
    params = {
        "appids": ",".join(str(appid) for appid in batch),
        "cc": "tw",
        "l": "tchinese",
        "filters": "price_overview",
    }
    last_error: Exception | None = None
    for attempt in range(retries + 1):
        try:
            response = session.get(STEAM_APPDETAILS_URL, params=params, timeout=(15, 90))
            response.raise_for_status()
            parsed = response.json()
            if not isinstance(parsed, dict):
                raise ValueError("Steam 回傳的 JSON 不是物件")
            missing = [str(appid) for appid in batch if str(appid) not in parsed]
            if missing:
                preview = ", ".join(missing[:10])
                suffix = "…" if len(missing) > 10 else ""
                raise ValueError(f"Steam 回傳缺少 {len(missing)} 個 App ID：{preview}{suffix}")
            return parsed
        except (requests.RequestException, ValueError) as error:
            last_error = error
            if attempt >= retries:
                break
            wait_seconds = retry_delay_seconds * (attempt + 1)
            print(
                f"[!] 第 {batch_number}/{total_batches} 批第 {attempt + 1} 次失敗：{error}；"
                f"{wait_seconds:g} 秒後重試",
                flush=True,
            )
            time.sleep(wait_seconds)
    raise RuntimeError(f"第 {batch_number}/{total_batches} 批無法完成：{last_error}") from last_error


def _write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(payload, stream, ensure_ascii=False, separators=(",", ":"))
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        with temporary_path.open("r", encoding="utf-8") as stream:
            check = json.load(stream)
        if not isinstance(check, dict) or not isinstance(check.get("items"), dict):
            raise ValueError("暫存 price.json 驗證失敗")
        os.replace(temporary_path, path)
    finally:
        temporary_path.unlink(missing_ok=True)


def update_prices(
    appids_file: str = DEFAULT_APPIDS_FILE,
    output_file: str = DEFAULT_OUTPUT_FILE,
    batch_size: int = DEFAULT_BATCH_SIZE,
    retries: int = DEFAULT_RETRIES,
    retry_delay_seconds: float = DEFAULT_RETRY_DELAY_SECONDS,
    limit: int | None = None,
) -> Path:
    if batch_size <= 0:
        raise ValueError("batch-size 必須大於 0")
    if retries < 0:
        raise ValueError("retries 不可小於 0")
    if limit is not None and limit <= 0:
        raise ValueError("limit 必須大於 0")
    appids_path = Path(appids_file).resolve()
    output_path = Path(output_file).resolve()
    appids = _load_appids(appids_path)
    if limit is not None:
        appids = appids[:limit]
    batches = [appids[index : index + batch_size] for index in range(0, len(appids), batch_size)]
    synced_at = int(_utc_now().timestamp() * 1000)
    generated_at = _isoformat(_utc_now())
    items: dict[str, dict[str, Any]] = {}

    print(f"[*] 讀取 {len(appids)} 個 App ID，分成 {len(batches)} 批", flush=True)
    session = requests.Session()
    session.headers.update({"Accept": "application/json", "User-Agent": USER_AGENT})
    for index, batch in enumerate(batches, 1):
        response_body = _request_batch(
            session,
            batch,
            index,
            len(batches),
            retries,
            retry_delay_seconds,
        )
        for appid in batch:
            items[str(appid)] = _normalize_entry(response_body[str(appid)], synced_at)
        print(f"[{index}/{len(batches)}] 已同步 {len(items)}/{len(appids)} 個 App ID", flush=True)
        if index < len(batches):
            time.sleep(1)

    payload = {
        "version": 1,
        "generated_at": generated_at,
        "source": "steam_appdetails",
        "item_count": len(items),
        "items": items,
    }
    if len(items) != len(appids):
        raise RuntimeError("同步項目數量不一致，拒絕更新 price.json")
    _write_json_atomic(output_path, payload)
    print(f"[+] 已更新：{output_path}")
    print(f"[+] 快照時間：{generated_at}；共 {len(items)} 筆")
    return output_path


def main() -> int:
    parser = argparse.ArgumentParser(description="從 Steam 產生中央 price.json")
    parser.add_argument("--appids", default=DEFAULT_APPIDS_FILE, help="App ID 清單")
    parser.add_argument("--output", default=DEFAULT_OUTPUT_FILE, help="price.json 輸出路徑")
    parser.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE, help="每次 Steam 請求的 App ID 數量")
    parser.add_argument("--retries", type=int, default=DEFAULT_RETRIES, help="每批失敗後的重試次數")
    parser.add_argument("--retry-delay-seconds", type=float, default=DEFAULT_RETRY_DELAY_SECONDS, help="重試前等待秒數")
    parser.add_argument("--limit", type=int, default=None, help="只同步前 N 個 App ID，供本機試跑")
    args = parser.parse_args()
    try:
        update_prices(args.appids, args.output, args.batch_size, args.retries, args.retry_delay_seconds, args.limit)
    except Exception as error:
        print(f"[ERROR] price.json 保持不變：{error}", flush=True)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
