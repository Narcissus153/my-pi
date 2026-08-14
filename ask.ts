import {
	getMarkdownTheme,
	type ExtensionAPI,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	type Focusable,
	Key,
	Markdown,
	matchesKey,
	stripTerminalSequences,
	Text,
	truncateToWidth,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

const OTHER_LABEL = "Other";
const MAX_NOTE_LENGTH = 500;

const AskParams = Type.Object(
	{
		question: Type.String({ minLength: 1, maxLength: 500 }),
		description: Type.Optional(Type.String({ maxLength: 2000 })),
		options: Type.Array(
			Type.Object(
				{ label: Type.String({ minLength: 1, maxLength: 160 }) },
				{ additionalProperties: false },
			),
			{ minItems: 1, maxItems: 8 },
		),
		multi: Type.Optional(Type.Boolean()),
		recommended: Type.Optional(Type.Integer()),
	},
	{ additionalProperties: false },
);

interface AskInput {
	question: string;
	description?: string;
	options: Array<{ label: string }>;
	multi?: boolean;
	recommended?: number;
}

interface NormalizedQuestion {
	question: string;
	description?: string;
	options: Array<{ label: string }>;
	multi: boolean;
	recommended?: number;
}

interface SelectedOption {
	index: number;
	label: string;
	note?: string;
}

interface AskDetails extends NormalizedQuestion {
	status: "answered" | "cancelled";
	selectedOptions: SelectedOption[];
	customInput?: string;
}

interface AnswerDraft {
	selectedIndexes: number[];
	notes: Map<number, string>;
	customInput?: string;
}

const description = [
	"Ask one bounded user-owned product, scope, UX, compatibility, or risk decision only after repository evidence is exhausted.",
	"Present concise compatible options with a recommendation and material trade-off; use multi only when choices can coexist.",
	"Treat cancellation as no decision and persist load-bearing decisions in the owning workflow artifact.",
	"Never use Ask for task creation, task.py start, implementation approval, commit, push, publish, settings, active-package, destructive actions, or other external-state authorization.",
	"An Ask answer is a toolResult, not the subsequent ordinary user message required for those gates.",
].join(" ");

function limitCharacters(value: string, maximum: number): string {
	return [...value].slice(0, maximum).join("");
}

function characterCount(value: string): number {
	return [...value].length;
}

function stripControls(value: string): string {
	return stripTerminalSequences(value)
		.replace(/\r\n?/g, "\n")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

function normalizeLine(value: string, maximum: number): string {
	return limitCharacters(stripControls(value).replace(/\s+/gu, " ").trim(), maximum);
}

function normalizeMarkdown(value: string, maximum: number): string {
	return limitCharacters(stripControls(value).replace(/\t/g, "    ").trim(), maximum);
}

function normalizeEditable(value: string): string {
	return limitCharacters(stripControls(value).replace(/\n/g, " "), MAX_NOTE_LENGTH);
}

function normalizeQuestion(input: AskInput): NormalizedQuestion {
	if (characterCount(input.question) > 500) throw new Error("Ask question must be at most 500 characters");
	if (input.description !== undefined && characterCount(input.description) > 2000) {
		throw new Error("Ask description must be at most 2000 characters");
	}
	if (input.options.length < 1 || input.options.length > 8) {
		throw new Error("Ask requires between 1 and 8 options");
	}
	const question = normalizeLine(input.question, 500);
	if (!question) throw new Error("Ask question must not be empty after normalization");

	const options = input.options.map(({ label }, index) => {
		if (characterCount(label) > 160) throw new Error(`Ask option ${index + 1} must be at most 160 characters`);
		const normalized = normalizeLine(label, 160);
		if (!normalized) throw new Error(`Ask option ${index + 1} must not be empty after normalization`);
		return { label: normalized };
	});
	const seen = new Set<string>();
	for (const { label } of options) {
		const key = label.toLowerCase();
		if (key === OTHER_LABEL.toLowerCase()) {
			throw new Error(`Ask option label "${OTHER_LABEL}" is reserved`);
		}
		if (seen.has(key)) throw new Error(`Ask option labels must be unique after normalization: "${label}"`);
		seen.add(key);
	}

	const normalized: NormalizedQuestion = {
		question,
		options,
		multi: input.multi === true,
	};
	const markdown = input.description === undefined ? "" : normalizeMarkdown(input.description, 2000);
	if (markdown) normalized.description = markdown;
	if (
		Number.isInteger(input.recommended)
		&& input.recommended! >= 0
		&& input.recommended! < options.length
	) {
		normalized.recommended = input.recommended;
	}
	return normalized;
}

function buildResult(question: NormalizedQuestion, draft: AnswerDraft | null) {
	if (draft === null) {
		const details: AskDetails = {
			...question,
			status: "cancelled",
			selectedOptions: [],
		};
		return {
			content: [{ type: "text" as const, text: "User cancelled Ask; no decision was made." }],
			details,
		};
	}

	const selectedOptions = [...new Set(draft.selectedIndexes)]
		.filter((index) => Number.isInteger(index) && index >= 0 && index < question.options.length)
		.sort((left, right) => left - right)
		.map((index) => {
			const selected: SelectedOption = { index, label: question.options[index].label };
			const note = normalizeLine(draft.notes.get(index) ?? "", MAX_NOTE_LENGTH);
			if (note) selected.note = note;
			return selected;
		});
	const customInput = normalizeLine(draft.customInput ?? "", MAX_NOTE_LENGTH);
	if (!question.multi && selectedOptions.length + (customInput ? 1 : 0) > 1) {
		throw new Error("Single-select Ask can return only one answer");
	}
	if (selectedOptions.length === 0 && !customInput) {
		throw new Error("Answered Ask requires a selected option or Other input");
	}

	const details: AskDetails = {
		...question,
		status: "answered",
		selectedOptions,
	};
	if (customInput) details.customInput = customInput;

	const lines = selectedOptions.map(({ index, label, note }) =>
		`- ${index + 1}. ${label}${note ? ` (note: ${note})` : ""}`
	);
	if (customInput) lines.push(`- ${OTHER_LABEL}: ${customInput}`);
	return {
		content: [{ type: "text" as const, text: `User answered Ask:\n${lines.join("\n")}` }],
		details,
	};
}

function createAskComponent(
	question: NormalizedQuestion,
	tui: TUI,
	theme: Theme,
	done: (draft: AnswerDraft | null) => void,
) {
	let cursor = question.recommended ?? 0;
	let mode: "list" | "note" | "other" = "list";
	let editingIndex: number | undefined;
	let customInput: string | undefined;
	let message = "";
	let cachedWidth: number | undefined;
	let cachedRows: number | undefined;
	let cachedLines: string[] | undefined;
	let manualViewportStart: number | undefined;
	let lastViewportStart = 0;
	let lastViewportRows = 1;
	let lastTotalRows = 1;
	let focused = false;
	let sanitizingEditor = false;
	const selected = new Set<number>();
	const notes = new Map<number, string>();

	const editorTheme: EditorTheme = {
		borderColor: (text) => theme.fg("accent", text),
		selectList: {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		},
	};
	const editor = new Editor(tui, editorTheme, { paddingX: 0, autocompleteMaxVisible: 0 });
	const markdown = question.description
		? new Markdown(question.description, 0, 0, getMarkdownTheme())
		: undefined;

	function invalidate(resetViewport = false) {
		cachedWidth = undefined;
		cachedRows = undefined;
		cachedLines = undefined;
		if (resetViewport) manualViewportStart = undefined;
		tui.requestRender();
	}

	function syncFocus() {
		editor.focused = focused && mode !== "list";
	}

	function setEditorText(value: string) {
		sanitizingEditor = true;
		editor.setText(normalizeEditable(value));
		sanitizingEditor = false;
	}

	function beginEdit(nextMode: "note" | "other", initial: string, index?: number) {
		mode = nextMode;
		editingIndex = index;
		message = "";
		setEditorText(initial);
		syncFocus();
		invalidate(true);
	}

	function returnToList() {
		mode = "list";
		editingIndex = undefined;
		setEditorText("");
		syncFocus();
		invalidate(true);
	}

	function answer(selectedIndexes: number[]) {
		done({ selectedIndexes, notes: new Map(notes), customInput });
	}

	editor.onChange = (value) => {
		if (sanitizingEditor) return;
		message = "";
		const safe = normalizeEditable(value);
		if (safe !== value) setEditorText(safe);
		invalidate();
	};
	editor.onSubmit = (value) => {
		const normalized = normalizeLine(value, MAX_NOTE_LENGTH);
		if (mode === "note" && editingIndex !== undefined) {
			if (normalized) notes.set(editingIndex, normalized);
			else notes.delete(editingIndex);
			if (!question.multi) {
				answer([editingIndex]);
				return;
			}
			if (normalized) selected.add(editingIndex);
			returnToList();
			return;
		}
		if (mode === "other") {
			if (!normalized) {
				message = "Enter Other text";
				invalidate();
				return;
			}
			customInput = normalized;
			if (!question.multi) {
				answer([]);
				return;
			}
			cursor = Math.max(0, question.options.length - 1);
			returnToList();
		}
	};

	function handleListInput(data: string) {
		const optionCount = question.options.length + 1;
		if (matchesKey(data, Key.up)) {
			cursor = Math.max(0, cursor - 1);
			message = "";
			invalidate(true);
			return;
		}
		if (matchesKey(data, Key.down)) {
			cursor = Math.min(optionCount - 1, cursor + 1);
			message = "";
			invalidate(true);
			return;
		}
		if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
			const direction = matchesKey(data, Key.pageUp) ? -1 : 1;
			const current = manualViewportStart ?? lastViewportStart;
			manualViewportStart = Math.max(
				0,
				Math.min(lastTotalRows - lastViewportRows, current + direction * Math.max(1, lastViewportRows - 1)),
			);
			invalidate();
			return;
		}
		if (matchesKey(data, Key.tab) && cursor < question.options.length) {
			beginEdit("note", notes.get(cursor) ?? "", cursor);
			return;
		}
		if (question.multi && matchesKey(data, Key.space)) {
			if (cursor === question.options.length) {
				if (customInput) {
					customInput = undefined;
					invalidate(true);
				} else {
					beginEdit("other", "");
				}
				return;
			}
			if (selected.has(cursor)) selected.delete(cursor);
			else selected.add(cursor);
			message = "";
			invalidate(true);
			return;
		}
		if (matchesKey(data, Key.enter)) {
			if (cursor === question.options.length) {
				beginEdit("other", customInput ?? "");
				return;
			}
			if (!question.multi) {
				answer([cursor]);
				return;
			}
			if (selected.size > 0 || customInput) answer([...selected]);
			else {
				message = "Select an option";
				invalidate();
			}
			return;
		}
	}

	function handleInput(data: string) {
		if (matchesKey(data, Key.ctrl("c"))) {
			done(null);
			return;
		}
		if (mode !== "list") {
			if (matchesKey(data, Key.escape)) {
				if (mode === "note" && editingIndex !== undefined) {
					const note = normalizeLine(editor.getExpandedText(), MAX_NOTE_LENGTH);
					if (note) {
						notes.set(editingIndex, note);
						if (question.multi) selected.add(editingIndex);
					} else notes.delete(editingIndex);
				}
				returnToList();
				return;
			}
			editor.handleInput(data);
			invalidate();
			return;
		}
		if (matchesKey(data, Key.escape)) {
			done(null);
			return;
		}
		handleListInput(data);
	}

	function render(width: number): string[] {
		const rows = Math.max(3, tui.terminal.rows - 4);
		if (cachedLines && cachedWidth === width && cachedRows === rows) return cachedLines;
		const renderWidth = Math.max(1, width);
		const lines: string[] = [];
		let focusLine = 0;

		function addWrappedWithPrefix(prefix: string, text: string) {
			const prefixWidth = visibleWidth(prefix);
			if (prefixWidth >= renderWidth) {
				lines.push(truncateToWidth(`${prefix}${text}`, renderWidth, ""));
				return;
			}
			const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
			for (let index = 0; index < Math.max(1, wrapped.length); index++) {
				lines.push(`${index === 0 ? prefix : " ".repeat(prefixWidth)}${wrapped[index] ?? ""}`);
			}
		}

		addWrappedWithPrefix("", theme.fg("text", theme.bold(question.question)));
		if (markdown) {
			lines.push("");
			lines.push(...markdown.render(renderWidth));
		}
		lines.push("");

		for (let index = 0; index <= question.options.length; index++) {
			const isOther = index === question.options.length;
			const active = cursor === index;
			if (active) focusLine = lines.length;
			const checked = isOther ? Boolean(customInput) : selected.has(index);
			const marker = question.multi ? `[${checked ? "x" : " "}] ` : "";
			const prefix = active ? theme.fg("accent", "> ") : "  ";
			const recommended = !isOther && question.recommended === index ? " (recommended)" : "";
			const noteMarker = !isOther && notes.has(index) ? " [note]" : "";
			const label = isOther ? OTHER_LABEL : question.options[index].label;
			const color = active ? "accent" : "text";
			addWrappedWithPrefix(prefix, theme.fg(color, `${marker}${label}${recommended}${noteMarker}`));
			const detail = isOther ? customInput : notes.get(index);
			if (detail) addWrappedWithPrefix("    ", theme.fg("muted", detail));
		}

		if (mode !== "list") {
			lines.push("");
			focusLine = lines.length;
			const title = mode === "other" ? OTHER_LABEL : `Note for ${question.options[editingIndex!].label}`;
			addWrappedWithPrefix("", theme.fg("muted", title));
			for (const line of editor.render(Math.max(1, renderWidth - 2))) {
				lines.push(truncateToWidth(`  ${line}`, renderWidth, ""));
			}
		}
		lastTotalRows = lines.length;
		const bodyRows = Math.max(1, rows - 1 - (message ? 1 : 0));
		lastViewportRows = Math.min(bodyRows, lines.length);
		let start = manualViewportStart;
		if (start === undefined) {
			start = Math.max(0, focusLine - Math.floor(lastViewportRows / 2));
		}
		start = Math.max(0, Math.min(lines.length - lastViewportRows, start));
		const end = Math.min(lines.length, start + lastViewportRows);
		const viewport = lines.slice(start, end).map((line) => truncateToWidth(line, renderWidth, ""));
		if (start > 0) viewport[0] = theme.fg("dim", truncateToWidth("... above ...", renderWidth, ""));
		if (end < lines.length) viewport[viewport.length - 1] = theme.fg("dim", truncateToWidth("... below ...", renderWidth, ""));
		lastViewportStart = start;
		const rendered = [
			theme.fg("muted", "─".repeat(renderWidth)),
			...(message ? [theme.fg("warning", truncateToWidth(`! ${message}`, renderWidth, ""))] : []),
			...viewport,
		];
		cachedWidth = width;
		cachedRows = rows;
		cachedLines = rendered;
		return rendered;
	}

	const component: Focusable & {
		render(width: number): string[];
		handleInput(data: string): void;
		invalidate(): void;
	} = {
		get focused() {
			return focused;
		},
		set focused(value: boolean) {
			focused = value;
			syncFocus();
		},
		render,
		handleInput,
		invalidate() {
			cachedWidth = undefined;
			cachedRows = undefined;
			cachedLines = undefined;
			markdown?.invalidate();
			editor.invalidate();
		},
	};
	return component;
}

export default function ask(pi: ExtensionAPI) {
	let usedThisPrompt = false;
	let registered = false;

	pi.on("before_agent_start", () => {
		usedThisPrompt = false;
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui" || registered) return;
		registered = true;

		pi.registerTool({
			name: "ask",
			label: "Ask",
			description,
			parameters: AskParams,
			executionMode: "sequential",

			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				const question = normalizeQuestion(params);
				if (usedThisPrompt) throw new Error("Ask is limited to one valid question per ordinary user prompt");
				usedThisPrompt = true;

				let close: ((draft: AnswerDraft | null) => void) | undefined;
				const abort = () => close?.(null);
				signal?.addEventListener("abort", abort, { once: true });
				try {
					if (signal?.aborted) return buildResult(question, null);
					const draft = await ctx.ui.custom<AnswerDraft | null>((tui, theme, _keybindings, done) => {
						let finished = false;
						close = (result) => {
							if (finished) return;
							finished = true;
							done(result);
						};
						if (signal?.aborted) close(null);
						return createAskComponent(question, tui, theme, (result) => close?.(result));
					});
					return buildResult(question, draft);
				} finally {
					signal?.removeEventListener("abort", abort);
					close = undefined;
				}
			},

			renderResult(result, _options, theme) {
				const details = result.details as AskDetails | undefined;
				if (!details) {
					const content = result.content[0];
					return new Text(content?.type === "text" ? content.text : "", 0, 0);
				}
				if (details.status === "cancelled") {
					return new Text(theme.fg("warning", "Cancelled - no decision"), 0, 0);
				}
				const lines = details.selectedOptions.map(({ label, note }) =>
					`${theme.fg("success", "[x]")} ${label}${note ? theme.fg("muted", ` - ${note}`) : ""}`
				);
				if (details.customInput) {
					lines.push(`${theme.fg("success", "[x]")} ${OTHER_LABEL}: ${details.customInput}`);
				}
				return new Text(lines.join("\n"), 0, 0);
			},
		});
	});
}
