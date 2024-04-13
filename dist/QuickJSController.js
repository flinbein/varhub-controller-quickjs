import { PlayerController, RPCController } from "@flinbein/varhub";
import { QuickJsProgram } from "./QuickJsProgram.js";
import { RoomModuleHelper } from "./RoomModuleHelper.js";
import { ApiModuleHelper } from "./ApiModuleHelper.js";
import eventEmitterSource from "./EventEmitterSource.js";
export class QuickJSController {
    #room;
    #apiHelperController;
    #rpcController;
    #apiModuleHelper;
    #playerController;
    #program;
    #main;
    #source;
    constructor(room, quickJS, code, config = {}) {
        try {
            this.#room = room;
            room.on("destroy", this[Symbol.dispose].bind(this));
            const apiCtrl = this.#apiHelperController = config.apiHelperController;
            const rpcCtrl = this.#rpcController = config.rpcController ?? new RPCController(room);
            const playerCtrl = this.#playerController = config.playerController ?? new PlayerController(room);
            this.#source = { ...code.source };
            rpcCtrl.addHandler(this.#rpcHandler);
            const program = this.#program = new QuickJsProgram(quickJS, this.#getSource.bind(this));
            new RoomModuleHelper(room, playerCtrl, program, "varhub:room");
            this.#apiModuleHelper = new ApiModuleHelper(apiCtrl, program, "varhub:api/");
            this.#main = this.#program.getModule(code.main);
        }
        catch (error) {
            this[Symbol.dispose]();
            throw error;
        }
    }
    get room() {
        return this.#room;
    }
    #rpcHandler = (connection, methodName, ...args) => {
        if (typeof methodName !== "string")
            return;
        const type = this.#main.getType(methodName);
        if (type === "function")
            return () => {
                const player = this.#playerController.getPlayerOfConnection(connection);
                const playerId = player ? this.#playerController.getPlayerId(player) : null;
                if (playerId == null)
                    throw new Error(`no player`);
                return this.#main.call(methodName, { player: playerId }, ...args);
            };
    };
    #getSource(file) {
        if (file === "varhub:events")
            return eventEmitterSource;
        const possibleApiModuleName = this.#apiModuleHelper.getPossibleApiModuleName(file);
        if (possibleApiModuleName != null)
            return this.#apiModuleHelper.createApiSource(possibleApiModuleName);
        return this.#source[file];
    }
    [Symbol.dispose]() {
        this.#program?.dispose();
        this.#room?.[Symbol.dispose]();
    }
}
