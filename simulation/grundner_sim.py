"""
Grundner stock simulator

Watches a folder (the configured Grundner folder) for:
- order_saw.csv  → writes order_saw.erl acknowledgment and updates a local
  grun_stock.csv to reflect reserved stock, adjusting stock_available.
- stock_request.csv → responds by copying the current grun_stock.csv to stock.csv.

Usage examples:
  python simulation/grundner_sim.py --folder "D:/SoftwareTesting/Nestpick"
  python simulation/grundner_sim.py --folder "D:/SoftwareTesting/Nestpick" --id-mode type_data

Notes:
- The simulator keeps an inventory CSV named grun_stock.csv in the watch folder.
- When an order is received, reserved_stock is incremented by the requested
  quantity and stock_available is set to max(0, stock - reserved_stock).
- The material column used for matching is controlled by --id-mode
  (type_data or customer_id). If the corresponding row does not exist in
  grun_stock.csv, it is created with stock=100 by default.
"""

from __future__ import annotations

import argparse
import csv
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Optional


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
    for ln in lines:
        _nc, material, qty = parse_order_csv_line(ln)
        # Track mapping for later delete confirmations
        nc_key = (_nc or "").strip().lower()
        if nc_key:
            _nc_to_material[nc_key] = (material or "").strip()
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
    nc = parts[0] if parts else ""
    nc = nc if nc.lower().endswith('.nc') else (nc + '.nc' if nc else nc)
    return (nc or "").strip().lower() or None


def handle_production_delete(folder: Path, id_mode: str, inventory_path: Path) -> None:
    def build_nc_material_map() -> Dict[str, str]:
        mapping: Dict[str, str] = dict(_nc_to_material)
        # Include current order if present
        try:
            cur_order = folder / ORDER_CSV
            if cur_order.exists():
                for ln in cur_order.read_text(encoding="utf-8").replace("\r\n", "\n").split("\n"):
                    if not ln.strip():
                        continue
                    nc, material, _ = parse_order_csv_line(ln)
                    if nc:
                        mapping[(nc or '').strip().lower()] = (material or '').strip()
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
                        if nc:
                            mapping[(nc or '').strip().lower()] = (material or '').strip()
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
    import re
    def derive_row_from_request(req_line: str) -> tuple[str, str, str, int, int, int, int, int]:
        parts = [p.strip() for p in req_line.split(';')]
        job_no = (parts[0] if len(parts) >= 1 else '').strip()
        token = (parts[1] if len(parts) >= 2 else '').strip()
        qty = (parts[2] if len(parts) >= 3 else '1').strip()
        machine = (parts[3] if len(parts) >= 4 else '0').strip()
        rotation = (parts[4] if len(parts) >= 5 else '0').strip()
        source = (parts[5] if len(parts) >= 6 else '0').strip()
        resv = (parts[6] if len(parts) >= 7 else '0').strip()
        # Decide type vs material based on token
        # Treat blank or zero-like tokens as empty (to allow inference)
        zero_like = {'', '0', '00', '000', '0000'}
        tok_eff = '' if token in zero_like else token
        is_num = tok_eff.isdigit() and int(tok_eff) > 0
        type_col = tok_eff if is_num else ''
        material_col = '' if is_num else tok_eff
        if not type_col and not material_col and job_no:
            base = job_no.rsplit('.', 1)[0]
            nums = re.findall(r"(\d+)", base)
            if nums:
                try:
                    type_col = str(max(int(n) for n in nums))
                except Exception:
                    type_col = nums[-1]
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
        job_no, type_col, material_col, qty_val, rot_val, mach_val, src_val, res_val = derive_row_from_request(ln)
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
            nc_key = (job_no or "").strip().lower()
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
        # Columns (1-based): 1=line, 2=job-no, 3=type, 4=material, 5=qty, 6=rotation, 7=machine, 8=source, 9=res
        type_field = (resolved_types[idx] or "").strip()
        material_field = (resolved_materials[idx] or "").strip()
        out_lines.append(f"{line_no};{job_no};{type_field};{material_field};{qty_val};{rot_val};{mach_val};{src_val};{res_val}")
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


def main(argv: list[str]) -> int:
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


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
