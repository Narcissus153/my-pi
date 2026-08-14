import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const hostRoot = process.env.PI_HOST_ROOT;
assert.ok(hostRoot, "PI_HOST_ROOT is required");

const host = await import(pathToFileURL(path.join(hostRoot, "dist", "index.js")));
const { loadExtensions } = await import(
	pathToFileURL(path.join(hostRoot, "dist", "core", "extensions", "loader.js"))
);
const themeModule = await import(
	pathToFileURL(path.join(hostRoot, "dist", "modes", "interactive", "theme", "theme.js"))
);
themeModule.initTheme("dark", false);
const { visibleWidth } = await import(
	pathToFileURL(path.join(path.dirname(hostRoot), "pi-tui", "dist", "index.js"))
);

class TrackedSignal {
	aborted = false;
	adds = 0;
	removes = 0;
	listeners = new Set();

	addEventListener(type, listener) {
		if (type !== "abort") return;
		this.adds++;
		this.listeners.add(listener);
	}

	removeEventListener(type, listener) {
		if (type !== "abort") return;
		this.removes++;
		this.listeners.delete(listener);
	}

	abort() {
		if (this.aborted) return;
		this.aborted = true;
		for (const listener of [...this.listeners]) listener.call(this, { type: "abort" });
	}
}

class UiHarness {
	width = 80;
	rows = 24;
	modalCount = 0;
	script = (component) => component.handleInput("\x1b");
	onOpen;
	lastComponent;
	lastLines = [];

	async custom(factory) {
		this.modalCount++;
		let settled = false;
		let value;
		const done = (result) => {
			if (settled) return;
			settled = true;
			value = result;
		};
		const tui = {
			requestRender() {},
			terminal: { columns: this.width, rows: this.rows },
		};
		const component = await factory(tui, themeModule.theme, {}, done);
		component.focused = true;
		this.lastComponent = component;
		this.lastLines = component.render(this.width);
		this.onOpen?.();
		await this.script(component, this);
		this.lastLines = component.render(this.width);
		if (!settled) throw new Error("Ask test modal did not close");
		return value;
	}
}

async function createRuntime(mode, reason = "startup") {
	const loaded = await loadExtensions([path.join(root, "ask.ts")], root);
	assert.deepEqual(loaded.errors, []);
	const runner = new host.ExtensionRunner(
		loaded.extensions,
		loaded.runtime,
		root,
		host.SessionManager.inMemory(root),
		new host.ModelRegistry({}),
	);
	let activeTools = [];
	let refreshCount = 0;
	const registered = () => runner.getAllRegisteredTools();

	runner.bindCore(
		{
			sendMessage() {},
			sendUserMessage() {},
			appendEntry() {},
			setSessionName() {},
			getSessionName: () => undefined,
			setLabel() {},
			getActiveTools: () => activeTools,
			getAllTools: () => registered().map(({ definition }) => definition),
			setActiveTools: (names) => { activeTools = [...names]; },
			refreshTools: () => {
				refreshCount++;
				activeTools = registered().map(({ definition }) => definition.name);
			},
			getCommands: () => [],
			setModel: async () => false,
			getThinkingLevel: () => "off",
			setThinkingLevel() {},
		},
		{
			getModel: () => undefined,
			getScopedModels: () => [],
			isIdle: () => true,
			isProjectTrusted: () => true,
			getSignal: () => undefined,
			abort() {},
			hasPendingMessages: () => false,
			shutdown() {},
			getContextUsage: () => undefined,
			compact() {},
			getSystemPrompt: () => "",
			getSystemPromptOptions: () => ({ cwd: root }),
		},
	);

	const ui = new UiHarness();
	runner.setUIContext(mode === "tui" || mode === "rpc" ? ui : undefined, mode);
	await runner.emit({ type: "session_start", reason });
	const registration = registered().find(({ definition }) => definition.name === "ask");
	return {
		runner,
		ui,
		registered,
		refreshCount: () => refreshCount,
		definition: registration?.definition,
		tool: registration ? host.wrapRegisteredTool(registration, runner) : undefined,
	};
}

function typeText(component, text) {
	for (const character of text) component.handleInput(character);
}

function assertBounded(lines, width, rows) {
	assert.ok(lines.length <= Math.max(3, rows - 4), `rendered ${lines.length} rows at terminal height ${rows}`);
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= width, `line width ${visibleWidth(line)} exceeds ${width}`);
	}
}

const simpleQuestion = {
	question: "Choose one?",
	options: [{ label: "Alpha" }, { label: "Beta" }],
};

test("TUI-only registration, singular schema, description, and fresh runtimes", async (t) => {
	for (const mode of ["rpc", "json", "print"]) {
		await t.test(`${mode} has no Ask`, async () => {
			const runtime = await createRuntime(mode);
			assert.equal(runtime.definition, undefined);
			assert.equal(runtime.refreshCount(), 0);
			assert.equal(runtime.ui.modalCount, 0);
		});
	}

	for (const reason of ["startup", "reload", "new", "resume", "fork"]) {
		await t.test(`${reason} fresh runtime has one Ask`, async () => {
			const runtime = await createRuntime("tui", reason);
			assert.equal(runtime.registered().filter(({ definition }) => definition.name === "ask").length, 1);
			assert.equal(runtime.refreshCount(), 1);
		});
	}

	const runtime = await createRuntime("tui");
	await runtime.runner.emit({ type: "session_start", reason: "reload" });
	assert.equal(runtime.registered().filter(({ definition }) => definition.name === "ask").length, 1);
	assert.equal(runtime.definition.executionMode, "sequential");
	assert.equal(runtime.definition.renderCall, undefined);
	const schema = runtime.definition.parameters;
	assert.deepEqual(Object.keys(schema.properties).sort(), ["description", "multi", "options", "question", "recommended"]);
	assert.equal("questions" in schema.properties, false);
	assert.equal("id" in schema.properties, false);
	assert.equal(schema.properties.question.maxLength, 500);
	assert.equal(schema.properties.description.maxLength, 2000);
	assert.equal(schema.properties.options.minItems, 1);
	assert.equal(schema.properties.options.maxItems, 8);
	assert.equal(schema.properties.options.items.properties.label.maxLength, 160);
	for (const phrase of [
		"repository evidence",
		"recommendation and material trade-off",
		"task creation",
		"task.py start",
		"implementation approval",
		"commit",
		"push",
		"publish",
		"settings",
		"active-package",
		"destructive",
		"external-state authorization",
		"toolResult",
		"ordinary user message",
	]) assert.match(runtime.definition.description, new RegExp(phrase.replace(".", "\\."), "i"));
});

test("complete package manifest loads through Pi Jiti", async () => {
	const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
	const extensionPaths = manifest.pi.extensions.map((entry) => path.join(root, entry));
	const loaded = await loadExtensions(extensionPaths, root);
	assert.deepEqual(loaded.errors, []);
	assert.equal(loaded.extensions.length, manifest.pi.extensions.length);
});

test("normalization failures do not consume the prompt allowance", async () => {
	const runtime = await createRuntime("tui");
	await runtime.runner.emitBeforeAgentStart("prompt one", undefined, "", { cwd: root });
	for (const [name, params] of [
		["question max", { question: "Q".repeat(501), options: [{ label: "A" }] }],
		["description max", { question: "Q", description: "D".repeat(2001), options: [{ label: "A" }] }],
		["option min", { question: "Q", options: [] }],
		["option max", { question: "Q", options: Array.from({ length: 9 }, (_, index) => ({ label: String(index) })) }],
		["label max", { question: "Q", options: [{ label: "L".repeat(161) }] }],
	]) await assert.rejects(() => runtime.tool.execute("schema-invalid", params), undefined, name);
	for (const params of [
		{ question: "\x1b[31m", options: [{ label: "A" }] },
		{ question: "Q", options: [{ label: "  " }] },
		{ question: "Q", options: [{ label: " A " }, { label: "a" }] },
		{ question: "Q", options: [{ label: "other" }] },
	]) await assert.rejects(() => runtime.tool.execute("invalid", params), /empty|unique|reserved/i);
	assert.equal(runtime.ui.modalCount, 0);

	runtime.ui.script = (component) => component.handleInput("\x1b");
	const cancelled = await runtime.tool.execute("valid", {
		question: "  Which\npath?\x1b[31m  ",
		description: "# Context\n\x1b[32mSafe",
		options: [{ label: " Alpha\tchoice " }],
		recommended: 99,
	});
	assert.equal(cancelled.details.status, "cancelled");
	assert.equal(cancelled.details.question, "Which path?");
	assert.equal(cancelled.details.description, "# Context\nSafe");
	assert.equal(cancelled.details.options[0].label, "Alpha choice");
	assert.equal(cancelled.details.recommended, undefined);
	await assert.rejects(() => runtime.tool.execute("second", simpleQuestion), /one valid question/i);
	assert.equal(runtime.ui.modalCount, 1);

	await runtime.runner.emitBeforeAgentStart("prompt two", undefined, "", { cwd: root });
	runtime.ui.script = (component) => component.handleInput("\r");
	const answered = await runtime.tool.execute("next", simpleQuestion);
	assert.equal(answered.details.status, "answered");
	assert.equal(runtime.ui.modalCount, 2);
});

test("single select keeps recommendation explicit and supports notes and Other", async () => {
	const runtime = await createRuntime("tui");
	await runtime.runner.emitBeforeAgentStart("recommended", undefined, "", { cwd: root });
	runtime.ui.script = (component) => {
		const rendered = component.render(80).join("\n");
		assert.match(rendered, /Beta.*recommended/i);
		component.handleInput("\r");
	};
	const recommended = await runtime.tool.execute("recommended", { ...simpleQuestion, recommended: 1 });
	assert.deepEqual(recommended.details.selectedOptions, [{ index: 1, label: "Beta" }]);

	await runtime.runner.emitBeforeAgentStart("cancel recommendation", undefined, "", { cwd: root });
	runtime.ui.script = (component) => component.handleInput("\x1b");
	const cancelled = await runtime.tool.execute("cancel", { ...simpleQuestion, recommended: 1 });
	assert.equal(cancelled.details.status, "cancelled");
	assert.deepEqual(cancelled.details.selectedOptions, []);

	await runtime.runner.emitBeforeAgentStart("note", undefined, "", { cwd: root });
	runtime.ui.script = (component) => {
		component.handleInput("because \x1b[31mred");
		component.handleInput("\r");
	};
	const noted = await runtime.tool.execute("note", simpleQuestion);
	assert.deepEqual(noted.details.selectedOptions, [{ index: 0, label: "Alpha", note: "because red" }]);
	assert.match(noted.content[0].text, /because red/);
	assert.doesNotMatch(noted.content[0].text, /\x1b/);

	await runtime.runner.emitBeforeAgentStart("other", undefined, "", { cwd: root });
	runtime.ui.script = (component) => {
		component.handleInput("\x1b[B");
		component.handleInput("\x1b[B");
		component.handleInput("\r");
		typeText(component, "x".repeat(510));
		component.handleInput("\r");
	};
	const other = await runtime.tool.execute("other", simpleQuestion);
	assert.equal(other.details.status, "answered");
	assert.deepEqual(other.details.selectedOptions, []);
	assert.equal(other.details.customInput.length, 500);
	assert.equal(other.details.customInput, "x".repeat(500));
});

test("multi select requires explicit submit and preserves notes plus Other", async () => {
	const runtime = await createRuntime("tui");
	await runtime.runner.emitBeforeAgentStart("multi", undefined, "", { cwd: root });
	runtime.ui.script = (component) => {
		component.handleInput(" ");
		component.handleInput("\x1b[B");
		typeText(component, "works together");
		component.handleInput("\r");
		component.handleInput("\x1b[B");
		component.handleInput("\r");
		typeText(component, "Custom add-on");
		component.handleInput("\r");
		component.handleInput("\r");
	};
	const answered = await runtime.tool.execute("multi", { ...simpleQuestion, multi: true });
	assert.deepEqual(answered.details.selectedOptions, [
		{ index: 0, label: "Alpha" },
		{ index: 1, label: "Beta", note: "works together" },
	]);
	assert.equal(answered.details.customInput, "Custom add-on");
	assert.match(answered.content[0].text, /Alpha/);
	assert.match(answered.content[0].text, /works together/);
	assert.match(answered.content[0].text, /Custom add-on/);

	await runtime.runner.emitBeforeAgentStart("empty multi", undefined, "", { cwd: root });
	runtime.ui.width = 20;
	runtime.ui.rows = 8;
	runtime.ui.script = (component) => {
		component.handleInput("\r");
		assert.match(component.render(20).join("\n"), /Select an option/i);
		assertBounded(component.render(20), 20, 8);
		component.handleInput("\x03");
	};
	const empty = await runtime.tool.execute("empty", { ...simpleQuestion, multi: true });
	assert.equal(empty.details.status, "cancelled");

	await runtime.runner.emitBeforeAgentStart("empty other", undefined, "", { cwd: root });
	runtime.ui.script = (component) => {
		component.handleInput("\x1b[B");
		component.handleInput("\x1b[B");
		component.handleInput("\r");
		component.handleInput("\r");
		assert.match(component.render(20).join("\n"), /Enter Other text/i);
		typeText(component, "x");
		assert.doesNotMatch(component.render(20).join("\n"), /Enter Other text/i);
		component.handleInput("\x1b");
		component.handleInput("\x1b");
	};
	const emptyOther = await runtime.tool.execute("empty-other", { ...simpleQuestion, multi: true });
	assert.equal(emptyOther.details.status, "cancelled");
});

test("Escape, Ctrl-C, and agent abort cancel and clean listeners", async () => {
	const runtime = await createRuntime("tui");
	for (const [name, key] of [["escape", "\x1b"], ["ctrl-c", "\x03"]]) {
		await runtime.runner.emitBeforeAgentStart(name, undefined, "", { cwd: root });
		runtime.ui.script = (component) => component.handleInput(key);
		const signal = new TrackedSignal();
		const result = await runtime.tool.execute(name, simpleQuestion, signal);
		assert.equal(result.details.status, "cancelled");
		assert.equal(signal.listeners.size, 0);
		assert.equal(signal.adds, signal.removes);
	}

	await runtime.runner.emitBeforeAgentStart("abort", undefined, "", { cwd: root });
	const signal = new TrackedSignal();
	runtime.ui.onOpen = () => signal.abort();
	runtime.ui.script = () => {};
	const aborted = await runtime.tool.execute("abort", simpleQuestion, signal);
	assert.equal(aborted.details.status, "cancelled");
	assert.equal(signal.listeners.size, 0);
	assert.equal(signal.adds, 1);
	assert.equal(signal.removes, 1);
});

test("component stays bounded and focused at narrow widths and small heights", async () => {
	const runtime = await createRuntime("tui");
	const params = {
		question: "Choose compatible options for a narrow terminal with CJK and emoji \u{1F680}\u{2728} content?",
		description: "# Context\n\n- Long material trade-off with `code` and wide text.\n- CJK: \u8fd9\u662f\u4e00\u6bb5\u5f88\u957f\u7684\u4e0a\u4e0b\u6587\n- Emoji: \u{1F680} \u{2728}\n\n```ts\nconst longValue = 'bounded markdown';\n```",
		options: Array.from({ length: 8 }, (_, index) => ({
			label: `Option ${index + 1} with a deliberately long label \u4e2d\u6587 \u{1F680} ${index}`,
		})),
		multi: true,
		recommended: 7,
	};

	for (const width of [20, 40, 80]) {
		for (const rows of [8, 18]) {
			await runtime.runner.emitBeforeAgentStart(`${width}x${rows}`, undefined, "", { cwd: root });
			runtime.ui.width = width;
			runtime.ui.rows = rows;
			runtime.ui.script = (component) => {
				let lines = component.render(width);
				assertBounded(lines, width, rows);
				assert.match(lines.join("\n"), />/);
				component.handleInput("\x1b[B");
				component.handleInput("\r");
				typeText(component, "\u5176\u4ed6 choice");
				lines = component.render(width);
				assertBounded(lines, width, rows);
				component.handleInput("\x1b[6~");
				assertBounded(component.render(width), width, rows);
				component.handleInput("\x03");
			};
			const result = await runtime.tool.execute(`${width}x${rows}`, params);
			assert.equal(result.details.status, "cancelled");
		}
	}
});

test("renderResult consumes the normalized details returned to the model", async () => {
	const runtime = await createRuntime("tui");
	await runtime.runner.emitBeforeAgentStart("render", undefined, "", { cwd: root });
	runtime.ui.script = (component) => component.handleInput("\r");
	const result = await runtime.tool.execute("render", simpleQuestion);
	const rendered = runtime.definition.renderResult(
		result,
		{ expanded: false, isPartial: false },
		themeModule.theme,
		{},
	).render(80).join("\n");
	assert.match(rendered, /Alpha/);
	assert.match(result.content[0].text, /Alpha/);
});
