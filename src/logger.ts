import { createWriteStream, statSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Rolling file logger — 2MB max, 3 files retained
// ---------------------------------------------------------------------------

const MAX_SIZE = 2 * 1024 * 1024; // 2 MB
const MAX_FILES = 3;
const LOG_DIR = join(homedir(), ".mini-claw", "logs");
const LOG_FILE = "mini-claw.log";

let stream: ReturnType<typeof createWriteStream> | null = null;
let currentSize = 0;

function getLogPath(index = 0): string {
	return index === 0
		? join(LOG_DIR, LOG_FILE)
		: join(LOG_DIR, LOG_FILE.replace(".log", `.${index}.log`));
}

function rotate(): void {
	if (stream) {
		stream.end();
		stream = null;
	}
	for (let i = MAX_FILES - 1; i >= 1; i--) {
		try { renameSync(getLogPath(i - 1), getLogPath(i)); } catch {}
	}
	currentSize = 0;
	openStream();
}

function openStream(): void {
	try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}
	try { currentSize = statSync(getLogPath()).size; } catch { currentSize = 0; }
	stream = createWriteStream(getLogPath(), { flags: "a" });
}

function writeLine(line: string): void {
	if (!stream) openStream();
	if (currentSize >= MAX_SIZE) rotate();
	stream!.write(line);
	currentSize += Buffer.byteLength(line);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

function ts(): string {
	const d = new Date();
	const pad2 = (n: number) => String(n).padStart(2, "0");
	const pad3 = (n: number) => String(n).padStart(3, "0");
	return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${pad3(d.getMilliseconds())}`;
}

export function log(level: LogLevel, tag: string, msg: string, extra?: Record<string, unknown>): void {
	const extraStr = extra ? " " + JSON.stringify(extra) : "";
	const line = `${ts()} [${level.padEnd(5)}] [${tag}] ${msg}${extraStr}\n`;
	writeLine(line);
	if (level === "ERROR") process.stderr.write(line);
	else process.stdout.write(line);
}

export const logger = {
	debug: (tag: string, msg: string, extra?: Record<string, unknown>) => log("DEBUG", tag, msg, extra),
	info:  (tag: string, msg: string, extra?: Record<string, unknown>) => log("INFO",  tag, msg, extra),
	warn:  (tag: string, msg: string, extra?: Record<string, unknown>) => log("WARN",  tag, msg, extra),
	error: (tag: string, msg: string, extra?: Record<string, unknown>) => log("ERROR", tag, msg, extra),
};

// ---------------------------------------------------------------------------
// Timer — measure any operation with laps
// ---------------------------------------------------------------------------

export class Timer {
	private start = Date.now();
	private lastLap = Date.now();
	private laps: Array<{ label: string; ms: number }> = [];

	constructor(public readonly tag: string, public readonly op: string) {
		logger.debug(tag, `⏱ START ${op}`);
	}

	lap(label: string): number {
		const now = Date.now();
		const ms = now - this.lastLap;
		this.laps.push({ label, ms });
		this.lastLap = now;
		logger.debug(this.tag, `  ├─ ${label}: ${ms}ms`);
		return ms;
	}

	done(summary?: string): number {
		const totalMs = Date.now() - this.start;
		const parts = this.laps.map(l => `${l.label}=${l.ms}ms`).join(", ");
		const extra = parts ? ` [${parts}]` : "";
		const sum = summary ? ` — ${summary}` : "";
		logger.info(this.tag, `⏱ DONE ${this.op}: ${totalMs}ms${extra}${sum}`);
		return totalMs;
	}
}

// ---------------------------------------------------------------------------
// Init / close
// ---------------------------------------------------------------------------

export function initLogger(): void {
	openStream();
	logger.info("logger", `Started: ${getLogPath()} (max ${MAX_SIZE / 1024 / 1024}MB × ${MAX_FILES} files)`);
}

export function closeLogger(): void {
	if (stream) { stream.end(); stream = null; }
}
