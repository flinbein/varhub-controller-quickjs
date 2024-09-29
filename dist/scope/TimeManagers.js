import { UsingDisposable } from "quickjs-emscripten";
export class QuickJSIntervalManager extends UsingDisposable {
    intervalId = 0;
    #intervalMap = new Map();
    #maxIntervals;
    #ownedDisposableItems = new Set();
    constructor(maxIntervals = Infinity) {
        super();
        this.#maxIntervals = maxIntervals;
    }
    setInterval(context, interruptManager, callbackVal, thisVal, timer, ...args) {
        if (!this.#intervalMap)
            throw new Error("intervals disposed");
        if (this.#intervalMap.size >= this.#maxIntervals)
            throw new Error("too many intervals");
        const callbackHandle = callbackVal.dup();
        const thisHandle = thisVal.dup();
        const argHandles = args.map(arg => arg.dup());
        const intervalId = this.intervalId++;
        if (this.intervalId >= Number.MAX_SAFE_INTEGER)
            this.intervalId = 0;
        const intervalValue = setInterval(() => {
            interruptManager.handleIgnoreErrors(() => {
                const callResult = context.callFunction(callbackHandle, thisHandle, ...argHandles);
                const jobs = context.runtime.executePendingJobs();
                jobs?.error?.dispose();
                context.unwrapResult(callResult).dispose();
            });
        }, timer);
        this.#intervalMap.set(intervalId, [intervalValue, callbackHandle, thisHandle, ...argHandles]);
        return intervalId;
    }
    clearInterval(intervalId) {
        if (!this.#intervalMap)
            throw new Error("intervals disposed");
        const intervalData = this.#intervalMap.get(intervalId);
        if (!intervalData)
            return;
        this.#intervalMap.delete(intervalId);
        const [intervalValue, ...garbage] = intervalData;
        clearInterval(intervalValue);
        for (const disposable of garbage) {
            disposable.dispose();
        }
    }
    get alive() {
        return this.#intervalMap != null;
    }
    dispose() {
        if (!this.#intervalMap)
            return;
        for (const [interval, ...garbage] of this.#intervalMap?.values()) {
            clearInterval(interval);
            for (const disposable of garbage) {
                disposable.dispose();
            }
        }
        this.#intervalMap?.clear();
        this.#intervalMap = null;
    }
    settleContext(context, interruptManager) {
        const manager = this;
        const setIntervalHandle = context.newFunction("setInterval", function (callbackArg, delayArg, ...args) {
            const delayMs = context.getNumber(delayArg);
            const intervalId = manager.setInterval(context, interruptManager, callbackArg, this, delayMs, ...args);
            return context.newNumber(intervalId);
        });
        const clearIntervalHandle = context.newFunction("clearInterval", (intervalIdHandle) => {
            manager.clearInterval(context.getNumber(intervalIdHandle));
            return context.undefined;
        });
        context.setProp(context.global, "setInterval", setIntervalHandle);
        context.setProp(context.global, "clearInterval", clearIntervalHandle);
        setIntervalHandle.dispose();
        clearIntervalHandle.dispose();
    }
}
export class QuickJSTimeoutManager extends UsingDisposable {
    #timeoutId = 0;
    #timeoutMap = new Map();
    #maxTimeouts;
    constructor(maxTimeouts = Infinity) {
        super();
        this.#maxTimeouts = maxTimeouts;
    }
    setTimeout(context, interruptManager, callbackVal, thisVal, timer, ...args) {
        if (!this.#timeoutMap)
            throw new Error("timeouts disposed");
        if (this.#timeoutMap.size >= this.#maxTimeouts)
            throw new Error("too many timeouts");
        const callbackHandle = callbackVal.dup();
        const thisHandle = thisVal.dup();
        const argHandles = args.map(arg => arg.dup());
        const timeoutId = this.#timeoutId++;
        if (this.#timeoutId >= Number.MAX_SAFE_INTEGER)
            this.#timeoutId = 0;
        const timeoutValue = setTimeout(() => {
            interruptManager.handleIgnoreErrors(() => {
                const callResult = context.callFunction(callbackHandle, thisHandle, ...argHandles);
                this.#timeoutMap?.delete(timeoutId);
                for (let disposable of [thisHandle, callbackHandle, ...argHandles]) {
                    disposable.dispose();
                }
                const jobs = context.runtime.executePendingJobs();
                jobs?.error?.dispose();
                context.unwrapResult(callResult).dispose();
            });
        }, timer);
        this.#timeoutMap.set(timeoutId, [timeoutValue, callbackHandle, thisHandle, ...argHandles]);
        return timeoutId;
    }
    clearTimeout(timeoutId) {
        if (!this.#timeoutMap)
            throw new Error("timeouts disposed");
        const timeoutData = this.#timeoutMap.get(timeoutId);
        if (!timeoutData)
            return;
        this.#timeoutMap.delete(timeoutId);
        const [timeoutValue, ...garbage] = timeoutData;
        clearTimeout(timeoutValue);
        for (const disposable of garbage) {
            disposable.dispose();
        }
    }
    get alive() {
        return this.#timeoutMap != null;
    }
    settleContext(context, interruptManager) {
        const manager = this;
        const setTimeoutHandle = context.newFunction("setTimeout", function (callbackArg, delayArg, ...args) {
            const delayMs = context.getNumber(delayArg);
            const timeoutId = manager.setTimeout(context, interruptManager, callbackArg, this, delayMs, ...args);
            return context.newNumber(timeoutId);
        });
        const clearTimeoutHandle = context.newFunction("clearTimeout", (timeoutIdHandle) => {
            manager.clearTimeout(context.getNumber(timeoutIdHandle));
            return context.undefined;
        });
        context.setProp(context.global, "setTimeout", setTimeoutHandle);
        context.setProp(context.global, "clearTimeout", clearTimeoutHandle);
        setTimeoutHandle.dispose();
        clearTimeoutHandle.dispose();
    }
    dispose() {
        if (!this.#timeoutMap)
            return;
        for (const [interval, ...garbage] of this.#timeoutMap.values()) {
            clearInterval(interval);
            for (const disposable of garbage) {
                disposable.dispose();
            }
        }
        this.#timeoutMap.clear();
        this.#timeoutMap = null;
    }
}
export class QuickJSImmediateManager extends UsingDisposable {
    #immediateId = 0;
    #immediateMap = new Map();
    #maxImmediateItems;
    constructor(maxImmediateItems = Infinity) {
        super();
        this.#maxImmediateItems = maxImmediateItems;
    }
    setImmediate(context, interruptManager, callbackVal, thisVal, ...args) {
        if (!this.#immediateMap)
            throw new Error("immediate disposed");
        if (this.#immediateMap.size >= this.#maxImmediateItems)
            throw new Error("too many immediate");
        const callbackHandle = callbackVal.dup();
        const thisHandle = thisVal.dup();
        const argHandles = args.map(arg => arg.dup());
        const timeoutId = this.#immediateId++;
        if (this.#immediateId >= Number.MAX_SAFE_INTEGER)
            this.#immediateId = 0;
        const immediateValue = setImmediate(() => {
            interruptManager.handleIgnoreErrors(() => {
                const callResult = context.callFunction(callbackHandle, thisHandle, ...argHandles);
                this.#immediateMap?.delete(timeoutId);
                for (let disposable of [thisHandle, callbackHandle, ...argHandles]) {
                    disposable.dispose();
                }
                const jobs = context.runtime.executePendingJobs();
                jobs?.error?.dispose();
                context.unwrapResult(callResult).dispose();
            });
        });
        this.#immediateMap.set(timeoutId, [immediateValue, callbackHandle, thisHandle, ...argHandles]);
        return timeoutId;
    }
    clearImmediate(immediateId) {
        if (!this.#immediateMap)
            throw new Error("timeouts disposed");
        const immediateData = this.#immediateMap.get(immediateId);
        if (!immediateData)
            return;
        this.#immediateMap.delete(immediateId);
        const [immediateValue, ...garbage] = immediateData;
        clearImmediate(immediateValue);
        for (const disposable of garbage) {
            disposable.dispose();
        }
    }
    get alive() {
        return this.#immediateMap != null;
    }
    settleContext(context, interruptManager) {
        const manager = this;
        const setImmediateHandle = context.newFunction("setImmediate", function (callbackArg, ...args) {
            const timeoutId = manager.setImmediate(context, interruptManager, callbackArg, this, ...args);
            return context.newNumber(timeoutId);
        });
        const clearImmediateHandle = context.newFunction("clearImmediate", (immediateIdHandle) => {
            manager.clearImmediate(context.getNumber(immediateIdHandle));
            return context.undefined;
        });
        context.setProp(context.global, "setImmediate", setImmediateHandle);
        context.setProp(context.global, "clearImmediate", clearImmediateHandle);
        setImmediateHandle.dispose();
        clearImmediateHandle.dispose();
    }
    dispose() {
        if (!this.#immediateMap)
            return;
        for (const [immediateValue, ...garbage] of this.#immediateMap.values()) {
            clearImmediate(immediateValue);
            for (const disposable of garbage) {
                disposable.dispose();
            }
        }
        this.#immediateMap.clear();
        this.#immediateMap = null;
    }
}
//# sourceMappingURL=TimeManagers.js.map