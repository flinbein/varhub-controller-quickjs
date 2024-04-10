import { Scope, UsingDisposable } from "quickjs-emscripten";
export class ConsoleManager extends UsingDisposable {
    #console = console;
    #prefix;
    constructor(...prefix) {
        super();
        this.#prefix = prefix;
    }
    settleContext(context) {
        Scope.withScope((scope) => {
            const consoleHandle = scope.manage(context.newObject());
            const consoleMethodNames = ["log", "error", "warn", "info", "debug"];
            for (let consoleMethodName of consoleMethodNames) {
                const methodHandle = scope.manage(context.newFunction(consoleMethodName, (...args) => {
                    const nativeArgs = args.map(context.dump);
                    console[consoleMethodName](...this.#prefix, ...nativeArgs);
                }));
                context.setProp(consoleHandle, consoleMethodName, methodHandle);
            }
            context.setProp(context.global, "console", consoleHandle);
        });
    }
    get alive() {
        return this.#console != null;
    }
    ;
    dispose() {
        this.#console = null;
    }
}
