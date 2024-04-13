import { Scope, UsingDisposable } from "quickjs-emscripten";
import { Lifetime } from "quickjs-emscripten-core";
function wrap(scope, context, data) {
    if (data instanceof Lifetime && data.owner === context.runtime)
        return data;
    const innerHandle = handleMap.get(data);
    if (innerHandle)
        return innerHandle;
    if (data === undefined)
        return scope.manage(context.undefined);
    if (data === null)
        return scope.manage(context.null);
    if (typeof data === "boolean")
        return scope.manage(data ? context.true : context.false);
    if (typeof data === "number")
        return scope.manage(context.newNumber(data));
    if (typeof data === "string")
        return scope.manage(context.newString(data));
    if (typeof data === "bigint")
        return scope.manage(context.newBigInt(data));
    if (data instanceof ArrayBuffer)
        return scope.manage(context.newArrayBuffer(data));
    if (data instanceof Error)
        return scope.manage(context.newError(data));
    if (Array.isArray(data)) {
        const arrayHandle = scope.manage(context.newArray());
        for (let i = 0; i < data.length; i++) {
            context.setProp(arrayHandle, i, wrap(scope, context, data[i]));
        }
        return arrayHandle;
    }
    if (typeof data === "object") {
        const objectHandle = scope.manage(context.newObject());
        for (const dataKey in data) {
            context.setProp(objectHandle, dataKey, wrap(scope, context, data[dataKey]));
        }
        return objectHandle;
    }
    throw new Error(`unwrappable type: ${typeof data}`);
}
function dumpPromisify(context, valueUnscoped) {
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
        const error = dumpPromisify(context, promiseState.error);
        return Promise.reject(error);
    }
    return context.resolvePromise(valueUnscoped).then(resolvedResult => {
        if (!("value" in resolvedResult)) {
            const innerPromiseState = context.getPromiseState(resolvedResult.error);
            if (innerPromiseState.type !== "fulfilled" || !innerPromiseState.notAPromise) {
                throw dumpPromisify(context, resolvedResult.error);
            }
            const dump = context.dump(resolvedResult.error);
            resolvedResult.error.dispose();
            throw dump;
        }
        const dump = context.dump(resolvedResult.value);
        resolvedResult.value.dispose();
        if (valueUnscoped.alive)
            valueUnscoped.dispose();
        return dump;
    });
}
export function callFunction(context, methodHandle, thisArg = undefined, ...args) {
    return Scope.withScope((scope) => {
        const wrapArg = wrap.bind(null, scope, context);
        const typeOfMethod = context.typeof(methodHandle);
        if (typeOfMethod !== "function") {
            throw new Error(`not a function: ${typeOfMethod}`);
        }
        const thisArgHandle = wrapArg(thisArg);
        const argsHandle = args.map(wrapArg);
        return context.callFunction(methodHandle, thisArgHandle, ...argsHandle);
    });
}
const handleMap = new WeakMap;
export class ShortLifeContextWrapper extends UsingDisposable {
    #scope;
    #context;
    constructor(scope, context) {
        super();
        this.#context = context;
        this.#scope = scope;
    }
    newFunction(fn) {
        const context = this.#context;
        const fnHandle = context.newFunction(fn.name, (...argHandles) => {
            const args = argHandles.map(context.dump);
            try {
                const apiResult = fn(...args);
                if (apiResult instanceof Promise) {
                    const promiseHandle = context.newPromise();
                    apiResult.then(v => Scope.withScope((scope) => promiseHandle.resolve(wrap(scope, context, v))), v => Scope.withScope((scope) => promiseHandle.reject(wrap(scope, context, v)))).finally(() => {
                        promiseHandle.dispose();
                        context.runtime.executePendingJobs();
                    });
                    return promiseHandle.handle;
                }
                let result;
                void Scope.withScopeAsync(async (fnScope) => {
                    result = wrap(fnScope, context, apiResult);
                });
                return result;
            }
            catch (error) {
                let result;
                void Scope.withScopeAsync(async (fnScope) => {
                    result = wrap(fnScope, context, error);
                });
                return { error: result };
            }
        });
        return new ShortLifeValueWrapper(this.#scope, context, fnHandle);
    }
    wrap(jsValue) {
        return new ShortLifeValueWrapper(this.#scope, this.#context, wrap(this.#scope, this.#context, jsValue));
    }
    get alive() {
        return this.#scope.alive;
    }
    dispose() {
        this.#scope.dispose();
    }
}
export class ShortLifeValueWrapper extends ShortLifeContextWrapper {
    #scope;
    #context;
    #handle;
    constructor(scope, context, handle, keep) {
        super(scope, context);
        this.#context = context;
        this.#scope = scope;
        this.#handle = handle;
        if (!keep)
            scope.manage(handle);
        handleMap.set(this, handle);
    }
    getType() {
        return this.#context.typeof(this.#handle);
    }
    isPromise() {
        const promiseState = this.#context.getPromiseState(this.#handle);
        return (promiseState.type !== "fulfilled" || !promiseState.notAPromise);
    }
    dump() {
        return dumpPromisify(this.#context, this.#handle);
    }
    getProp(key) {
        const ctxKey = (key instanceof ShortLifeValueWrapper) ? key.#handle : key;
        const handle = this.#context.getProp(this.#handle, ctxKey);
        return new ShortLifeValueWrapper(this.#scope, this.#context, handle);
    }
    callMethod(key, ...args) {
        const fn = this.getProp(key);
        return fn.call(this.#handle, ...args);
    }
    callMethodAndDump(key, ...args) {
        const fn = this.getProp(key);
        return fn.callAndDump(this.#handle, ...args);
    }
    setProp(key, value) {
        const ctxKey = (key instanceof ShortLifeValueWrapper) ? key.#handle : key;
        return Scope.withScope(scope => {
            const valueHandle = wrap(scope, this.#context, value);
            this.#context.setProp(this.#handle, ctxKey, valueHandle);
        });
    }
    call(thisArg = undefined, ...args) {
        return Scope.withScope(scope => {
            const thisHandle = wrap(scope, this.#context, thisArg);
            const argHandles = args.map(wrap.bind(undefined, scope, this.#context));
            const callResult = this.#context.callFunction(this.#handle, thisHandle, ...argHandles);
            if (!("value" in callResult))
                throw new ShortLifeValueWrapper(this.#scope, this.#context, callResult.error);
            return new ShortLifeValueWrapper(this.#scope, this.#context, callResult.value);
        });
    }
    callAndDump(thisArg = undefined, ...args) {
        try {
            return this.call(thisArg, ...args).dump();
        }
        catch (error) {
            throw error.dump();
        }
    }
    get alive() {
        return this.#scope.alive;
    }
    dispose() {
        this.#scope.dispose();
    }
}
