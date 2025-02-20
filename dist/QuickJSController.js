import { TypedEventEmitter } from "@flinbein/varhub";
import { QuickJsProgram } from "./QuickJsProgram.js";
import { RoomModuleHelper } from "./RoomModuleHelper.js";
import { ApiModuleHelper } from "./ApiModuleHelper.js";
import { PerformanceModuleHelper } from "./PerformanceModuleHelper.js";
import eventEmitterSource from "./innerSource/EventEmitterSource.js";
import { rpcSourceModified, rpcSourceInner } from "./innerSource/RpcSourceModified.js";
import playersSource from "./innerSource/PlayersSource.js";
const baseModules = {
    "varhub:events": eventEmitterSource,
    "varhub:rpc": rpcSourceModified,
    "varhub:rpc#inner": rpcSourceInner,
    "varhub:players": playersSource,
};
export class QuickJSController extends TypedEventEmitter {
    #quickJS;
    #room;
    #apiHelperController;
    #apiModuleHelper;
    #program;
    #mainModuleName;
    #source;
    #configJson;
    constructor(room, quickJS, code, options = {}) {
        super();
        try {
            this.#room = room;
            this.#quickJS = quickJS;
            room.on("destroy", this[Symbol.dispose].bind(this));
            this.#apiHelperController = options.apiHelperController;
            this.#source = { ...code.source };
            this.#configJson = JSON.stringify(options.config) ?? "undefined";
            this.#program = new QuickJsProgram(quickJS, this.#getSource.bind(this), {
                consoleHandler: this.#consoleHandler,
                disposeHandler: () => this[Symbol.dispose]()
            });
            this.#mainModuleName = code.main;
        }
        catch (error) {
            this[Symbol.dispose]();
            throw error;
        }
    }
    #started = false;
    start() {
        this.#startModules();
        const module = this.#program.createModule(this.#mainModuleName, this.#source[this.#mainModuleName]);
        const keys = module.withModule(val => val.getKeys());
        if (keys && keys.length > 0)
            this.#program.startRpc(module);
        return this;
    }
    async startAsync() {
        this.#startModules();
        const module = await this.#program.createModuleAsync(this.#mainModuleName, this.#source[this.#mainModuleName]);
        const keys = module.withModule(val => val.getKeys());
        if (keys && keys.length > 0)
            await this.#program.startRpcAsync(module);
        return this;
    }
    #startModules() {
        if (this.#started)
            throw new Error("already starting");
        this.#started = true;
        new RoomModuleHelper(this.#room, this.#program, "varhub:room");
        new PerformanceModuleHelper(this.#program, "varhub:performance");
        this.#apiModuleHelper = new ApiModuleHelper(this.#apiHelperController, this.#program, "varhub:api/");
    }
    #consoleHandler = (level, ...args) => {
        this.emit("console", level, ...args);
    };
    get room() {
        return this.#room;
    }
    #getSource(file, program) {
        if (file === "varhub:config")
            return `export default ${this.#configJson}`;
        if (file in baseModules)
            return baseModules[file];
        const possibleApiModuleName = this.#apiModuleHelper?.getPossibleApiModuleName(file);
        if (possibleApiModuleName != null)
            return this.#apiModuleHelper?.createApiSource(possibleApiModuleName, program);
        if (file in this.#source)
            return this.#source[file];
        if ("evalCodeAsync" in this.#quickJS) {
            const url = this.#tryGetUrl(file);
            if (url)
                return this.#fetchSource(url);
        }
        return undefined;
    }
    #tryGetUrl(descriptor) {
        try {
            return new URL(descriptor);
        }
        catch {
            return undefined;
        }
    }
    async #fetchSource(url) {
        const response = await fetch(url);
        return await response.text();
    }
    #disposed = false;
    get disposed() {
        return this.#disposed;
    }
    [Symbol.dispose]() {
        if (this.#disposed)
            return;
        this.#disposed = true;
        this.#program?.dispose();
        this.emit("dispose");
    }
}
//# sourceMappingURL=QuickJSController.js.map