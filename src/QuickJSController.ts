import { PlayerController, RPCController, ApiHelperController, Room, Connection } from "@flinbein/varhub";
type ApiHelperMap = ConstructorParameters<typeof ApiHelperController>[1];

interface QuickJSControllerConfig {
	playerController?: PlayerController;
	apiController?: ApiHelperController;
	apiConstructorMap?: ApiHelperMap
}
export class QuickJSController {
	#rpcController: RPCController;
	
	constructor(room: Room, source: any, options: QuickJSControllerConfig) {
		this.#rpcController = new RPCController(room, this.#rpc.bind(this));
	}
	
	#rpc(connection: Connection, ...args: any[]){
		// todo HARD!
	}
}