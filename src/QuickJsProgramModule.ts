import type  { InterruptManager } from "./InterruptManager.js";
import { type QuickJSContext, type QuickJSHandle, Scope, UsingDisposable } from "quickjs-emscripten"
import { ShortLifeContextWrapper, ShortLifeValueWrapper } from "./utils/wrapper.js"

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
		return this.withModule(wrapper => wrapper.getProp(methodName).callAndDump(thisArg, ...args));
	}
	
	callMethodIgnored(methodName: string, thisArg: unknown = undefined, ...args: unknown[]): void {
		this.withModule(wrapper => void wrapper.getProp(methodName).call(thisArg, ...args));
	}
	
	getProp(propName: string) {
		return this.withModule(wrapper => wrapper.getProp(propName).dump());
	}
	
	withModule<T>(wrapper: (wrapper: ShortLifeValueWrapper) => T extends ShortLifeContextWrapper ? "do not return wrapped value! call .dump()" : T): T {
		return Scope.withScope(scope => {
			return this.#interruptManager.handle(() => {
				return wrapper(new ShortLifeValueWrapper(scope, this.#context, this.#interruptManager, this.#exports, true));
			});
		}) as T;
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
