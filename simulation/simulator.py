from __future__ import annotations

import argparse
import csv
import json
import os
import random
import shutil
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Optional, Tuple

# Support either psycopg2 (v2) or psycopg (v3)
try:  
    import psycopg2 as _psycopg
except Exception:
    try:
        import psycopg as _psycopg  # type: ignore
    except Exception as e:
        raise SystemExit(
            "Missing database driver. Install one of:\n"
            "  pip install psycopg2-binary\n"
            "  pip install \"psycopg[binary]\""
        ) from e


@dataclass
class DbConfig:
    host: str
    port: int
    database: str
    user: str
    password: str


@dataclass
class Settings:
    processed_jobs_root: str
    auto_pac_csv_dir: str


@dataclass
class Machine:
    machine_id: int
    name: str
    ap_jobfolder: str
    nestpick_folder: str
    nestpick_enabled: bool


@dataclass
class Job:
    key: str
    folder: Optional[str]
    ncfile: Optional[str]


def split_csv_line(line: str) -> list[str]:
    out: list[str] = []
    current = ''
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
            current = ''
        else:
            current += ch
        i += 1
    out.append(current)
    return [c.strip() for c in out]


def parse_csv_content(text: str) -> list[list[str]]:
    lines = [ln.rstrip() for ln in text.splitlines() if ln.strip()]
    return [split_csv_line(ln) for ln in lines]


def count_parts_from_pts(source_root: Path, base_stem: str) -> Optional[int]:
    pts = find_file_by_name(source_root, f"{base_stem}.pts")
    if not pts:
        return None
    try:
        text = pts.read_text(encoding='utf-8', errors='ignore')
    except Exception:
        return None
    rows = parse_csv_content(text)
    if not rows:
        return None
    # Heuristic: if first row has alphabetic header, skip it
    start = 1 if any(any(ch.isalpha() for ch in cell) for cell in rows[0]) else 0
    count = sum(1 for r in rows[start:] if any(cell.strip() for cell in r))
    return count or None


def count_parts_from_lpt(source_root: Path, base_stem: str) -> Optional[int]:
    lpt = find_file_by_name(source_root, f"{base_stem}.lpt")
    if not lpt:
        return None
    try:
        text = lpt.read_text(encoding='utf-8', errors='ignore')
    except Exception:
        return None
    rows = parse_csv_content(text)
    if not rows:
        return None
    # Heuristic: count rows that look like data (3+ columns or first col numeric-like)
    start = 1 if any(any(ch.isalpha() for ch in cell) for cell in rows[0]) else 0
    data_rows = [r for r in rows[start:] if len(r) >= 1 and any(tok for tok in r)]
    return (len(data_rows) or None)


def synthesize_parts_rows(source_root: Path, base_stem: str) -> list[list[str]]:
    count = (
        count_parts_from_pts(source_root, base_stem)
        or count_parts_from_lpt(source_root, base_stem)
        or 1
    )
    rows: list[list[str]] = []
    for i in range(count):
        rows.append([
            "0",            # X-pos
            "0",            # Y-pos
            "",             # reserve
            f"{base_stem}-{i+1}",  # ElementID
            "0",            # LengthX
            "0",            # LengthY
            "0",            # Thickness
            "",             # Destination (filled by watcher)
            "",             # SourceMachine (filled by watcher)
            "",             # Type
            "",             # Additional
            "",             # Category
            "",             # PalletName
            "0",            # X-posTarget
            "0",            # YposTarget
            "0",            # RposTarget
        ])
    return rows


def wait_for_file(path: Path, timeout_s: int = 60) -> bool:
    end = time.time() + timeout_s
    while time.time() < end:
        if path.exists():
            # basic stability check
            size1 = path.stat().st_size
            time.sleep(0.2)
            size2 = path.stat().st_size
            if size1 == size2:
                return True
        time.sleep(0.3)
    return False


def try_extract_pallet_then_clear(nestpick_root: Path) -> Optional[str]:
    nestpick_csv = nestpick_root / "Nestpick.csv"
    if not wait_for_file(nestpick_csv, timeout_s=60):
        return None
    try:
        text = nestpick_csv.read_text(encoding='utf-8', errors='ignore')
        rows = parse_csv_content(text)
        if not rows:
            return None
        header = rows[0]
        is_header = any(any(ch.isalpha() for ch in cell) for cell in header)
        pallet_idx = -1
        data_start = 0
        if is_header:
            data_start = 1
            for idx, cell in enumerate(header):
                if cell.strip().lower() == 'palletname':
                    pallet_idx = idx
                    break
        # pick first non-empty pallet value
        pallet_val: Optional[str] = None
        for r in rows[data_start:]:
            if pallet_idx >= 0 and pallet_idx < len(r):
                val = r[pallet_idx].strip().strip('"')
                if val:
                    pallet_val = val
                    break
        return pallet_val
    finally:
        try:
            nestpick_csv.unlink()
            print(f"[nestpick] Cleared {nestpick_csv}")
        except Exception:
            pass


def write_unstack_unified(nestpick_root: Path, base: str, pallet: str, dry_run=False) -> Path:
    out_path = nestpick_root / "Report_FullNestpickUnstack.csv"
    data = f"{base},{pallet}"
    if dry_run:
        print(f"[unstack] Would write {out_path}\n{data}")
        return out_path
    atomic_write(out_path, data)
    print(f"[unstack] Wrote {out_path}")
    return out_path


def load_settings(repo_root: Path) -> Tuple[DbConfig, Settings]:
    cfg_path = repo_root / "settings.json"
    with cfg_path.open("r", encoding="utf-8") as f:
        raw = json.load(f)
    db_raw = raw["db"]
    db = DbConfig(
        host=db_raw["host"],
        port=int(db_raw["port"]),
        database=db_raw["database"],
        user=db_raw["user"],
        password=str(db_raw.get("password", "")),
    )
    s_raw = raw["paths"]
    s = Settings(
        processed_jobs_root=s_raw.get("processedJobsRoot", ""),
        auto_pac_csv_dir=s_raw.get("autoPacCsvDir", ""),
    )
    return db, s


def connect_db(cfg: DbConfig):
    return _psycopg.connect(
        host=cfg.host,
        port=cfg.port,
        dbname=cfg.database,
        user=cfg.user,
        password=cfg.password,
    )


def list_machines(conn) -> list[Machine]:
    with conn.cursor() as cur:
        cur.execute(
            """
            select machine_id, coalesce(name, ''), ap_jobfolder, nestpick_folder, nestpick_enabled
            from machines
            order by machine_id asc
            """
        )
        rows = cur.fetchall() or []
        out: list[Machine] = []
        for row in rows:
            out.append(
                Machine(
                    machine_id=int(row[0]),
                    name=row[1] or f"Machine {row[0]}",
                    ap_jobfolder=row[2],
                    nestpick_folder=row[3],
                    nestpick_enabled=bool(row[4]),
                )
            )
        return out


def get_machine(conn, selector: str) -> Machine:
    with conn.cursor() as cur:
        if selector.isdigit():
            cur.execute(
                """
                select machine_id, coalesce(name, ''), ap_jobfolder, nestpick_folder, nestpick_enabled
                from machines
                where machine_id = %s
                limit 1
                """,
                (int(selector),),
            )
        else:
            cur.execute(
                """
                select machine_id, coalesce(name, ''), ap_jobfolder, nestpick_folder, nestpick_enabled
                from machines
                where lower(name) = lower(%s)
                order by machine_id asc
                limit 1
                """,
                (selector,),
            )
        row = cur.fetchone()
        if not row:
            raise RuntimeError(f"Machine not found for selector: {selector}")
        return Machine(
            machine_id=int(row[0]),
            name=row[1] or f"Machine {row[0]}",
            ap_jobfolder=row[2],
            nestpick_folder=row[3],
            nestpick_enabled=bool(row[4]),
        )


def choose_machine_interactive(conn) -> Machine:
    machines = list_machines(conn)
    if not machines:
        raise RuntimeError("No machines configured in DB")
    print("Select a machine to simulate:")
    for m in machines:
        print(f"  - {m.machine_id}: {m.name}")
    while True:
        raw = input("Enter machine name or id: ").strip()
        if not raw:
            # default to first
            return machines[0]
        # try id1
        if raw.isdigit():
            for m in machines:
                if m.machine_id == int(raw):
                    return m
        # try name (case-insensitive exact)
        for m in machines:
            if m.name.lower() == raw.lower():
                return m
        print("Not found. Please enter a valid machine name or id.")


def pick_random_job(conn) -> Job:
    with conn.cursor() as cur:
        # Prefer jobs that have an ncfile set; watchers can handle PENDING → LOAD_FINISH directly
        cur.execute(
            """
            select key, folder, ncfile
            from jobs
            where coalesce(ncfile,'') <> ''
            order by random()
            limit 1
            """
        )
        row = cur.fetchone()
        if not row:
            raise RuntimeError("No jobs available (ncfile missing)")
        return Job(key=row[0], folder=row[1], ncfile=row[2])


def derive_job_leaf(folder: Optional[str], ncfile: Optional[str], key: str) -> str:
    if folder:
        parts = [p for p in Path(folder).parts if p not in ("/", "\\") and p]
        if parts:
            return parts[-1]
    if ncfile:
        return str(Path(ncfile).stem)
    return str(Path(key).stem)


def find_file_by_name(root: Path, target_name: str) -> Optional[Path]:
    target_lower = target_name.lower()
    for base, _dirs, files in os.walk(root):
        for name in files:
            if name.lower() == target_lower:
                return Path(base) / name
    return None


def pick_random_fs_job(processed_root: Path) -> Optional[Job]:
    """Scan the processed_root for any .nc file and construct a Job for it.

    Returns a Job whose folder is relative to processed_root (if applicable)
    and whose ncfile is the discovered filename.
    """
    nc_files: list[Path] = []
    for base, _dirs, files in os.walk(processed_root):
        for name in files:
            if name.lower().endswith(".nc"):
                nc_files.append(Path(base) / name)
    if not nc_files:
        return None
    choice = random.choice(nc_files)
    try:
        rel = choice.relative_to(processed_root)
        folder = str(rel.parent) if str(rel.parent) != "." else ""
    except Exception:
        folder = str(choice.parent)
    key = f"FS/{folder}/{choice.name}" if folder else f"FS/{choice.name}"
    return Job(key=key, folder=folder, ncfile=choice.name)


def find_source_root(processed_root: Path, job: Job) -> Path:
    # Follow the spirit of worklist.ts: if job.folder is absolute and exists → use it;
    # if it is relative and exists under processed_root → use it; otherwise fall back to processed_root.
    if job.folder:
        try:
            p = Path(job.folder)
            if p.is_absolute() and p.exists():
                return p
            candidate = processed_root / job.folder
            if candidate.exists():
                return candidate
        except Exception:
            pass
    return processed_root


def ensure_unique_dir(base_dir: Path) -> Path:
    """Deprecated behavior retained for compatibility.

    The simulator now stages directly into the base directory without adding
    timestamps. This function simply returns the base path unchanged.
    """
    return base_dir


def stage_job(processed_root: Path, job: Job, machine: Machine, dry_run=False) -> Optional[Path]:
    if not machine.ap_jobfolder:
        print("[stage] Machine ap_jobfolder not set; skipping copy")
        return None

    source_root = find_source_root(processed_root, job)
    leaf = derive_job_leaf(job.folder, job.ncfile, job.key)
    dest_base = Path(machine.ap_jobfolder) / leaf
    # No timestamped folders: if the folder exists, reuse it; otherwise create it.
    dest = dest_base

    if dry_run:
        print(f"[stage] Would stage into: {dest}")
        return dest

    dest.mkdir(parents=True, exist_ok=True)

    # Copy the primary NC file and, if present, the exact per-file CSV (<base>.csv)
    if not job.ncfile:
        raise RuntimeError("Job has no ncfile set")
    nc_candidates = [job.ncfile, f"{Path(job.ncfile).stem}.nc"]
    nc_path = None
    for name in nc_candidates:
        nc_path = find_file_by_name(source_root, name)
        if nc_path:
            break
    if not nc_path:
        raise RuntimeError(f"NC file not found under {source_root}: {job.ncfile}")

    shutil.copy2(nc_path, dest / nc_path.name)

    base_stem = Path(job.ncfile).stem
    parts_csv = find_file_by_name(source_root, f"{base_stem}.csv")
    if parts_csv:
        shutil.copy2(parts_csv, dest / parts_csv.name)
    else:
        # Generate a minimal parts CSV compatible with Nestpick expectations
        print(f"[stage] Parts CSV not found for base {base_stem}; generating synthetic parts CSV")
        rows = synthesize_parts_rows(source_root, base_stem)
        header = [
            "X-pos","Y-pos","reserve","ElementID","LengthX","LengthY","Thickness",
            "Destination","SourceMachine","Type","Additional","Category","PalletName",
            "X-posTarget","YposTarget","RposTarget"
        ]
        # Build CSV text (header + synthesized rows)
        lines = [",".join(header)]
        for r in rows:
            lines.append(",".join(r))
        out = "\n".join(lines) + "\n"
        atomic_write(dest / f"{base_stem}.csv", out)

    # Copy associated .lpt/.pts and images (base*.(bmp|jpg|jpeg))
    for ext in (".lpt", ".pts"):
        cand = find_file_by_name(source_root, f"{base_stem}{ext}")
        if cand:
            shutil.copy2(cand, dest / cand.name)

    for base_dir, _dirs, files in os.walk(source_root):
        for name in files:
            name_lower = name.lower()
            if name_lower.endswith((".bmp",".jpg",".jpeg")) and name_lower.startswith(base_stem.lower()):
                src = Path(base_dir) / name
                rel = src.relative_to(source_root)
                (dest / rel.parent).mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dest / rel)

    print(f"[stage] Staged {job.key} → {dest}")
    return dest


def atomic_write(path: Path, data: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = Path(f"{path}.tmp-{int(time.time() * 1000)}")
    with tmp.open("w", encoding="utf-8", newline="\n") as f:
        f.write(data)
        if not data.endswith("\n"):
            f.write("\n")
    os.replace(tmp, path)


def remove_staged_job_files(dest_root: Path, base_stem: str):
    """Remove staged files for a given job base from the destination folder.

    Deletes files matching the job base (e.g., base.*, images starting with base)
    recursively under dest_root. Leaves unrelated files intact. Prunes any empty
    directories created during staging.
    """
    allowed_exts = {".nc", ".csv", ".lpt", ".pts", ".bmp", ".jpg", ".jpeg", ".txt"}
    base_lower = base_stem.lower()
    if not dest_root or not dest_root.exists():
        return
    # Delete matching files
    for path in dest_root.rglob("*"):
        try:
            if path.is_file():
                name = path.name.lower()
                stem, ext = os.path.splitext(name)
                if (name.startswith(base_lower) or stem == base_lower) and ext in allowed_exts:
                    path.unlink(missing_ok=True)
        except Exception:
            pass
    # Prune empty directories bottom-up
    for d in sorted([p for p in dest_root.rglob("*") if p.is_dir()], key=lambda p: len(str(p)), reverse=True):
        try:
            if not any(d.iterdir()):
                d.rmdir()
        except Exception:
            pass


def write_autopac_csv(auto_pac_dir: Path, machine_token: str, kind: str, bases: list[str], dry_run=False) -> Path:
    # kind ∈ {load_finish, label_finish, cnc_finish}
    filename = f"{kind}{machine_token}.csv"
    content_lines = []
    for b in bases:
        content_lines.append(b)
    content_lines.append(machine_token)
    data = "\n".join(content_lines)
    # Ensure CSV rows are comma-separated as Base,Machine
    rows = [f"{b},{machine_token}" for b in bases]
    data = "\n".join(rows)
    out_path = auto_pac_dir / filename
    if dry_run:
        print(f"[autopac] Would write {out_path}\n{data}")
        return out_path
    atomic_write(out_path, data)
    print(f"[autopac] Wrote {out_path}")
    return out_path


def write_unstack_csv(nestpick_root: Path, base: str, pallet_num: int, dry_run=False) -> Path:
    pallet = f"Pallet_A{pallet_num:02d}"
    out_path = nestpick_root / "Report_FullNestpickUnstack.csv"
    data = f"{base},{pallet}"
    if dry_run:
        print(f"[unstack] Would write {out_path}\n{data}")
        return out_path
    atomic_write(out_path, data)
    print(f"[unstack] Wrote {out_path}")
    return out_path


def sleep_random(min_s: int, max_s: int):
    delay = random.uniform(min_s, max_s)
    print(f"[delay] Sleeping {delay:.1f}s")
    time.sleep(delay)


def workflow_once(argv: Optional[list[str]] = None):
    parser = argparse.ArgumentParser(description="Simulate a full job workflow via file watchers")
    parser.add_argument("--machine", help="Machine selector: name token (e.g. WT1) or numeric id. If omitted, prompts interactively.")
    parser.add_argument("--ask-machine", action="store_true", help="Prompt for the machine even if --machine is provided.")
    parser.add_argument("--min-delay", type=int, default=0, help="Minimum seconds between steps within a cycle (default: 0)")
    parser.add_argument("--max-delay", type=int, default=30, help="Maximum seconds between steps within a cycle (default: 30)")
    parser.add_argument("--between-min", type=int, default=3, help="Minimum seconds between cycles (default: 3)")
    parser.add_argument("--between-max", type=int, default=15, help="Maximum seconds between cycles (default: 15)")
    parser.add_argument("--once", action="store_true", help="Run a single simulation cycle and exit")
    parser.add_argument("--no-stage", action="store_true", help="Skip staging step")
    parser.add_argument("--dry-run", action="store_true", help="Print actions without writing files")
    parser.add_argument("--job-source", choices=["db", "fs"], default="fs", help="Where to pick jobs from: filesystem (fs) under processedJobsRoot, or database (db)")
    parser.add_argument("--wait-app", action="store_true", help="Wait for the app to consume each AutoPAC CSV before the next step")
    parser.add_argument("--wait-timeout", type=int, default=90, help="Seconds to wait for app consumption when --wait-app is set (default: 90)")
    args = parser.parse_args(argv)

    repo_root = Path(__file__).resolve().parents[1]
    db_cfg, app_settings = load_settings(repo_root)

    if not app_settings.auto_pac_csv_dir:
        print("autoPacCsvDir is not configured in settings.json", file=sys.stderr)
        sys.exit(1)

    processed_root = Path(app_settings.processed_jobs_root) if app_settings.processed_jobs_root else None
    if not processed_root and not args.no_stage:
        print("processedJobsRoot is not configured in settings.json; cannot stage", file=sys.stderr)
        sys.exit(1)

    with connect_db(db_cfg) as conn:
        if args.ask_machine or not args.machine:
            machine = choose_machine_interactive(conn)
        else:
            machine = get_machine(conn, args.machine)
        print(f"[machine] Using {machine.name} (#{machine.machine_id})")

        if args.job_source == "fs":
            if not processed_root:
                print("processedJobsRoot is required when --job-source fs", file=sys.stderr)
                sys.exit(1)
            job = pick_random_fs_job(processed_root)
            if not job:
                print(f"[warn] No .nc files found under {processed_root}")
                sys.exit(1)
        else:
            job = pick_random_job(conn)
        base = Path(job.ncfile or job.key).stem
        print(f"[job] Selected {job.key} (base '{base}')")

        # Stage
        staged_ok = True
        staged_dest: Optional[Path] = None
        if not args.no_stage:
            try:
                staged_dest = stage_job(processed_root, job, machine, dry_run=args.dry_run)
            except Exception as e:
                staged_ok = False
                print(f"[warn] Staging failed: {e}")
                # Try filesystem fallback to find any NC under processed_root
                if processed_root:
                    fs_job = pick_random_fs_job(processed_root)
                    if fs_job:
                        try:
                            base = Path(fs_job.ncfile or fs_job.key).stem
                            print(f"[job] Fallback to filesystem NC {fs_job.key} (base '{base}')")
                            staged_dest = stage_job(processed_root, fs_job, machine, dry_run=args.dry_run)
                            job = fs_job
                            staged_ok = True
                        except Exception as e2:
                            print(f"[warn] Fallback staging failed: {e2}")
                if not staged_ok:
                    print("[skip] Skipping AutoPAC for this job due to staging failure")
                    # For one-off runs, don't attempt AutoPAC when staging fails
                    return

        # AutoPAC: LOAD_FINISH → LABEL_FINISH → CNC_FINISH
        auto_pac_dir = Path(app_settings.auto_pac_csv_dir)
        machine_token = machine.name if machine.name else str(machine.machine_id)

        def wait_consumed(p: Path, timeout_s: int) -> bool:
            end = time.time() + timeout_s
            while time.time() < end:
                if not p.exists():
                    print(f"[autopac] {p.name} consumed by app")
                    return True
                time.sleep(0.25)
            print(f"[warn] Timeout waiting for app to consume {p.name}")
            return False

        sleep_random(args.min_delay, args.max_delay)
        p = write_autopac_csv(auto_pac_dir, machine_token, "load_finish", [base], dry_run=args.dry_run)
        if args.wait_app and not args.dry_run:
            if not wait_consumed(p, args.wait_timeout):
                print("[skip] Aborting remaining steps due to unconsumed load_finish CSV")
                if staged_dest:
                    print(f"[clean] Removing staged files for base '{base}' from {staged_dest}")
                    remove_staged_job_files(staged_dest, base)
                return

        sleep_random(args.min_delay, args.max_delay)
        p = write_autopac_csv(auto_pac_dir, machine_token, "label_finish", [base], dry_run=args.dry_run)
        if args.wait_app and not args.dry_run:
            if not wait_consumed(p, args.wait_timeout):
                print("[skip] Aborting remaining steps due to unconsumed label_finish CSV")
                if staged_dest:
                    print(f"[clean] Removing staged files for base '{base}' from {staged_dest}")
                    remove_staged_job_files(staged_dest, base)
                return

        sleep_random(args.min_delay, args.max_delay)
        p = write_autopac_csv(auto_pac_dir, machine_token, "cnc_finish", [base], dry_run=args.dry_run)
        if args.wait_app and not args.dry_run:
            if not wait_consumed(p, args.wait_timeout):
                print("[skip] CNC finish not consumed; skipping Nestpick")
                if staged_dest:
                    print(f"[clean] Removing staged files for base '{base}' from {staged_dest}")
                    remove_staged_job_files(staged_dest, base)
                return

        # After CNC_FINISH, the app should forward parts CSV to Nestpick (Nestpick.csv).
        # Before writing Unstack, try to read PalletName from Nestpick.csv then delete it.
        if machine.nestpick_enabled and machine.nestpick_folder:
            sleep_random(args.min_delay, args.max_delay)
            pallet = try_extract_pallet_then_clear(Path(machine.nestpick_folder)) or f"Pallet_A{random.randint(0,20):02d}"
            # Write Unstack report using pallet value
            write_unstack_unified(Path(machine.nestpick_folder), base, pallet, dry_run=args.dry_run)
        else:
            print("[nestpick] Machine not configured for Nestpick; skipping unstack")

        print("[done] Simulation complete")


def workflow_loop(argv: Optional[list[str]] = None):
    parser = argparse.ArgumentParser(description="Simulate a full job workflow via file watchers (repeat)")
    parser.add_argument("--machine", help="Machine selector: name token (e.g. WT1) or numeric id. If omitted, prompts interactively.")
    parser.add_argument("--ask-machine", action="store_true", help="Prompt for the machine even if --machine is provided.")
    parser.add_argument("--min-delay", type=int, default=0, help="Minimum seconds between steps within a cycle (default: 0)")
    parser.add_argument("--max-delay", type=int, default=30, help="Maximum seconds between steps within a cycle (default: 30)")
    parser.add_argument("--between-min", type=int, default=3, help="Minimum seconds between cycles (default: 3)")
    parser.add_argument("--between-max", type=int, default=15, help="Maximum seconds between cycles (default: 15)")
    parser.add_argument("--no-stage", action="store_true", help="Skip staging step")
    parser.add_argument("--dry-run", action="store_true", help="Print actions without writing files")
    parser.add_argument("--job-source", choices=["db", "fs"], default="fs", help="Where to pick jobs from: filesystem (fs) under processedJobsRoot, or database (db)")
    parser.add_argument("--wait-app", action="store_true", help="Wait for the app to consume each AutoPAC CSV before the next step")
    parser.add_argument("--wait-timeout", type=int, default=90, help="Seconds to wait for app consumption when --wait-app is set (default: 90)")
    args = parser.parse_args(argv)

    repo_root = Path(__file__).resolve().parents[1]
    db_cfg, app_settings = load_settings(repo_root)
    if not app_settings.auto_pac_csv_dir:
        print("autoPacCsvDir is not configured in settings.json", file=sys.stderr)
        sys.exit(1)
    processed_root = Path(app_settings.processed_jobs_root) if app_settings.processed_jobs_root else None
    if not processed_root and not args.no_stage:
        print("processedJobsRoot is not configured in settings.json; cannot stage", file=sys.stderr)
        sys.exit(1)

    with connect_db(db_cfg) as conn:
        if args.ask_machine or not args.machine:
            machine = choose_machine_interactive(conn)
        else:
            machine = get_machine(conn, args.machine)
        print(f"[machine] Using {machine.name} (#{machine.machine_id})")

        cycle = 0
        try:
            while True:
                cycle += 1
                print(f"\n=== Simulation cycle {cycle} ===")
                try:
                    if args.job_source == "fs":
                        if not processed_root:
                            print("processedJobsRoot is required when --job-source fs", file=sys.stderr)
                            time.sleep(max(1, args.between_min))
                            continue
                        job = pick_random_fs_job(processed_root)
                        if not job:
                            print(f"[warn] No .nc files found under {processed_root}")
                            time.sleep(max(1, args.between_min))
                            continue
                    else:
                        job = pick_random_job(conn)
                except Exception as e:
                    print(f"[warn] Could not pick a job: {e}")
                    time.sleep(max(1, args.between_min))
                    continue

                base = Path(job.ncfile or job.key).stem
                print(f"[job] Selected {job.key} (base '{base}')")

                # Attempt staging; if it fails, do NOT write AutoPAC CSVs for this job.
                staged_ok = True
                staged_dest: Optional[Path] = None
                if not args.no_stage and processed_root:
                    try:
                        staged_dest = stage_job(processed_root, job, machine, dry_run=args.dry_run)
                    except Exception as e:
                        staged_ok = False
                        print(f"[warn] Staging failed: {e}")
                        print("[info] Will try another job without writing AutoPAC CSVs")

                # If staging failed, try a few different DB jobs before giving up this cycle
                retry_attempts = 5
                while not staged_ok and retry_attempts > 0:
                    retry_attempts -= 1
                    try:
                        job = pick_random_job(conn)
                        base = Path(job.ncfile or job.key).stem
                        print(f"[job] Trying alternate job {job.key} (base '{base}')")
                        staged_dest = stage_job(processed_root, job, machine, dry_run=args.dry_run)
                        staged_ok = True
                        break
                    except Exception as e:
                        print(f"[warn] Alternate staging failed: {e}")

                # Last resort: scan filesystem for any NC to stage
                if not staged_ok and processed_root:
                    fs_job = pick_random_fs_job(processed_root)
                    if fs_job:
                        try:
                            base = Path(fs_job.ncfile or fs_job.key).stem
                            print(f"[job] Fallback to filesystem NC {fs_job.key} (base '{base}')")
                            staged_dest = stage_job(processed_root, fs_job, machine, dry_run=args.dry_run)
                            job = fs_job
                            staged_ok = True
                        except Exception as e:
                            print(f"[warn] Fallback staging failed: {e}")

                if not args.no_stage and not staged_ok:
                    print("[skip] No successfully staged job found; skipping AutoPAC this cycle")
                else:
                    auto_pac_dir = Path(app_settings.auto_pac_csv_dir)
                    machine_token = machine.name if machine.name else str(machine.machine_id)

                    def wait_consumed(p: Path, timeout_s: int) -> bool:
                        end = time.time() + timeout_s
                        while time.time() < end:
                            if not p.exists():
                                print(f"[autopac] {p.name} consumed by app")
                                return True
                            time.sleep(0.25)
                        print(f"[warn] Timeout waiting for app to consume {p.name}")
                        return False

                    sleep_random(args.min_delay, args.max_delay)
                    p = write_autopac_csv(auto_pac_dir, machine_token, "load_finish", [base], dry_run=args.dry_run)
                    if args.wait_app and not args.dry_run and not wait_consumed(p, args.wait_timeout):
                        print("[skip] Skipping remaining steps for this cycle due to unconsumed load_finish CSV")
                        if staged_dest:
                            print(f"[clean] Removing staged files for base '{base}' from {staged_dest}")
                            remove_staged_job_files(staged_dest, base)
                        continue

                    sleep_random(args.min_delay, args.max_delay)
                    p = write_autopac_csv(auto_pac_dir, machine_token, "label_finish", [base], dry_run=args.dry_run)
                    if args.wait_app and not args.dry_run and not wait_consumed(p, args.wait_timeout):
                        print("[skip] Skipping remaining steps for this cycle due to unconsumed label_finish CSV")
                        if staged_dest:
                            print(f"[clean] Removing staged files for base '{base}' from {staged_dest}")
                            remove_staged_job_files(staged_dest, base)
                        continue

                    sleep_random(args.min_delay, args.max_delay)
                    p = write_autopac_csv(auto_pac_dir, machine_token, "cnc_finish", [base], dry_run=args.dry_run)
                    if args.wait_app and not args.dry_run and not wait_consumed(p, args.wait_timeout):
                        print("[skip] CNC finish not consumed; skipping Nestpick for this cycle")
                        if staged_dest:
                            print(f"[clean] Removing staged files for base '{base}' from {staged_dest}")
                            remove_staged_job_files(staged_dest, base)
                        continue

                if machine.nestpick_enabled and machine.nestpick_folder:
                    sleep_random(args.min_delay, args.max_delay)
                    pallet = try_extract_pallet_then_clear(Path(machine.nestpick_folder)) or f"Pallet_A{random.randint(0,20):02d}"
                    write_unstack_unified(Path(machine.nestpick_folder), base, pallet, dry_run=args.dry_run)
                else:
                    print("[nestpick] Machine not configured for Nestpick; skipping unstack")

                print(f"[done] Cycle {cycle} complete")

                if args.between_max > 0:
                    sleep_random(args.between_min, args.between_max)
        except KeyboardInterrupt:
            print("\n[exit] Stopped by user")


# ---------------------------------------------------------------------------
# Grundner stock simulator
# ---------------------------------------------------------------------------


ORDER_CSV = "order_saw.csv"
ERL_FILE = "order_saw.erl"
STOCK_REQUEST = "stock_request.csv"
STOCK_REPLY = "stock.csv"
LOCAL_STOCK = "grun_stock.csv"
PROD_DEL_REQ_B = "get_production.csv"
PROD_DEL_ANS = "productionLIST_del.csv"

# Preferred inventory filenames (virtual Grundner stock). We only update
# stock, stock_available, and reserved_stock in this file; all other columns
# and order are preserved exactly.
INVENTORY_CANDIDATES = [
    "Grundstock.csv",     # preferred per spec
    "Grun_Stock.csv",     # alternative naming
    LOCAL_STOCK,           # legacy default
]

# Track last processed stock_request.csv timestamp to avoid duplicate copies
_last_stock_request_mtime: Optional[float] = None

# Remember mapping of NC file -> material key (from order_saw lines)
_nc_to_material: Dict[str, str] = {}

# Persist NC -> material mapping on disk so multi-line deletes can resolve
# materials even across simulator restarts or different code paths.
NC_MATERIAL_MAP = "nc_material_map.json"


def _normalize_nc_key(name: Optional[str]) -> str:
    if not name:
        return ""
    key = name.strip().lower()
    if not key:
        return ""
    if not key.endswith(".nc"):
        key = f"{key}.nc"
    return key


def _load_nc_map(folder: Path) -> Dict[str, str]:
    try:
        p = folder / NC_MATERIAL_MAP
        if not p.exists():
            return {}
        data = json.loads(p.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return {}
        out: Dict[str, str] = {}
        for k, v in data.items():
            nk = _normalize_nc_key(k)
            if nk:
                out[nk] = str(v or "").strip()
        return out
    except Exception:
        return {}


def _save_nc_map(folder: Path, mapping: Dict[str, str]) -> None:
    try:
        # Shallow sanitize to string->string
        clean = { _normalize_nc_key(k): str(v or "").strip() for k, v in mapping.items() }
        clean = { k: v for k, v in clean.items() if k }
        p = folder / NC_MATERIAL_MAP
        tmp = p.with_suffix(p.suffix + ".tmp")
        tmp.write_text(json.dumps(clean, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(p)
    except Exception:
        pass

def _normalize_header(raw: str) -> str:
    return (raw or "").strip().lower()

# Default header used when creating a new inventory file.
# Matches the provided format including placeholder NA columns.
DEFAULT_INVENTORY_HEADER = [
    "type_data", "customer_id", "NA", "length_mm", "width_mm", "thickness_mm", "NA",
    "stock", "stock_available", "NA", "NA", "NA", "NA", "NA", "NA",
    "reserved_stock", "NA", "NA", "NA",
]

def resolve_inventory_path(folder: Path) -> Path:
    for name in INVENTORY_CANDIDATES:
        p = folder / name
        if p.exists():
            return p
    return folder / INVENTORY_CANDIDATES[0]

def ensure_inventory_file(path: Path) -> None:
    if path.exists():
        return
    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(DEFAULT_INVENTORY_HEADER)

def read_inventory(path: Path) -> tuple[list[str], list[list[str]]]:
    with path.open("r", encoding="utf-8", newline="") as f:
        reader = csv.reader(f)
        try:
            header = next(reader)
        except StopIteration:
            return [], []
        rows = [row for row in reader]
    return header, rows

def write_inventory(path: Path, header: list[str], rows: list[list[str]]) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(header)
        writer.writerows(rows)
    tmp.replace(path)

def _find_column(header: list[str], name: str) -> Optional[int]:
    lname = name.lower()
    for i, col in enumerate(header):
        if _normalize_header(col) == lname:
            return i
    return None


def _coerce_int(value: Optional[str]) -> int:
    if value is None:
        return 0
    s = str(value).strip()
    if not s or s.lower() in {"na", "null"}:
        return 0
    try:
        return int(float(s))
    except Exception:
        return 0


def wait_for_file_ready(path: Path, timeout: float = 5.0, interval: float = 0.1) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with path.open("rb"):
                return True
        except OSError:
            time.sleep(interval)
        except FileNotFoundError:
            return False
    return False


@dataclass
class StockRow:
    type_data: Optional[int] = None
    customer_id: Optional[str] = None
    length_mm: Optional[int] = None
    width_mm: Optional[int] = None
    thickness_mm: Optional[int] = None
    stock: int = 100
    stock_available: int = 100
    reserved_stock: int = 0

    def material_key(self, mode: str) -> str:
        if mode == "customer_id":
            return (self.customer_id or "").strip()
        return str(self.type_data) if self.type_data is not None else ""


CSV_HEADER = [
    "type_data",
    "customer_id",
    "length_mm",
    "width_mm",
    "thickness_mm",
    "stock",
    "stock_available",
    "reserved_stock",
]


def read_local_stock(path: Path) -> Dict[str, StockRow]:
    if not path.exists():
        return {}
    rows: Dict[str, StockRow] = {}
    with path.open("r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        # Normalize header names to lower
        field_map = {k: k for k in reader.fieldnames or []}
        for rec in reader:
            def get_int(name: str) -> Optional[int]:
                v = (rec.get(name) or rec.get(name.lower()) or "").strip()
                if v == "" or v.lower() == "null":
                    return None
                try:
                    return int(float(v))
                except Exception:
                    return None

            def get_str(name: str) -> Optional[str]:
                v = (rec.get(name) or rec.get(name.lower()) or "").strip()
                return v or None

            row = StockRow(
                type_data=get_int("type_data"),
                customer_id=get_str("customer_id"),
                length_mm=get_int("length_mm"),
                width_mm=get_int("width_mm"),
                thickness_mm=get_int("thickness_mm"),
                stock=get_int("stock") or 0,
                stock_available=get_int("stock_available") or 0,
                reserved_stock=get_int("reserved_stock") or 0,
            )
            # Indexing by both keys keeps lookups fast regardless of mode
            if row.type_data is not None:
                rows[f"type_data:{row.type_data}"] = row
            if row.customer_id:
                rows[f"customer_id:{row.customer_id}"] = row
    return rows


def write_local_stock(path: Path, rows: Dict[str, StockRow]) -> None:
    # Deduplicate by material identity: prefer type_data uniqueness, else customer_id
    unique: Dict[str, StockRow] = {}
    for key, row in rows.items():
        # Collapse potential duplicates (same underlying object)
        ident = id(row)
        unique[str(ident)] = row

    # Create deterministic ordering for readability
    ordered = sorted(unique.values(), key=lambda r: (
        r.type_data if r.type_data is not None else 0,
        r.customer_id or ""
    ))

    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_HEADER)
        writer.writeheader()
        for r in ordered:
            writer.writerow({
                "type_data": r.type_data if r.type_data is not None else "",
                "customer_id": r.customer_id or "",
                "length_mm": r.length_mm if r.length_mm is not None else "",
                "width_mm": r.width_mm if r.width_mm is not None else "",
                "thickness_mm": r.thickness_mm if r.thickness_mm is not None else "",
                "stock": r.stock,
                "stock_available": r.stock_available,
                "reserved_stock": r.reserved_stock,
            })
    tmp.replace(path)


def copy_to_stock_reply(folder: Path, inventory_path: Path) -> None:
    dst = folder / STOCK_REPLY
    if not inventory_path.exists():
        # No inventory available; do not create stock.csv.
        return
    if not wait_for_file_ready(inventory_path):
        return
    tmp = dst.with_suffix(dst.suffix + ".tmp")
    tmp.write_bytes(inventory_path.read_bytes())
    tmp.replace(dst)
    time.sleep(2.0)


def parse_order_csv_line(line: str) -> tuple[str, str, int]:
    # Expected format (semicolon separated):
    # <ncname>;<material>;<qty>;...
    parts = [p.strip() for p in line.strip().split(";")] + [""] * 3
    nc = parts[0]
    material = parts[1]
    try:
        qty = int(parts[2] or "1")
    except Exception:
        qty = 1
    return nc, material, max(1, qty)


def handle_order_csv(folder: Path, id_mode: str, inventory_path: Path) -> None:
    order_path = folder / ORDER_CSV
    erl_path = folder / ERL_FILE
    if not order_path.exists():
        return
    try:
        text = order_path.read_text(encoding="utf-8")
    except Exception:
        # Try again next loop if temporarily unreadable
        return

    lines = [ln for ln in text.replace("\r\n", "\n").split("\n") if ln.strip()]
    # Ack by mirroring content into .erl
    tmp = erl_path.with_suffix(erl_path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(erl_path)

    # Load inventory and locate required columns
    ensure_inventory_file(inventory_path)
    header, rows = read_inventory(inventory_path)
    idx_type = _find_column(header, "type_data")
    idx_cust = _find_column(header, "customer_id")
    idx_stock = _find_column(header, "stock")
    idx_avail = _find_column(header, "stock_available")
    idx_resvd = _find_column(header, "reserved_stock")
    if None in (idx_type, idx_cust, idx_stock, idx_avail, idx_resvd):
        return

    # Build lookups for fast search
    by_type: Dict[str, int] = {}
    by_cust: Dict[str, int] = {}
    for i, row in enumerate(rows):
        if idx_type is not None and idx_type < len(row):
            t = (row[idx_type] or "").strip()
            if t:
                by_type[t] = i
        if idx_cust is not None and idx_cust < len(row):
            c = (row[idx_cust] or "").strip()
            if c:
                by_cust[c] = i

    # Apply each order line against existing rows only
    # Also accumulate NC->material mapping for later production delete answers
    updated_map: Dict[str, str] = {}
    for ln in lines:
        _nc, material, qty = parse_order_csv_line(ln)
        # Track mapping for later delete confirmations
        nc_key = _normalize_nc_key(_nc)
        if nc_key:
            mat = (material or "").strip()
            _nc_to_material[nc_key] = mat
            updated_map[nc_key] = mat
        index: Optional[int] = None
        if id_mode == "type_data":
            index = by_type.get(material)
        else:
            index = by_cust.get(material)
        if index is None:
            # Do not create new rows; skip if not found
            continue

        row = rows[index]
        stock_val = _coerce_int(row[idx_stock] if idx_stock < len(row) else None)
        resvd_val = _coerce_int(row[idx_resvd] if idx_resvd < len(row) else None)

        resvd_val = max(0, resvd_val + max(1, int(qty)))
        avail_val = max(0, stock_val - resvd_val)

        row[idx_avail] = str(avail_val)
        row[idx_resvd] = str(resvd_val)

    # Persist inventory only. stock.csv is created only upon stock_request.csv.
    write_inventory(inventory_path, header, rows)

    # Persist mapping to disk for robust multi-line unlock resolution
    if updated_map:
        persisted = _load_nc_map(folder)
        persisted.update(updated_map)
        _save_nc_map(folder, persisted)

    # Optionally relocate the processed CSV to avoid blocking future orders
    try:
        ts = time.strftime("%Y%m%d-%H%M%S")
        processed = folder / f"order_saw.{ts}.processed.csv"
        order_path.replace(processed)
    except Exception:
        # If rename fails, best effort: leave the CSV in place
        pass


def _parse_prod_del_line(line: str) -> Optional[str]:
    parts = [p.strip() for p in line.strip().split(";")]
    if not parts:
        return None
    key = _normalize_nc_key(parts[0] if parts else "")
    return key or None


def handle_production_delete(folder: Path, id_mode: str, inventory_path: Path) -> None:
    def build_nc_material_map() -> Dict[str, str]:
        # Start from persisted map, then overlay in-memory (current session)
        mapping: Dict[str, str] = _load_nc_map(folder)
        mapping.update(_nc_to_material)
        # Include current order if present
        try:
            cur_order = folder / ORDER_CSV
            if cur_order.exists():
                for ln in cur_order.read_text(encoding="utf-8").replace("\r\n", "\n").split("\n"):
                    if not ln.strip():
                        continue
                    nc, material, _ = parse_order_csv_line(ln)
                    key = _normalize_nc_key(nc)
                    if key:
                        mapping[key] = (material or '').strip()
        except Exception:
            pass
        # Also scan processed order files (newest last wins)
        try:
            processed = sorted(folder.glob("order_saw.*.processed.csv"), key=lambda p: p.stat().st_mtime)
            for p in processed:
                try:
                    for ln in p.read_text(encoding="utf-8").replace("\r\n", "\n").split("\n"):
                        if not ln.strip():
                            continue
                        nc, material, _ = parse_order_csv_line(ln)
                        key = _normalize_nc_key(nc)
                        if key:
                            mapping[key] = (material or '').strip()
                except Exception:
                    continue
        except Exception:
            pass
        return mapping

    # Support both legacy and new request filenames
    req = None
    b = folder / PROD_DEL_REQ_B
    if b.exists():
        req = b
    if req is None:
        return
    # Wait up to ~5s for file to become ready; then sleep 2s per spec
    if not wait_for_file_ready(req, timeout=5.0):
        return
    time.sleep(2.0)
    try:
        text = req.read_text(encoding="utf-8")
    except Exception:
        return

    lines = [ln for ln in text.replace("\r\n", "\n").split("\n") if ln.strip()]
    print(f"[grundner-sim] prod-del: request lines={len(lines)}")
    for ln in lines:
        print(f"[grundner-sim] prod-del: line='{ln}'")
    sys.stdout.flush()
    # Build commissioning answer rows 1:1 with request lines
    def derive_row_from_request(req_line: str, id_mode_local: str) -> tuple[str, str, str, int, int, int, int, int]:
        parts = [p.strip() for p in req_line.split(';')]
        job_no = (parts[0] if len(parts) >= 1 else '').strip()
        token = (parts[1] if len(parts) >= 2 else '').strip()
        qty = (parts[2] if len(parts) >= 3 else '1').strip()
        machine = (parts[3] if len(parts) >= 4 else '0').strip()
        rotation = (parts[4] if len(parts) >= 5 else '0').strip()
        source = (parts[5] if len(parts) >= 6 else '0').strip()
        resv = (parts[6] if len(parts) >= 7 else '0').strip()
        # Decide type vs material based on token and id_mode
        # Treat blank or zero-like tokens as empty
        zero_like = {'', '0', '00', '000', '0000'}
        tok_eff = '' if token in zero_like else token
        is_num = tok_eff.isdigit() and int(tok_eff) > 0
        # Initialize both as empty; fill according to id_mode
        type_col = ''
        material_col = ''
        if id_mode_local == "type_data":
            # In type_data mode, only numeric tokens are treated as type_data values
            type_col = tok_eff if is_num else ''
            material_col = '' if is_num else tok_eff
        else:
            # customer_id mode: treat any provided token as material; never infer type from job name
            material_col = tok_eff
        try:
            qty_val = max(1, int(float(qty)))
        except Exception:
            qty_val = 1
        try:
            mach_val = int(float(machine))
        except Exception:
            mach_val = 0
        try:
            rot_val = int(float(rotation))
        except Exception:
            rot_val = 0
        try:
            src_val = int(float(source))
        except Exception:
            src_val = 0
        try:
            res_val = int(float(resv))
        except Exception:
            res_val = 0
        return job_no, type_col, material_col, qty_val, rot_val, mach_val, src_val, res_val

    parsed_entries: list[tuple[str, str, str, int, int, int, int, int]] = []
    resolved_types: list[str] = []
    resolved_materials: list[str] = []
    for ln in lines:
        job_no, type_col, material_col, qty_val, rot_val, mach_val, src_val, res_val = derive_row_from_request(ln, id_mode)
        parsed_entries.append((job_no, type_col, material_col, qty_val, rot_val, mach_val, src_val, res_val))
        resolved_types.append(type_col)
        resolved_materials.append(material_col)

    inventory_dirty = False
    try:
        ensure_inventory_file(inventory_path)
        header, rows = read_inventory(inventory_path)
    except Exception:
        header, rows = [], []

    idx_type = _find_column(header, "type_data")
    idx_cust = _find_column(header, "customer_id")
    idx_stock = _find_column(header, "stock")
    idx_avail = _find_column(header, "stock_available")
    idx_resvd = _find_column(header, "reserved_stock")

    needs_type = id_mode == "type_data"
    needs_cust = id_mode == "customer_id"
    has_columns = (
        header
        and rows
        and idx_stock is not None
        and idx_avail is not None
        and idx_resvd is not None
        and ((needs_type and idx_type is not None) or (needs_cust and idx_cust is not None))
    )

    if has_columns:
        by_type: Dict[str, int] = {}
        by_cust: Dict[str, int] = {}
        for i, row in enumerate(rows):
            if idx_type is not None and idx_type < len(row):
                token = (row[idx_type] or "").strip()
                if token:
                    by_type[token] = i
            if idx_cust is not None and idx_cust < len(row):
                token = (row[idx_cust] or "").strip()
                if token:
                    by_cust[token] = i

        material_map = build_nc_material_map()

        adjusted_count = 0
        for idx, entry in enumerate(parsed_entries):
            job_no, type_col, material_col, qty_val, _rot, _mach, _src, _res = entry
            qty = max(1, int(qty_val))
            nc_key = _normalize_nc_key(job_no)
            inferred = (material_map.get(nc_key) or "").strip()
            if id_mode == "type_data":
                lookup_key = (type_col or "").strip() or inferred
                index = by_type.get(lookup_key)
                if lookup_key:
                    resolved_types[idx] = lookup_key
            else:
                lookup_key = (material_col or "").strip() or inferred
                index = by_cust.get(lookup_key)
                if lookup_key:
                    resolved_materials[idx] = lookup_key
            if index is None or not lookup_key:
                continue

            row = rows[index]
            stock_val = _coerce_int(row[idx_stock] if idx_stock < len(row) else None)
            resvd_val = _coerce_int(row[idx_resvd] if idx_resvd < len(row) else None)
            avail_val = _coerce_int(row[idx_avail] if idx_avail < len(row) else None)
            new_resvd = max(0, resvd_val - qty)
            new_avail = max(0, stock_val - new_resvd)
            if new_resvd != resvd_val or new_avail != avail_val:
                row[idx_resvd] = str(new_resvd)
                row[idx_avail] = str(new_avail)
                inventory_dirty = True
                adjusted_count += 1

        if inventory_dirty:
            write_inventory(inventory_path, header, rows)
            print(f"[grundner-sim] prod-del: adjusted inventory for {adjusted_count} request line(s)")
            sys.stdout.flush()

    out_lines: list[str] = []
    line_no = 1
    for idx, entry in enumerate(parsed_entries):
        job_no, _type_col, _material_col, qty_val, rot_val, mach_val, src_val, res_val = entry
        # Columns (1-based) expected by the app: material must be present in column index 2 (zero-based),
        # so we write material into both positions (type and material) to maximize compatibility.
        mat_token = (resolved_materials[idx] or resolved_types[idx] or "").strip()
        type_field = mat_token
        material_field = mat_token
        out_lines.append(f"{line_no};{job_no};{material_field};{type_field};{qty_val};{rot_val};{mach_val};{src_val};{res_val}")
        line_no = (line_no + 1) if line_no < 255 else 1

    # Write answer via tmp then rename after 3 seconds
    ans = folder / PROD_DEL_ANS
    tmp = ans.with_suffix(ans.suffix + '.tmp')
    out_text = ("\r\n".join(out_lines) + "\r\n") if out_lines else "\r\n"
    print(f"[grundner-sim] prod-del: writing tmp '{tmp.name}' with {len(out_lines)} row(s)")
    for row in out_lines:
        print(f"[grundner-sim] prod-del: >> {row}")
    sys.stdout.flush()
    with tmp.open('w', encoding='utf-8', newline='') as f:
        f.write(out_text)
        try:
            f.flush()
        except Exception:
            pass
    time.sleep(3.0)
    try:
        tmp.replace(ans)
        print(f"[grundner-sim] prod-del: renamed tmp to '{ans.name}'")
    except Exception as e:
        print(f"[grundner-sim] prod-del: rename failed: {e}; attempting direct write")
        ans.write_text(out_text, encoding='utf-8')
    sys.stdout.flush()

    # Optionally, remove or archive the request
    try:
        ts = time.strftime("%Y%m%d-%H%M%S")
        processed = folder / f"productionLIST_del.{ts}.processed.csv"
        req.replace(processed)
    except Exception:
        try:
            req.unlink()
        except Exception:
            pass


def handle_stock_request(folder: Path, inventory_path: Path) -> None:
    global _last_stock_request_mtime
    req = folder / STOCK_REQUEST
    if not req.exists():
        # No request present; reset marker so the next file will be processed.
        _last_stock_request_mtime = None
        return

    try:
        mtime = req.stat().st_mtime
    except Exception:
        # Could not stat the file; retry next loop.
        return

    if _last_stock_request_mtime is not None and mtime == _last_stock_request_mtime:
        # Already processed this exact request file; nothing to do.
        return

    if not wait_for_file_ready(req):
        return

    time.sleep(2.0)

    try:
        copy_to_stock_reply(folder, inventory_path)
    except Exception:
        # Copy failed; do not update marker so we retry next loop.
        return

    try:
        req.unlink()
        # Successfully processed and removed request; clear marker.
        _last_stock_request_mtime = None
    except Exception:
        # Could not delete; remember mtime so we don't duplicate copies until it changes.
        _last_stock_request_mtime = mtime


def grundner_main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="Grundner stock simulator")
    ap.add_argument("--folder", required=True, help="Folder to watch (Grundner folder)")
    ap.add_argument(
        "--id-mode",
        choices=["type_data", "customer_id"],
        default="type_data",
        help="Which column to treat as the material key",
    )
    ap.add_argument(
        "--interval",
        type=float,
        default=0.5,
        help="Polling interval in seconds",
    )
    args = ap.parse_args(argv)

    folder = Path(args.folder)
    if not folder.exists():
        print(f"[grundner-sim] Folder does not exist: {folder}")
        return 2

    id_mode: str = args.id_mode

    # Resolve/initialize inventory
    stock_path = resolve_inventory_path(folder)
    ensure_inventory_file(stock_path)

    print(
        f"[grundner-sim] Watching: {folder}\n"
        f"  - id mode: {id_mode}\n"
        f"  - inventory file: {stock_path}\n"
        f"  - responds to: {ORDER_CSV}, {STOCK_REQUEST}, {PROD_DEL_REQ_B}\n"
    )

    try:
        while True:
            handle_order_csv(folder, id_mode, stock_path)
            handle_stock_request(folder, stock_path)
            handle_production_delete(folder, id_mode, stock_path)
            time.sleep(max(0.05, float(args.interval)))
    except KeyboardInterrupt:
        print("\n[grundner-sim] Stopped")
        return 0


def run_cli(argv: Optional[list[str]] = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    command = None
    if args and args[0] in {"workflow", "grundner"}:
        command = args.pop(0)
    else:
        command = "workflow"
    if command == "grundner":
        return grundner_main(args)
    # Allow explicit "workflow" command or default behavior.
    if "--once" in args:
        return workflow_once(args)
    return workflow_loop(args)


if __name__ == "__main__":
    raise SystemExit(run_cli())
