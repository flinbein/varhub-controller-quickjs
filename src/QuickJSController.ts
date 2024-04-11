import { PlayerController, RPCController, ApiHelperController, Room, Connection } from "@flinbein/varhub";
import { QuickJsProgram } from "./QuickJsProgram.js";
import { QuickJSWASMModule } from "quickjs-emscripten";
import { QuickJsProgramModule } from "./QuickJsProgramModule.js";
type ApiHelperMap = ConstructorParameters<typeof ApiHelperController>[1];


interface QuickJSControllerCode {
	main: string,
	source: Record<string, string>
}
export class QuickJSController {
	#room: Room;
	#rpcController: RPCController;
	#playerController: PlayerController;
	#program: QuickJsProgram;
	#main: QuickJsProgramModule;
	#source: Record<string, string>
	
	constructor(room: Room, quickJS: QuickJSWASMModule, conf: QuickJSControllerCode) {
		this.#room = room;
		room.on("destroy", this.#onDestroy.bind(this))
		this.#source = {...conf.source}
		this.#rpcController = new RPCController(room, this.#rpc.bind(this));
		this.#playerController = new PlayerController(room);
		this.#program = new QuickJsProgram(quickJS, this.#getSource.bind(this));
		this.#main = this.#program.getModule(conf.main);
	}
	
	#rpc(connection: Connection, methodName: unknown, ...args: unknown[]){
		if (typeof methodName !== "string") throw new Error(`wrong method name`)
		const type = this.#main.getType(methodName);
		if (type !== "function") throw new Error(`no method: ${methodName}`);
		const player = this.#playerController.getPlayerOfConnection(connection);
		const playerId = player ? this.#playerController.getPlayerId(player) : null;
		if (!playerId) throw new Error(`no player`);
		return this.#main.call(methodName, {player: playerId}, ...args);
	}
	
	#getSource(file: string): string|undefined {
		return this.#source[file];
	}
	
	#onDestroy(){
		this.#program.dispose();
	}
}