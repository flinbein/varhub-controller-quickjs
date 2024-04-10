import { QuickJSContext, QuickJSHandle, QuickJSWASMModule, Scope, UsingDisposable } from "quickjs-emscripten"
import url from 'node:url';
import { QuickJSImmediateManager, QuickJSIntervalManager, QuickJSTimeoutManager } from "./scope/TimeManagers.js"
import { ConsoleManager } from "./scope/ConsoleManager.js";
import { InterruptManager } from "./InterruptManager.js";
import { QuickJsProgramModule } from "./QuickJsProgramModule.js";
import { JSModuleNormalizeResult } from "quickjs-emscripten-core";

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
		try {
			if (importText.startsWith(":")) {
				const moduleName = baseModuleName + importText;
				this.getModule(moduleName)
				return moduleName;
			}
			
			if (importText.includes(":")) {
				// noinspection ExceptionCaughtLocallyJS
				throw new Error(`no module access: ${importText}`);
			}
			
			const moduleName = importText.startsWith(".") ? url.resolve(baseModuleName, importText) : importText;
			this.getModule(moduleName)
			return moduleName;
		} catch (error: any) {
			return `${JSON.stringify(String(importText))} not found from ${JSON.stringify(String(baseModuleName))} `
		}
		
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
	
	hasModule(moduleName: string){
		return this.#moduleMap.has(moduleName);
	}
	
	#createModule(context: QuickJSContext, moduleName: string): QuickJSHandle {
		const src = this.#getModuleSource(moduleName);
		const evalHandle = context.evalCode(src, moduleName, {type: "module", strict: true, strip: true});
		if ("value" in evalHandle) return evalHandle.value;
		throw Scope.withScope((scope) => {
			return context.dump(scope.manage(evalHandle.error));
		});
	}
	
	#getModuleSource(moduleName: string){
		let ext = moduleName.match(/\.([^/.]+$)/)?.[1];
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