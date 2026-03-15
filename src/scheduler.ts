/**
 * Task Scheduler — cron + interval + one-shot tasks
 * 
 * Tasks are stored in ~/.mini-claw/tasks.json and checked every 30s.
 * When a task is due, it runs session.prompt(task.prompt) and sends
 * the result to the associated Telegram chat.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { logger, Timer } from "./logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScheduledTask {
	id: string;
	chatId: number;
	prompt: string;
	/** "cron" | "interval" | "once" */
	scheduleType: "cron" | "interval" | "once";
	/** cron expression, interval in ms, or ISO date for once */
	scheduleValue: string;
	/** ISO string — next time this task should run */
	nextRun: string;
	/** ISO string — last time it ran (null if never) */
	lastRun: string | null;
	/** Last result summary (truncated) */
	lastResult: string | null;
	/** "active" | "paused" | "done" */
	status: "active" | "paused" | "done";
	/** ISO string */
	createdAt: string;
	/** Human label */
	label: string;
}

interface TaskStore {
	tasks: ScheduledTask[];
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const TASKS_DIR = join(homedir(), ".mini-claw");
const TASKS_FILE = join(TASKS_DIR, "tasks.json");

async function loadTasks(): Promise<ScheduledTask[]> {
	try {
		const raw = await readFile(TASKS_FILE, "utf-8");
		const store: TaskStore = JSON.parse(raw);
		return store.tasks || [];
	} catch {
		return [];
	}
}

async function saveTasks(tasks: ScheduledTask[]): Promise<void> {
	await mkdir(TASKS_DIR, { recursive: true });
	const store: TaskStore = { tasks };
	await writeFile(TASKS_FILE, JSON.stringify(store, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Cron parser (minimal — supports: "M H D Mo DoW")
// ---------------------------------------------------------------------------

function cronMatches(expr: string, date: Date): boolean {
	const parts = expr.trim().split(/\s+/);
	if (parts.length !== 5) return false;

	const [minExpr, hourExpr, domExpr, monExpr, dowExpr] = parts;
	const min = date.getMinutes();
	const hour = date.getHours();
	const dom = date.getDate();
	const mon = date.getMonth() + 1;
	const dow = date.getDay(); // 0=Sun

	return (
		fieldMatches(minExpr, min, 0, 59) &&
		fieldMatches(hourExpr, hour, 0, 23) &&
		fieldMatches(domExpr, dom, 1, 31) &&
		fieldMatches(monExpr, mon, 1, 12) &&
		fieldMatches(dowExpr, dow, 0, 6)
	);
}

function fieldMatches(expr: string, value: number, _min: number, _max: number): boolean {
	if (expr === "*") return true;

	// Handle */N (every N)
	if (expr.startsWith("*/")) {
		const step = parseInt(expr.slice(2), 10);
		return step > 0 && value % step === 0;
	}

	// Handle comma-separated values: 1,3,5
	const values = expr.split(",").map((v) => parseInt(v.trim(), 10));
	return values.includes(value);
}

function nextCronRun(expr: string, after: Date): Date {
	// Brute force: check every minute for the next 48 hours
	const d = new Date(after);
	d.setSeconds(0, 0);
	d.setMinutes(d.getMinutes() + 1);

	for (let i = 0; i < 48 * 60; i++) {
		if (cronMatches(expr, d)) return d;
		d.setMinutes(d.getMinutes() + 1);
	}

	// Fallback: 24h from now
	return new Date(after.getTime() + 24 * 60 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Compute next run
// ---------------------------------------------------------------------------

function computeNextRun(task: ScheduledTask): string | null {
	const now = Date.now();

	if (task.scheduleType === "once") return null; // done after first run

	if (task.scheduleType === "cron") {
		return nextCronRun(task.scheduleValue, new Date(now)).toISOString();
	}

	if (task.scheduleType === "interval") {
		const ms = parseInt(task.scheduleValue, 10);
		if (!ms || ms <= 0) return new Date(now + 60_000).toISOString();
		// Anchor to scheduled time to prevent drift
		let next = new Date(task.nextRun).getTime() + ms;
		while (next <= now) next += ms;
		return new Date(next).toISOString();
	}

	return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function generateTaskId(): string {
	return `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export async function addTask(task: ScheduledTask): Promise<void> {
	const tasks = await loadTasks();
	tasks.push(task);
	await saveTasks(tasks);
	logger.info("scheduler", `Task added: ${task.id} "${task.label}"`, {
		scheduleType: task.scheduleType,
		scheduleValue: task.scheduleValue,
		nextRun: task.nextRun,
	});
}

export async function removeTask(taskId: string): Promise<boolean> {
	const tasks = await loadTasks();
	const idx = tasks.findIndex((t) => t.id === taskId);
	if (idx === -1) return false;
	const removed = tasks.splice(idx, 1)[0];
	await saveTasks(tasks);
	logger.info("scheduler", `Task removed: ${taskId} "${removed.label}"`);
	return true;
}

export async function pauseTask(taskId: string): Promise<boolean> {
	const tasks = await loadTasks();
	const task = tasks.find((t) => t.id === taskId);
	if (!task) return false;
	task.status = "paused";
	await saveTasks(tasks);
	logger.info("scheduler", `Task paused: ${taskId}`);
	return true;
}

export async function resumeTask(taskId: string): Promise<boolean> {
	const tasks = await loadTasks();
	const task = tasks.find((t) => t.id === taskId);
	if (!task) return false;
	task.status = "active";
	if (!task.nextRun || new Date(task.nextRun).getTime() < Date.now()) {
		const next = computeNextRun(task);
		if (next) task.nextRun = next;
	}
	await saveTasks(tasks);
	logger.info("scheduler", `Task resumed: ${taskId}`);
	return true;
}

export async function listTasks(): Promise<ScheduledTask[]> {
	return loadTasks();
}

export type TaskRunner = (chatId: number, prompt: string) => Promise<string>;

let schedulerTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the scheduler polling loop.
 * @param runner — function that runs a prompt and returns the output
 * @param sendMessage — function that sends a message to a Telegram chat
 */
export function startScheduler(
	runner: TaskRunner,
	sendMessage: (chatId: number, text: string) => Promise<void>,
	pollIntervalMs = 30_000,
): void {
	if (schedulerTimer) {
		logger.warn("scheduler", "Already running, skipping duplicate start");
		return;
	}

	logger.info("scheduler", `Started (poll every ${pollIntervalMs / 1000}s)`);

	const poll = async () => {
		try {
			const tasks = await loadTasks();
			const now = Date.now();
			let changed = false;

			for (const task of tasks) {
				if (task.status !== "active") continue;
				if (!task.nextRun) continue;

				const nextRunMs = new Date(task.nextRun).getTime();
				if (nextRunMs > now) continue;

				// Task is due!
				const timer = new Timer("scheduler", `task ${task.id} "${task.label}"`);
				logger.info("scheduler", `Running task: ${task.id} "${task.label}"`, { chatId: task.chatId });

				try {
					const output = await runner(task.chatId, task.prompt);
					timer.done(`${output.length}B output`);

					// Send result to user
					const msg = `⏰ **Tâche planifiée** : ${task.label}\n\n${output}`;
					await sendMessage(task.chatId, msg.slice(0, 4000));

					task.lastRun = new Date().toISOString();
					task.lastResult = output.slice(0, 500);

					// Compute next run
					const nextRun = computeNextRun(task);
					if (nextRun) {
						task.nextRun = nextRun;
					} else {
						task.status = "done";
						logger.info("scheduler", `Task completed (one-shot): ${task.id}`);
					}
				} catch (err: any) {
					logger.error("scheduler", `Task ${task.id} failed: ${err.message}`);
					task.lastRun = new Date().toISOString();
					task.lastResult = `Error: ${err.message}`;

					// Still advance next run to avoid retry spam
					const nextRun = computeNextRun(task);
					if (nextRun) task.nextRun = nextRun;
				}

				changed = true;
			}

			if (changed) await saveTasks(tasks);
		} catch (err: any) {
			logger.error("scheduler", `Poll error: ${err.message}`);
		}
	};

	// First poll immediately
	poll();
	schedulerTimer = setInterval(poll, pollIntervalMs);
}

export function stopScheduler(): void {
	if (schedulerTimer) {
		clearInterval(schedulerTimer);
		schedulerTimer = null;
		logger.info("scheduler", "Stopped");
	}
}
