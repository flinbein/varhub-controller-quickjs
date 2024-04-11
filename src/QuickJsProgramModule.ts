import {
	QuickJSContext,
	QuickJSHandle,
	Scope,
	UsingDisposable
} from "quickjs-emscripten"
import { Lifetime, VmCallResult } from "quickjs-emscripten-core";
import { wrap, dumpPromisify } from "./utils/wrapper.js"
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

	getType(propName: string){
		return this.#context.getProp(this.#exports, propName)
			.consume((v) => this.#context.typeof(v))
		;
	}
	
	call(methodName: string, thisArg: unknown = undefined, ...args: unknown[]): unknown {
		const context = this.#context;
		const callResult = this.#callFunction(methodName, thisArg, ...args);
		if (!("value" in callResult)) {
			throw dumpPromisify(context, callResult.error);
		}
		return dumpPromisify(context, callResult.value);
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
			const wrapArg = wrap.bind(this, scope, context);
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