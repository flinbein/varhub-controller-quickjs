import { Scope, UsingDisposable } from "quickjs-emscripten";
import url from 'node:url';
import { QuickJSImmediateManager, QuickJSIntervalManager, QuickJSTimeoutManager } from "./scope/TimeManagers.js";
import { ShortLifeContextWrapper } from "./utils/wrapper.js";
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
    #interruptManager = new InterruptManager(1000000n);
    #ownedDisposableItems = new Set([
        this.#timeoutManager,
        this.#intervalManager,
        this.#immediateManager,
    ]);
    #moduleMap = new Map;
    #builtinModules = new Set;
    constructor(quickJS, getSource, settings = {}) {
        super();
        this.#getSource = getSource;
        const context = this.#context = quickJS.newContext();
        context.runtime.setMemoryLimit(10000000);
        this.#intervalManager.settleContext(context);
        this.#timeoutManager.settleContext(context);
        this.#immediateManager.settleContext(context);
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
        throw new Error(`module loading error: ${moduleName}`);
    }
    #moduleNormalizer(baseModuleName, importText, context) {
        if (importText.startsWith("#")) {
            const moduleName = baseModuleName + importText;
            if (!this.getModule(moduleName))
                return this.#createModuleErrorText(baseModuleName, importText);
            return moduleName;
        }
        if (importText.includes("#") && !this.#builtinModules.has(baseModuleName)) {
            return this.#createModuleErrorText(baseModuleName, importText);
        }
        const moduleName = importText.startsWith(".") ? url.resolve(baseModuleName, importText) : importText;
        if (!this.getModule(moduleName))
            return this.#createModuleErrorText(baseModuleName, importText);
        return moduleName;
    }
    #createModuleErrorText(base, importText) {
        return `${JSON.stringify(String(importText))} not found from ${JSON.stringify(String(base))}`;
    }
    getLoadedModules() {
        return new Set(this.#moduleMap.keys());
    }
    getModule(moduleName) {
        const loadedModule = this.#moduleMap.get(moduleName);
        if (loadedModule)
            return loadedModule;
        const srcResult = this.#getModuleSource(moduleName);
        const src = typeof srcResult === "string" ? srcResult : srcResult.source;
        const afterCreate = typeof srcResult === "string" ? undefined : srcResult.afterCreate;
        const builtin = typeof srcResult === "string" ? false : srcResult.builtin;
        const handle = this.#createModuleBySource(this.#context, moduleName, src, builtin);
        const module = new QuickJsProgramModule(this.#interruptManager, this.#context, handle);
        this.#moduleMap.set(moduleName, module);
        afterCreate?.(module, this);
        return module;
    }
    createModule(moduleName, src, builtin) {
        if (this.#moduleMap.has(moduleName))
            throw new Error(`Module already exists: ${moduleName}`);
        const moduleHandle = this.#createModuleBySource(this.#context, moduleName, src, builtin);
        const module = new QuickJsProgramModule(this.#interruptManager, this.#context, moduleHandle);
        this.#moduleMap.set(moduleName, module);
        return module;
    }
    hasModule(moduleName) {
        return this.#moduleMap.has(moduleName);
    }
    #createModuleBySource(context, moduleName, src, builtin) {
        if (builtin)
            this.#builtinModules.add(moduleName);
        const evalHandle = context.evalCode(src, moduleName, { type: "module", strict: true, strip: true });
        if ("value" in evalHandle)
            return evalHandle.value;
        throw Scope.withScope((scope) => {
            return context.dump(scope.manage(evalHandle.error));
        });
    }
    #getModuleSource(moduleName) {
        let ext = moduleName.match(/\.([^/.:#]+$)/)?.[1];
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
    withContext(handler) {
        return Scope.withScope(scope => {
            return handler(new ShortLifeContextWrapper(scope, this.#context));
        });
    }
    get alive() {
        return this.#alive;
    }
    dispose() {
        this.#alive = false;
        // wait for complete current jobs
        setImmediate(() => {
            for (let module of this.#moduleMap.values()) {
                if (module.alive)
                    module.dispose();
            }
            for (let ownedDisposableItem of this.#ownedDisposableItems) {
                if (ownedDisposableItem.alive)
                    ownedDisposableItem.dispose();
            }
        });
    }
}
