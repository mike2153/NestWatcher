import argparse
import json
import os
import random
import shutil
import sys
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Optional, Tuple

import psycopg2


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
    return psycopg2.connect(
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
        # try id
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
    if not base_dir.exists():
        return base_dir
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    candidate = base_dir.parent / f"{base_dir.name}_{ts}"
    suffix = 1
    while candidate.exists():
        candidate = base_dir.parent / f"{base_dir.name}_{ts}_{suffix}"
        suffix += 1
    return candidate


def stage_job(processed_root: Path, job: Job, machine: Machine, dry_run=False) -> Optional[Path]:
    if not machine.ap_jobfolder:
        print("[stage] Machine ap_jobfolder not set; skipping copy")
        return None

    source_root = find_source_root(processed_root, job)
    leaf = derive_job_leaf(job.folder, job.ncfile, job.key)
    dest_base = Path(machine.ap_jobfolder) / leaf
    dest = ensure_unique_dir(dest_base)

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


def write_autopac_csv(auto_pac_dir: Path, machine_token: str, kind: str, bases: list[str], dry_run=False) -> Path:
    # kind ∈ {load_finish, label_finish, cnc_finish}
    filename = f"{kind}{machine_token}.csv"
    content_lines = []
    for b in bases:
        content_lines.append(b)
    content_lines.append(machine_token)
    data = "\n".join(content_lines)
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


def main():
    parser = argparse.ArgumentParser(description="Simulate a full job workflow via file watchers")
    parser.add_argument("--machine", help="Machine selector: name token (e.g. WT1) or numeric id. If omitted, prompts interactively.")
    parser.add_argument("--ask-machine", action="store_true", help="Prompt for the machine even if --machine is provided.")
    parser.add_argument("--min-delay", type=int, default=0, help="Minimum seconds between steps within a cycle (default: 0)")
    parser.add_argument("--max-delay", type=int, default=120, help="Maximum seconds between steps within a cycle (default: 120)")
    parser.add_argument("--between-min", type=int, default=3, help="Minimum seconds between cycles (default: 3)")
    parser.add_argument("--between-max", type=int, default=15, help="Maximum seconds between cycles (default: 15)")
    parser.add_argument("--once", action="store_true", help="Run a single simulation cycle and exit")
    parser.add_argument("--no-stage", action="store_true", help="Skip staging step")
    parser.add_argument("--dry-run", action="store_true", help="Print actions without writing files")
    args = parser.parse_args()

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

        job = pick_random_job(conn)
        base = Path(job.ncfile or job.key).stem
        print(f"[job] Selected {job.key} (base '{base}')")

        # Stage
        if not args.no_stage:
            stage_job(processed_root, job, machine, dry_run=args.dry_run)

        # AutoPAC: LOAD_FINISH → LABEL_FINISH → CNC_FINISH
        auto_pac_dir = Path(app_settings.auto_pac_csv_dir)
        machine_token = machine.name if machine.name else str(machine.machine_id)

        sleep_random(args.min_delay, args.max_delay)
        write_autopac_csv(auto_pac_dir, machine_token, "load_finish", [base], dry_run=args.dry_run)

        sleep_random(args.min_delay, args.max_delay)
        write_autopac_csv(auto_pac_dir, machine_token, "label_finish", [base], dry_run=args.dry_run)

        sleep_random(args.min_delay, args.max_delay)
        write_autopac_csv(auto_pac_dir, machine_token, "cnc_finish", [base], dry_run=args.dry_run)

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


def run_forever():
    parser = argparse.ArgumentParser(description="Simulate a full job workflow via file watchers (repeat)")
    parser.add_argument("--machine", help="Machine selector: name token (e.g. WT1) or numeric id. If omitted, prompts interactively.")
    parser.add_argument("--ask-machine", action="store_true", help="Prompt for the machine even if --machine is provided.")
    parser.add_argument("--min-delay", type=int, default=0, help="Minimum seconds between steps within a cycle (default: 0)")
    parser.add_argument("--max-delay", type=int, default=120, help="Maximum seconds between steps within a cycle (default: 120)")
    parser.add_argument("--between-min", type=int, default=3, help="Minimum seconds between cycles (default: 3)")
    parser.add_argument("--between-max", type=int, default=15, help="Maximum seconds between cycles (default: 15)")
    parser.add_argument("--no-stage", action="store_true", help="Skip staging step")
    parser.add_argument("--dry-run", action="store_true", help="Print actions without writing files")
    args = parser.parse_args()

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
                    job = pick_random_job(conn)
                except Exception as e:
                    print(f"[warn] Could not pick a job: {e}")
                    time.sleep(max(1, args.between_min))
                    continue

                base = Path(job.ncfile or job.key).stem
                print(f"[job] Selected {job.key} (base '{base}')")

                if not args.no_stage and processed_root:
                    try:
                        stage_job(processed_root, job, machine, dry_run=args.dry_run)
                    except Exception as e:
                        print(f"[warn] Staging failed: {e}")

                auto_pac_dir = Path(app_settings.auto_pac_csv_dir)
                machine_token = machine.name if machine.name else str(machine.machine_id)

                sleep_random(args.min_delay, args.max_delay)
                write_autopac_csv(auto_pac_dir, machine_token, "load_finish", [base], dry_run=args.dry_run)

                sleep_random(args.min_delay, args.max_delay)
                write_autopac_csv(auto_pac_dir, machine_token, "label_finish", [base], dry_run=args.dry_run)

                sleep_random(args.min_delay, args.max_delay)
                write_autopac_csv(auto_pac_dir, machine_token, "cnc_finish", [base], dry_run=args.dry_run)

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


if __name__ == "__main__":
    if "--once" in sys.argv:
        main()
    else:
        run_forever()
