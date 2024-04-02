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

export interface QuickJsProgramSourceConfig {
	sources: {
		[moduleName: string]: string;
	}
	main?: string,
}

export class QuickJsProgram extends UsingDisposable {
	readonly #sourceConfig: QuickJsProgramSourceConfig
	
	readonly #runtime: QuickJSRuntime
	readonly #exports: QuickJSHandle
	readonly #context: QuickJSContext
	readonly #intervalManager = new QuickJSIntervalManager(5000);
	readonly #timeoutManager = new QuickJSTimeoutManager(5000);
	readonly #immediateManager = new QuickJSImmediateManager(5000);
	readonly #maxInterrupts = 1000;
	
	constructor(quickJS: QuickJSWASMModule, sourceConfig: QuickJsProgramSourceConfig) {
		super();
		const runtime = this.#runtime = quickJS.newRuntime();
		runtime.setInterruptHandler(this.#interruptHandler.bind(this));
		runtime.setModuleLoader(this.#moduleLoader.bind(this), this.#moduleNormalizer.bind(this));
		this.#sourceConfig = sourceConfig;
		const context = this.#context = this.#runtime.newContext();

		this.#settleGlobal(context);
		const mainModuleName = this.#sourceConfig.main ?? "index.js";
		
		const source = this.#moduleLoader(mainModuleName, context);
		const moduleResult = context.evalCode(source, mainModuleName, { type: "module", strict: true, strip: true });
		this.#exports = context.unwrapResult(moduleResult);
	}
	
	#settleGlobal(context: QuickJSContext) {
		Scope.withScope((scope) => {
			
			// todo: remove console
			const consoleHandle = scope.manage(context.newObject())
			const consoleMethodNames = ["log", "error", "warn", "info", "debug"] as const satisfies (keyof typeof console)[];
			for (let consoleMethodName of consoleMethodNames) {
				const methodHandle = scope.manage(context.newFunction(consoleMethodName, (...args: QuickJSHandle[]) => {
					const nativeArgs = args.map(context.dump);
					console[consoleMethodName]("QuickJS:", ...nativeArgs);
				}));
				context.setProp(consoleHandle, consoleMethodName, methodHandle)
			}
			context.setProp(context.global, "console", consoleHandle);

			const intervalManager = this.#intervalManager;
			const timeoutManager = this.#timeoutManager;
			const immediateManager = this.#immediateManager;
			const clearInterrupts = () => this.#clearInterruptsCounter();
			
			const setIntervalHandle = context.newFunction("setInterval", function(callbackArg, delayArg, ...args) {
				const delayMs = context.getNumber(delayArg);
				const intervalId = intervalManager.setInterval(context, clearInterrupts, callbackArg, this, delayMs, ...args);
				return context.newNumber(intervalId);
			})
			
			const clearIntervalHandle = context.newFunction("clearInterval", (intervalIdHandle) => {
				intervalManager.clearInterval(context.getNumber(intervalIdHandle));
				return context.undefined;
			})
			
			const setTimeoutHandle = context.newFunction("setTimeout", function(callbackArg, delayArg, ...args) {
				const delayMs = context.getNumber(delayArg);
				const timeoutId = timeoutManager.setTimeout(context, clearInterrupts, callbackArg, this, delayMs, ...args);
				return context.newNumber(timeoutId);
			})
			
			const clearTimeoutHandle = context.newFunction("clearTimeout", (timeoutIdHandle) => {
				timeoutManager.clearTimeout(context.getNumber(timeoutIdHandle));
				return context.undefined;
			})
			
			const setImmediateHandle = context.newFunction("setImmediate", function(callbackArg, ...args) {
				const immediateId = immediateManager.setImmediate(context, clearInterrupts, callbackArg, this, ...args);
				return context.newNumber(immediateId);
			})
			
			const clearImmediateHandle = context.newFunction("clearImmediate", (immediateIdHandle) => {
				immediateManager.clearImmediate(context.getNumber(immediateIdHandle));
				return context.undefined;
			})
			
			context.setProp(context.global, "setInterval", setIntervalHandle);
			context.setProp(context.global, "clearInterval", clearIntervalHandle);
			context.setProp(context.global, "setTimeout", setTimeoutHandle);
			context.setProp(context.global, "clearTimeout", clearTimeoutHandle);
			context.setProp(context.global, "setImmediate", setImmediateHandle);
			context.setProp(context.global, "clearImmediate", clearImmediateHandle);
		});

	}
	
	#moduleLoader(moduleName: string, context: QuickJSContext): string {
		const src = this.#sourceConfig.sources[moduleName];
		if (src == null) throw new Error("module not found: "+moduleName);
		if (moduleName.endsWith(".js") || moduleName.endsWith(".cjs") || moduleName.endsWith(".mjs")) return src;
		if (moduleName.endsWith(".json")) return `export default ${src}`;
		return `export default ${JSON.stringify(src)}`;
	}
	
	#moduleNormalizer(baseModuleName: string, requestModuleName: string, context: QuickJSContext): string {
		let result
		if (requestModuleName.startsWith(".")) result = url.resolve(baseModuleName, requestModuleName);
		else result = requestModuleName;
		if (result === "@varhub/inner" || result.startsWith("@varhub/inner/")) {
			if (baseModuleName === "@varhub" || baseModuleName.startsWith("@varhub/")) return result;
			throw new Error("restricted access to @varhub/inner module");
		}
		return result;
	}
	
	#interruptsCount = 0;
	#interruptHandler(runtime: QuickJSRuntime): boolean {
		if (this.#interruptsCount > this.#maxInterrupts) return true;
		this.#interruptsCount++;
		return false;
	}
	
	#clearInterruptsCounter(){
		this.#interruptsCount = 0;
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
		return this.#runtime.alive;
	}
	
	dispose() {
		this.#intervalManager?.dispose();
		this.#exports?.dispose();
		this.#context?.dispose();
		this.#runtime?.dispose();
	}
	
	
}

class QuickJSIntervalManager extends UsingDisposable {
	intervalId = 0;
	#intervalMap: Map<number, [ReturnType<typeof setInterval>, ...UsingDisposable[]]> | null = new Map();
	readonly #maxIntervals: number;
	
	constructor(maxIntervals = Infinity) {
		super();
		this.#maxIntervals = maxIntervals;
	}
	
	setInterval(context: QuickJSContext, callback: null | (() => void), callbackVal: QuickJSHandle, thisVal: QuickJSHandle, timer: number, ...args: QuickJSHandle[]): number {
		if (!this.#intervalMap) throw new Error("intervals disposed");
		if (this.#intervalMap.size >= this.#maxIntervals) throw new Error("too many intervals");
		
		const callbackHandle = callbackVal.dup();
		const thisHandle = thisVal.dup();
		const argHandles = args.map(arg => arg.dup());
		const intervalId = this.intervalId++;
		if (this.intervalId >= Number.MAX_SAFE_INTEGER) this.intervalId = 0;

		const intervalValue = setInterval(() => {
			callback?.()
			const callResult = context.callFunction(callbackHandle, thisHandle, ...argHandles);
			context.unwrapResult(callResult).dispose();
			context.runtime.executePendingJobs();
		}, timer);

		this.#intervalMap.set(intervalId, [intervalValue, callbackHandle, thisHandle, ...argHandles] as const);

		return intervalId;
	}
	
	clearInterval(intervalId: number): void{
		if (!this.#intervalMap) throw new Error("intervals disposed");
		const intervalData = this.#intervalMap.get(intervalId);
		if (!intervalData) return;
		this.#intervalMap.delete(intervalId);
		const [intervalValue, ...garbage] = intervalData;
		clearInterval(intervalValue);
		for (const disposable of garbage) {
			disposable.dispose();
		}
	}
	
	get alive(){
		return this.#intervalMap != null;
	}
	
	dispose() {
		if (!this.#intervalMap) return;
		for (const [interval, ...garbage] of this.#intervalMap?.values()) {
			clearInterval(interval);
			for (const disposable of garbage) {
				disposable.dispose();
			}
		}
		this.#intervalMap?.clear();
		this.#intervalMap = null;
	}
}

class QuickJSTimeoutManager extends UsingDisposable {
	#timeoutId = 0;
	#timeoutMap: Map<number, [ReturnType<typeof setInterval>, ...UsingDisposable[]]> | null = new Map();
	readonly #maxTimeouts: number;
	
	constructor(maxTimeouts = Infinity) {
		super();
		this.#maxTimeouts = maxTimeouts;
	}
	
	setTimeout(context: QuickJSContext, callback: null | (() => void), callbackVal: QuickJSHandle, thisVal: QuickJSHandle, timer: number, ...args: QuickJSHandle[]): number {
		if (!this.#timeoutMap) throw new Error("timeouts disposed");
		if (this.#timeoutMap.size >= this.#maxTimeouts) throw new Error("too many timeouts");
		
		const callbackHandle = callbackVal.dup();
		const thisHandle = thisVal.dup();
		const argHandles = args.map(arg => arg.dup());
		const timeoutId = this.#timeoutId++;
		if (this.#timeoutId >= Number.MAX_SAFE_INTEGER) this.#timeoutId = 0;
		
		const timeoutValue = setTimeout(() => {
			callback?.()
			const callResult = context.callFunction(callbackHandle, thisHandle, ...argHandles);
			this.#timeoutMap?.delete(timeoutId);
			for (let disposable of [thisHandle, callbackHandle, ...argHandles]) {
				disposable.dispose();
			}
			context.unwrapResult(callResult).dispose();
			context.runtime.executePendingJobs();
		}, timer);
		
		this.#timeoutMap.set(timeoutId, [timeoutValue, callbackHandle, thisHandle, ...argHandles] as const);
		
		return timeoutId;
	}
	
	clearTimeout(timeoutId: number): void {
		if (!this.#timeoutMap) throw new Error("timeouts disposed");
		const timeoutData = this.#timeoutMap.get(timeoutId);
		if (!timeoutData) return;
		this.#timeoutMap.delete(timeoutId);
		const [timeoutValue, ...garbage] = timeoutData;
		clearTimeout(timeoutValue);
		for (const disposable of garbage) {
			disposable.dispose();
		}
	}
	
	get alive(){
		return this.#timeoutMap != null;
	}
	
	dispose() {
		if (!this.#timeoutMap) return;
		for (const [interval, ...garbage] of this.#timeoutMap.values()) {
			clearInterval(interval);
			for (const disposable of garbage) {
				disposable.dispose();
			}
		}
		this.#timeoutMap.clear();
		this.#timeoutMap = null;
	}
}

class QuickJSImmediateManager extends UsingDisposable {
	#immediateId = 0;
	#immediateMap: Map<number, [ReturnType<typeof setImmediate>, ...UsingDisposable[]]> | null = new Map();
	readonly #maxImmediateItems: number;
	
	constructor(maxImmediateItems = Infinity) {
		super();
		this.#maxImmediateItems = maxImmediateItems;
	}
	
	setImmediate(context: QuickJSContext, callback: null | (() => void), callbackVal: QuickJSHandle, thisVal: QuickJSHandle, ...args: QuickJSHandle[]): number {
		if (!this.#immediateMap) throw new Error("immediate disposed");
		if (this.#immediateMap.size >= this.#maxImmediateItems) throw new Error("too many immediate");
		
		const callbackHandle = callbackVal.dup();
		const thisHandle = thisVal.dup();
		const argHandles = args.map(arg => arg.dup());
		const timeoutId = this.#immediateId++;
		if (this.#immediateId >= Number.MAX_SAFE_INTEGER) this.#immediateId = 0;
		
		const immediateValue = setImmediate(() => {
			callback?.()
			const callResult = context.callFunction(callbackHandle, thisHandle, ...argHandles);
			this.#immediateMap?.delete(timeoutId);
			for (let disposable of [thisHandle, callbackHandle, ...argHandles]) {
				disposable.dispose();
			}
			context.unwrapResult(callResult).dispose();
			context.runtime.executePendingJobs();
		});
		
		this.#immediateMap.set(timeoutId, [immediateValue, callbackHandle, thisHandle, ...argHandles] as const);
		
		return timeoutId;
	}
	
	clearImmediate(immediateId: number): void {
		if (!this.#immediateMap) throw new Error("timeouts disposed");
		const immediateData = this.#immediateMap.get(immediateId);
		if (!immediateData) return;
		this.#immediateMap.delete(immediateId);
		const [immediateValue, ...garbage] = immediateData;
		clearImmediate(immediateValue);
		for (const disposable of garbage) {
			disposable.dispose();
		}
	}
	
	get alive(){
		return this.#immediateMap != null;
	}
	
	dispose() {
		if (!this.#immediateMap) return;
		for (const [immediateValue, ...garbage] of this.#immediateMap.values()) {
			clearImmediate(immediateValue);
			for (const disposable of garbage) {
				disposable.dispose();
			}
		}
		this.#immediateMap.clear();
		this.#immediateMap = null;
	}
}