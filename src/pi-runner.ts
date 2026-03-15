import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
	AuthStorage,
	ModelRegistry,
	SessionManager,
	createAgentSession,
	type AgentSession,
	type AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";
import type { Config } from "./config.js";
import { logger, Timer } from "./logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RunResult {
	output: string;
	error?: string;
}

export type ActivityType =
	| "thinking"
	| "reading"
	| "writing"
	| "running"
	| "searching"
	| "working";

export interface ActivityUpdate {
	type: ActivityType;
	detail: string;
	elapsed: number; // seconds
}

export type ActivityCallback = (activity: ActivityUpdate) => void;

// ---------------------------------------------------------------------------
// Per-chat lock (prevents concurrent prompts on same session)
// ---------------------------------------------------------------------------

const locks = new Map<number, Promise<void>>();

export async function acquireLock(chatId: number): Promise<() => void> {
	while (locks.has(chatId)) {
		logger.debug("lock", `Waiting for lock on chat ${chatId}`);
		await locks.get(chatId);
	}
	let release: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	locks.set(chatId, promise);
	return () => {
		locks.delete(chatId);
		release?.();
	};
}

// ---------------------------------------------------------------------------
// Shared Pi infrastructure (initialized once)
// ---------------------------------------------------------------------------

let sharedAuth: AuthStorage | null = null;
let sharedModelRegistry: ModelRegistry | null = null;
let piInitialized = false;

async function ensurePiInfra(): Promise<{
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
}> {
	if (!sharedAuth) {
		sharedAuth = AuthStorage.create();
	}
	if (!sharedModelRegistry) {
		sharedModelRegistry = new ModelRegistry(sharedAuth);
	}
	return { authStorage: sharedAuth, modelRegistry: sharedModelRegistry };
}

// ---------------------------------------------------------------------------
// Per-chat session cache (sessions stay alive between messages)
// ---------------------------------------------------------------------------

const sessions = new Map<number, AgentSession>();
const sessionCreating = new Map<number, Promise<AgentSession>>();

function getSessionPath(config: Config, chatId: number): string {
	return join(config.sessionDir, `telegram-${chatId}.jsonl`);
}

async function getOrCreateSession(
	config: Config,
	chatId: number,
	workspace: string,
): Promise<AgentSession> {
	const existing = sessions.get(chatId);
	if (existing) return existing;

	// If already being created (e.g. preload in progress), wait for it
	const pending = sessionCreating.get(chatId);
	if (pending) {
		logger.debug("pi-sdk", `Session for chat ${chatId} already loading, waiting...`);
		return pending;
	}

	const promise = createSessionInternal(config, chatId, workspace);
	sessionCreating.set(chatId, promise);
	try {
		return await promise;
	} finally {
		sessionCreating.delete(chatId);
	}
}

async function createSessionInternal(
	config: Config,
	chatId: number,
	workspace: string,
): Promise<AgentSession> {
	const timer = new Timer("pi-sdk", `session create (chat ${chatId})`);

	const { authStorage, modelRegistry } = await ensurePiInfra();
	timer.lap("infra");

	const sessionPath = getSessionPath(config, chatId);
	logger.info("pi-sdk", `Creating session for chat ${chatId}`, { cwd: workspace, sessionPath });

	const sessionOptions: Parameters<typeof createAgentSession>[0] = {
		cwd: workspace,
		sessionManager: SessionManager.open(sessionPath),
		authStorage,
		modelRegistry,
	};

	if (config.piModel) {
		const parts = config.piModel.split("/");
		const provider = parts.length > 1 ? parts[0] : "anthropic";
		const modelId = parts.length > 1 ? parts[1] : parts[0];
		const model = modelRegistry.find(provider, modelId);
		if (model) {
			sessionOptions.model = model;
			logger.info("pi-sdk", `Model override: ${provider}/${modelId}`);
		} else {
			logger.warn("pi-sdk", `Model not found: ${config.piModel}, using default`);
		}
	}

	if (config.piThinkingLevel) {
		sessionOptions.thinkingLevel = config.piThinkingLevel as any;
		logger.info("pi-sdk", `Thinking override: ${config.piThinkingLevel}`);
	}

	timer.lap("options");

	const { session } = await createAgentSession(sessionOptions);
	timer.done(`chat ${chatId} ready`);

	sessions.set(chatId, session);
	return session;
}

// ---------------------------------------------------------------------------
// Pre-load sessions at startup
// ---------------------------------------------------------------------------

export async function preloadSessions(
	config: Config,
	workspace: string,
): Promise<void> {
	if (config.allowedUsers.length === 0) {
		logger.info("preload", "No ALLOWED_USERS configured, skipping");
		return;
	}

	const timer = new Timer("preload", `${config.allowedUsers.length} session(s)`);

	for (const userId of config.allowedUsers) {
		try {
			await getOrCreateSession(config, userId, workspace);
		} catch (err: any) {
			logger.error("preload", `Failed for user ${userId}: ${err.message}`);
		}
	}

	timer.done("all sessions ready");
}

// ---------------------------------------------------------------------------
// Activity detection from events
// ---------------------------------------------------------------------------

function eventToActivity(event: AgentSessionEvent): { type: ActivityType; detail: string } | null {
	switch (event.type) {
		case "tool_execution_start": {
			const name = event.toolName || "";
			if (/read/i.test(name)) return { type: "reading", detail: name };
			if (/write|edit/i.test(name)) return { type: "writing", detail: name };
			if (/bash/i.test(name)) return { type: "running", detail: String((event as any).args?.command || "").slice(0, 80) };
			if (/search|grep|find|fast_search/i.test(name)) return { type: "searching", detail: name };
			return { type: "working", detail: name };
		}
		case "message_update": {
			const sub = (event as any).assistantMessageEvent;
			if (sub?.type === "thinking_delta") return { type: "thinking", detail: "" };
			return null;
		}
		default:
			return null;
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function initPi(): Promise<boolean> {
	const timer = new Timer("pi-sdk", "initPi");
	try {
		const { authStorage, modelRegistry } = await ensurePiInfra();
		timer.lap("infra");
		const available = await modelRegistry.getAvailable();
		timer.lap("getAvailable");
		piInitialized = available.length > 0;
		if (piInitialized) {
			timer.done(`${available.length} model(s) available`);
		} else {
			logger.error("pi-sdk", "No models available — run 'pi /login' to authenticate");
		}
		return piInitialized;
	} catch (err: any) {
		logger.error("pi-sdk", `Init failed: ${err.message}`);
		return false;
	}
}

export async function runPi(
	config: Config,
	chatId: number,
	prompt: string,
	workspace: string,
): Promise<RunResult> {
	const release = await acquireLock(chatId);
	try {
		await mkdir(config.sessionDir, { recursive: true });
		const session = await getOrCreateSession(config, chatId, workspace);

		let output = "";
		const unsub = session.subscribe((event) => {
			if (event.type === "message_update") {
				const sub = (event as any).assistantMessageEvent;
				if (sub?.type === "text_delta") {
					output += sub.delta;
				}
			}
		});

		await session.prompt(prompt);
		unsub();

		return { output: output || "(no output)" };
	} catch (err: any) {
		return { output: "", error: err.message };
	} finally {
		release();
	}
}

export async function runPiWithStreaming(
	config: Config,
	chatId: number,
	prompt: string,
	workspace: string,
	onActivity: ActivityCallback,
): Promise<RunResult> {
	const release = await acquireLock(chatId);
	const timer = new Timer("prompt", `chat ${chatId}`);
	let lastActivity: ActivityUpdate | null = null;
	let toolCalls = 0;

	try {
		await mkdir(config.sessionDir, { recursive: true });
		const session = await getOrCreateSession(config, chatId, workspace);
		timer.lap("session");

		logger.info("prompt", `← "${prompt.slice(0, 120)}${prompt.length > 120 ? "..." : ""}"`, { chatId, promptLen: prompt.length });

		let output = "";
		const unsub = session.subscribe((event) => {
			// Collect text
			if (event.type === "message_update") {
				const sub = (event as any).assistantMessageEvent;
				if (sub?.type === "text_delta") output += sub.delta;
			}

			// Log tool calls
			if (event.type === "tool_execution_start") {
				toolCalls++;
				const name = event.toolName || "?";
				const args = JSON.stringify((event as any).args || {}).slice(0, 200);
				logger.debug("tool", `▶ ${name} ${args}`, { chatId });
			}
			if (event.type === "tool_execution_end") {
				const name = (event as any).toolName || "?";
				const dur = (event as any).durationMs;
				const err = (event as any).error;
				if (err) {
					logger.warn("tool", `✗ ${name} failed (${dur}ms): ${String(err).slice(0, 200)}`, { chatId });
				} else {
					logger.debug("tool", `✓ ${name} (${dur}ms)`, { chatId });
				}
			}

			// Activity for typing indicator
			const activity = eventToActivity(event);
			if (activity) {
				const elapsed = Math.floor((Date.now() - timer["start"]) / 1000);
				lastActivity = { ...activity, elapsed };
				onActivity(lastActivity);
			}
		});

		const activityInterval = setInterval(() => {
			const elapsed = Math.floor((Date.now() - timer["start"]) / 1000);
			if (!lastActivity || elapsed - lastActivity.elapsed > 5) {
				onActivity({ type: "working", detail: "", elapsed });
			}
		}, 5000);

		const timeoutId = setTimeout(() => {
			logger.warn("prompt", `Timeout reached (${config.piTimeoutMs}ms), aborting`, { chatId });
			session.abort();
		}, config.piTimeoutMs);

		try {
			await session.prompt(prompt);
		} finally {
			clearTimeout(timeoutId);
			clearInterval(activityInterval);
			unsub();
		}

		timer.done(`${output.length}B, ${toolCalls} tools`);
		return { output: output || "(no output)" };
	} catch (err: any) {
		const isTimeout = err.message?.includes("abort");
		logger.error("prompt", `Failed for chat ${chatId}: ${err.message}`, { isTimeout });
		return {
			output: "",
			error: isTimeout ? "Timeout: Pi took too long" : err.message,
		};
	} finally {
		release();
	}
}

export async function checkPiAuth(): Promise<boolean> {
	return initPi();
}

export async function resetSession(chatId: number): Promise<void> {
	const session = sessions.get(chatId);
	if (session) {
		logger.info("pi-sdk", `Resetting session for chat ${chatId}`);
		session.dispose();
		sessions.delete(chatId);
	}
}

export async function disposeAll(): Promise<void> {
	for (const [chatId, session] of sessions) {
		try { session.dispose(); } catch {}
	}
	sessions.clear();
	logger.info("pi-sdk", "All sessions disposed");
}
