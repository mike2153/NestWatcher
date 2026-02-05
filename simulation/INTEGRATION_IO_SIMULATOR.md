# Integration IO Simulator

This folder contains Python scripts used to simulate CNC integration file I/O.

`integration_io_simulator.py` is the simplest end-to-end simulator for:

- AutoPAC status CSVs
- Grundner request/reply CSV/ERL handshakes
- Nestpick request/ack/unstack

It is meant to run alongside the Electron app.

## Usage

Example (explicit paths):

```powershell
python .\simulation\integration_io_simulator.py `
  --ap-jobfolder "D:\\Machine1\\Ready-To-Run" `
  --autopac-dir "D:\\SoftwareTesting\\LabelStatus" `
  --grundner-dir "D:\\SoftwareTesting\\Nestpick" `
  --nestpick-dir "D:\\SoftwareTesting\\Nestpick" `
  --machine-token WT1 `
  --machine-id 1
```

Example (default: read `paths.autoPacCsvDir` and `paths.grundnerFolderPath` from repo root `settings.json`):

```powershell
python .\simulation\integration_io_simulator.py `
  --ap-jobfolder "D:\\Machine1\\Ready-To-Run" `
  --nestpick-dir "D:\\SoftwareTesting\\Nestpick" `
  --machine-token WT1 `
  --machine-id 1
```

If you want a different settings file, pass it explicitly:

```powershell
python .\simulation\integration_io_simulator.py `
  --settings .\settings.json `
  --ap-jobfolder "D:\\Machine1\\Ready-To-Run" `
  --nestpick-dir "D:\\SoftwareTesting\\Nestpick" `
  --machine-token WT1 `
  --machine-id 1
```

## What It Does

- Watches `--ap-jobfolder` for a newly created subfolder.
- Reads any `.nc` files inside that folder and uses each filename stem as a job id.
- Writes the following files into `--autopac-dir` with random 0-10s delays:
  - `order_sawWT1.csv` (optional)
  - `load_finishWT1.csv`
  - `label_finishWT1.csv`
  - `cnc_finishWT1.csv`
- Watches `--grundner-dir` for requests and replies with matching `.erl` files:
  - `ChangeMachNr.csv` -> `ChangeMachNr.erl`
  - `order_saw.csv` -> `order_saw.erl`
  - `get_production.csv` -> `get_production.erl`
- Waits for `Nestpick.csv` to appear in `--nestpick-dir`, then:
  - writes `Nestpick.erl` with the same content
  - writes `Report_FullNestpickUnstack.csv`
