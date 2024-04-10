import {
	QuickJSContext,
	QuickJSHandle,
	QuickJSRuntime,
	QuickJSWASMModule,
	Scope,
	UsingDisposable
} from "quickjs-emscripten"
import { Lifetime, VmCallResult } from "quickjs-emscripten-core";
import url from 'node:url';
import {QuickJSTimeoutManager, QuickJSImmediateManager, QuickJSIntervalManager} from "./scope/TimeManagers.js"
import { ConsoleManager } from "./scope/ConsoleManager.js";
import {hrtime} from "node:process";
import { InterruptManager } from "./InterruptManager.js";

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

export class QuickJsProgramModule extends UsingDisposable {
	readonly #context: QuickJSContext;
	readonly #exports: QuickJSHandle;
	readonly #interruptManager: InterruptManager;
	
	constructor(interruptManager: InterruptManager, context: QuickJSContext, exports: QuickJSHandle) {
		super();
		this.#interruptManager = interruptManager;
		this.#context = context;
		this.#exports = exports;
	}

	call(methodName: string, thisArg: unknown = undefined, ...args: unknown[]): unknown {
		const context = this.#context;
		const callResult = this.#callFunction(methodName, thisArg, ...args);
		if (!("value" in callResult)) {
			throw this.#dumpPromisify(context, callResult.error);
		}
		return this.#dumpPromisify(context, callResult.value);
	}
	
	withCallResult<T = undefined>(
		methodName: string,
		thisArg: unknown,
		args: unknown[],
		fnAction?: (handle: QuickJSHandle) => T,
		errorAction?: (handle: QuickJSHandle) => T
	): T {
		return Scope.withScope((scope => {
			const callResult = this.#callFunction(methodName, thisArg, ...args);
			if (!("value" in callResult)) {
				return errorAction?.(scope.manage(callResult.error));
			}
			return fnAction?.(scope.manage(callResult.value));
		})) as T;
	}
	
	#callFunction(methodName: string, thisArg: unknown = undefined, ...args: unknown[]): VmCallResult<QuickJSHandle> {
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
			this.#interruptManager.clear();
			return context.callFunction(methodHandle, thisArgHandle, ...argsHandle);
		})
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
								v => Scope.withScope((scope) => promiseHandle.resolve(this.#wrap(scope, context, v))),
								v => Scope.withScope((scope) => promiseHandle.reject(this.#wrap(scope, context, v))),
							).finally(() => {
								promiseHandle.dispose();
								context.runtime.executePendingJobs();
							});
							return promiseHandle.handle;
						}
						let result: QuickJSHandle | undefined;
						void Scope.withScopeAsync(async (fnScope) => {
							result = this.#wrap(fnScope, context, apiResult);
						});
						return result!
					} catch (error) {
						let result: QuickJSHandle | undefined;
						void Scope.withScopeAsync(async (fnScope) => {
							result = this.#wrap(fnScope, context, error);
						});
						return {error: result} as VmCallResult<QuickJSHandle>;
					}
				}));
			});
			return fnAction(...fnHandleList);
		})
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
	
	withProps<T>(propNames: string[], fnAction: (...handles: QuickJSHandle[]) => T) : T {
		return Scope.withScope((scope) => {
			const handles = propNames.map(prop => scope.manage(this.#context.getProp(this.#exports, prop)));
			return fnAction(...handles);
		});
	}
	
	dump() {
		return this.#context.dump(this.#exports);
	}
	
	get alive(){
		return this.#exports.alive;
	}
	
	dispose() {
		this.#exports.dispose();
	}
}