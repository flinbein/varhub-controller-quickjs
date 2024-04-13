import type { QuickJSWASMModule } from "quickjs-emscripten";
import type { QuickJsProgramModule } from "./QuickJsProgramModule.js";
import { PlayerController, RPCController, type Room, type Connection } from "@flinbein/varhub";
import { QuickJsProgram } from "./QuickJsProgram.js";
import { RoomModuleHelper } from "./RoomModuleHelper.js";


interface QuickJSControllerCode {
	main: string,
	source: Record<string, string>
}
export class QuickJSController {
	readonly #room: Room;
	readonly #rpcController: RPCController;
	readonly #playerController: PlayerController;
	readonly #program: QuickJsProgram;
	readonly #main: QuickJsProgramModule;
	readonly #source: Record<string, string>
	
	constructor(room: Room, quickJS: QuickJSWASMModule, conf: QuickJSControllerCode /* TODO: add API */) {
		this.#room = room;
		room.on("destroy", this.#onDestroy.bind(this));
		this.#source = {...conf.source};
		this.#rpcController = new RPCController(room, this.#rpc.bind(this));
		this.#playerController = new PlayerController(room);
		this.#program = new QuickJsProgram(quickJS, this.#getSource.bind(this));
		new RoomModuleHelper(room, this.#playerController, this.#program);
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
		// TODO: add api sources
		return this.#source[file];
	}
	
	#onDestroy(){
		this.#program.dispose();
	}
}