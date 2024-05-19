import { PlayerController, RPCController, TypedEventEmitter } from "@flinbein/varhub";
import { QuickJsProgram } from "./QuickJsProgram.js";
import { RoomModuleHelper } from "./RoomModuleHelper.js";
import { ApiModuleHelper } from "./ApiModuleHelper.js";
import eventEmitterSource from "./EventEmitterSource.js";
import { PerformanceModuleHelper } from "./PerformanceModuleHelper.js";
export class QuickJSController extends TypedEventEmitter {
    #quickJS;
    #room;
    #apiHelperController;
    #rpcController;
    #apiModuleHelper;
    #playerController;
    #program;
    #mainModule = undefined;
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
            this.#rpcController = options.rpcController ?? new RPCController(room);
            this.#playerController = options.playerController ?? new PlayerController(room);
            this.#source = { ...code.source };
            this.#configJson = JSON.stringify(options.config) ?? "undefined";
            this.#program = new QuickJsProgram(quickJS, this.#getSource.bind(this), {
                consoleHandler: this.#consoleHandler
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
        this.#mainModule = this.#program.createModule(this.#mainModuleName, this.#source[this.#mainModuleName]);
        return this;
    }
    async startAsync() {
        this.#startModules();
        this.#mainModule = await this.#program.createModuleAsync(this.#mainModuleName, this.#source[this.#mainModuleName]);
        return this;
    }
    #startModules() {
        if (this.#started)
            throw new Error("already starting");
        this.#started = true;
        new RoomModuleHelper(this.#room, this.#playerController, this.#program, "varhub:room");
        new PerformanceModuleHelper(this.#program, "varhub:performance");
        this.#apiModuleHelper = new ApiModuleHelper(this.#apiHelperController, this.#program, "varhub:api/");
        this.#rpcController.addHandler(this.#rpcHandler);
    }
    #consoleHandler = (level, ...args) => {
        this.emit("console", level, ...args);
    };
    get room() {
        return this.#room;
    }
    #rpcHandler = (connection, methodName, ...args) => {
        if (typeof methodName !== "string")
            return;
        const type = this.#mainModule?.getType(methodName);
        if (type === "function")
            return () => {
                const player = this.#playerController.getPlayerOfConnection(connection);
                const playerId = player ? this.#playerController.getPlayerId(player) : null;
                if (playerId == null)
                    throw new Error(`no player`);
                return this.#mainModule?.call(methodName, { player: playerId, connection: connection.id }, ...args);
            };
    };
    #getSource(file, program) {
        if (file === "varhub:config")
            return `export default ${this.#configJson}`;
        if (file === "varhub:events")
            return eventEmitterSource;
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
    [Symbol.dispose]() {
        this.#program?.dispose();
        this.#rpcController.removeHandler(this.#rpcHandler);
        this.#room?.[Symbol.dispose]();
    }
}
