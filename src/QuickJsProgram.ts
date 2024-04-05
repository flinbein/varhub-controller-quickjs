import {
	QuickJSContext,
	QuickJSHandle,
	QuickJSRuntime,
	QuickJSWASMModule,
	Scope,
	UsingDisposable
} from "quickjs-emscripten"
import { Lifetime } from "quickjs-emscripten-core";
import url from 'node:url';
import {QuickJSTimeoutManager, QuickJSImmediateManager, QuickJSIntervalManager} from "./scope/TimeManagers.js"
import { ConsoleManager } from "./scope/ConsoleManager.js";
import {hrtime} from "node:process";

export interface QuickJsProgramSourceConfig {
	sources: {
		[moduleName: string]: string;
	}
	main?: string,
}
export interface QuickJsProgramOptions {
	getApi?: (name: string) => (...args: any) => any;
	hasApi?: (name: string) => boolean;
}

export class QuickJsProgram extends UsingDisposable {
	readonly #sourceConfig: QuickJsProgramSourceConfig
	
	readonly #options: QuickJsProgramOptions
	readonly #exports: QuickJSHandle
	readonly #context: QuickJSContext
	readonly #intervalManager = new QuickJSIntervalManager(5000);
	readonly #timeoutManager = new QuickJSTimeoutManager(5000);
	readonly #immediateManager = new QuickJSImmediateManager(5000);
	readonly #consoleManager = new ConsoleManager("QuickJS:");
	// readonly #maxInterrupts = 10000;
	readonly #maxInterruptTimeNs = 100000000n; // nanoseconds
	readonly #ownedDisposableItems = new Set<UsingDisposable>([
		this.#consoleManager,
		this.#timeoutManager,
		this.#intervalManager,
		this.#immediateManager,
	]);
	
	constructor(quickJS: QuickJSWASMModule, sourceConfig: QuickJsProgramSourceConfig, options: QuickJsProgramOptions = {}) {
		super();
		this.#sourceConfig = sourceConfig;
		this.#options = options;
		const context = this.#context = quickJS.newContext();
		context.runtime.setMemoryLimit(10000000);
		
		this.#intervalManager.settleContext(context);
		this.#timeoutManager.settleContext(context);
		this.#immediateManager.settleContext(context);
		this.#consoleManager.settleContext(context);
		
		this.#ownedDisposableItems.add(context);
		
		
		const runtime = context.runtime;
		runtime.setInterruptHandler(this.#interruptHandler.bind(this));
		runtime.setModuleLoader(this.#moduleLoader.bind(this), this.#moduleNormalizer.bind(this));
		

		const mainModuleName = this.#sourceConfig.main ?? "index.js";
		
		const source = this.#moduleLoader(mainModuleName, context);
		const moduleResult = context.evalCode(source, mainModuleName, { type: "module", strict: true, strip: true });
		try {
			this.#exports = context.unwrapResult(moduleResult);
			this.#ownedDisposableItems.add(this.#exports);
		} catch (error) {
			this.dispose();
			throw error;
		}
	}
	
	#moduleLoader(moduleName: string, context: QuickJSContext): string {
		const src = this.#sourceConfig.sources[moduleName];
		if (src == null) throw new Error("module not found: "+moduleName);
		if (moduleName.startsWith("@varhub/api/")) return "export default null";
		if (moduleName.endsWith(".js") || moduleName.endsWith(".cjs") || moduleName.endsWith(".mjs")) return src;
		if (moduleName.endsWith(".json")) return `export default ${src}`;
		return `export default ${JSON.stringify(src)}`;
	}
	
	#moduleNormalizer(baseModuleName: string, requestModuleName: string, context: QuickJSContext): string {
		let result
		if (requestModuleName.startsWith(".")) result = url.resolve(baseModuleName, requestModuleName);
		else result = requestModuleName;
		
		if (result.startsWith("@varhub/api/")) this.#tryLoadApiModule(result.substring(12), context);
		
		if (result === "@inner") return `@inner:${baseModuleName}`;
		if (result.startsWith("@inner:")) throw new Error("inner module invalid");
		
		return result;
	}
	
	#tryLoadApiModule(apiName: string, context: QuickJSContext){
		if (this.#options.hasApi?.(apiName)) return;
		const apiFilename = `@varhub/api/${apiName}`;
		const innerResult = context.evalCode(
			`export let handle; export const setHandle = h => handle = h`,
			`@inner:${apiFilename}`,
			{type: "module", strict: true}
		);
		const apiFn = this.#options.getApi?.(apiName);
		if (!apiFn) return;
		Scope.withScope((scope) => {
			const innerModuleHandle = scope.manage(context.unwrapResult(innerResult));
			const setHandle = scope.manage(context.getProp(innerModuleHandle, "setHandle"));
			const thisHandle = scope.manage(context.undefined);
			const fnHandle = scope.manage(context.newFunction(apiName, (...argHandles) => {
				const args = argHandles.map(context.dump);
				const apiResult = apiFn(...args);
				if (apiResult instanceof Promise) {
					const promiseHandle = context.newPromise();
					apiResult.then(promiseHandle.resolve, promiseHandle.reject).finally(() => {
						promiseHandle.dispose();
						context.runtime.executePendingJobs();
					});
					scope.manage(promiseHandle.handle);
					return promiseHandle.handle;
				}
				let result: QuickJSHandle | undefined;
				void Scope.withScopeAsync(async (fnScope) => {
					result = this.#wrap(fnScope, context, apiResult);
				});
				return result!
			}));
			const callResult = context.callFunction(setHandle, thisHandle, fnHandle);
			context.unwrapResult(callResult).dispose();
		})
		
		const result = context.evalCode(
			`import {handle} from "@inner"; export default handle`,
			apiFilename,
			{type: "module", strict: true}
		);
		context.unwrapResult(result).dispose();
	}
	
	#interruptImmediate: ReturnType<typeof setImmediate> | null = null;
	#interruptTime: bigint | null = null;
	#interruptHandler(runtime: QuickJSRuntime): boolean {
		if (this.#interruptImmediate == null) {
			this.#interruptImmediate = setImmediate(() => {
				this.#interruptImmediate = null;
				this.#interruptTime = null;
			});
			this.#interruptTime = hrtime.bigint();
			return false;
		}
		if (this.#interruptTime == null) return false;
		const diff = hrtime.bigint() - this.#interruptTime;
		// console.log("---diff", diff);
		return diff > this.#maxInterruptTimeNs;
	}
	
	#clearInterruptsCounter(){
		//this.#interruptsCount = 0;
	}

	#wrap(scope: Scope, context: QuickJSContext, data: unknown): QuickJSHandle{
		if (data instanceof Lifetime && data.owner === context.runtime) return data;
		if (data === undefined) return scope.manage(context.undefined);
		if (data === null) return scope.manage(context.null);
		if (typeof data === "boolean") return scope.manage(data ? context.true : context.false);
		if (typeof data === "number") return scope.manage(context.newNumber(data));
		if (typeof data === "string") return scope.manage(context.newString(data));
		if (typeof data === "bigint") return scope.manage(context.newBigInt(data));
		if (data instanceof Error) return scope.manage(context.newError(data));
		if (Array.isArray(data)) {
			const arrayHandle = scope.manage(context.newArray());
			for (let i = 0; i < data.length; i++) {
				context.setProp(arrayHandle, i, this.#wrap(scope, context, data[i]));
			}
			return arrayHandle;
		}
		if (typeof data === "object") {
			const objectHandle = scope.manage(context.newObject());
			for (const dataKey in data) {
				context.setProp(objectHandle, dataKey, this.#wrap(scope, context, (data as any)[dataKey]));
			}
			return objectHandle;
		}
		throw new Error(`unwrappable type: ${typeof data}`);
	}

	call(methodName: string, thisArg: unknown = undefined, ...args: unknown[]): unknown {
		if (this.#interruptImmediate != null) {
			clearImmediate(this.#interruptImmediate);
			this.#interruptImmediate = null;
		}
		const context = this.#context;
		const callResult = Scope.withScope((scope) => {
			const wrapArg = this.#wrap.bind(this, scope, context);
			const methodHandle = scope.manage(context.getProp(this.#exports, methodName));
			const typeOfMethod = context.typeof(methodHandle);
			if (typeOfMethod !== "function") {
				throw new Error(`no exported function: ${methodName}, ${typeOfMethod}`)
			}
			const thisArgHandle = wrapArg(thisArg);
			const argsHandle = args.map(wrapArg);
			this.#clearInterruptsCounter();
			return context.callFunction(methodHandle, thisArgHandle, ...argsHandle);
		})
		if (!("value" in callResult)) {
			throw this.#dumpPromisify(context, callResult.error);
		}
		return this.#dumpPromisify(context, callResult.value);
	}
	
	#dumpPromisify(context: QuickJSContext, valueUnscoped: QuickJSHandle): unknown{
		const promiseState = context.getPromiseState(valueUnscoped);
		if (promiseState.type === "fulfilled" && promiseState.notAPromise) {
			const dump = context.dump(valueUnscoped);
			promiseState.value.dispose();
			return dump;
		}
		if (promiseState.type === "fulfilled") {
			const promise = Promise.resolve(context.dump(promiseState.value));
			promiseState.value.dispose();
			return promise;
		}
		if (promiseState.type === "rejected") {
			const error = this.#dumpPromisify(context, promiseState.error);
			return Promise.reject(error);
		}
		return context.resolvePromise(valueUnscoped).then(resolvedResult => {
			if (!("value" in resolvedResult)) {
				const innerPromiseState = context.getPromiseState(resolvedResult.error);
				if (innerPromiseState.type !== "fulfilled" || !innerPromiseState.notAPromise) {
					throw this.#dumpPromisify(context, resolvedResult.error);
				}
				const dump = context.dump(resolvedResult.error);
				resolvedResult.error.dispose();
				throw dump;
			}
			const dump = context.dump(resolvedResult.value);
			resolvedResult.value.dispose();
			valueUnscoped.dispose();
			return dump;
		});
	}
	
	getProp(propName: string) {
		const propHandle = this.#context.getProp(this.#exports, propName);
		const result = this.#context.dump(propHandle);
		propHandle.dispose();
		return result;
	}
	
	get alive(){
		return this.#context.alive;
	}
	
	dispose() {
		for (let ownedDisposableItem of this.#ownedDisposableItems) {
			if (ownedDisposableItem.alive) ownedDisposableItem.dispose();
		}
	}
}