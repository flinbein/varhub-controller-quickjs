import { RPCController } from "@flinbein/varhub";
export class QuickJSController {
    #rpcController;
    constructor(room, source, options) {
        this.#rpcController = new RPCController(room, this.#rpc.bind(this));
    }
    #rpc(connection, ...args) {
        // todo HARD!
    }
}
