import { PlayerController, RPCController, TypedEventEmitter } from "@flinbein/varhub";
import { QuickJsProgram } from "./QuickJsProgram.js";
import { RoomModuleHelper } from "./RoomModuleHelper.js";
import { ApiModuleHelper } from "./ApiModuleHelper.js";
import eventEmitterSource from "./EventEmitterSource.js";
export class QuickJSController extends TypedEventEmitter {
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
    start() {
        if (this.#mainModule)
            return this;
        new RoomModuleHelper(this.#room, this.#playerController, this.#program, "varhub:room");
        this.#apiModuleHelper = new ApiModuleHelper(this.#apiHelperController, this.#program, "varhub:api/");
        this.#rpcController.addHandler(this.#rpcHandler);
        this.#mainModule = this.#program.getModule(this.#mainModuleName);
        return this;
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
    #getSource(file) {
        if (file === "varhub:config")
            return `export default ${this.#configJson}`;
        if (file === "varhub:events")
            return eventEmitterSource;
        const possibleApiModuleName = this.#apiModuleHelper?.getPossibleApiModuleName(file);
        if (possibleApiModuleName != null)
            return this.#apiModuleHelper?.createApiSource(possibleApiModuleName);
        return this.#source[file];
    }
    [Symbol.dispose]() {
        this.#program?.dispose();
        this.#rpcController.removeHandler(this.#rpcHandler);
        this.#room?.[Symbol.dispose]();
    }
}
