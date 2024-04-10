import { PlayerController, RPCController, ApiHelperController } from "@flinbein/varhub";
export class QuickJSController {
    #playerController;
    #apiController;
    #rpcController;
    constructor(room, source, options) {
        this.#playerController = options?.playerController ?? new PlayerController(room);
        this.#rpcController = new RPCController(room, this.#rpc.bind(this));
        this.#apiController = options.apiController ?? new ApiHelperController(room, options.apiConstructorMap ?? {});
    }
    #rpc(connection, ...args) {
        // todo HARD!
    }
}
