import { QuickJSContext, QuickJSHandle, Scope } from "quickjs-emscripten";
import { Lifetime } from "quickjs-emscripten-core";

export function wrap(scope: Scope, context: QuickJSContext, data: unknown): QuickJSHandle{
	if (data instanceof Lifetime && data.owner === context.runtime) return data;
	if (data === undefined) return scope.manage(context.undefined);
	if (data === null) return scope.manage(context.null);
	if (typeof data === "boolean") return scope.manage(data ? context.true : context.false);
	if (typeof data === "number") return scope.manage(context.newNumber(data));
	if (typeof data === "string") return scope.manage(context.newString(data));
	if (typeof data === "bigint") return scope.manage(context.newBigInt(data));
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

export function dumpPromisify(context: QuickJSContext, valueUnscoped: QuickJSHandle): unknown {
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
		valueUnscoped.dispose();
		return dump;
	});
}