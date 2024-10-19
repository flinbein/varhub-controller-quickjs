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
        return this.withModule(wrapper => wrapper.getProp(methodName).callAndDump(thisArg, ...args));
    }
    callMethodIgnored(methodName, thisArg = undefined, ...args) {
        this.withModule(wrapper => void wrapper.getProp(methodName).call(thisArg, ...args));
    }
    getProp(propName) {
        return this.withModule(wrapper => wrapper.getProp(propName).dump());
    }
    withModule(wrapper) {
        return Scope.withScope(scope => {
            return this.#interruptManager.handle(() => {
                return wrapper(new ShortLifeValueWrapper(scope, this.#context, this.#interruptManager, this.#exports, true));
            });
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
//# sourceMappingURL=QuickJsProgramModule.js.map