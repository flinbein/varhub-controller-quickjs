import { QuickJSContext, QuickJSHandle, Scope, UsingDisposable } from "quickjs-emscripten"
import { InterruptManager } from "../InterruptManager.js";

export interface ConsoleHandler {
	(level: "log" | "error" | "warn" | "info" | "debug", ...args: unknown[]): void
}
export class ConsoleManager extends UsingDisposable {
	#console: Console | null = console;
	readonly #handler: ConsoleHandler;
	
	constructor(handler: ConsoleHandler) {
		super();
		this.#handler = handler;
	}
	
	settleContext(context: QuickJSContext){
		Scope.withScope((scope) => {
			const consoleHandle = scope.manage(context.newObject())
			const consoleMethodNames = ["log", "error", "warn", "info", "debug"] as const satisfies (keyof typeof console)[];
			for (let consoleMethodName of consoleMethodNames) {
				const methodHandle = scope.manage(context.newFunction(consoleMethodName, (...args: QuickJSHandle[]) => {
					const nativeArgs = args.map(context.dump);
					this.#handler(consoleMethodName, ...nativeArgs);
				}));
				context.setProp(consoleHandle, consoleMethodName, methodHandle)
			}
			context.setProp(context.global, "console", consoleHandle);
		})
	}
	
	
	get alive() {
		return this.#console != null;
	};
	
	dispose() {
		this.#console = null;
	}
}