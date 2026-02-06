from __future__ import annotations

import argparse
import json
import os
import queue
import random
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional


@dataclass(frozen=True)
class SettingsOverrides:
    auto_pac_csv_dir: Optional[Path]
    grundner_dir: Optional[Path]


def _now_ms() -> int:
    return int(time.time() * 1000)


def _atomic_write_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.tmp-{_now_ms()}")
    with tmp.open("wb") as f:
        f.write(data)
    os.replace(tmp, path)


def _atomic_write_text(path: Path, text: str) -> None:
    # Keep newline style deterministic; the app normalizes newlines before comparing
    # most integration reply files.
    normalized = text.replace("\r\n", "\n")
    if not normalized.endswith("\n"):
        normalized += "\n"
    _atomic_write_bytes(path, normalized.encode("utf-8"))


def _sleep_random(min_s: float, max_s: float, label: str) -> None:
    delay = random.uniform(min_s, max_s)
    print(f"[delay] {label}: sleeping {delay:.2f}s")
    time.sleep(delay)


def _wait_for_exists(path: Path, timeout_s: float, poll_s: float = 0.25) -> bool:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if path.exists():
            return True
        time.sleep(poll_s)
    return False


def _read_bytes_stable(path: Path, attempts: int = 6, sleep_s: float = 0.25) -> Optional[bytes]:
    last_size = -1
    for _ in range(max(1, attempts)):
        try:
            size = path.stat().st_size
            if size == last_size:
                return path.read_bytes()
            last_size = size
        except FileNotFoundError:
            return None
        except OSError:
            pass
        time.sleep(sleep_s)
    try:
        return path.read_bytes()
    except Exception:
        return None


def _scan_tree_signature(root: Path) -> tuple[int, int]:
    # Return (file_count, total_bytes) as a cheap stability signal.
    file_count = 0
    total_bytes = 0
    for p in root.rglob("*"):
        try:
            if not p.is_file():
                continue
            file_count += 1
            total_bytes += p.stat().st_size
        except OSError:
            # Share / copy in progress. Keep going.
            continue
    return file_count, total_bytes


def _wait_for_folder_stable(folder: Path, timeout_s: float = 10.0) -> bool:
    deadline = time.time() + timeout_s
    last = None
    while time.time() < deadline:
        cur = _scan_tree_signature(folder)
        if last is not None and cur == last:
            return True
        last = cur
        time.sleep(0.5)
    return True


def _find_nc_bases(staged_folder: Path) -> list[str]:
    bases: list[str] = []
    seen = set()
    for p in staged_folder.rglob("*.nc"):
        try:
            if not p.is_file():
                continue
        except OSError:
            continue
        base = p.stem
        if not base:
            continue
        if base.lower() in seen:
            continue
        seen.add(base.lower())
        bases.append(base)
    return bases


def _write_autopac_status_csv(auto_pac_dir: Path, kind: str, machine_token: str, machine_id: int, bases: Iterable[str]) -> Path:
    # The app enforces:
    # - filename prefix kind
    # - machine token is extracted from filename
    # - >= 2 columns per row
    # - token must appear somewhere in the CSV
    # - base in column 1 (with or without .nc)
    out = auto_pac_dir / f"{kind}{machine_token}.csv"
    # Real AutoPAC status files use machine number in column 2.
    rows = [f"{b},{machine_id}" for b in bases]
    _atomic_write_text(out, "\n".join(rows))
    print(f"[autopac] wrote {out}")
    return out


def _write_autopac_order_saw(auto_pac_dir: Path, machine_token: str, machine_id: int, bases: Iterable[str]) -> Path:
    out = auto_pac_dir / f"order_saw{machine_token}.csv"
    # The app parser accepts comma or semicolon. This semicolon format matches its
    # canonical output when it re-emits ChangeMachNr.csv.
    rows = [f"{b};{machine_id};" for b in bases]
    _atomic_write_text(out, "\n".join(rows))
    print(f"[autopac] wrote {out}")
    return out


def _write_nestpick_stack(nestpick_dir: Path) -> Optional[Path]:
    req = nestpick_dir / "Nestpick.csv"
    if not req.exists():
        return None
    raw = _read_bytes_stable(req)
    if raw is None:
        return None
    out = nestpick_dir / "Nestpick.erl"
    _atomic_write_bytes(out, raw)
    print(f"[nestpick] wrote {out}")
    # Real integrations usually remove the request file after consuming it.
    try:
        req.unlink(missing_ok=True)
        print(f"[nestpick] deleted {req}")
    except OSError:
        pass
    return out


def _write_nestpick_unstack(nestpick_dir: Path, bases: Iterable[str], pallet: str = "P1") -> Path:
    out = nestpick_dir / "Report_FullNestpickUnstack.csv"
    rows = [f"{b},{pallet}" for b in bases]
    _atomic_write_text(out, "\n".join(rows))
    print(f"[nestpick] wrote {out}")
    return out


def _mirror_request_to_erl(request_path: Path, reply_name: str, delete_request: bool = True) -> Optional[Path]:
    raw = _read_bytes_stable(request_path)
    if raw is None:
        return None
    reply_path = request_path.with_name(reply_name)
    _atomic_write_bytes(reply_path, raw)
    print(f"[grundner] wrote {reply_path}")
    if delete_request:
        try:
            request_path.unlink(missing_ok=True)
            print(f"[grundner] deleted {request_path}")
        except OSError:
            pass
    return reply_path


def _load_settings_overrides(settings_path: Path) -> SettingsOverrides:
    raw = json.loads(settings_path.read_text(encoding="utf-8"))
    paths = raw.get("paths") or {}
    auto_pac = (paths.get("autoPacCsvDir") or "").strip()
    grundner = (paths.get("grundnerFolderPath") or "").strip()
    return SettingsOverrides(
        auto_pac_csv_dir=Path(auto_pac) if auto_pac else None,
        grundner_dir=Path(grundner) if grundner else None,
    )


def _grundner_loop(grundner_dir: Path, stop: threading.Event, poll_s: float) -> None:
    print(f"[grundner] watching {grundner_dir}")
    # We respond to the three request types the app writes.
    mapping = {
        "ChangeMachNr.csv": "ChangeMachNr.erl",
        "order_saw.csv": "order_saw.erl",
        "get_production.csv": "get_production.erl",
    }

    last_handled_mtime: dict[str, float] = {}
    while not stop.is_set():
        for req_name, rep_name in mapping.items():
            req = grundner_dir / req_name
            try:
                if not req.exists():
                    continue
                mtime = req.stat().st_mtime
            except OSError:
                continue
            key = str(req)
            if last_handled_mtime.get(key) == mtime:
                continue

            # Random delay here makes the flow feel real and also exercises
            # the app's busy/backoff behaviors.
            _sleep_random(0.0, 10.0, f"grundner {req_name}")
            reply = _mirror_request_to_erl(req, rep_name, delete_request=True)
            if reply is not None:
                last_handled_mtime[key] = mtime

        stop.wait(poll_s)


def _ap_jobfolder_scan_loop(
    ap_jobfolder: Path,
    jobs: queue.Queue[Path],
    stop: threading.Event,
    poll_s: float,
    process_existing: bool,
) -> None:
    print(f"[stage-watch] watching {ap_jobfolder}")
    seen: set[str] = set()
    if process_existing:
        for p in ap_jobfolder.iterdir():
            try:
                if p.is_dir():
                    seen.add(str(p.resolve()))
            except OSError:
                continue

    while not stop.is_set():
        try:
            for p in ap_jobfolder.iterdir():
                try:
                    if not p.is_dir():
                        continue
                    resolved = str(p.resolve())
                except OSError:
                    continue
                if resolved in seen:
                    continue
                seen.add(resolved)
                print(f"[stage-watch] detected new staged folder: {p}")
                jobs.put(p)
        except FileNotFoundError:
            pass
        except OSError:
            pass
        stop.wait(poll_s)


def _job_runner_loop(
    jobs: queue.Queue[Path],
    stop: threading.Event,
    *,
    auto_pac_dir: Path,
    grundner_dir: Path,
    nestpick_dir: Path,
    machine_token: str,
    machine_id: int,
    min_delay_s: float,
    max_delay_s: float,
    nestpick_timeout_s: float,
    emit_order_saw: bool,
) -> None:
    print("[runner] ready")
    while not stop.is_set():
        try:
            staged = jobs.get(timeout=0.25)
        except queue.Empty:
            continue

        try:
            _wait_for_folder_stable(staged, timeout_s=10.0)
            bases = _find_nc_bases(staged)
            if not bases:
                print(f"[runner] no .nc files found in {staged}; skipping")
                continue
            # AutoPAC status CSVs should represent ONE sheet/job at a time.
            # If the staged folder contains multiple .nc programs, pick one deterministically
            # so we do not incorrectly progress multiple jobs.
            bases = sorted(bases, key=lambda s: s.lower())
            base = bases[0]
            print(f"[runner] selected base={base} from {len(bases)} nc file(s)")

            # AutoPAC + Grundner (optional order_saw -> ChangeMachNr handshake)
            if emit_order_saw:
                _sleep_random(min_delay_s, max_delay_s, "before order_saw")
                _write_autopac_order_saw(auto_pac_dir, machine_token, machine_id, [base])
                print(f"[runner] order_saw emitted; app should write ChangeMachNr.csv into {grundner_dir}")

            # AutoPAC status progression
            _sleep_random(min_delay_s, max_delay_s, "before load_finish")
            _write_autopac_status_csv(auto_pac_dir, "load_finish", machine_token, machine_id, [base])

            _sleep_random(min_delay_s, max_delay_s, "before label_finish")
            _write_autopac_status_csv(auto_pac_dir, "label_finish", machine_token, machine_id, [base])

            _sleep_random(min_delay_s, max_delay_s, "before cnc_finish")
            _write_autopac_status_csv(auto_pac_dir, "cnc_finish", machine_token, machine_id, [base])

            # Nestpick stack/unstack
            nestpick_req = nestpick_dir / "Nestpick.csv"
            if _wait_for_exists(nestpick_req, timeout_s=nestpick_timeout_s, poll_s=0.25):
                _sleep_random(min_delay_s, max_delay_s, "before Nestpick.erl")
                _write_nestpick_stack(nestpick_dir)
                _sleep_random(min_delay_s, max_delay_s, "before Report_FullNestpickUnstack.csv")
                _write_nestpick_unstack(nestpick_dir, [base], pallet="P1")
            else:
                print(
                    f"[nestpick] did not see Nestpick.csv within {nestpick_timeout_s:.0f}s; "
                    "skipping Nestpick stack/unstack for this job"
                )

        except Exception as e:
            print(f"[runner] error while processing {staged}: {e}")
        finally:
            jobs.task_done()


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(
        description=(
            "Simulate AutoPAC + Grundner + Nestpick integration I/O by writing the same CSV/ERL files "
            "the Woodtron app expects.\n\n"
            "This tool is designed to be run alongside the Electron app during development/testing."
        )
    )

    ap.add_argument("--ap-jobfolder", required=True, help="Machine 1 Ready-To-Run folder to watch for new staged job folders")
    ap.add_argument("--autopac-dir", help="paths.autoPacCsvDir (AutoPAC status CSV drop folder). Defaults to repo root settings.json")
    ap.add_argument("--grundner-dir", help="paths.grundnerFolderPath (Grundner request/reply folder). Defaults to repo root settings.json")
    ap.add_argument("--nestpick-dir", required=True, help="Machine 1 nestpickFolder")
    ap.add_argument("--machine-token", default="WT1", help="Machine token used in filenames/cells (default: WT1)")
    ap.add_argument("--machine-id", type=int, default=1, help="Numeric machine id used in order_saw rows (default: 1)")
    ap.add_argument(
        "--settings",
        help="Optional path to settings.json. If omitted, defaults to repo root settings.json.",
    )

    ap.add_argument("--min-delay", type=float, default=0.0, help="Minimum seconds between steps (default: 0)")
    ap.add_argument("--max-delay", type=float, default=10.0, help="Maximum seconds between steps (default: 10)")
    ap.add_argument("--nestpick-timeout", type=float, default=120.0, help="Seconds to wait for Nestpick.csv after cnc_finish (default: 120)")

    ap.add_argument("--poll-interval", type=float, default=0.5, help="Polling interval seconds for folders (default: 0.5)")
    ap.add_argument(
        "--process-existing",
        action="store_true",
        help="If set, treat existing folders in --ap-jobfolder as already seen (default: off)",
    )
    ap.add_argument(
        "--no-order-saw",
        action="store_true",
        help="Do not emit order_sawWT1.csv (default: emit it to exercise ChangeMachNr flow)",
    )

    args = ap.parse_args(argv)

    settings_overrides = SettingsOverrides(auto_pac_csv_dir=None, grundner_dir=None)
    settings_path: Optional[Path] = None
    if args.settings:
        settings_path = Path(args.settings)
    else:
        # Default to the repo root settings.json so you can run this tool with minimal args.
        settings_path = Path(__file__).resolve().parents[1] / "settings.json"

    # Only load settings.json when we actually need it.
    if (not args.autopac_dir) or (not args.grundner_dir):
        if not settings_path.exists():
            raise SystemExit(
                "Missing --autopac-dir/--grundner-dir and could not find settings.json. "
                "Provide --autopac-dir and --grundner-dir explicitly, or pass --settings <path-to-settings.json>."
            )
        settings_overrides = _load_settings_overrides(settings_path)

    ap_jobfolder = Path(args.ap_jobfolder)
    nestpick_dir = Path(args.nestpick_dir)

    auto_pac_dir = Path(args.autopac_dir) if args.autopac_dir else settings_overrides.auto_pac_csv_dir
    grundner_dir = Path(args.grundner_dir) if args.grundner_dir else settings_overrides.grundner_dir

    if auto_pac_dir is None:
        raise SystemExit(
            "Missing --autopac-dir and settings.json did not contain paths.autoPacCsvDir. "
            "Set it in repo root settings.json or pass --autopac-dir explicitly."
        )
    if grundner_dir is None:
        raise SystemExit(
            "Missing --grundner-dir and settings.json did not contain paths.grundnerFolderPath. "
            "Set it in repo root settings.json or pass --grundner-dir explicitly."
        )

    auto_pac_dir.mkdir(parents=True, exist_ok=True)
    grundner_dir.mkdir(parents=True, exist_ok=True)
    nestpick_dir.mkdir(parents=True, exist_ok=True)

    jobs: queue.Queue[Path] = queue.Queue()
    stop = threading.Event()

    threads = [
        threading.Thread(
            target=_ap_jobfolder_scan_loop,
            name="stage-watch",
            daemon=True,
            kwargs={
                "ap_jobfolder": ap_jobfolder,
                "jobs": jobs,
                "stop": stop,
                "poll_s": float(args.poll_interval),
                "process_existing": bool(args.process_existing),
            },
        ),
        threading.Thread(
            target=_grundner_loop,
            name="grundner",
            daemon=True,
            kwargs={
                "grundner_dir": grundner_dir,
                "stop": stop,
                "poll_s": float(args.poll_interval),
            },
        ),
        threading.Thread(
            target=_job_runner_loop,
            name="runner",
            daemon=True,
            kwargs={
                "jobs": jobs,
                "stop": stop,
                "auto_pac_dir": auto_pac_dir,
                "grundner_dir": grundner_dir,
                "nestpick_dir": nestpick_dir,
                "machine_token": str(args.machine_token),
                "machine_id": int(args.machine_id),
                "min_delay_s": float(args.min_delay),
                "max_delay_s": float(args.max_delay),
                "nestpick_timeout_s": float(args.nestpick_timeout),
                "emit_order_saw": not bool(args.no_order_saw),
            },
        ),
    ]

    for t in threads:
        t.start()

    print("\n[integration-io-sim] running; Ctrl+C to stop")
    try:
        while True:
            time.sleep(1.0)
    except KeyboardInterrupt:
        print("\n[integration-io-sim] stopping")
        stop.set()
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
