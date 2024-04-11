import { QuickJSContext, QuickJSHandle, QuickJSWASMModule, Scope, UsingDisposable } from "quickjs-emscripten"
import url from 'node:url';
import { QuickJSImmediateManager, QuickJSIntervalManager, QuickJSTimeoutManager } from "./scope/TimeManagers.js"
import { wrap } from "./utils/wrapper.js"
import { ConsoleManager } from "./scope/ConsoleManager.js";
import { InterruptManager } from "./InterruptManager.js";
import { QuickJsProgramModule } from "./QuickJsProgramModule.js";
import { JSModuleNormalizeResult, Lifetime, VmCallResult } from "quickjs-emscripten-core";

export interface QuickJsProgramSource {
	(file: string, program: QuickJsProgram): string | undefined
}

export class QuickJsProgram extends UsingDisposable {
	readonly #getSource: QuickJsProgramSource
	
	readonly #context: QuickJSContext
	readonly #intervalManager = new QuickJSIntervalManager(5000);
	readonly #timeoutManager = new QuickJSTimeoutManager(5000);
	readonly #immediateManager = new QuickJSImmediateManager(5000);
	readonly #consoleManager = new ConsoleManager("QuickJS:");
	readonly #interruptManager = new InterruptManager(1_000_000n);
	readonly #ownedDisposableItems = new Set<UsingDisposable>([
		this.#consoleManager,
		this.#timeoutManager,
		this.#intervalManager,
		this.#immediateManager,
	]);
	readonly #moduleMap = new Map<string, QuickJsProgramModule>;
	
	constructor(quickJS: QuickJSWASMModule, getSource: QuickJsProgramSource) {
		super();
		this.#getSource = getSource;
		const context = this.#context = quickJS.newContext();
		context.runtime.setMemoryLimit(10000000);
		
		this.#intervalManager.settleContext(context);
		this.#timeoutManager.settleContext(context);
		this.#immediateManager.settleContext(context);
		this.#consoleManager.settleContext(context);
		
		this.#ownedDisposableItems.add(context);
		
		
		const runtime = context.runtime;
		runtime.setInterruptHandler(this.#interruptManager.onInterrupt);
		runtime.setModuleLoader(this.#moduleLoader.bind(this), this.#moduleNormalizer.bind(this));
	}
	
	#moduleLoader(moduleName: string, context: QuickJSContext): string {
		throw new Error(`module loading error: ${moduleName}`);
	}
	
	
	#moduleNormalizer(baseModuleName: string, importText: string, context: QuickJSContext): JSModuleNormalizeResult {
		if (importText.startsWith(":")) {
			const moduleName = baseModuleName + importText;
			if (!this.getModule(moduleName)) return this.#createModuleErrorText(baseModuleName, importText);
			return moduleName;
		}
		
		if (importText.includes(":")) return this.#createModuleErrorText(baseModuleName, importText);
		
		const moduleName = importText.startsWith(".") ? url.resolve(baseModuleName, importText) : importText;
		if (!this.getModule(moduleName))  return this.#createModuleErrorText(baseModuleName, importText);
		return moduleName;
	}
	
	#createModuleErrorText(base: string, importText: string){
		return `${JSON.stringify(String(importText))} not found from ${JSON.stringify(String(base))} `
	}
	
	getLoadedModules(): Set<string>{
		return new Set(this.#moduleMap.keys())
	}
	
	getModule(moduleName: string): QuickJsProgramModule {
		const loadedModule = this.#moduleMap.get(moduleName);
		if (loadedModule) return loadedModule;
		const moduleHandle = this.#createModule(this.#context, moduleName);
		const module = new QuickJsProgramModule(this.#interruptManager, this.#context, moduleHandle);
		this.#moduleMap.set(moduleName, module);
		return module;
	}
	
	createModule(moduleName: string, src: string): QuickJsProgramModule {
		if (this.#moduleMap.has(moduleName)) throw new Error(`Module already exists: ${moduleName}`);
		const moduleHandle = this.#createModuleBySource(this.#context, moduleName, src);
		const module = new QuickJsProgramModule(this.#interruptManager, this.#context, moduleHandle);
		this.#moduleMap.set(moduleName, module);
		return module;
	}
	
	hasModule(moduleName: string){
		return this.#moduleMap.has(moduleName);
	}
	
	#createModule(context: QuickJSContext, moduleName: string): QuickJSHandle {
		const src = this.#getModuleSource(moduleName);
		return this.#createModuleBySource(context, moduleName, src);
	}
	
	#createModuleBySource(context: QuickJSContext, moduleName: string, src: string): QuickJSHandle {
		const evalHandle = context.evalCode(src, moduleName, {type: "module", strict: true, strip: true});
		if ("value" in evalHandle) return evalHandle.value;
		throw Scope.withScope((scope) => {
			return context.dump(scope.manage(evalHandle.error));
		});
	}
	
	#getModuleSource(moduleName: string){
		let ext = moduleName.match(/\.([^/.:]+$)/)?.[1];
		let src = this.#getSource(moduleName, this);
		if (!ext && !src) {
			for (ext of ["js", "mjs", "cjs", "json", "json5"]) {
				src = this.#getSource(moduleName+"."+ext, this);
				if (src != undefined) break;
			}
		}
		if (src == undefined) throw new Error(`module not found: ${moduleName}`);
		if (!ext) return src;
		if (ext === "js" || ext === "mjs" || ext === "cjs") return src;
		if (ext === "json" || ext === "json5") return `export default ${src}`;
		return `export default ${JSON.stringify(src)}`;
	}
	
	withProxyFunctions<T>(fnList: ((...args: any[]) => any)[], fnAction: (...fnHandleList: QuickJSHandle[]) => T): T{
		const context = this.#context;
		return Scope.withScope((scope) => {
			const fnHandleList = fnList.map(fn => {
				return scope.manage(context.newFunction(fn.name, (...argHandles) => {
					const args = argHandles.map(context.dump);
					try {
						const apiResult = fn(...args);
						if (apiResult instanceof Promise) {
							const promiseHandle = context.newPromise();
							apiResult.then(
								v => Scope.withScope((scope) => promiseHandle.resolve(wrap(scope, context, v))),
								v => Scope.withScope((scope) => promiseHandle.reject(wrap(scope, context, v))),
							).finally(() => {
								promiseHandle.dispose();
								context.runtime.executePendingJobs();
							});
							return promiseHandle.handle;
						}
						let result: QuickJSHandle | undefined;
						void Scope.withScopeAsync(async (fnScope) => {
							result = wrap(fnScope, context, apiResult);
						});
						return result!
					} catch (error) {
						let result: QuickJSHandle | undefined;
						void Scope.withScopeAsync(async (fnScope) => {
							result = wrap(fnScope, context, error);
						});
						return {error: result} as VmCallResult<QuickJSHandle>;
					}
				}));
			});
			return fnAction(...fnHandleList);
		})
	}
	
	get alive(){
		return this.#context.alive;
	}
	
	dispose() {
		for (let module of this.#moduleMap.values()) {
			if (module.alive) module.dispose();
		}
		for (let ownedDisposableItem of this.#ownedDisposableItems) {
			if (ownedDisposableItem.alive) ownedDisposableItem.dispose();
		}
	}
}