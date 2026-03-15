import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

type GpuInfo = {
	index: number;
	name: string;
	util: number;
	memoryUsedMiB: number;
	memoryTotalMiB: number;
};

type QueryResult =
	| { ok: true; source: "nvidia-smi"; gpus: GpuInfo[] }
	| { ok: false; summary?: string; error: string };

const WIDGET_KEY = "gpu-monitor";
const HISTORY_POINTS = 8;
const DEFAULT_REFRESH_MS = 3000;
const MIN_REFRESH_MS = 1000;
const MAX_REFRESH_MS = 30000;
const SPARK_BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function toInt(value: string): number {
	const parsed = Number.parseInt(value.trim(), 10);
	return Number.isFinite(parsed) ? parsed : 0;
}

function formatGiB(mib: number): string {
	return `${(mib / 1024).toFixed(mib >= 10 * 1024 ? 0 : 1)}G`;
}

function normalizeGpuName(name: string): string {
	return name.replace(/^NVIDIA\s+/i, "").replace(/\s+/g, " ").trim();
}

function summarizeGpuTypes(gpus: GpuInfo[]): string {
	if (gpus.length === 0) return "no GPUs";

	const counts = new Map<string, number>();
	for (const gpu of gpus) {
		const key = normalizeGpuName(gpu.name);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}

	const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	if (groups.length === 1) {
		const [name, count] = groups[0]!;
		return `${count}× ${name}`;
	}

	const head = groups
		.slice(0, 2)
		.map(([name, count]) => `${count}× ${name}`)
		.join(", ");
	const extra = groups.length > 2 ? ` +${groups.length - 2} types` : "";
	return head + extra;
}

async function queryNvidiaSmi(pi: ExtensionAPI, cwd: string): Promise<QueryResult> {
	const result = await pi.exec(
		"nvidia-smi",
		[
			"--query-gpu=index,name,utilization.gpu,memory.used,memory.total",
			"--format=csv,noheader,nounits",
		],
		{ cwd, timeout: 2000 },
	);

	if (result.code !== 0 || result.killed) {
		return {
			ok: false,
			error: result.stderr.trim() || "nvidia-smi failed",
		};
	}

	const gpus = result.stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const parts = line.split(",");
			if (parts.length < 5) return undefined;
			return {
				index: toInt(parts[0] ?? "0"),
				name: (parts[1] ?? "Unknown GPU").trim(),
				util: clamp(toInt(parts[2] ?? "0"), 0, 100),
				memoryUsedMiB: Math.max(0, toInt(parts[3] ?? "0")),
				memoryTotalMiB: Math.max(0, toInt(parts[4] ?? "0")),
			} satisfies GpuInfo;
		})
		.filter((gpu): gpu is GpuInfo => Boolean(gpu))
		.sort((a, b) => a.index - b.index);

	if (gpus.length === 0) {
		return { ok: false, error: "No NVIDIA GPUs reported by nvidia-smi" };
	}

	return { ok: true, source: "nvidia-smi", gpus };
}

async function queryFallbackSummary(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
	const result = await pi.exec("lspci", [], { cwd, timeout: 2000 });
	if (result.code !== 0 || result.killed) return undefined;

	const lines = result.stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => /\b(VGA compatible controller|3D controller|Display controller)\b/i.test(line));

	if (lines.length === 0) return undefined;

	const counts = new Map<string, number>();
	for (const line of lines) {
		const name = line.split(": ").slice(1).join(": ") || line;
		const shortName = name.replace(/\(rev [^)]+\)/i, "").trim();
		counts.set(shortName, (counts.get(shortName) ?? 0) + 1);
	}

	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, 2)
		.map(([name, count]) => `${count}× ${name}`)
		.join(", ");
}

function sparkline(history: number[]): string {
	return history
		.slice(-HISTORY_POINTS)
		.map((value) => {
			const idx = clamp(Math.round((clamp(value, 0, 100) / 100) * (SPARK_BLOCKS.length - 1)), 0, SPARK_BLOCKS.length - 1);
			return SPARK_BLOCKS[idx]!;
		})
		.join("");
}

function utilColor(util: number): "muted" | "success" | "warning" | "error" {
	if (util >= 90) return "error";
	if (util >= 65) return "warning";
	if (util >= 20) return "success";
	return "muted";
}

function memoryColor(percent: number): "muted" | "success" | "warning" | "error" {
	if (percent >= 90) return "error";
	if (percent >= 75) return "warning";
	if (percent >= 30) return "success";
	return "muted";
}

export default function gpuMonitorExtension(pi: ExtensionAPI) {
	let enabled = false;
	let refreshMs = DEFAULT_REFRESH_MS;
	let currentCtx: ExtensionContext | undefined;
	let requestRender: (() => void) | undefined;
	let timer: NodeJS.Timeout | undefined;
	let pollInFlight = false;
	let lastError: string | undefined;
	let fallbackSummary: string | undefined;
	let lastSource: string | undefined;
	let gpus: GpuInfo[] = [];
	const histories = new Map<number, number[]>();

	function clearWidget(ctx: ExtensionContext | undefined): void {
		requestRender = undefined;
		ctx?.ui.setWidget(WIDGET_KEY, undefined);
	}

	function stopPolling(): void {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
	}

	function renderLine(width: number, ctx: ExtensionContext): string {
		const theme = ctx.ui.theme;
		if (lastError && gpus.length === 0) {
			const summary = fallbackSummary ? `${fallbackSummary} • ` : "";
			const line =
				theme.fg("warning", "GPU ") +
				theme.fg("dim", summary) +
				theme.fg("error", `unavailable (${lastError})`);
			return truncateToWidth(line, width);
		}

		if (gpus.length === 0) {
			return truncateToWidth(theme.fg("muted", "GPU loading…"), width);
		}

		const left =
			theme.fg("accent", theme.bold("GPU ")) +
			theme.fg("text", summarizeGpuTypes(gpus)) +
			theme.fg("dim", lastSource ? ` • ${lastSource}` : "");

		const segments: string[] = [];
		for (const gpu of gpus) {
			const history = histories.get(gpu.index) ?? [gpu.util];
			const memPercent = gpu.memoryTotalMiB > 0 ? Math.round((gpu.memoryUsedMiB / gpu.memoryTotalMiB) * 100) : 0;
			const spark = sparkline(history).padStart(HISTORY_POINTS, SPARK_BLOCKS[0]!);
			segments.push(
				theme.fg("dim", `${gpu.index}`) +
					theme.fg("dim", "[") +
					theme.fg(utilColor(gpu.util), spark) +
					theme.fg("dim", "]") +
					" " +
					theme.fg(utilColor(gpu.util), `${gpu.util}%`) +
					" " +
					theme.fg(memoryColor(memPercent), `${formatGiB(gpu.memoryUsedMiB)}/${formatGiB(gpu.memoryTotalMiB)}`),
			);
		}

		let right = segments.join(" ");
		if (visibleWidth(right) > width) {
			for (let i = 0; i < segments.length; i++) {
				const remaining = segments.length - (i + 1);
				const tail = remaining > 0 ? theme.fg("dim", ` …+${remaining}`) : "";
				const candidate = segments.slice(i).join(" ") + tail;
				if (visibleWidth(candidate) <= width) {
					right = candidate;
					break;
				}
			}
			if (visibleWidth(right) > width) {
				right = truncateToWidth(right, width);
			}
		}

		const leftWidth = visibleWidth(left);
		const rightWidth = visibleWidth(right);
		if (leftWidth + 1 + rightWidth <= width) {
			return left + " ".repeat(width - leftWidth - rightWidth) + right;
		}

		const maxLeftWidth = Math.max(0, width - rightWidth - 1);
		if (maxLeftWidth <= 0) return truncateToWidth(right, width);
		const truncatedLeft = truncateToWidth(left, maxLeftWidth);
		const gap = Math.max(1, width - visibleWidth(truncatedLeft) - rightWidth);
		return truncatedLeft + " ".repeat(gap) + right;
	}

	function ensureWidget(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		ctx.ui.setWidget(
			WIDGET_KEY,
			(tui) => {
				requestRender = () => tui.requestRender();
				return {
					render: (width: number) => [renderLine(width, ctx)],
					invalidate: () => {},
					dispose: () => {
						if (requestRender) requestRender = undefined;
					},
				};
			},
			{ placement: "belowEditor" },
		);
	}

	function refreshWidget(): void {
		requestRender?.();
	}

	function applySnapshot(snapshot: QueryResult): void {
		if (!snapshot.ok) {
			lastError = snapshot.error;
			fallbackSummary = snapshot.summary;
			lastSource = undefined;
			gpus = [];
			refreshWidget();
			return;
		}

		lastError = undefined;
		lastSource = snapshot.source;
		gpus = snapshot.gpus;

		const activeIndices = new Set(snapshot.gpus.map((gpu) => gpu.index));
		for (const key of histories.keys()) {
			if (!activeIndices.has(key)) histories.delete(key);
		}

		for (const gpu of snapshot.gpus) {
			const history = histories.get(gpu.index) ?? [];
			history.push(gpu.util);
			if (history.length > HISTORY_POINTS) history.splice(0, history.length - HISTORY_POINTS);
			histories.set(gpu.index, history);
		}

		refreshWidget();
	}

	async function poll(): Promise<void> {
		if (!enabled || !currentCtx || pollInFlight) return;
		pollInFlight = true;
		try {
			const snapshot = await queryNvidiaSmi(pi, currentCtx.cwd);
			if (snapshot.ok) {
				applySnapshot(snapshot);
			} else {
				applySnapshot({
					ok: false,
					error: snapshot.error,
					summary: await queryFallbackSummary(pi, currentCtx.cwd),
				});
			}
		} catch (error) {
			applySnapshot({
				ok: false,
				error: error instanceof Error ? error.message : String(error),
				summary: fallbackSummary,
			});
		} finally {
			pollInFlight = false;
		}
	}

	function startPolling(): void {
		stopPolling();
		void poll();
		timer = setInterval(() => {
			void poll();
		}, refreshMs);
	}

	function setEnabled(nextEnabled: boolean, ctx: ExtensionContext): void {
		enabled = nextEnabled;
		currentCtx = ctx;

		if (!enabled) {
			stopPolling();
			clearWidget(ctx);
			ctx.ui.notify("GPU widget hidden", "info");
			return;
		}

		ensureWidget(ctx);
		startPolling();
		ctx.ui.notify(`GPU widget enabled (${Math.round(refreshMs / 1000)}s refresh)`, "info");
	}

	function updateUiForSession(ctx: ExtensionContext): void {
		currentCtx = ctx;
		if (!enabled) return;
		ensureWidget(ctx);
		startPolling();
	}

	pi.registerCommand("gpu", {
		description: "Toggle a live single-line GPU widget (/gpu [on|off|toggle] [seconds])",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/gpu needs an interactive UI session", "warning");
				return;
			}

			const parts = args
				.trim()
				.split(/\s+/)
				.filter(Boolean);
			let action = parts[0]?.toLowerCase();
			let secondsToken: string | undefined;

			if (!action) {
				action = "toggle";
			} else if (/^\d+(?:\.\d+)?$/.test(action)) {
				secondsToken = action;
				action = "on";
			} else {
				secondsToken = parts[1];
			}

			if (!["on", "off", "toggle"].includes(action)) {
				ctx.ui.notify("Usage: /gpu [on|off|toggle] [refresh-seconds]", "warning");
				return;
			}

			if (secondsToken) {
				const seconds = Number.parseFloat(secondsToken);
				if (!Number.isFinite(seconds) || seconds <= 0) {
					ctx.ui.notify("Refresh seconds must be a positive number", "warning");
					return;
				}
				refreshMs = clamp(Math.round(seconds * 1000), MIN_REFRESH_MS, MAX_REFRESH_MS);
			}

			const nextEnabled = action === "toggle" ? !enabled : action === "on";
			setEnabled(nextEnabled, ctx);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		updateUiForSession(ctx);
	});

	pi.on("session_switch", (_event, ctx) => {
		updateUiForSession(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		stopPolling();
		clearWidget(ctx);
	});
}
