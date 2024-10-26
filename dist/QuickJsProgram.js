import { Scope, UsingDisposable } from "quickjs-emscripten";
import url from 'node:url';
import { QuickJSImmediateManager, QuickJSIntervalManager, QuickJSTimeoutManager } from "./scope/TimeManagers.js";
import { ShortLifeContextWrapper, init } from "./utils/wrapper.js";
import { ConsoleManager } from "./scope/ConsoleManager.js";
import { InterruptManager } from "./InterruptManager.js";
import { QuickJsProgramModule } from "./QuickJsProgramModule.js";
export class QuickJsProgram extends UsingDisposable {
    #alive = true;
    #getSource;
    #context;
    #intervalManager = new QuickJSIntervalManager(5000);
    #timeoutManager = new QuickJSTimeoutManager(5000);
    #immediateManager = new QuickJSImmediateManager(5000);
    #interruptManager = new InterruptManager(1000000n, 100000000n, 20000000n);
    #ownedDisposableItems = new Set([
        this.#timeoutManager,
        this.#intervalManager,
        this.#immediateManager,
    ]);
    #builtinModuleNames = new Set;
    #disposeHandler;
    constructor(quickJS, getSource, settings = {}) {
        super();
        this.#disposeHandler = settings.disposeHandler;
        this.#getSource = getSource;
        const context = this.#context = quickJS.newContext();
        context.runtime.setMemoryLimit(100000000);
        init(context);
        this.#intervalManager.settleContext(context, this.#interruptManager);
        this.#timeoutManager.settleContext(context, this.#interruptManager);
        this.#immediateManager.settleContext(context, this.#interruptManager);
        if (settings.consoleHandler) {
            const consoleManager = new ConsoleManager(settings.consoleHandler);
            this.#ownedDisposableItems.add(consoleManager);
            consoleManager.settleContext(context);
        }
        this.#ownedDisposableItems.add(context);
        const runtime = context.runtime;
        runtime.setInterruptHandler(this.#interruptManager.onInterrupt);
        runtime.setModuleLoader(this.#moduleLoader.bind(this), this.#moduleNormalizer.bind(this));
    }
    #moduleLoader(moduleName, context) {
        if (moduleName.startsWith("#"))
            throw new Error(`module not found: ${moduleName}`);
        const source = this.#getSource(moduleName, this);
        if (!source)
            throw new Error(`module not found: ${moduleName}`);
        if (typeof source === "string")
            return this.#fixModuleContent(moduleName, source);
        return source.then((res) => {
            if (typeof res === "string")
                return this.#fixModuleContent(moduleName, res);
            throw new Error(`module not found: ${moduleName}`);
        }).finally(() => {
            const jobs = context.runtime.executePendingJobs();
            jobs?.error?.dispose();
        });
    }
    #fixModuleContent(moduleName, source) {
        let ext = moduleName.match(/\.([^/.:#?\n]+)(?:$|\?|#)/)?.[1];
        if (!ext)
            return source;
        if (ext === "js" || ext === "mjs" || ext === "cjs")
            return source;
        if (ext === "json" || ext === "json5")
            return `export default ${source}`;
        return `export default ${JSON.stringify(source)}`;
    }
    #moduleNormalizer(base, importText, context) {
        if (importText.startsWith("#")) {
            return base + importText;
        }
        if (importText.includes("#") && !this.#builtinModuleNames.has(base)) {
            return `# ${JSON.stringify(String(importText))} is private. Imported from ${JSON.stringify(String(base))}`;
        }
        if (importText.startsWith(".") || importText.startsWith("/")) {
            return url.resolve(base, importText);
        }
        return importText.startsWith(".") ? url.resolve(base, importText) : importText;
    }
    #loadedModules = new Map();
    createModule(moduleName, src, builtin) {
        if (builtin)
            this.#builtinModuleNames.add(moduleName);
        if (src === undefined) {
            const requestedSource = this.#getSource(moduleName, this);
            if (typeof requestedSource !== "string")
                throw new Error(`module source not found: ${moduleName}`);
            src = requestedSource;
        }
        const callResult = this.#interruptManager.handle(() => {
            return this.#context.evalCode(src, moduleName, { type: "module", strict: true, strip: true });
        }, 50000000n);
        return this.#createModuleByCallResult(moduleName, callResult);
    }
    async createModuleAsync(moduleName, src, builtin) {
        if (builtin)
            this.#builtinModuleNames.add(moduleName);
        if (src === undefined) {
            const requestedSource = await this.#getSource(moduleName, this);
            if (typeof requestedSource !== "string")
                throw new Error(`module source not found: ${moduleName}`);
            src = requestedSource;
        }
        const callResult = await this.#context.evalCodeAsync(src, moduleName, { type: "module", strict: true, strip: true });
        if (!("value" in callResult)) {
            throw Scope.withScope((scope) => {
                return this.#context.dump(scope.manage(callResult.error));
            });
        }
        const promiseState = this.#context.getPromiseState(callResult.value);
        if (promiseState.type === "fulfilled") {
            return this.#createModuleByCallResult(moduleName, promiseState);
        }
        if (promiseState.type === "rejected") {
            throw Scope.withScope((scope) => {
                return this.#context.dump(scope.manage(promiseState.error));
            });
        }
        const promiseResult = await this.#context.resolvePromise(callResult.value);
        return this.#createModuleByCallResult(moduleName, promiseResult);
    }
    #createModuleByCallResult(moduleName, callResult) {
        if (!("value" in callResult)) {
            throw Scope.withScope((scope) => {
                return this.#context.dump(scope.manage(callResult.error));
            });
        }
        const module = new QuickJsProgramModule(this.#interruptManager, this.#context, callResult.value);
        this.#loadedModules.set(moduleName, module);
        return module;
    }
    #createModuleBySource(context, moduleName, src, builtin) {
        if (builtin)
            this.#builtinModuleNames.add(moduleName);
        const evalHandle = context.evalCode(src, moduleName, { type: "module", strict: true, strip: true });
        if ("value" in evalHandle)
            return evalHandle.value;
        throw Scope.withScope((scope) => {
            return context.dump(scope.manage(evalHandle.error));
        });
    }
    static #rpcLoaderCode /* language=javascript */ = `
		import RPCSource from "varhub:rpc";
		import room from "varhub:room";
        export default (module) => RPCSource.start(new RPCSource(module), room);
	`;
    startRpc(targetModule) {
        const module = this.createModule("varhub:rpc#loader", QuickJsProgram.#rpcLoaderCode, true);
        targetModule.withModule(wrapper => module.callMethodIgnored("default", undefined, wrapper));
    }
    async startRpcAsync(targetModule) {
        const module = await this.createModuleAsync("varhub:rpc#loader", QuickJsProgram.#rpcLoaderCode, true);
        targetModule.withModule(wrapper => module.callMethodIgnored("default", undefined, wrapper));
    }
    setBuiltinModuleName(moduleName, builtin) {
        if (builtin) {
            this.#builtinModuleNames.add(moduleName);
        }
        else {
            this.#builtinModuleNames.delete(moduleName);
        }
    }
    withContext(handler) {
        return Scope.withScope(scope => {
            return handler(new ShortLifeContextWrapper(scope, this.#context, this.#interruptManager));
        });
    }
    get alive() {
        return this.#alive;
    }
    executePendingJobs(count = -1) {
        void this.#context.runtime.executePendingJobs(count);
    }
    dispose() {
        this.#alive = false;
        for (let module of this.#loadedModules.values())
            if (module.alive)
                try {
                    module.dispose();
                }
                catch { }
        for (let ownedDisposableItem of this.#ownedDisposableItems)
            if (ownedDisposableItem.alive)
                try {
                    ownedDisposableItem.dispose();
                }
                catch { }
        this.#disposeHandler?.();
    }
}
//# sourceMappingURL=QuickJsProgram.js.map