import { PlayerController, RPCController } from "@flinbein/varhub";
import { QuickJsProgram } from "./QuickJsProgram.js";
import { RoomModuleHelper } from "./RoomModuleHelper.js";
export class QuickJSController {
    #room;
    #rpcController;
    #playerController;
    #program;
    #main;
    #source;
    constructor(room, quickJS, conf /* TODO: add API */) {
        this.#room = room;
        room.on("destroy", this.#onDestroy.bind(this));
        this.#source = { ...conf.source };
        this.#rpcController = new RPCController(room, this.#rpc.bind(this));
        this.#playerController = new PlayerController(room);
        this.#program = new QuickJsProgram(quickJS, this.#getSource.bind(this));
        new RoomModuleHelper(room, this.#playerController, this.#program);
        this.#main = this.#program.getModule(conf.main);
    }
    #rpc(connection, methodName, ...args) {
        if (typeof methodName !== "string")
            throw new Error(`wrong method name`);
        const type = this.#main.getType(methodName);
        if (type !== "function")
            throw new Error(`no method: ${methodName}`);
        const player = this.#playerController.getPlayerOfConnection(connection);
        const playerId = player ? this.#playerController.getPlayerId(player) : null;
        if (!playerId)
            throw new Error(`no player`);
        return this.#main.call(methodName, { player: playerId }, ...args);
    }
    #getSource(file) {
        // TODO: add api sources
        return this.#source[file];
    }
    #onDestroy() {
        this.#program.dispose();
    }
}
