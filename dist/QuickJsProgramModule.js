import { Scope, UsingDisposable } from "quickjs-emscripten";
import { ShortLifeValueWrapper } from "./utils/wrapper.js";
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
        this.#interruptManager.clear();
        return this.withModule(wrapper => wrapper.getProp(methodName).callAndDump(thisArg, ...args));
    }
    getProp(propName) {
        this.#interruptManager.clear();
        return this.withModule(wrapper => wrapper.getProp(propName).dump());
    }
    withModule(wrapper) {
        return Scope.withScope(scope => {
            this.#interruptManager.clear();
            return wrapper(new ShortLifeValueWrapper(scope, this.#context, this.#exports, true));
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
