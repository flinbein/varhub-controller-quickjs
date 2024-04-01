import {
	QuickJSContext,
	QuickJSHandle,
	QuickJSRuntime,
	QuickJSWASMModule,
	Scope,
	UsingDisposable,
} from "quickjs-emscripten"

export interface QuickJsProgramSourceConfig {
	sources: {
		[moduleName: string]: JsSourceModule | JsonSourceModule;
	}
	main: string,
}

interface JsSourceModule { type: "js"; source: string }
interface JsonSourceModule { type: "json"; source: string }

export class QuickJsProgram extends UsingDisposable {
	readonly #sourceConfig: QuickJsProgramSourceConfig
	
	readonly #runtime: QuickJSRuntime
	readonly #exports: QuickJSHandle
	readonly #context: QuickJSContext
	readonly #intervalManager = new QuickJSIntervalManager(5000);
	readonly #timeoutManager = new QuickJSTimeoutManager(5000);
	
	constructor(quickJS: QuickJSWASMModule, sourceConfig: QuickJsProgramSourceConfig) {
		super();
		// todo: ADD INTERRUPT-HANDLER
		const runtime = this.#runtime = quickJS.newRuntime();
		this.#sourceConfig = sourceConfig;
		const context = this.#context = this.#runtime.newContext();
		this.#settleGlobal(context);

		const logHandle = context.newFunction("log", (...args: any[]) => {
			const nativeArgs = args.map(context.dump);
			console.log("QuickJS:", ...nativeArgs);
		});
		const consoleHandle = context.newObject()
		context.setProp(consoleHandle, "log", logHandle)
		context.setProp(context.global, "console", consoleHandle)
		consoleHandle.dispose()
		logHandle.dispose()

		runtime.setModuleLoader(this.#moduleLoader.bind(this));
		const mainModuleName = this.#sourceConfig.main;
		const source = this.#moduleLoader(mainModuleName, context);
		const moduleResult = context.evalCode(source, mainModuleName, { type: "module" });
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
			const setIntervalHandle = context.newFunction("setInterval", function(callbackArg, delayArg, ...args) {
				const delayMs = context.getNumber(delayArg);
				const intervalId = intervalManager.setInterval(context, callbackArg, this, delayMs, ...args);
				return context.newNumber(intervalId);
			})
			
			const clearIntervalHandle = context.newFunction("clearInterval", (intervalIdHandle) => {
				intervalManager.clearInterval(context.getNumber(intervalIdHandle));
				return context.undefined;
			})
			
			const setTimeoutHandle = context.newFunction("setTimeout", function(callbackArg, delayArg, ...args) {
				const delayMs = context.getNumber(delayArg);
				const timeoutId = timeoutManager.setTimeout(context, callbackArg, this, delayMs, ...args);
				return context.newNumber(timeoutId);
			})
			
			const clearTimeoutHandle = context.newFunction("clearTimeout", (intervalIdHandle) => {
				timeoutManager.clearTimeout(context.getNumber(intervalIdHandle));
				return context.undefined;
			})
			
			context.setProp(context.global, "setInterval", setIntervalHandle);
			context.setProp(context.global, "clearInterval", clearIntervalHandle);
			context.setProp(context.global, "setTimeout", setTimeoutHandle);
			context.setProp(context.global, "clearTimeout", clearTimeoutHandle);
		});

	}
	
	#moduleLoader(moduleName: string, context: QuickJSContext): string {
		const moduleData = this.#sourceConfig.sources[moduleName];
		if (!moduleData) throw new Error("module not found: "+moduleName);
		if (moduleData.type === "js") return moduleData.source;
		if (moduleData.type === "json") return `export default ${JSON.stringify(JSON.parse(moduleData.source))}`;
		throw new Error(`unknown module type`);
	}

	#wrap(scope: Scope, context: QuickJSContext, data: unknown): QuickJSHandle{
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

	call(methodName: string, thisArg: unknown, ...args: unknown[]): unknown{
		const context = this.#context;
		return Scope.withScope((scope) => {
			const wrapArg = this.#wrap.bind(this, scope, context);
			const methodHandle = scope.manage(context.getProp(this.#exports, methodName));
			const typeOfMethod = context.typeof(methodHandle);
			if (typeOfMethod !== "function") {
				throw new Error(`no exported function: ${methodName}, ${typeOfMethod}`)
			}
			const thisArgHandle = wrapArg(thisArg);
			const argsHandle = args.map(wrapArg);
			const callResult = context.callFunction(methodHandle, thisArgHandle, ...argsHandle);
			if (!("value" in callResult)) {
				const dump = context.dump(callResult.error);
				callResult.error.dispose();
				// todo check if promise
				throw dump;
			}
			const resultHandleUnscoped = context.unwrapResult(callResult);
			const promiseState = context.getPromiseState(resultHandleUnscoped);
			if (promiseState.type === "fulfilled" && promiseState.notAPromise) {
				const resolvedValue = scope.manage(promiseState.value);
				const dump = context.dump(resolvedValue);
				resultHandleUnscoped.dispose();
				return dump;
			}
			return context.resolvePromise(resultHandleUnscoped).then(resolvedResult => {
				if (!("value" in resolvedResult)) {
					const dump = context.dump(resolvedResult.error);
					resolvedResult.error.dispose();
					throw dump;
				}
				// do not use scope here
				const dump = context.dump(resolvedResult.value);
				resolvedResult.value.dispose();
				return dump;
			});
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
	
	setInterval(context: QuickJSContext, callbackVal: QuickJSHandle, thisVal: QuickJSHandle, timer: number, ...args: QuickJSHandle[]): number {
		if (!this.#intervalMap) throw new Error("intervals disposed");
		if (this.#intervalMap.size >= this.#maxIntervals) throw new Error("too many intervals");
		
		const callbackHandle = callbackVal.dup();
		const thisHandle = thisVal.dup();
		const argHandles = args.map(arg => arg.dup());
		const intervalId = this.intervalId++;
		if (this.intervalId >= Number.MAX_SAFE_INTEGER) this.intervalId = 0;

		const intervalValue = setInterval(() => {
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
	timeoutId = 0;
	#timeoutMap: Map<number, [ReturnType<typeof setInterval>, ...UsingDisposable[]]> | null = new Map();
	readonly #maxTimeouts: number;
	
	constructor(maxTimeouts = Infinity) {
		super();
		this.#maxTimeouts = maxTimeouts;
	}
	
	setTimeout(context: QuickJSContext, callbackVal: QuickJSHandle, thisVal: QuickJSHandle, timer: number, ...args: QuickJSHandle[]): number {
		if (!this.#timeoutMap) throw new Error("timeouts disposed");
		if (this.#timeoutMap.size >= this.#maxTimeouts) throw new Error("too many timeouts");
		
		const callbackHandle = callbackVal.dup();
		const thisHandle = thisVal.dup();
		const argHandles = args.map(arg => arg.dup());
		const timeoutId = this.timeoutId++;
		if (this.timeoutId >= Number.MAX_SAFE_INTEGER) this.timeoutId = 0;
		
		const timeoutValue = setTimeout(() => {
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