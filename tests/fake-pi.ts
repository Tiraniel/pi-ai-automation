// Fake Pi ExtensionAPI for behavioral smokes.
//
// register*Tools(pi) modules have a one-way interface: they push declarations
// into the ExtensionAPI and return nothing. This fake makes that interface
// testable — smokes capture the registered declarations, assert tool schemas
// as data, and drive `execute` handlers directly against a temp cwd instead
// of reading extension source files as text (source-greps break on pure
// refactors even when behavior is unchanged).

export interface FakeRegisteredTool {
	name: string;
	label?: string;
	description?: string;
	parameters?: any;
	execute: (
		toolCallId: string,
		params: unknown,
		signal?: unknown,
		onUpdate?: unknown,
		ctx?: any,
	) => Promise<any> | any;
	[key: string]: unknown;
}

export interface FakePi {
	/** Pass this to register*Tools / applyBrainPreset as the ExtensionAPI. */
	pi: any;
	tools: Map<string, FakeRegisteredTool>;
	commands: Map<string, any>;
	hooks: Map<string, Array<(...args: any[]) => any>>;
	setModelCalls: any[];
	thinkingLevels: string[];
}

export function createFakePi(overrides: Record<string, unknown> = {}): FakePi {
	const tools = new Map<string, FakeRegisteredTool>();
	const commands = new Map<string, any>();
	const hooks = new Map<string, Array<(...args: any[]) => any>>();
	const setModelCalls: any[] = [];
	const thinkingLevels: string[] = [];
	const pi: any = {
		registerTool: (decl: FakeRegisteredTool) => {
			tools.set(decl.name, decl);
		},
		registerCommand: (nameOrDecl: any, maybeDecl?: any) => {
			const name = typeof nameOrDecl === "string" ? nameOrDecl : nameOrDecl?.name;
			commands.set(String(name), maybeDecl ?? nameOrDecl);
		},
		on: (event: string, handler: (...args: any[]) => any) => {
			const list = hooks.get(event) ?? [];
			list.push(handler);
			hooks.set(event, list);
		},
		getFlag: () => undefined,
		setModel: async (model: any) => {
			setModelCalls.push(model);
			return true;
		},
		setThinkingLevel: (level: string) => {
			thinkingLevels.push(level);
		},
		...overrides,
	};
	return { pi, tools, commands, hooks, setModelCalls, thinkingLevels };
}

/** Minimal ExtensionContext stand-in for driving execute handlers / hooks. */
export function createFakeContext(cwd: string, extra: Record<string, unknown> = {}): any {
	return {
		cwd,
		sessionManager: undefined,
		ui: {
			notify: () => {},
			setStatus: () => {},
			theme: { fg: (_color: string, text: string) => text },
		},
		modelRegistry: {
			find: (provider: string, model: string) => ({ provider, model }),
			getAvailable: () => [],
		},
		...extra,
	};
}
