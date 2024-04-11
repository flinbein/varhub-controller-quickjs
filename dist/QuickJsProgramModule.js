import { Scope, UsingDisposable } from "quickjs-emscripten";
import { wrap, dumpPromisify } from "./utils/wrapper.js";
export class QuickJsProgramModule extends UsingDisposable {
    #context;
    #exports;
    #interruptManager;
    constructor(interruptManager, context, exports) {
        super();
        this.#interruptManager = interruptManager;
        this.#context = context;
        this.#exports = exports;
    }
    getType(propName) {
        return this.#context.getProp(this.#exports, propName)
            .consume((v) => this.#context.typeof(v));
    }
    call(methodName, thisArg = undefined, ...args) {
        const context = this.#context;
        const callResult = this.#callFunction(methodName, thisArg, ...args);
        if (!("value" in callResult)) {
            throw dumpPromisify(context, callResult.error);
        }
        return dumpPromisify(context, callResult.value);
    }
    withCallResult(methodName, thisArg, args, fnAction, errorAction) {
        return Scope.withScope((scope => {
            const callResult = this.#callFunction(methodName, thisArg, ...args);
            if (!("value" in callResult)) {
                return errorAction?.(scope.manage(callResult.error));
            }
            return fnAction?.(scope.manage(callResult.value));
        }));
    }
    #callFunction(methodName, thisArg = undefined, ...args) {
        const context = this.#context;
        return Scope.withScope((scope) => {
            const wrapArg = wrap.bind(this, scope, context);
            const methodHandle = scope.manage(context.getProp(this.#exports, methodName));
            const typeOfMethod = context.typeof(methodHandle);
            if (typeOfMethod !== "function") {
                throw new Error(`no exported function: ${methodName}, ${typeOfMethod}`);
            }
            const thisArgHandle = wrapArg(thisArg);
            const argsHandle = args.map(wrapArg);
            this.#interruptManager.clear();
            return context.callFunction(methodHandle, thisArgHandle, ...argsHandle);
        });
    }
    getProp(propName) {
        const propHandle = this.#context.getProp(this.#exports, propName);
        const result = this.#context.dump(propHandle);
        propHandle.dispose();
        return result;
    }
    withProps(propNames, fnAction) {
        return Scope.withScope((scope) => {
            const handles = propNames.map(prop => scope.manage(this.#context.getProp(this.#exports, prop)));
            return fnAction(...handles);
        });
    }
    dump() {
        return this.#context.dump(this.#exports);
    }
    get alive() {
        return this.#exports.alive;
    }
    dispose() {
        this.#exports.dispose();
    }
}
