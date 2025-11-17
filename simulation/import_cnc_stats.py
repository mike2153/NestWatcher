"""
Import CNC telemetry stats from cnc_data*.json (and CSV) into Postgres.

Behavior
- Watches a folder (or processes a single file) for telemetry exports:
  files matching cnc_data*.json (date-stamped). CSV is also supported.
- Parses JSON (object, array, NDJSON lines, or container objects under
  common keys like data/items/rows/records/telemetry/payloads).
- Maps fields to the public.cncstats table and upserts on key
  (same mapping as the Electron app's test-data path).
- After commit, verifies inserted keys exist in DB; deletes the file
  only when verification succeeds (unless --no-delete is set).

Usage
- Edit HARD_CODED_DIR below or run:
    python simulation/import_cnc_stats.py --dir "C:\\path\\to\\folder"
  First pass behavior: process only the newest file unless you pass --all.
  Single file:
    python simulation/import_cnc_stats.py --file "C:\\path\\to\\cnc_data_20250908_141408.json"
- Keep running (default) or process once and exit with --once.
- Polling interval can be set via --interval (seconds).

Notes
- DB connection is read from repo-root settings.json (same as the app).
- Columns: key, api_ip, currentprogram, mode, status, alarm, emg,
  powerontime, cuttingtime, alarmhistory, vacuumtime, drillheadtime,
  spindletime, conveyortime, greasetime.
"""

from __future__ import annotations

import argparse
import json
import logging
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

import psycopg2


# 1) Set this to your folder containing cnc_data*.json files
HARD_CODED_DIR = r"C:\\Users\\mike2\\Documents\\GitHub\\CNCTestData\\cnc_data"  # <-- update me or pass --dir


# ----- DB config helpers -----

@dataclass
class DbConfig:
    host: str
    port: int
    database: str
    user: str
    password: str


def load_db_settings(repo_root: Path) -> DbConfig:
    cfg_path = repo_root / "settings.json"
    with cfg_path.open("r", encoding="utf-8") as f:
        raw = json.load(f)
    db_raw = raw["db"]
    return DbConfig(
        host=db_raw["host"],
        port=int(db_raw["port"]),
        database=db_raw["database"],
        user=db_raw["user"],
        password=str(db_raw.get("password", "")),
    )


def connect_db(cfg: DbConfig):
    return psycopg2.connect(
        host=cfg.host,
        port=cfg.port,
        dbname=cfg.database,
        user=cfg.user,
        password=cfg.password,
    )


# ----- File parsing utilities -----

def infer_timestamp_from_file_name(file_name: str) -> Optional[str]:
    """Infer timestamp in format YYYY.MM.DD HH:MM:SS from names like 2024-09-10_12-34-56.*"""
    import re

    m = re.search(r"(\d{4})[._-]?(\d{2})[._-]?(\d{2})[T_\- ]?(\d{2})[._-]?(\d{2})[._-]?(\d{2})", file_name)
    if not m:
        return None
    return f"{m.group(1)}.{m.group(2)}.{m.group(3)} {m.group(4)}:{m.group(5)}:{m.group(6)}"


def split_csv_line(line: str) -> List[str]:
    out: List[str] = []
    current = ""
    in_quotes = False
    i = 0
    while i < len(line):
        ch = line[i]
        if ch == '"':
            if in_quotes and i + 1 < len(line) and line[i + 1] == '"':
                current += '"'
                i += 1
            else:
                in_quotes = not in_quotes
        elif (ch == ',' or ch == ';') and not in_quotes:
            out.append(current)
            current = ""
        else:
            current += ch
        i += 1
    out.append(current)
    return [c.strip() for c in out]


def strip_csv_cell(value: Optional[str]) -> str:
    if not isinstance(value, str):
        return ""
    return value.strip().strip('"')


def parse_csv_content(text: str) -> List[List[str]]:
    lines = [ln.rstrip() for ln in text.splitlines() if ln.strip()]
    return [split_csv_line(ln) for ln in lines]


def normalize_header_name(name: str, index: int, seen: Dict[str, int]) -> str:
    import re

    base = strip_csv_cell(name).lower()
    base = re.sub(r"[^a-z0-9]+", "_", base).strip("_")
    if not base:
        base = f"column_{index + 1}"
    count = seen.get(base, 0) + 1
    seen[base] = count
    return f"{base}_{count}" if count > 1 else base


def parse_cnc_csv_records(csv_file: Path) -> List[Dict[str, Any]]:
    raw = csv_file.read_text(encoding="utf-8", errors="ignore")
    rows = parse_csv_content(raw)
    if len(rows) <= 1:
        return []
    headers = rows[0]
    seen: Dict[str, int] = {}
    keys = [normalize_header_name(h, idx, seen) for idx, h in enumerate(headers)]
    out: List[Dict[str, Any]] = []
    for r in rows[1:]:
        rec: Dict[str, Any] = {}
        has_val = False
        for i, key in enumerate(keys):
            val = strip_csv_cell(r[i] if i < len(r) else "")
            if val:
                rec[key] = val
                has_val = True
        if has_val:
            out.append(rec)
    return out


def read_json_payloads(file_path: Path) -> List[Dict[str, Any]]:
    """Parse JSON or NDJSON file into a list of dict payloads.

    Accepts:
    - Single object → [obj]
    - Array of objects → [obj, ...]
    - Object with array under common keys (data/items/rows/records/telemetry/payloads) → that array
    - NDJSON lines → one object per line
    """
    text = file_path.read_text(encoding="utf-8", errors="ignore").lstrip("\ufeff").strip()
    if not text:
        return []
    # Try standard JSON (object or array)
    try:
        parsed = json.loads(text)
        if isinstance(parsed, list):
            return [p for p in parsed if isinstance(p, dict)]
        if isinstance(parsed, dict):
            for key in ("data", "items", "rows", "records", "telemetry", "payloads"):
                val = parsed.get(key)
                if isinstance(val, list):
                    return [p for p in val if isinstance(p, dict)]
            return [parsed]
    except Exception:
        pass
    # Try NDJSON (one JSON per line)
    out_list: List[Dict[str, Any]] = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
            if isinstance(obj, dict):
                out_list.append(obj)
        except Exception:
            continue
    return out_list


# ----- Mapping logic to public.cncstats (mirrors app test-data path) -----

def _to_record(value: Any) -> Optional[Dict[str, Any]]:
    return value if isinstance(value, dict) else None


def _pick_ci(source: Optional[Dict[str, Any]], candidates: List[str]) -> Any:
    if not source:
        return None
    lower_map = {k.lower(): v for k, v in source.items()}
    for cand in candidates:
        v = lower_map.get(cand.lower())
        if v is not None:
            return v
    return None


def _to_str_or_null(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, str):
        s = value.strip()
        return s if s else None
    if isinstance(value, (int, float)):
        try:
            if not (float("-inf") < float(value) < float("inf")):
                return None
        except Exception:
            return None
        return str(value)
    if isinstance(value, bool):
        return "true" if value else "false"
    try:
        return json.dumps(value)
    except Exception:
        return str(value)


def _pick_string(sources: List[Optional[Dict[str, Any]]], candidates: List[str]) -> Optional[str]:
    for src in sources:
        v = _pick_ci(src, candidates)
        s = _to_str_or_null(v)
        if s is not None:
            return s
    return None


def _sanitize(value: Optional[str], limit: int) -> Optional[str]:
    if value is None:
        return None
    s = value.strip()
    if not s:
        return None
    return s if len(s) <= limit else s[:limit]


def build_upsert_from_payload(entry: Any, file_name_for_timestamp: Optional[str]) -> Optional[Dict[str, Optional[str]]]:
    rec = _to_record(entry)
    if rec is None:
        return None

    machine_status = _to_record(_pick_ci(rec, ["MachineStatus", "machineStatus", "machine_status"]))
    timers = _to_record(_pick_ci(rec, ["Timers", "timers", "timer"]))

    # Prefer timestamp from record, else infer from file name, else current time
    timestamp_value = _pick_string([rec], ["timestamp", "time", "ts", "key"]) or (
        infer_timestamp_from_file_name(file_name_for_timestamp or "") if file_name_for_timestamp else None
    )
    if not timestamp_value:
        timestamp_value = datetime.now().strftime("%Y.%m.%d %H:%M:%S")

    api_ip = _pick_string([rec, machine_status], ["CNC_IP", "cnc_ip", "api_ip", "ip"])  # optional

    alarm_history_raw = _pick_ci(rec, ["AlarmHistoryDictionary", "alarmHistory", "AlarmHistory"])
    if isinstance(alarm_history_raw, dict) and alarm_history_raw:
        alarm_history = json.dumps(alarm_history_raw)
    else:
        alarm_history = None

    upsert = {
        "key": timestamp_value,
        "api_ip": api_ip,
        "currentprogram": _pick_string([machine_status, rec], ["CurrentProgram", "currentProgram", "Program", "program", "MainProgram"]),
        "mode": _pick_string([machine_status, rec], ["Mode", "mode", "OperatingMode"]),
        "status": _pick_string([machine_status, rec], ["Status", "status", "MachineStatus", "state"]),
        "alarm": _pick_string([machine_status, rec], ["Alarm", "alarm"]),
        "emg": _pick_string([machine_status, rec], ["EMG", "emg", "Emergency", "emergency"]),
        "powerontime": _pick_string([timers, rec], ["PowerOnTime_sec", "powerOnTime", "power_on", "PowerOn", "powerontime"]),
        "cuttingtime": _pick_string([timers, rec], ["CycleCuttingTime_sec", "cycleCuttingTime", "AccumulatedCuttingTime_sec", "cuttingTime", "cut_time"]),
        "alarmhistory": alarm_history,
        "vacuumtime": _pick_string([timers, rec], ["VacTime_sec", "vacTime", "VacuumTime"]),
        "drillheadtime": _pick_string([timers, rec], ["DrillTime_sec", "drillTime", "DrillHeadTime"]),
        "spindletime": _pick_string([timers, rec], ["SpindleTime_sec", "spindleTime"]),
        "conveyortime": _pick_string([timers, rec], ["ConveyorTime_sec", "conveyorTime"]),
        "greasetime": _pick_string([timers, rec], ["GreaseTime_sec", "greaseTime"]),
    }

    # Sanitize to match app constraints (key/api_ip<=100, others<=50)
    upsert["key"] = _sanitize(upsert["key"], 100)
    upsert["api_ip"] = _sanitize(upsert["api_ip"], 100)
    for col in (
        "currentprogram",
        "mode",
        "status",
        "alarm",
        "emg",
        "powerontime",
        "cuttingtime",
        "alarmhistory",
        "vacuumtime",
        "drillheadtime",
        "spindletime",
        "conveyortime",
        "greasetime",
    ):
        upsert[col] = _sanitize(upsert[col], 50)

    if not upsert["key"]:
        return None
    return upsert


def upsert_cncstats(conn, row: Dict[str, Optional[str]]):
    sql = (
        "INSERT INTO public.cncstats("
        " key, api_ip, currentprogram, mode, status, alarm, emg, powerontime, cuttingtime,"
        " alarmhistory, vacuumtime, drillheadtime, spindletime, conveyortime, greasetime)"
        " VALUES (%(key)s, %(api_ip)s, %(currentprogram)s, %(mode)s, %(status)s, %(alarm)s, %(emg)s, %(powerontime)s, %(cuttingtime)s,"
        " %(alarmhistory)s, %(vacuumtime)s, %(drillheadtime)s, %(spindletime)s, %(conveyortime)s, %(greasetime)s)"
        " ON CONFLICT (key) DO UPDATE SET"
        " api_ip = EXCLUDED.api_ip,"
        " currentprogram = EXCLUDED.currentprogram,"
        " mode = EXCLUDED.mode,"
        " status = EXCLUDED.status,"
        " alarm = EXCLUDED.alarm,"
        " emg = EXCLUDED.emg,"
        " powerontime = EXCLUDED.powerontime,"
        " cuttingtime = EXCLUDED.cuttingtime,"
        " alarmhistory = EXCLUDED.alarmhistory,"
        " vacuumtime = EXCLUDED.vacuumtime,"
        " drillheadtime = EXCLUDED.drillheadtime,"
        " spindletime = EXCLUDED.spindletime,"
        " conveyortime = EXCLUDED.conveyortime,"
        " greasetime = EXCLUDED.greasetime"
    )
    with conn.cursor() as cur:
        cur.execute(sql, row)


def find_cnc_jsons(folder: Path) -> List[Path]:
    return sorted([p for p in folder.glob("cnc_data*.json") if p.is_file()], key=lambda p: p.stat().st_mtime)


def find_cnc_csvs(folder: Path) -> List[Path]:
    return sorted([p for p in folder.glob("cnc_data*.csv") if p.is_file()], key=lambda p: p.stat().st_mtime)


def _is_file_stable(path: Path, attempts: int = 4, delay_s: float = 0.25) -> bool:
    try:
        last = path.stat().st_size
    except FileNotFoundError:
        return False
    for _ in range(max(1, attempts)):
        time.sleep(max(0.01, delay_s))
        try:
            now = path.stat().st_size
        except FileNotFoundError:
            return False
        if now == last:
            return True
        last = now
    return False


def _process_one_file(conn, path: Path):
    logger = logging.getLogger("import_cnc_stats")
    batch = 0
    keys_successful: List[str] = []
    if path.suffix.lower() == ".json":
        records = read_json_payloads(path)
        if not records:
            logger.warning("No JSON objects in %s; skipping", path.name)
            return 0, []
        logger.info("Parsed %d JSON object(s) from %s", len(records), path.name)
        for rec in records:
            upsert = build_upsert_from_payload(rec, path.name)
            if not upsert:
                continue
            key = upsert.get("key")
            try:
                logger.info("Upserting key=%s from %s", key, path.name)
                upsert_cncstats(conn, upsert)
                batch += 1
                if key:
                    keys_successful.append(key)
            except Exception as e:
                logger.error("Upsert failed for key=%s file=%s: %s", key, path.name, e)
    elif path.suffix.lower() == ".csv":
        records = parse_cnc_csv_records(path)
        if not records:
            logger.warning("No data rows in %s; skipping", path.name)
            return 0, []
        logger.info("Parsed %d CSV row(s) from %s", len(records), path.name)
        for rec in records:
            upsert = build_upsert_from_payload(rec, path.name)
            if not upsert:
                continue
            key = upsert.get("key")
            try:
                logger.info("Upserting key=%s from %s", key, path.name)
                upsert_cncstats(conn, upsert)
                batch += 1
                if key:
                    keys_successful.append(key)
            except Exception as e:
                logger.error("Upsert failed for key=%s file=%s: %s", key, path.name, e)
    else:
        logger.warning("Unsupported file type: %s; skipping", path.name)
        return 0, []
    return batch, keys_successful


def _verify_keys(conn, keys: List[str]) -> List[str]:
    """Return the list of keys that are present in DB."""
    if not keys:
        return []
    unique = list({k for k in keys if k})
    with conn.cursor() as cur:
        cur.execute("SELECT key FROM public.cncstats WHERE key = ANY(%s)", (unique,))
        rows = cur.fetchall() or []
    found = [r[0] for r in rows if r and r[0] is not None]
    return found


def main():
    # Configure logging
    logging.basicConfig(level=logging.INFO, format='[%(asctime)s] %(levelname)s %(message)s', datefmt='%H:%M:%S')
    logger = logging.getLogger("import_cnc_stats")

    parser = argparse.ArgumentParser(description="Import CNC telemetry from cnc_data*.json (or .csv) into public.cncstats")
    parser.add_argument("--dir", help="Folder containing cnc_data*.json (or .csv)")
    parser.add_argument("--file", help="Import a single file (json/csv)")
    parser.add_argument("--all", action="store_true", help="Import all matching files on first pass (default: newest only)")
    parser.add_argument("--once", action="store_true", help="Process available files then exit")
    parser.add_argument("--interval", type=float, default=1.0, help="Polling interval in seconds for --dir mode (default: 1.0)")
    parser.add_argument("--no-delete", action="store_true", help="Do not delete files after successful import")
    args = parser.parse_args()

    # Load DB settings from repo root settings.json
    repo_root = Path(__file__).resolve().parents[1]
    db_cfg = load_db_settings(repo_root)

    if args.file:
        file_path = Path(args.file)
        if not file_path.exists() or not file_path.is_file():
            raise SystemExit(f"File not found: {file_path}")
        with connect_db(db_cfg) as conn:
            if not _is_file_stable(file_path):
                logger.info("Waiting for file to stabilize: %s", file_path.name)
            batch, keys = _process_one_file(conn, file_path)
            conn.commit()
            found = _verify_keys(conn, keys)
            ok = len(found) == len(keys)
            logger.info("Imported %d row(s) from %s; verified %d/%d keys", batch, file_path.name, len(found), len(keys))
            if ok and batch > 0 and not args.no_delete:
                try:
                    file_path.unlink()
                    logger.info("Deleted %s", file_path.name)
                except Exception as e:
                    logger.warning("Failed to delete %s: %s", file_path.name, e)
            elif not ok:
                missing = [k for k in keys if k not in set(found)]
                logger.warning("Verification failed for %s; missing keys: %s", file_path.name, ", ".join(missing) if missing else "<none>")
        return

    target_dir = Path(args.dir) if args.dir else Path(HARD_CODED_DIR)
    if not target_dir.exists() or not target_dir.is_dir():
        raise SystemExit(f"Target directory not found: {target_dir}")

    logger.info("Watching for cnc_data*.json/.csv in: %s", target_dir)

    try:
        with connect_db(db_cfg) as conn:
            first_pass = True
            while True:
                # Collect candidates (JSON first, then CSV), oldest→newest
                json_files = find_cnc_jsons(target_dir)
                csv_files = find_cnc_csvs(target_dir)
                candidates: List[Path] = []
                if json_files:
                    candidates.extend(json_files)
                if csv_files:
                    candidates.extend(csv_files)

                if not candidates:
                    if args.once:
                        logger.info("No files to process; exiting (--once)")
                        return
                    time.sleep(max(0.1, args.interval))
                    first_pass = False
                    continue

                if first_pass and not args.all and len(candidates) > 1:
                    # Only process newest on first pass when --all is not set
                    candidates = [candidates[-1]]

                processed_any = False
                for path in candidates:
                    if not _is_file_stable(path):
                        # Skip this cycle; it may still be written
                        continue
                    batch, keys = _process_one_file(conn, path)
                    conn.commit()
                    found = _verify_keys(conn, keys)
                    ok = len(found) == len(keys)
                    if ok and batch > 0:
                        processed_any = True
                        logger.info("Imported %d row(s) from %s; verified %d/%d keys", batch, path.name, len(found), len(keys))
                        if not args.no_delete:
                            try:
                                path.unlink()
                                logger.info("Deleted %s", path.name)
                            except Exception as e:
                                logger.warning("Failed to delete %s: %s", path.name, e)
                    else:
                        if batch == 0:
                            logger.info("No rows imported from %s; leaving file in place", path.name)
                        else:
                            missing = [k for k in keys if k not in set(found)]
                            logger.warning("Verification failed for %s; missing keys: %s", path.name, ", ".join(missing) if missing else "<none>")

                first_pass = False
                if args.once:
                    return
                if not processed_any:
                    time.sleep(max(0.1, args.interval))
    except KeyboardInterrupt:
        logger.info("Stopped by user")


if __name__ == "__main__":
    main()

