import "dotenv/config";
import { mkdir } from "node:fs/promises";
import { createBot } from "./bot.js";
import { loadConfig } from "./config.js";
import { initLogger, closeLogger, logger, Timer } from "./logger.js";
import { checkPiAuth, preloadSessions, runPiForScheduler } from "./pi-runner.js";
import { startScheduler, stopScheduler } from "./scheduler.js";
import { startTranscriber, stopTranscriber } from "./transcriber.js";

async function main() {
	initLogger();
	const boot = new Timer("boot", "Mini-Claw startup");

	// Load configuration
	const config = loadConfig();
	boot.lap("config");
	logger.info("boot", `Workspace: ${config.workspace}`);
	logger.info("boot", `Session dir: ${config.sessionDir}`);

	// Ensure directories exist
	await mkdir(config.workspace, { recursive: true });
	await mkdir(config.sessionDir, { recursive: true });

	// Check Pi installation (fatal if not available)
	const piOk = await checkPiAuth();
	boot.lap("pi-auth");
	if (!piOk) {
		logger.error("boot", "Pi is not installed or not authenticated. Run 'pi /login'.");
		process.exit(1);
	}
	logger.info("boot", "Pi: OK");

	// Start transcription server (non-blocking)
	startTranscriber().then((ok) => {
		if (ok) {
			logger.info("transcriber", "Ready (voice messages enabled)");
		} else {
			logger.warn("transcriber", "NOT AVAILABLE (voice messages disabled). pip install faster-whisper");
		}
	});

	// Create and start bot
	const bot = createBot(config);
	boot.lap("bot-created");

	// Start scheduler after preload completes (needs sessions ready)
	preloadSessions(config, config.workspace).then(() => {
		startScheduler(
			(chatId, prompt) => runPiForScheduler(config, chatId, prompt, config.workspace),
			async (chatId, text) => {
				try {
					await bot.api.sendMessage(chatId, text);
				} catch (err: any) {
					logger.error("scheduler", `Failed to send message to ${chatId}: ${err.message}`);
				}
			},
		);
	}).catch((err) => {
		logger.error("preload", `Failed: ${err.message}`);
	});

	// Graceful shutdown
	const shutdown = () => {
		logger.info("boot", "Shutting down...");
		stopScheduler();
		stopTranscriber();
		bot.stop();
		closeLogger();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	logger.info("boot", "Bot starting...");
	await bot.start({
		onStart: (botInfo) => {
			boot.lap("bot-started");
			boot.done(`@${botInfo.username} is running!`);
		},
	});
}

main().catch((err) => {
	logger.error("boot", `Fatal error: ${err.message}`);
	process.exit(1);
});
