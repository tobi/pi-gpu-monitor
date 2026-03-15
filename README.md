# pi-gpu-monitor

Live GPU monitoring widget for [pi](https://github.com/badlogic/pi-mono). Shows sparkline utilization graphs and memory usage via `nvidia-smi`, updated in real-time.

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

When `nvidia-smi` is unavailable, falls back to `lspci` to show detected GPU hardware.

## Requirements

- NVIDIA GPU with `nvidia-smi` available in PATH
- Falls back gracefully if no NVIDIA GPU is present
