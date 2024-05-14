import { QuickJSContext, QuickJSHandle, Scope, UsingDisposable } from "quickjs-emscripten";
import { Lifetime, VmCallResult } from "quickjs-emscripten-core";

function wrap(scope: Scope, context: QuickJSContext, data: unknown): QuickJSHandle{
	const typedArrayWrap = getTypedArrayWrapper(context);
	const wrappedArray = typedArrayWrap(data);
	if (wrappedArray) return scope.manage(wrappedArray);
	
	if (data instanceof Lifetime && data.owner === context.runtime) return data;
	const innerHandle = handleMap.get(data)
	if (innerHandle) return innerHandle;
	
	if (data === undefined) return scope.manage(context.undefined);
	if (data === null) return scope.manage(context.null);
	if (typeof data === "boolean") return scope.manage(data ? context.true : context.false);
	if (typeof data === "number") return scope.manage(context.newNumber(data));
	if (typeof data === "string") return scope.manage(context.newString(data));
	if (typeof data === "bigint") return scope.manage(context.newBigInt(data));
	if (data instanceof ArrayBuffer) return scope.manage(context.newArrayBuffer(data));
	if (data instanceof Error) return scope.manage(context.newError(data));
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
			context.setProp(objectHandle, dataKey, wrap(scope, context, (data as any)[dataKey]));
		}
		return objectHandle;
	}
	throw new Error(`unwrappable type: ${typeof data}`);
}

function dumpValue(context: QuickJSContext, valueUnscoped: QuickJSHandle): unknown {
	return Scope.withScope(scope => {
		const dumperHandle = scope.manage(getRecursiveDumperCreator(context)());
		const cache = new Map<number, any>;
		
		function extractValue(value: QuickJSHandle): unknown {
			const formResult = context.callFunction(dumperHandle, context.undefined, value);
			const formHandle = scope.manage(context.unwrapResult(formResult));
			const type = context.getProp(formHandle, 0).consume(h => context.getString(h));
			if (type === "null") {
				cache.set(valueUnscoped.value, null);
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
			if (cache.has(id)) return cache.get(id);
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
				const arrayTypeConstructor = (globalThis as any)[arrayType];
				if (!arrayTypeConstructor) return null;
				if (Object.getPrototypeOf(arrayTypeConstructor) !== TypedArray) return null;
				const buffer = context.getProp(formHandle, 3).consume(extractValue);
				const byteOffset = context.getProp(formHandle, 4).consume(h => context.getNumber(h));
				const length = context.getProp(formHandle, 5).consume(h => context.getNumber(h));
				const result = new arrayTypeConstructor(buffer, byteOffset, length);
				cache.set(id, result);
				return result;
			}
			if (type === "array") {
				const length = context.getProp(formHandle, 2).consume(h => context.getNumber(h));
				const result: any[] = [];
				cache.set(id, result);
				context.getProp(formHandle, 3).consume(arrayHandle => {
					for	(let i=0; i < length; i++) {
						result[i] = context.getProp(arrayHandle, i).consume(extractValue);
					}
				});
				return result;
			}
			if (type === "error") {
				const errorConstructorName = context.getProp(formHandle, 2).consume(h => context.getString(h));
				const errorConstructor = (globalThis as any)[errorConstructorName] ?? Error;
				if (!errorConstructor) return null;
				if (!(Object.create(errorConstructor?.prototype) instanceof Error)) return null;
				const result = Object.create(errorConstructor?.prototype);
				cache.set(id, result);
				const keys = context.getProp(formHandle, 3).consume(h => context.dump(h)) as string[];
				context.getProp(formHandle, 4).consume(objHandle => {
					for (let key of keys) {
						result[key] = context.getProp(objHandle, key).consume(extractValue);
					}
				});
				return result;
			}
			if (type === "object") {
				const keys = context.getProp(formHandle, 2).consume(h => context.dump(h)) as string[];
				const result: Record<string, any> = {};
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
		
		return extractValue(valueUnscoped);
	});
}

function dumpPromisify(context: QuickJSContext, valueUnscoped: QuickJSHandle): unknown {
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
		if (valueUnscoped.alive) valueUnscoped.dispose();
		return dump;
	});
}

export function callFunction(context: QuickJSContext, methodHandle: QuickJSHandle, thisArg: unknown = undefined, ...args: unknown[]): VmCallResult<QuickJSHandle> {
	return Scope.withScope((scope) => {
		const wrapArg = wrap.bind(null, scope, context);
		const typeOfMethod = context.typeof(methodHandle);
		if (typeOfMethod !== "function") {
			throw new Error(`not a function: ${typeOfMethod}`);
		}
		const thisArgHandle = wrapArg(thisArg);
		const argsHandle = args.map(wrapArg);
		return context.callFunction(methodHandle, thisArgHandle, ...argsHandle);
	})
}


const handleMap = new WeakMap<any, QuickJSHandle>;


export class ShortLifeContextWrapper extends UsingDisposable {
	#scope: Scope
	#context: QuickJSContext
	constructor(scope: Scope, context: QuickJSContext) {
		super();
		this.#context = context;
		this.#scope = scope;
	}
	
	newFunction(fn: Function){
		const context = this.#context;
		const fnHandle = context.newFunction(fn.name, (...argHandles) => {
			const args = argHandles.map(context.dump);
			try {
				const apiResult = fn(...args);
				if (apiResult instanceof Promise) {
					const promiseHandle = context.newPromise();
					apiResult.then(
						v => Scope.withScope((scope) => promiseHandle.resolve(wrap(scope, context, v))),
						v => Scope.withScope((scope) => promiseHandle.reject(wrap(scope, context, v))),
					).finally(() => {
						promiseHandle.dispose();
						context.runtime.executePendingJobs();
					});
					return promiseHandle.handle;
				}
				let result: QuickJSHandle | undefined;
				void Scope.withScopeAsync(async (fnScope) => {
					result = wrap(fnScope, context, apiResult);
				});
				return result!
			} catch (error) {
				let result: QuickJSHandle | undefined;
				void Scope.withScopeAsync(async (fnScope) => {
					result = wrap(fnScope, context, error);
				});
				return {error: result} as VmCallResult<QuickJSHandle>;
			}
		});
		return new ShortLifeValueWrapper(this.#scope, context, fnHandle);
	}
	
	wrap(jsValue: any){
		return new ShortLifeValueWrapper(this.#scope, this.#context, wrap(this.#scope, this.#context, jsValue));
	}
	
	get alive(){
		return this.#scope.alive;
	}
	
	dispose() {
		this.#scope.dispose();
	}
	
}
export class ShortLifeValueWrapper extends ShortLifeContextWrapper {
	#scope: Scope
	#context: QuickJSContext
	#handle: QuickJSHandle
	constructor(scope: Scope, context: QuickJSContext, handle: QuickJSHandle, keep?: boolean) {
		super(scope, context);
		this.#context = context;
		this.#scope = scope;
		this.#handle = handle;
		if (!keep) scope.manage(handle);
		handleMap.set(this, handle);
	}
	
	getType(): "undefined" | "boolean" | "number" | "bigint" | "string" | "symbol" | "object" | "function" {
		return this.#context.typeof(this.#handle) as any;
	}
	
	isPromise(){
		const promiseState = this.#context.getPromiseState(this.#handle);
		return (promiseState.type !== "fulfilled" || !promiseState.notAPromise);
	}
	
	dump(){
		return dumpPromisify(this.#context, this.#handle);
	}
	
	getProp(key: number | string | ShortLifeValueWrapper){
		const ctxKey = (key instanceof ShortLifeValueWrapper) ? key.#handle : key;
		const handle = this.#context.getProp(this.#handle, ctxKey);
		return new ShortLifeValueWrapper(this.#scope, this.#context, handle);
	}
	
	callMethod(key: number | string | ShortLifeValueWrapper, ...args: unknown[]) {
		const fn = this.getProp(key);
		return fn.call(this.#handle, ...args);
	}
	
	callMethodAndDump(key: number | string | ShortLifeValueWrapper, ...args: unknown[]) {
		const fn = this.getProp(key);
		return fn.callAndDump(this.#handle, ...args);
	}
	
	setProp(key: number | string | ShortLifeValueWrapper, value: unknown){
		const ctxKey = (key instanceof ShortLifeValueWrapper) ? key.#handle : key;
		return Scope.withScope(scope => {
			const valueHandle = wrap(scope, this.#context, value);
			this.#context.setProp(this.#handle, ctxKey, valueHandle);
		});
	}
	
	call(thisArg: unknown = undefined, ...args: unknown[]){
		return Scope.withScope(scope => {
			const thisHandle = wrap(scope, this.#context, thisArg);
			const argHandles = args.map(wrap.bind(undefined, scope, this.#context));
			const callResult = this.#context.callFunction(this.#handle, thisHandle, ...argHandles);
			if (!("value" in callResult)) throw new ShortLifeValueWrapper(this.#scope, this.#context, callResult.error);
			return new ShortLifeValueWrapper(this.#scope, this.#context, callResult.value);
		});
	}
	
	callAndDump(thisArg: unknown = undefined, ...args: unknown[]){
		let callResult: ShortLifeValueWrapper;
		try {
			callResult = this.call(thisArg, ...args);
		} catch (error: any){
			if (error instanceof ShortLifeValueWrapper) {
				throw error.dump();
			}
			throw error;
		}
		return callResult.dump();
	}
	
	get alive(){
		return this.#scope.alive;
	}
	
	dispose() {
		this.#scope.dispose();
	}
}

const _typedArrayDump = Symbol();
function getRecursiveDumperCreator(context: QuickJSContext): () => QuickJSHandle {
	if (_typedArrayDump in context) return context[_typedArrayDump] as any;
	const unwrapCodeResult = context.evalCode(unwrapCode, "", {type: "global", strip: true, strict: true});
	const unwrapFnHandle = context.unwrapResult(unwrapCodeResult);
	
	return (context as any)[_typedArrayDump] = function(){
		const uwResult = context.callFunction(unwrapFnHandle, context.undefined);
		return context.unwrapResult(uwResult);
	}
}

const TypedArray = Object.getPrototypeOf(Uint8Array);
const _typedArrayWrap = Symbol();
function getTypedArrayWrapper(context: QuickJSContext): (array: unknown) => QuickJSHandle | undefined {
	if (_typedArrayWrap in context) return context[_typedArrayWrap] as any;
	const unwrapCodeResult = context.evalCode(wrapArrayCode, "", {type: "global", strip: true, strict: true});
	const wrapFnHandle = context.unwrapResult(unwrapCodeResult);

	return (context as any)[_typedArrayWrap] = function(value: unknown): QuickJSHandle | undefined {
		if (value instanceof ArrayBuffer) return context.newArrayBuffer(value);
		if (!(value instanceof TypedArray)) return undefined;
		const buffer = (value as any).buffer as ArrayBuffer;
		const bufferPart = buffer.slice((value as any).byteOffset, (value as any).byteOffset + (value as any).byteLength);
		const bufferName = String(value?.constructor?.name);
		const nameHandle = context.newString(bufferName);
		const bufferHandle = context.newArrayBuffer(bufferPart);
		const arrayResult = context.callFunction(wrapFnHandle, context.undefined, nameHandle, bufferHandle);
		nameHandle.dispose();
		bufferHandle.dispose();
		return context.unwrapResult(arrayResult);
	}
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
`

// language=javascript
const wrapArrayCode = `
	(type, buffer) => {
        if (type === "ArrayBuffer") return buffer;
        return new globalThis[type](buffer);
	}
`