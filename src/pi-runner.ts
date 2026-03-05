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

let sharedAuth: InstanceType<typeof AuthStorage> | null = null;
let sharedModelRegistry: InstanceType<typeof ModelRegistry> | null = null;
let piInitialized = false;

async function ensurePiInfra(): Promise<{
	authStorage: InstanceType<typeof AuthStorage>;
	modelRegistry: InstanceType<typeof ModelRegistry>;
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

	const { authStorage, modelRegistry } = await ensurePiInfra();
	const sessionPath = getSessionPath(config, chatId);

	console.log(`[pi-sdk] Creating session for chat ${chatId} (cwd: ${workspace})`);
	const startMs = Date.now();

	// Resolve model override from config (env vars PI_MODEL / PI_THINKING_LEVEL)
	const sessionOptions: Parameters<typeof createAgentSession>[0] = {
		cwd: workspace,
		sessionManager: SessionManager.open(sessionPath),
		authStorage,
		modelRegistry,
	};

	if (config.piModel) {
		// Model format: "provider/model-id" or just "model-id" (defaults to anthropic)
		const parts = config.piModel.split("/");
		const provider = parts.length > 1 ? parts[0] : "anthropic";
		const modelId = parts.length > 1 ? parts[1] : parts[0];
		const model = modelRegistry.find(provider, modelId);
		if (model) {
			sessionOptions.model = model;
			console.log(`[pi-sdk] Model override: ${provider}/${modelId}`);
		} else {
			console.warn(`[pi-sdk] Model not found: ${config.piModel}, using default`);
		}
	}

	if (config.piThinkingLevel) {
		sessionOptions.thinkingLevel = config.piThinkingLevel as any;
		console.log(`[pi-sdk] Thinking override: ${config.piThinkingLevel}`);
	}

	const { session } = await createAgentSession(sessionOptions);

	const elapsed = Date.now() - startMs;
	console.log(`[pi-sdk] Session for chat ${chatId} ready in ${elapsed}ms`);

	sessions.set(chatId, session);
	return session;
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
			if (/bash/i.test(name)) return { type: "running", detail: String((event as any).args?.command || "").slice(0, 50) };
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

/**
 * Initialize Pi SDK (call once at startup). Validates auth.
 */
export async function initPi(): Promise<boolean> {
	try {
		const { authStorage, modelRegistry } = await ensurePiInfra();
		const available = await modelRegistry.getAvailable();
		piInitialized = available.length > 0;
		if (piInitialized) {
			console.log(`[pi-sdk] Pi initialized: ${available.length} model(s) available`);
		} else {
			console.error("[pi-sdk] No models available — run 'pi /login' to authenticate");
		}
		return piInitialized;
	} catch (err: any) {
		console.error(`[pi-sdk] Init failed: ${err.message}`);
		return false;
	}
}

/**
 * Run a prompt (non-streaming, simple). Kept for backward compat.
 */
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

/**
 * Run a prompt with activity streaming (typing indicators for Telegram).
 */
export async function runPiWithStreaming(
	config: Config,
	chatId: number,
	prompt: string,
	workspace: string,
	onActivity: ActivityCallback,
): Promise<RunResult> {
	const release = await acquireLock(chatId);
	const startTime = Date.now();
	let lastActivity: ActivityUpdate | null = null;

	try {
		await mkdir(config.sessionDir, { recursive: true });
		const session = await getOrCreateSession(config, chatId, workspace);

		let output = "";
		const unsub = session.subscribe((event) => {
			// Collect text output
			if (event.type === "message_update") {
				const sub = (event as any).assistantMessageEvent;
				if (sub?.type === "text_delta") {
					output += sub.delta;
				}
			}

			// Detect activity for Telegram typing indicator
			const activity = eventToActivity(event);
			if (activity) {
				const elapsed = Math.floor((Date.now() - startTime) / 1000);
				lastActivity = { ...activity, elapsed };
				onActivity(lastActivity);
			}
		});

		// Periodic "working" pings when no specific activity
		const activityInterval = setInterval(() => {
			const elapsed = Math.floor((Date.now() - startTime) / 1000);
			if (!lastActivity || elapsed - lastActivity.elapsed > 5) {
				onActivity({ type: "working", detail: "", elapsed });
			}
		}, 5000);

		// Timeout via AbortController
		const timeoutId = setTimeout(() => {
			session.abort();
		}, config.piTimeoutMs);

		try {
			await session.prompt(prompt);
		} finally {
			clearTimeout(timeoutId);
			clearInterval(activityInterval);
			unsub();
		}

		const totalMs = Date.now() - startTime;
		console.log(`[pi-sdk] chat ${chatId} responded in ${totalMs}ms (${output.length}B)`);

		return { output: output || "(no output)" };
	} catch (err: any) {
		const isTimeout = err.message?.includes("abort");
		return {
			output: "",
			error: isTimeout ? "Timeout: Pi took too long" : err.message,
		};
	} finally {
		release();
	}
}

/**
 * Check Pi auth (used at startup).
 * @deprecated Use initPi() instead
 */
export async function checkPiAuth(): Promise<boolean> {
	return initPi();
}

/**
 * Reset a chat session (for /new command).
 */
export async function resetSession(chatId: number): Promise<void> {
	const session = sessions.get(chatId);
	if (session) {
		session.dispose();
		sessions.delete(chatId);
	}
}

/**
 * Dispose all sessions (graceful shutdown).
 */
export async function disposeAll(): Promise<void> {
	for (const [chatId, session] of sessions) {
		try {
			session.dispose();
		} catch {}
	}
	sessions.clear();
	console.log("[pi-sdk] All sessions disposed");
}
