import { Scope, UsingDisposable } from "quickjs-emscripten";
import url from 'node:url';
import { QuickJSImmediateManager, QuickJSIntervalManager, QuickJSTimeoutManager } from "./scope/TimeManagers.js";
import { wrap } from "./utils/wrapper.js";
import { ConsoleManager } from "./scope/ConsoleManager.js";
import { InterruptManager } from "./InterruptManager.js";
import { QuickJsProgramModule } from "./QuickJsProgramModule.js";
export class QuickJsProgram extends UsingDisposable {
    #getSource;
    #context;
    #intervalManager = new QuickJSIntervalManager(5000);
    #timeoutManager = new QuickJSTimeoutManager(5000);
    #immediateManager = new QuickJSImmediateManager(5000);
    #consoleManager = new ConsoleManager("QuickJS:");
    #interruptManager = new InterruptManager(1000000n);
    #ownedDisposableItems = new Set([
        this.#consoleManager,
        this.#timeoutManager,
        this.#intervalManager,
        this.#immediateManager,
    ]);
    #moduleMap = new Map;
    constructor(quickJS, getSource) {
        super();
        this.#getSource = getSource;
        const context = this.#context = quickJS.newContext();
        context.runtime.setMemoryLimit(10000000);
        this.#intervalManager.settleContext(context);
        this.#timeoutManager.settleContext(context);
        this.#immediateManager.settleContext(context);
        this.#consoleManager.settleContext(context);
        this.#ownedDisposableItems.add(context);
        const runtime = context.runtime;
        runtime.setInterruptHandler(this.#interruptManager.onInterrupt);
        runtime.setModuleLoader(this.#moduleLoader.bind(this), this.#moduleNormalizer.bind(this));
    }
    #moduleLoader(moduleName, context) {
        throw new Error(`module loading error: ${moduleName}`);
    }
    #moduleNormalizer(baseModuleName, importText, context) {
        if (importText.startsWith(":")) {
            const moduleName = baseModuleName + importText;
            if (!this.getModule(moduleName))
                return this.#createModuleErrorText(baseModuleName, importText);
            return moduleName;
        }
        if (importText.includes(":"))
            return this.#createModuleErrorText(baseModuleName, importText);
        const moduleName = importText.startsWith(".") ? url.resolve(baseModuleName, importText) : importText;
        if (!this.getModule(moduleName))
            return this.#createModuleErrorText(baseModuleName, importText);
        return moduleName;
    }
    #createModuleErrorText(base, importText) {
        return `${JSON.stringify(String(importText))} not found from ${JSON.stringify(String(base))} `;
    }
    getLoadedModules() {
        return new Set(this.#moduleMap.keys());
    }
    getModule(moduleName) {
        const loadedModule = this.#moduleMap.get(moduleName);
        if (loadedModule)
            return loadedModule;
        const moduleHandle = this.#createModule(this.#context, moduleName);
        const module = new QuickJsProgramModule(this.#interruptManager, this.#context, moduleHandle);
        this.#moduleMap.set(moduleName, module);
        return module;
    }
    createModule(moduleName, src) {
        if (this.#moduleMap.has(moduleName))
            throw new Error(`Module already exists: ${moduleName}`);
        const moduleHandle = this.#createModuleBySource(this.#context, moduleName, src);
        const module = new QuickJsProgramModule(this.#interruptManager, this.#context, moduleHandle);
        this.#moduleMap.set(moduleName, module);
        return module;
    }
    hasModule(moduleName) {
        return this.#moduleMap.has(moduleName);
    }
    #createModule(context, moduleName) {
        const src = this.#getModuleSource(moduleName);
        return this.#createModuleBySource(context, moduleName, src);
    }
    #createModuleBySource(context, moduleName, src) {
        const evalHandle = context.evalCode(src, moduleName, { type: "module", strict: true, strip: true });
        if ("value" in evalHandle)
            return evalHandle.value;
        throw Scope.withScope((scope) => {
            return context.dump(scope.manage(evalHandle.error));
        });
    }
    #getModuleSource(moduleName) {
        let ext = moduleName.match(/\.([^/.:]+$)/)?.[1];
        let src = this.#getSource(moduleName, this);
        if (!ext && !src) {
            for (ext of ["js", "mjs", "cjs", "json", "json5"]) {
                src = this.#getSource(moduleName + "." + ext, this);
                if (src != undefined)
                    break;
            }
        }
        if (src == undefined)
            throw new Error(`module not found: ${moduleName}`);
        if (!ext)
            return src;
        if (ext === "js" || ext === "mjs" || ext === "cjs")
            return src;
        if (ext === "json" || ext === "json5")
            return `export default ${src}`;
        return `export default ${JSON.stringify(src)}`;
    }
    withProxyFunctions(fnList, fnAction) {
        const context = this.#context;
        return Scope.withScope((scope) => {
            const fnHandleList = fnList.map(fn => {
                return scope.manage(context.newFunction(fn.name, (...argHandles) => {
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
                }));
            });
            return fnAction(...fnHandleList);
        });
    }
    get alive() {
        return this.#context.alive;
    }
    dispose() {
        for (let module of this.#moduleMap.values()) {
            if (module.alive)
                module.dispose();
        }
        for (let ownedDisposableItem of this.#ownedDisposableItems) {
            if (ownedDisposableItem.alive)
                ownedDisposableItem.dispose();
        }
    }
}
