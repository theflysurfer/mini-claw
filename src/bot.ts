import { spawn } from "node:child_process";
import { Bot, InlineKeyboard, InputFile } from "grammy";
import type { Config } from "./config.js";
import { detectFiles, snapshotWorkspace } from "./file-detector.js";
import { logger, Timer } from "./logger.js";
import { markdownToHtml, stripMarkdown } from "./markdown.js";
import {
	type ActivityUpdate,
	acquireLock,
	checkPiAuth,
	initPi,
	resetSession,
	runPiWithStreaming,
} from "./pi-runner.js";
import { checkRateLimit } from "./rate-limiter.js";
import {
	archiveSession,
	cleanupOldSessions,
	clearActiveSession,
	formatFileSize,
	formatSessionAge,
	generateSessionTitle,
	listSessions,
	switchSession,
} from "./sessions.js";
import {
	downloadTelegramFile,
	isTranscriberReady,
	transcribe,
} from "./transcriber.js";
import { formatPath, getWorkspace, setWorkspace } from "./workspace.js";

interface ShellResult {
	stdout: string;
	stderr: string;
	code: number | null;
}

async function runShell(
	cmd: string,
	cwd: string,
	timeoutMs: number,
): Promise<ShellResult> {
	return new Promise((resolve) => {
		const proc = spawn("bash", ["-c", cmd], {
			cwd,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";

		proc.stdout.on("data", (data) => {
			stdout += data.toString();
		});

		proc.stderr.on("data", (data) => {
			stderr += data.toString();
		});

		proc.on("close", (code) => {
			resolve({ stdout, stderr, code });
		});

		proc.on("error", (err) => {
			resolve({ stdout: "", stderr: err.message, code: 1 });
		});

		setTimeout(() => {
			proc.kill("SIGTERM");
			resolve({ stdout, stderr: `${stderr}\n(timeout)`, code: 124 });
		}, timeoutMs);
	});
}

const MAX_MESSAGE_LENGTH = 4096;

function splitMessage(text: string): string[] {
	if (text.length <= MAX_MESSAGE_LENGTH) {
		return [text];
	}

	const chunks: string[] = [];
	let remaining = text;

	while (remaining.length > 0) {
		if (remaining.length <= MAX_MESSAGE_LENGTH) {
			chunks.push(remaining);
			break;
		}

		// Try to split at newline
		let splitIndex = remaining.lastIndexOf("\n", MAX_MESSAGE_LENGTH);
		if (splitIndex === -1 || splitIndex < MAX_MESSAGE_LENGTH / 2) {
			// Fall back to space
			splitIndex = remaining.lastIndexOf(" ", MAX_MESSAGE_LENGTH);
		}
		if (splitIndex === -1 || splitIndex < MAX_MESSAGE_LENGTH / 2) {
			// Hard split
			splitIndex = MAX_MESSAGE_LENGTH;
		}

		chunks.push(remaining.slice(0, splitIndex));
		remaining = remaining.slice(splitIndex).trimStart();
	}

	return chunks;
}

export function createBot(config: Config): Bot {
	const bot = new Bot(config.telegramToken);

	// Access control middleware
	if (config.allowedUsers.length > 0) {
		bot.use(async (ctx, next) => {
			const userId = ctx.from?.id;
			if (userId && config.allowedUsers.includes(userId)) {
				await next();
			} else {
				await ctx.reply("Sorry, you are not authorized to use this bot.");
			}
		});
	}

	// Command descriptions for menu
	const commands = [
		{ command: "start", description: "Welcome & quick start" },
		{ command: "help", description: "Show all commands" },
		{ command: "pwd", description: "Show current directory" },
		{ command: "cd", description: "Change directory" },
		{ command: "home", description: "Go to home directory" },
		{ command: "shell", description: "Run shell command" },
		{ command: "session", description: "Manage sessions" },
		{ command: "new", description: "Start fresh conversation" },
		{ command: "status", description: "Show bot status" },
	];

	// Set bot command menu
	bot.api.setMyCommands(commands).catch(() => {
		// Ignore errors (might not have permission)
	});

	// /start command
	bot.command("start", async (ctx) => {
		const piOk = await initPi();
		const status = piOk
			? "Pi is ready"
			: "Pi is not installed or not authenticated";
		const cwd = await getWorkspace(ctx.chat.id);

		await ctx.reply(
			`Welcome to Mini-Claw!

${status}
Working directory: ${formatPath(cwd)}

Type /help for all commands.
Send any message to chat with AI.`,
		);
	});

	// /help command
	bot.command("help", async (ctx) => {
		await ctx.reply(
			`📖 Mini-Claw Commands

📁 Navigation:
/pwd - Show current directory
/cd <path> - Change directory
/home - Go to home directory

🔧 Execution:
/shell <cmd> - Run shell command directly

💬 Sessions:
/session - List & manage sessions
/new - Archive current & start fresh

📊 Info:
/status - Show bot status
/help - Show this message

💡 Tips:
• Any text → AI conversation
• /shell runs instantly, no AI
• /cd supports ~, .., relative paths`,
		);
	});

	// /pwd command
	bot.command("pwd", async (ctx) => {
		const cwd = await getWorkspace(ctx.chat.id);
		await ctx.reply(`📁 ${formatPath(cwd)}`);
	});

	// /home command
	bot.command("home", async (ctx) => {
		try {
			const cwd = await setWorkspace(ctx.chat.id, "~");
			await ctx.reply(`📁 ${formatPath(cwd)}`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : "Unknown error";
			await ctx.reply(`Error: ${msg}`);
		}
	});

	// /cd command
	bot.command("cd", async (ctx) => {
		const path = ctx.match?.trim();
		if (!path) {
			// No argument = go home
			try {
				const cwd = await setWorkspace(ctx.chat.id, "~");
				await ctx.reply(`📁 ${formatPath(cwd)}`);
			} catch (err) {
				const msg = err instanceof Error ? err.message : "Unknown error";
				await ctx.reply(`Error: ${msg}`);
			}
			return;
		}

		try {
			const cwd = await setWorkspace(ctx.chat.id, path);
			await ctx.reply(`📁 ${formatPath(cwd)}`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : "Unknown error";
			await ctx.reply(`Error: ${msg}`);
		}
	});

	// /new command - start fresh session
	bot.command("new", async (ctx) => {
		// Must wait for any ongoing Pi execution to complete first
		// Otherwise Pi will recreate the session file after we rename it
		const release = await acquireLock(ctx.chat.id);
		try {
			const archived = await archiveSession(config, ctx.chat.id);
			// Clear active session tracking for truly fresh start
			await clearActiveSession(ctx.chat.id);
			if (archived) {
				await ctx.reply(
					`Session archived as ${archived}\nStarting fresh conversation.`,
				);
			} else {
				await ctx.reply("Starting fresh conversation.");
			}
		} finally {
			release();
		}
	});

	// /status command
	bot.command("status", async (ctx) => {
		const piOk = await checkPiAuth();
		const cwd = await getWorkspace(ctx.chat.id);
		await ctx.reply(
			`Status:
- Pi: ${piOk ? "OK" : "Not available"}
- Chat ID: ${ctx.chat.id}
- Workspace: ${formatPath(cwd)}`,
		);
	});

	// /shell command - run shell command in current directory
	bot.command("shell", async (ctx) => {
		const cmd = ctx.match?.trim();
		if (!cmd) {
			await ctx.reply("Usage: /shell <command>\nExample: /shell ls -la");
			return;
		}

		const cwd = await getWorkspace(ctx.chat.id);
		await ctx.replyWithChatAction("typing");

		try {
			const result = await runShell(cmd, cwd, config.shellTimeoutMs);

			let output = "";
			if (result.stdout) {
				output += result.stdout;
			}
			if (result.stderr) {
				output += `${output ? "\n" : ""}stderr: ${result.stderr}`;
			}
			if (!output) {
				output = "(no output)";
			}

			// Add exit code if non-zero
			if (result.code !== 0) {
				output += `\n\n[exit code: ${result.code}]`;
			}

			// Split long output
			const chunks = splitMessage(output.trim());
			for (const chunk of chunks) {
				await ctx.reply(chunk);
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : "Unknown error";
			await ctx.reply(`Error: ${msg}`);
		}
	});

	// /session command - list and manage sessions
	bot.command("session", async (ctx) => {
		await ctx.replyWithChatAction("typing");

		const sessions = await listSessions(config);

		if (sessions.length === 0) {
			await ctx.reply("No sessions found.");
			return;
		}

		// Generate titles for sessions (in parallel, max 5)
		const sessionsWithTitles = await Promise.all(
			sessions.slice(0, 10).map(async (session) => {
				const title = await generateSessionTitle(
					session.path,
					config.sessionTitleTimeoutMs,
				);
				return { ...session, title };
			}),
		);

		// Build inline keyboard
		const keyboard = new InlineKeyboard();

		for (const session of sessionsWithTitles) {
			const age = formatSessionAge(session.modifiedAt);
			const size = formatFileSize(session.sizeBytes);
			const label = `${session.title} (${age}, ${size})`;

			// Callback data format: session:load:<filename>
			keyboard.text(label, `session:load:${session.filename}`).row();
		}

		// Add cleanup button
		keyboard.text("🗑 Clean Up Old Sessions", "session:cleanup").row();

		await ctx.reply(
			`📚 Sessions (${sessions.length} total)\n\nTap to switch session:`,
			{ reply_markup: keyboard },
		);
	});

	// Handle callback queries for session buttons
	bot.callbackQuery(/^session:load:(.+)$/, async (ctx) => {
		const filename = ctx.match[1];
		const chatId = ctx.chat?.id;

		if (!chatId) {
			await ctx.answerCallbackQuery({ text: "Error: No chat ID" });
			return;
		}

		try {
			await switchSession(config, chatId, filename);
			await ctx.answerCallbackQuery({ text: "Session switched!" });
			await ctx.editMessageText(`✅ Switched to session: ${filename}`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : "Unknown error";
			await ctx.answerCallbackQuery({
				text: `Error: ${msg}`,
				show_alert: true,
			});
		}
	});

	bot.callbackQuery("session:cleanup", async (ctx) => {
		await ctx.answerCallbackQuery({ text: "Cleaning up..." });

		const deleted = await cleanupOldSessions(config, 5);

		await ctx.editMessageText(
			`🗑 Cleanup complete!\nDeleted ${deleted} old session(s).\nKept the 5 most recent sessions per chat.`,
		);
	});

	// Handle voice messages — transcribe and forward to AI
	bot.on(["message:voice", "message:audio", "message:video_note"], async (ctx) => {
		const chatId = ctx.chat.id;

		// Rate limiting check
		const rateLimit = checkRateLimit(chatId, config.rateLimitCooldownMs);
		if (!rateLimit.allowed) {
			const seconds = Math.ceil((rateLimit.retryAfterMs || 0) / 1000);
			await ctx.reply(`⏳ Please wait ${seconds}s before sending another message.`);
			return;
		}

		// Check if transcriber is available
		const ready = await isTranscriberReady();
		if (!ready) {
			await ctx.reply("🎤 Voice transcription is not available (server offline).");
			return;
		}

		// Get file_id from voice, audio, or video_note
		const voice = ctx.message.voice;
		const audio = ctx.message.audio;
		const videoNote = ctx.message.video_note;
		const fileId = voice?.file_id || audio?.file_id || videoNote?.file_id;
		const duration = voice?.duration || audio?.duration || videoNote?.duration || 0;

		if (!fileId) {
			await ctx.reply("Could not process this media.");
			return;
		}

		const statusMsg = await ctx.reply(`🎤 Transcribing voice (${duration}s)...`);
		await ctx.replyWithChatAction("typing");

		try {
			// Download audio from Telegram
			const audioBuffer = await downloadTelegramFile(config.telegramToken, fileId);

			// Determine MIME type
			const mimeType = voice?.mime_type || audio?.mime_type || "audio/ogg";

			// Transcribe
			const result = await transcribe(audioBuffer, mimeType);

			// Delete status message
			try {
				await ctx.api.deleteMessage(chatId, statusMsg.message_id);
			} catch {
				// Ignore
			}

			if (!result.text || result.text.trim().length === 0) {
				await ctx.reply("🎤 (empty — no speech detected)");
				return;
			}

			// Send transcription
			const meta = `⏱ ${result.durationProcessing}s | 🌍 ${result.language}`;
			await ctx.reply(`🎤 ${result.text}\n\n<i>${meta}</i>`, { parse_mode: "HTML" });

			// Also forward the transcribed text to Pi as if the user typed it
			// This way voice messages participate in the AI conversation
			const caption = ctx.message.caption;
			const textForPi = caption
				? `[Voice message] ${result.text}\n[Caption] ${caption}`
				: `[Voice message] ${result.text}`;

			// Get current workspace for this chat
			const workspace = await getWorkspace(chatId);
			const beforeSnapshot = await snapshotWorkspace(workspace);

			const piStatusMsg = await ctx.reply("🔄 Processing...");
			let lastStatusUpdate = Date.now();

			const activityEmoji: Record<string, string> = {
				thinking: "🧠", reading: "📖", writing: "✍️",
				running: "⚡", searching: "🔍", working: "🔄",
			};

			const onActivity = async (activity: ActivityUpdate) => {
				const now = Date.now();
				if (now - lastStatusUpdate < 2000) return;
				lastStatusUpdate = now;
				try {
					const emoji = activityEmoji[activity.type] || "🔄";
					await ctx.api.editMessageText(
						chatId, piStatusMsg.message_id,
						`${emoji} Working... (${activity.elapsed}s)${activity.detail ? `\n└─ ${activity.detail}` : ""}`,
					);
				} catch { /* ignore */ }
			};

			const typingInterval = setInterval(() => {
				ctx.replyWithChatAction("typing").catch(() => {});
			}, 4000);

			try {
				const piResult = await runPiWithStreaming(config, chatId, textForPi, workspace, onActivity);
				clearInterval(typingInterval);

				try { await ctx.api.deleteMessage(chatId, piStatusMsg.message_id); } catch { /* ignore */ }

				if (piResult.error) {
					await ctx.reply(`Error: ${piResult.error}`);
				}
				if (piResult.output) {
					const chunks = splitMessage(piResult.output.trim());
					for (const chunk of chunks) {
						try {
							await ctx.reply(markdownToHtml(chunk), { parse_mode: "HTML" });
						} catch {
							await ctx.reply(stripMarkdown(chunk));
						}
					}
				}

				const detectedFiles = await detectFiles(piResult.output || "", workspace, beforeSnapshot);
				for (const file of detectedFiles) {
					try {
						if (file.type === "photo") {
							await ctx.replyWithPhoto(new InputFile(file.path), { caption: file.filename });
						} else {
							await ctx.replyWithDocument(new InputFile(file.path), { caption: file.filename });
						}
					} catch {
						await ctx.reply(`(Could not send file: ${file.filename})`);
					}
				}
			} catch (err) {
				clearInterval(typingInterval);
				try { await ctx.api.deleteMessage(chatId, piStatusMsg.message_id); } catch { /* ignore */ }
				const errorMsg = err instanceof Error ? err.message : "Unknown error";
				await ctx.reply(`Failed to process: ${errorMsg}`);
			}

		} catch (err) {
			try { await ctx.api.deleteMessage(chatId, statusMsg.message_id); } catch { /* ignore */ }
			const errorMsg = err instanceof Error ? err.message : "Unknown error";
			await ctx.reply(`🎤 Transcription failed: ${errorMsg}`);
		}
	});

	// Handle all text messages
	bot.on("message:text", async (ctx) => {
		const chatId = ctx.chat.id;
		const text = ctx.message.text;

		// Skip commands
		if (text.startsWith("/")) {
			return;
		}

		const msgTimer = new Timer("msg", `text from ${ctx.from?.username || chatId}`);
		logger.info("msg", `📩 "${text.slice(0, 150)}${text.length > 150 ? "..." : ""}"`, { chatId, from: ctx.from?.username, len: text.length });

		// Rate limiting check
		const rateLimit = checkRateLimit(chatId, config.rateLimitCooldownMs);
		if (!rateLimit.allowed) {
			const seconds = Math.ceil((rateLimit.retryAfterMs || 0) / 1000);
			logger.info("msg", `Rate limited chat ${chatId}, ${seconds}s remaining`);
			await ctx.reply(
				`⏳ Please wait ${seconds}s before sending another message.`,
			);
			return;
		}

		// Get current workspace for this chat
		const workspace = await getWorkspace(chatId);
		msgTimer.lap("workspace");

		// Snapshot workspace before Pi execution
		const beforeSnapshot = await snapshotWorkspace(workspace);
		msgTimer.lap("snapshot");

		// Send initial status message that we'll update
		const statusMsg = await ctx.reply("🔄 Working...");
		let lastStatusUpdate = Date.now();

		// Activity emoji mapping
		const activityEmoji: Record<string, string> = {
			thinking: "🧠",
			reading: "📖",
			writing: "✍️",
			running: "⚡",
			searching: "🔍",
			working: "🔄",
		};

		// Format status message
		const formatStatus = (activity: ActivityUpdate): string => {
			const emoji = activityEmoji[activity.type] || "🔄";
			const elapsed = `${activity.elapsed}s`;
			const detail = activity.detail ? `\n└─ ${activity.detail}` : "";
			return `${emoji} Working... (${elapsed})${detail}`;
		};

		// Activity callback - update status message
		const onActivity = async (activity: ActivityUpdate) => {
			// Throttle updates to avoid rate limits (max once per 2 seconds)
			const now = Date.now();
			if (now - lastStatusUpdate < 2000) return;
			lastStatusUpdate = now;

			try {
				await ctx.api.editMessageText(
					chatId,
					statusMsg.message_id,
					formatStatus(activity),
				);
			} catch {
				// Ignore edit errors (message might be deleted, or content unchanged)
			}
		};

		// Keep typing indicator active
		const typingInterval = setInterval(() => {
			ctx.replyWithChatAction("typing").catch(() => {});
		}, 4000);

		try {
			const result = await runPiWithStreaming(
				config,
				chatId,
				text,
				workspace,
				onActivity,
			);

			clearInterval(typingInterval);

			// Delete status message
			try {
				await ctx.api.deleteMessage(chatId, statusMsg.message_id);
			} catch {
				// Ignore delete errors
			}

			if (result.error) {
				await ctx.reply(`Error: ${result.error}`);
			}

			if (result.output) {
				// Try to send as HTML, fallback to plain text
				const chunks = splitMessage(result.output.trim());
				for (const chunk of chunks) {
					try {
						const html = markdownToHtml(chunk);
						await ctx.reply(html, { parse_mode: "HTML" });
					} catch {
						// Fallback to plain text if HTML fails
						await ctx.reply(stripMarkdown(chunk));
					}
				}
			}

			// Detect and send any files created by Pi
			const detectedFiles = await detectFiles(
				result.output || "",
				workspace,
				beforeSnapshot,
			);

			for (const file of detectedFiles) {
				try {
					if (file.type === "photo") {
						await ctx.replyWithPhoto(new InputFile(file.path), {
							caption: file.filename,
						});
					} else {
						await ctx.replyWithDocument(new InputFile(file.path), {
							caption: file.filename,
						});
					}
				} catch {
					// File might have been deleted or inaccessible
					await ctx.reply(`(Could not send file: ${file.filename})`);
				}
			}
			msgTimer.lap("reply-sent");
			msgTimer.done(`${result.output?.length || 0}B response`);
		} catch (err) {
			clearInterval(typingInterval);
			// Try to delete status message on error too
			try {
				await ctx.api.deleteMessage(chatId, statusMsg.message_id);
			} catch {
				// Ignore
			}
			const errorMsg = err instanceof Error ? err.message : "Unknown error";
			logger.error("msg", `Failed for chat ${chatId}: ${errorMsg}`);
			await ctx.reply(`Failed to process: ${errorMsg}`);
		}
	});

	return bot;
}
