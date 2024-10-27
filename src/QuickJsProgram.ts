import {
	QuickJSAsyncContext,
	QuickJSContext,
	type QuickJSHandle,
	type QuickJSWASMModule,
	Scope,
	UsingDisposable
} from "quickjs-emscripten"
import url from 'node:url';
import { QuickJSImmediateManager, QuickJSIntervalManager, QuickJSTimeoutManager } from "./scope/TimeManagers.js"
import { ShortLifeContextWrapper, init } from "./utils/wrapper.js"
import { ConsoleHandler, ConsoleManager } from "./scope/ConsoleManager.js";
import { InterruptManager } from "./InterruptManager.js";
import { QuickJsProgramModule } from "./QuickJsProgramModule.js";
import { VmCallResult } from "quickjs-emscripten-core";

export type QuickJsProgramSource = {
	(file: string, program: QuickJsProgram): void | string | Promise<void | string>
}

export interface QuickJsProgramSettings {
	consoleHandler?: ConsoleHandler
	disposeHandler?: () => void,
}

export class QuickJsProgram extends UsingDisposable {
	#alive = true;
	readonly #getSource: QuickJsProgramSource
	
	readonly #context: QuickJSContext;
	readonly #intervalManager = new QuickJSIntervalManager(5000);
	readonly #timeoutManager = new QuickJSTimeoutManager(5000);
	readonly #immediateManager = new QuickJSImmediateManager(5000);
	readonly #interruptManager = new InterruptManager(1_000_000n, 100_000_000n, 20_000_000n);
	readonly #ownedDisposableItems = new Set<UsingDisposable>([
		this.#timeoutManager,
		this.#intervalManager,
		this.#immediateManager,
	]);
	readonly #builtinModuleNames = new Set<string>;
	readonly #disposeHandler;
	
	constructor(quickJS: QuickJSWASMModule, getSource: QuickJsProgramSource, settings: QuickJsProgramSettings ={}) {
		super();
		this.#disposeHandler = settings.disposeHandler;
		this.#getSource = getSource;
		const context = this.#context = quickJS.newContext();
		context.runtime.setMemoryLimit(100000000);
		
		init(context);
		this.#intervalManager.settleContext(context, this.#interruptManager);
		this.#timeoutManager.settleContext(context, this.#interruptManager);
		this.#immediateManager.settleContext(context, this.#interruptManager);
		if (settings.consoleHandler) {
			const consoleManager = new ConsoleManager(settings.consoleHandler);
			this.#ownedDisposableItems.add(consoleManager);
			consoleManager.settleContext(context);
		}
		
		this.#ownedDisposableItems.add(context);
		
		
		const runtime = context.runtime;
		runtime.setInterruptHandler(this.#interruptManager.onInterrupt);
		runtime.setModuleLoader(this.#moduleLoader.bind(this) as any, this.#moduleNormalizer.bind(this))
	}
	
	#moduleLoader(moduleName: string, context: QuickJSContext): string | Promise<string> {
		if (moduleName.startsWith("#")) throw new Error(`module not found: ${moduleName}`);
		const source = this.#getSource(moduleName, this);
		if (!source) throw new Error(`module not found: ${moduleName}`);
		if (typeof source === "string") return this.#fixModuleContent(moduleName, source);
		return source.then((res) => {
			if (typeof res === "string") return this.#fixModuleContent(moduleName, res);
			throw new Error(`module not found: ${moduleName}`);
		}).finally(() => {
			const jobs = context.runtime.executePendingJobs();
			jobs?.error?.dispose();
		});
	}
	
	#fixModuleContent(moduleName: string, source: string): string{
		let ext = moduleName.match(/\.([^/.:#?\n]+)(?:$|\?|#)/)?.[1];
		if (!ext) return source;
		if (ext === "js" || ext === "mjs" || ext === "cjs") return source;
		if (ext === "json" || ext === "json5") return `export default ${source}`;
		return `export default ${JSON.stringify(source)}`;
	}
	
	#moduleNormalizer(base: string, importText: string, context: QuickJSContext): string {
		if (importText.startsWith("#")) {
			return base + importText;
		}
		
		if (importText.includes("#") && !this.#builtinModuleNames.has(base)) {
			return `# ${JSON.stringify(String(importText))} is private. Imported from ${JSON.stringify(String(base))}`
		}

		if (importText.startsWith(".") || importText.startsWith("/")) {
			return url.resolve(base, importText);
		}
		return importText.startsWith(".") ? url.resolve(base, importText) : importText;
	}
	
	#loadedModules = new Map<string, QuickJsProgramModule>();
	createModule(moduleName: string, src?: string, builtin?: boolean): QuickJsProgramModule {
		if (builtin) this.#builtinModuleNames.add(moduleName);
		if (src === undefined) {
			const requestedSource = this.#getSource(moduleName, this);
			if (typeof requestedSource !== "string") throw new Error(`module source not found: ${moduleName}`);
			src = requestedSource;
		}
		const callResult = this.#interruptManager.handle(() => {
			return this.#context.evalCode(
				src,
				moduleName,
				{type: "module", strict: true, strip: true}
			)
		}, 50_000_000n);
		return this.#createModuleByCallResult(moduleName, callResult);
	}
	
	async createModuleAsync(moduleName: string, src?: string, builtin?: boolean): Promise<QuickJsProgramModule> {
		if (builtin) this.#builtinModuleNames.add(moduleName);
		if (src === undefined) {
			const requestedSource = await this.#getSource(moduleName, this);
			if (typeof requestedSource !== "string") throw new Error(`module source not found: ${moduleName}`);
			src = requestedSource;
		}
		const callResult = await (this.#context as QuickJSAsyncContext).evalCodeAsync(
			src,
			moduleName,
			{type: "module", strict: true, strip: true}
		);
		if (!("value" in callResult)) {
			throw Scope.withScope((scope) => {
				return this.#context.dump(scope.manage(callResult.error));
			});
		}
		const promiseState = this.#context.getPromiseState(callResult.value);
		if (promiseState.type === "fulfilled") {
			return this.#createModuleByCallResult(moduleName, promiseState);
		}
		if (promiseState.type === "rejected") {
			throw Scope.withScope((scope) => {
				return this.#context.dump(scope.manage(promiseState.error));
			});
		}
		const promiseResult = await this.#context.resolvePromise(callResult.value);
		return this.#createModuleByCallResult(moduleName, promiseResult);
	}
	
	#createModuleByCallResult(moduleName: string, callResult: VmCallResult<QuickJSHandle>){
		if (!("value" in callResult)) {
			throw Scope.withScope((scope) => {
				return this.#context.dump(scope.manage(callResult.error));
			});
		}
		const module = new QuickJsProgramModule(this.#interruptManager, this.#context, callResult.value);
		this.#loadedModules.set(moduleName, module);
		return module;
	}
	
	#createModuleBySource(context: QuickJSContext, moduleName: string, src: string, builtin?: boolean): QuickJSHandle {
		if (builtin) this.#builtinModuleNames.add(moduleName);
		const evalHandle = context.evalCode(src, moduleName, {type: "module", strict: true, strip: true});
		if ("value" in evalHandle) return evalHandle.value;
		throw Scope.withScope((scope) => {
			return context.dump(scope.manage(evalHandle.error));
		});
	}
	
	static #rpcLoaderCode /* language=javascript */ = `
		import RPCSource from "varhub:rpc";
		import room from "varhub:room";
        export default (module) => {
            const current = new RPCSource(module);
            Object.defineProperty(RPCSource, "current", {get: () => current});
            RPCSource.start(current, room);
        }
	`
	
	startRpc(targetModule: QuickJsProgramModule){
		const module = this.createModule("varhub:rpc#loader", QuickJsProgram.#rpcLoaderCode, true);
		targetModule.withModule(wrapper => module.callMethodIgnored("default", undefined, wrapper));
	}
	
	async startRpcAsync(targetModule: QuickJsProgramModule){
		const module = await this.createModuleAsync("varhub:rpc#loader", QuickJsProgram.#rpcLoaderCode, true);
		targetModule.withModule(wrapper => module.callMethodIgnored("default", undefined, wrapper));
	}
	
	setBuiltinModuleName(moduleName: string, builtin: boolean): void {
		if (builtin) {
			this.#builtinModuleNames.add(moduleName);
		} else {
			this.#builtinModuleNames.delete(moduleName);
		}
	}
	
	withContext<T>(handler: (wrapper: ShortLifeContextWrapper) => T extends ShortLifeContextWrapper ? "do not return wrapped value!" : T): T {
		return Scope.withScope(scope => {
			return handler(new ShortLifeContextWrapper(scope, this.#context, this.#interruptManager));
		}) as T;
	}
	
	get alive(){
		return this.#alive;
	}
	
	executePendingJobs(count = -1){
		void this.#context.runtime.executePendingJobs(count)
	}
	
	dispose() {
		this.#alive = false;
		for (let module of this.#loadedModules.values()) if (module.alive) try {
			module.dispose();
		} catch {}
		for (let ownedDisposableItem of this.#ownedDisposableItems) if (ownedDisposableItem.alive) try {
			ownedDisposableItem.dispose();
		} catch {}
		this.#disposeHandler?.();
	}
}