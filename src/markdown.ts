/**
 * Convert markdown to Telegram-compatible HTML
 * Supports: bold, italic, code, code blocks, links
 */

// Escape HTML special characters
function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

// Convert markdown to Telegram HTML
// Uses \x00 (null byte) delimiters for placeholders so they never collide
// with markdown patterns like __bold__ or *italic*.
export function markdownToHtml(text: string): string {
	// First, extract and preserve code blocks to prevent processing inside them
	const codeBlocks: string[] = [];
	let processed = text.replace(
		/```(\w*)\n?([\s\S]*?)```/g,
		(_, _lang, code) => {
			const index = codeBlocks.length;
			// Escape HTML inside code blocks
			codeBlocks.push(`<pre>${escapeHtml(code.trim())}</pre>`);
			return `\x00CB${index}\x00`;
		},
	);

	// Extract inline code
	const inlineCodes: string[] = [];
	processed = processed.replace(/`([^`]+)`/g, (_, code) => {
		const index = inlineCodes.length;
		inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
		return `\x00IC${index}\x00`;
	});

	// Escape HTML in remaining text
	processed = escapeHtml(processed);

	// Convert markdown formatting
	// Bold: **text** or __text__
	processed = processed.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
	processed = processed.replace(/__([^_]+)__/g, "<b>$1</b>");

	// Italic: *text* or _text_ (but not inside words)
	processed = processed.replace(
		/(?<![a-zA-Z])\*([^*]+)\*(?![a-zA-Z])/g,
		"<i>$1</i>",
	);
	processed = processed.replace(
		/(?<![a-zA-Z])_([^_]+)_(?![a-zA-Z])/g,
		"<i>$1</i>",
	);

	// Strikethrough: ~~text~~
	processed = processed.replace(/~~([^~]+)~~/g, "<s>$1</s>");

	// Links: [text](url)
	processed = processed.replace(
		/\[([^\]]+)\]\(([^)]+)\)/g,
		'<a href="$2">$1</a>',
	);

	// Restore code blocks
	for (let i = 0; i < codeBlocks.length; i++) {
		processed = processed.replace(`\x00CB${i}\x00`, codeBlocks[i]);
	}

	// Restore inline code
	for (let i = 0; i < inlineCodes.length; i++) {
		processed = processed.replace(`\x00IC${i}\x00`, inlineCodes[i]);
	}

	return processed;
}

// Strip all markdown formatting to plain text
export function stripMarkdown(text: string): string {
	return (
		text
			// Remove code blocks
			.replace(/```[\s\S]*?```/g, (match) => {
				const code = match.replace(/```\w*\n?/, "").replace(/```$/, "");
				return code.trim();
			})
			// Remove inline code backticks
			.replace(/`([^`]+)`/g, "$1")
			// Remove bold
			.replace(/\*\*([^*]+)\*\*/g, "$1")
			.replace(/__([^_]+)__/g, "$1")
			// Remove italic
			.replace(/\*([^*]+)\*/g, "$1")
			.replace(/_([^_]+)_/g, "$1")
			// Remove strikethrough
			.replace(/~~([^~]+)~~/g, "$1")
			// Convert links to just text
			.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
	);
}
