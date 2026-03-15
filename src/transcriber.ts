/**
 * Transcriber client — communicates with the Python faster-whisper HTTP server.
 *
 * The server runs on localhost:3900 and accepts:
 *   POST /transcribe  — raw audio body → JSON { text, language, duration_audio, duration_processing }
 *   GET  /health      — status check
 */

import { spawn, type ChildProcess } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TRANSCRIBER_PORT = parseInt(
	process.env.TRANSCRIBER_PORT || "3900",
	10,
);
const TRANSCRIBER_URL = `http://127.0.0.1:${TRANSCRIBER_PORT}`;

// Resolve path to transcriber/server.py relative to project root
const __filename_resolved = fileURLToPath(import.meta.url);
const PROJECT_ROOT = join(dirname(__filename_resolved), "..");
const SERVER_SCRIPT = join(PROJECT_ROOT, "transcriber", "server.py");

let serverProcess: ChildProcess | null = null;

export interface TranscriptionResult {
	text: string;
	language: string;
	languageProbability: number;
	durationAudio: number;
	durationProcessing: number;
}

/**
 * Check if the transcription server is running.
 */
export async function isTranscriberReady(): Promise<boolean> {
	try {
		const res = await fetch(`${TRANSCRIBER_URL}/health`, {
			signal: AbortSignal.timeout(2000),
		});
		return res.ok;
	} catch {
		return false;
	}
}

/**
 * Start the Python transcription server as a child process.
 * No-op if already running.
 */
export async function startTranscriber(): Promise<boolean> {
	if (await isTranscriberReady()) {
		console.log("[transcriber] Already running");
		return true;
	}

	console.log("[transcriber] Starting Python server...");

	// Try python from the better-transcription venv first, then system python
	const pythonCandidates = [
		"python",
		"python3",
	];

	for (const python of pythonCandidates) {
		try {
			serverProcess = spawn(python, [SERVER_SCRIPT], {
				env: {
					...process.env,
					TRANSCRIBER_PORT: String(TRANSCRIBER_PORT),
				},
				stdio: ["ignore", "pipe", "pipe"],
				detached: false,
			});

			// Forward server output to console
			serverProcess.stdout?.on("data", (data) => {
				process.stdout.write(`[transcriber] ${data}`);
			});
			serverProcess.stderr?.on("data", (data) => {
				process.stderr.write(`[transcriber] ${data}`);
			});

			serverProcess.on("exit", (code) => {
				console.log(`[transcriber] Process exited with code ${code}`);
				serverProcess = null;
			});

			// Wait for server to be ready (model loading can take ~10-15s)
			for (let i = 0; i < 60; i++) {
				await new Promise((r) => setTimeout(r, 1000));
				if (await isTranscriberReady()) {
					console.log("[transcriber] Server ready");
					return true;
				}
				// Check if process died
				if (serverProcess === null) {
					break;
				}
			}
		} catch {
			// Try next python candidate
			continue;
		}
	}

	console.error("[transcriber] Failed to start server");
	return false;
}

/**
 * Stop the transcription server.
 */
export function stopTranscriber(): void {
	if (serverProcess) {
		console.log("[transcriber] Stopping server...");
		serverProcess.kill("SIGTERM");
		serverProcess = null;
	}
}

/**
 * Transcribe audio data by sending it to the Python server.
 *
 * @param audioBuffer - Raw audio bytes (ogg, mp3, wav, etc.)
 * @param contentType - MIME type (default: audio/ogg)
 * @param language - Language code override (default: server's configured language)
 */
export async function transcribe(
	audioBuffer: Buffer,
	contentType = "audio/ogg",
	language?: string,
): Promise<TranscriptionResult> {
	const headers: Record<string, string> = {
		"Content-Type": contentType,
		"Content-Length": String(audioBuffer.length),
	};

	if (language) {
		headers["X-Language"] = language;
	}

	const res = await fetch(`${TRANSCRIBER_URL}/transcribe`, {
		method: "POST",
		headers,
		body: audioBuffer,
		signal: AbortSignal.timeout(120_000), // 2 min timeout for large files
	});

	if (!res.ok) {
		const errorBody = await res.text();
		throw new Error(`Transcription failed (${res.status}): ${errorBody}`);
	}

	const data = (await res.json()) as {
		text: string;
		language: string;
		language_probability: number;
		duration_audio: number;
		duration_processing: number;
	};

	return {
		text: data.text,
		language: data.language,
		languageProbability: data.language_probability,
		durationAudio: data.duration_audio,
		durationProcessing: data.duration_processing,
	};
}

/**
 * Download a file from Telegram's API, given a file_id.
 * Returns the raw Buffer.
 */
export async function downloadTelegramFile(
	token: string,
	fileId: string,
): Promise<Buffer> {
	// Step 1: Get file path from Telegram
	const fileInfoRes = await fetch(
		`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`,
	);
	const fileInfo = (await fileInfoRes.json()) as {
		ok: boolean;
		result?: { file_path: string };
	};

	if (!fileInfo.ok || !fileInfo.result?.file_path) {
		throw new Error("Failed to get file info from Telegram");
	}

	// Step 2: Download the file
	const downloadUrl = `https://api.telegram.org/file/bot${token}/${fileInfo.result.file_path}`;
	const fileRes = await fetch(downloadUrl);

	if (!fileRes.ok) {
		throw new Error(`Failed to download file: ${fileRes.status}`);
	}

	return Buffer.from(await fileRes.arrayBuffer());
}
