import { PlayerController, RPCController, ApiHelperController, Room, Connection } from "@flinbein/varhub";
type ApiHelperMap = ConstructorParameters<typeof ApiHelperController>[1];

interface QuickJSControllerConfig {
	playerController?: PlayerController;
	apiController?: ApiHelperController;
	apiConstructorMap?: ApiHelperMap
}
export class QuickJSController {
	#playerController: PlayerController;
	#apiController: ApiHelperController;
	#rpcController: RPCController;
	
	constructor(room: Room, source: any, options: QuickJSControllerConfig) {
		this.#playerController = options?.playerController ?? new PlayerController(room);
		this.#rpcController = new RPCController(room, this.#rpc.bind(this));
		this.#apiController = options.apiController ?? new ApiHelperController(room, options.apiConstructorMap ?? {});
	}
	
	#rpc(connection: Connection, ...args: any[]){
		// todo HARD!
	}
}