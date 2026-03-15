# pi-gpu-monitor

Live GPU monitoring widget for [pi](https://github.com/badlogic/pi-mono). Shows sparkline utilization graphs and memory usage, updated in real-time.

Works on **Linux** (NVIDIA via `nvidia-smi`) and **macOS** (Apple Silicon via `ioreg`).

## Install

```bash
pi install git:github.com/tobi/pi-gpu-monitor
```

## Usage

Toggle the widget with the `/gpu` command:

```
/gpu          # toggle on/off
/gpu on       # enable
/gpu off      # disable
/gpu on 5     # enable with 5s refresh interval
/gpu 2        # enable with 2s refresh
```

The widget appears below the editor showing per-GPU:
- **Sparkline history** — last 8 readings as a mini bar chart
- **Utilization %** — color-coded (green → yellow → red)
- **Memory** — used/total in GiB, color-coded by pressure

## Platform Support

### macOS (Apple Silicon)

Uses `ioreg` to read GPU utilization from the IOAccelerator driver — no `sudo` required. Reports the GPU memory allocation from the unified memory pool. Chip name is detected via `sysctl` (e.g. "Apple M2 Max").

Falls back to `system_profiler` for GPU identification if `ioreg` data is unavailable.

### Linux (NVIDIA)

Uses `nvidia-smi` for per-GPU utilization and dedicated VRAM usage.

Falls back to `lspci` for GPU identification if `nvidia-smi` is unavailable.

### macOS with eGPU

If you have an NVIDIA eGPU on macOS, the extension tries Apple GPU first, then falls back to `nvidia-smi`.
