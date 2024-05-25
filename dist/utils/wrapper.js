import { Scope, UsingDisposable } from "quickjs-emscripten";
import { Lifetime } from "quickjs-emscripten-core";
export function init(context) {
    getRecursiveDumperCreator(context);
    getTypedArrayWrapper(context);
    getStructureDumpSymbolHandle(context);
}
function wrap(scope, context, data) {
    const typedArrayWrap = getTypedArrayWrapper(context);
    const wrappedArray = typedArrayWrap(data);
    if (wrappedArray)
        return scope.manage(wrappedArray);
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
function dumpValue(context, valueUnscoped) {
    //fast-dump
    const type = context.typeof(valueUnscoped);
    if (type === "undefined")
        return undefined;
    if (type !== "object")
        return context.dump(valueUnscoped);
    return Scope.withScope(scope => {
        const structureDumpSymbolHandle = getStructureDumpSymbolHandle(context);
        const structureHandle = scope.manage(context.getProp(valueUnscoped, structureDumpSymbolHandle));
        const typeOfStructure = context.typeof(structureHandle);
        if (typeOfStructure === "unknown")
            return null; // valueUnscoped is null or undefined. In this case = null;
        if (typeOfStructure === "undefined")
            return context.dump(valueUnscoped);
        const dumperHandle = scope.manage(getRecursiveDumperCreator(context)());
        const cache = new Map;
        function extractValue(value) {
            const formResult = context.callFunction(dumperHandle, context.undefined, value);
            const formHandle = scope.manage(context.unwrapResult(formResult));
            const type = context.getProp(formHandle, 0).consume(h => context.getString(h));
            if (type === "null") {
                return null;
            }
            if (type === "primitive") {
                return context.getProp(formHandle, 1).consume(h => context.dump(h));
            }
            if (type === "dump") {
                const id = context.getProp(formHandle, 1).consume(h => context.getNumber(h));
                const result = context.getProp(formHandle, 2).consume(h => context.dump(h));
                cache.set(id, result);
                return result;
            }
            const id = context.getProp(formHandle, 1).consume(h => context.getNumber(h));
            if (cache.has(id))
                return cache.get(id);
            if (type === "buffer") {
                const lifeBuffer = context.getProp(formHandle, 2).consume(h => context.getArrayBuffer(h));
                scope.manage(lifeBuffer);
                const u8 = lifeBuffer.value;
                const result = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
                cache.set(id, result);
                return result;
            }
            if (type === "typedArray") {
                const arrayType = context.getProp(formHandle, 2).consume(h => context.getString(h));
                const arrayTypeConstructor = globalThis[arrayType];
                if (!arrayTypeConstructor)
                    return null;
                if (Object.getPrototypeOf(arrayTypeConstructor) !== TypedArray)
                    return null;
                const buffer = context.getProp(formHandle, 3).consume(extractValue);
                const byteOffset = context.getProp(formHandle, 4).consume(h => context.getNumber(h));
                const length = context.getProp(formHandle, 5).consume(h => context.getNumber(h));
                const result = new arrayTypeConstructor(buffer, byteOffset, length);
                cache.set(id, result);
                return result;
            }
            if (type === "array") {
                const length = context.getProp(formHandle, 2).consume(h => context.getNumber(h));
                const result = [];
                cache.set(id, result);
                context.getProp(formHandle, 3).consume(arrayHandle => {
                    for (let i = 0; i < length; i++) {
                        result[i] = context.getProp(arrayHandle, i).consume(extractValue);
                    }
                });
                return result;
            }
            if (type === "error") {
                const errorConstructorName = context.getProp(formHandle, 2).consume(h => context.getString(h));
                const errorConstructor = globalThis[errorConstructorName] ?? Error;
                if (!errorConstructor)
                    return null;
                if (!(Object.create(errorConstructor?.prototype) instanceof Error))
                    return null;
                const result = Object.create(errorConstructor?.prototype);
                cache.set(id, result);
                const keys = context.getProp(formHandle, 3).consume(h => context.dump(h));
                context.getProp(formHandle, 4).consume(objHandle => {
                    for (let key of keys) {
                        result[key] = context.getProp(objHandle, key).consume(extractValue);
                    }
                });
                return result;
            }
            if (type === "object") {
                const keys = context.getProp(formHandle, 2).consume(h => context.dump(h));
                const result = {};
                cache.set(id, result);
                context.getProp(formHandle, 3).consume(objHandle => {
                    for (let key of keys) {
                        result[key] = context.getProp(objHandle, key).consume(extractValue);
                    }
                });
                return result;
            }
            return null;
        }
        return extractValue(structureHandle);
    });
}
function dumpPromisify(context, valueUnscoped) {
    const promiseState = context.getPromiseState(valueUnscoped);
    if (promiseState.type === "fulfilled" && promiseState.notAPromise) {
        const dump = dumpValue(context, valueUnscoped);
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
            const dump = dumpValue(context, resolvedResult.error);
            resolvedResult.error.dispose();
            throw dump;
        }
        const dump = dumpValue(context, resolvedResult.value);
        resolvedResult.value.dispose();
        if (valueUnscoped.alive)
            valueUnscoped.dispose();
        return dump;
    });
}
const handleMap = new WeakMap;
export class ShortLifeContextWrapper extends UsingDisposable {
    #scope;
    #context;
    #interruptManager;
    constructor(scope, context, interruptManager) {
        super();
        this.#context = context;
        this.#scope = scope;
        this.#interruptManager = interruptManager;
    }
    newFunction(fn) {
        const context = this.#context;
        const fnHandle = context.newFunction(fn.name, (...argHandles) => {
            const args = argHandles.map(context.dump);
            try {
                const apiResult = fn(...args);
                if (apiResult instanceof Promise) {
                    const promiseHandle = context.newPromise();
                    apiResult.then(v => Scope.withScope((scope) => {
                        promiseHandle.resolve(wrap(scope, context, v));
                    }), v => Scope.withScope((scope) => {
                        promiseHandle.reject(wrap(scope, context, v));
                    })).finally(() => {
                        promiseHandle.dispose();
                        this.#interruptManager.handle(() => {
                            const jobs = context.runtime.executePendingJobs();
                            jobs?.error?.dispose();
                        });
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
        return new ShortLifeValueWrapper(this.#scope, context, this.#interruptManager, fnHandle);
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
    #interruptManager;
    constructor(scope, context, interruptManager, handle, keep) {
        super(scope, context, interruptManager);
        this.#context = context;
        this.#scope = scope;
        this.#handle = handle;
        this.#interruptManager = interruptManager;
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
        return new ShortLifeValueWrapper(this.#scope, this.#context, this.#interruptManager, handle);
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
                throw this.#next(callResult.error);
            return this.#next(callResult.value);
        });
    }
    callAndDump(thisArg = undefined, ...args) {
        let callResult;
        try {
            callResult = this.call(thisArg, ...args);
        }
        catch (error) {
            if (error instanceof ShortLifeValueWrapper) {
                throw error.dump();
            }
            throw error;
        }
        return callResult.dump();
    }
    get alive() {
        return this.#scope.alive;
    }
    dispose() {
        this.#scope.dispose();
    }
    #next(handle) {
        return new ShortLifeValueWrapper(this.#scope, this.#context, this.#interruptManager, handle);
    }
}
const _typedArrayDump = Symbol();
function getRecursiveDumperCreator(context) {
    if (_typedArrayDump in context)
        return context[_typedArrayDump];
    const unwrapCodeResult = context.evalCode(unwrapCode, "", { type: "global", strip: false, strict: true });
    const unwrapFnHandle = context.unwrapResult(unwrapCodeResult);
    return context[_typedArrayDump] = function () {
        const uwResult = context.callFunction(unwrapFnHandle, context.undefined);
        return context.unwrapResult(uwResult);
    };
}
const TypedArray = Object.getPrototypeOf(Uint8Array);
const _typedArrayWrap = Symbol();
function getTypedArrayWrapper(context) {
    if (_typedArrayWrap in context)
        return context[_typedArrayWrap];
    const unwrapCodeResult = context.evalCode(wrapArrayCode, "", { type: "global", strip: false, strict: true });
    const wrapFnHandle = context.unwrapResult(unwrapCodeResult);
    return context[_typedArrayWrap] = function (value) {
        if (value instanceof ArrayBuffer)
            return context.newArrayBuffer(value);
        if (!(value instanceof TypedArray))
            return undefined;
        const buffer = value.buffer;
        const bufferPart = buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
        const bufferName = String(value?.constructor?.name);
        const nameHandle = context.newString(bufferName);
        const bufferHandle = context.newArrayBuffer(bufferPart);
        const arrayResult = context.callFunction(wrapFnHandle, context.undefined, nameHandle, bufferHandle);
        nameHandle.dispose();
        bufferHandle.dispose();
        return context.unwrapResult(arrayResult);
    };
}
// language=javascript
const unwrapCode = `
    const TypedArray = Object.getPrototypeOf(Uint8Array);
    () => {
        const idWeakMap = new WeakMap();
        let _id = 0;
        const getId = (obj) => {
            if (idWeakMap.has(obj)) return idWeakMap.get(obj);
            const id = _id++;
            idWeakMap.set(obj, id);
            return id;
		}
        
        return (value) => {
            if (value === null) return ["null"];
            if (typeof value !== "object") return ["primitive", value];
            const id = getId(value);
            if (value instanceof Error) {
                const names = Object.getOwnPropertyNames(value);
                if (!names.includes("name")) names.push("name");
                return ["error", id, value?.constructor?.name, names, value];
            }
            if (value instanceof ArrayBuffer) {
                return ["buffer", id, value];
            }
            if (Array.isArray(value)) {
                return ["array", id, value.length, value];
            }
            if (value instanceof TypedArray) {
                return ["typedArray", id, value.constructor?.name, value.buffer, value.byteOffset, value.length];
            }
            const keys = Object.getOwnPropertyNames(value);
            return ["object", id, keys, value];
        }

    }
`;
// language=javascript
const wrapArrayCode = `
	(type, buffer) => {
        if (type === "ArrayBuffer") return buffer;
        return new globalThis[type](buffer);
	}
`;
const _StructureDumpSymbolHandleKey = Symbol();
function getStructureDumpSymbolHandle(context) {
    if (_StructureDumpSymbolHandleKey in context)
        return context[_StructureDumpSymbolHandleKey];
    return context[_StructureDumpSymbolHandleKey] = context.newSymbolFor("varhub.structure");
}
