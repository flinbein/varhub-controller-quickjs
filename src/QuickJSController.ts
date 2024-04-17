import type { QuickJSWASMModule } from "quickjs-emscripten";
import type { ConsoleHandler } from "./scope/ConsoleManager.js";
import type { QuickJsProgramModule } from "./QuickJsProgramModule.js";
import { PlayerController, RPCController, type Room, type Connection, ApiHelperController, TypedEventEmitter } from "@flinbein/varhub";
import { QuickJsProgram, QuickJsProgramModuleSource } from "./QuickJsProgram.js";
import { RoomModuleHelper } from "./RoomModuleHelper.js";
import { ApiModuleHelper } from "./ApiModuleHelper.js";
import eventEmitterSource from "./EventEmitterSource.js";


export interface QuickJSControllerCode {
	main: string,
	source: Record<string, string>
}

export interface ControllerOptions {
	apiHelperController?: ApiHelperController,
	playerController?: PlayerController;
	rpcController?: RPCController;
	config?: {};
}

export type QuickJSControllerEvents = {
	console: Parameters<ConsoleHandler>;
}

export class QuickJSController extends TypedEventEmitter<QuickJSControllerEvents> implements Disposable  {
	readonly #room: Room;
	readonly #apiHelperController: ApiHelperController | undefined;
	readonly #rpcController: RPCController;
	readonly #apiModuleHelper: ApiModuleHelper;
	readonly #playerController: PlayerController;
	readonly #program: QuickJsProgram;
	readonly #main: QuickJsProgramModule;
	readonly #source: Record<string, string>;
	readonly #configJson: string;
	
	constructor(room: Room, quickJS: QuickJSWASMModule, code: QuickJSControllerCode, options: ControllerOptions = {}) {
		super();
		try {
			this.#room = room;
			room.on("destroy", this[Symbol.dispose].bind(this));
			const apiCtrl = this.#apiHelperController = options.apiHelperController;
			const rpcCtrl = this.#rpcController = options.rpcController ?? new RPCController(room);
			const playerCtrl = this.#playerController = options.playerController ?? new PlayerController(room);
			this.#source = {...code.source};
			this.#configJson = JSON.stringify(options.config) ?? "undefined";
			
			rpcCtrl.addHandler(this.#rpcHandler);
			
			const program = this.#program = new QuickJsProgram(quickJS, this.#getSource.bind(this), {
				consoleHandler: this.#consoleHandler
			});
			new RoomModuleHelper(room, playerCtrl, program, "varhub:room");
			
			this.#apiModuleHelper = new ApiModuleHelper(apiCtrl, program, "varhub:api/");
			
			this.#main = this.#program.getModule(code.main);
		} catch (error) {
			this[Symbol.dispose]();
			throw error;
		}
	}
	
	#consoleHandler: ConsoleHandler = (level, ...args: any[]) => {
		this.emit("console", level, ...args);
	}
	
	get room(){
		return this.#room;
	}
	
	#rpcHandler = (connection: Connection, methodName: unknown, ...args: unknown[]) => {
		if (typeof methodName !== "string") return;
		const type = this.#main.getType(methodName);
		if (type === "function") return () => {
			const player = this.#playerController.getPlayerOfConnection(connection);
			const playerId = player ? this.#playerController.getPlayerId(player) : null;
			if (playerId == null) throw new Error(`no player`);
			return this.#main.call(methodName, {player: playerId}, ...args);
		}
	}
	
	#getSource(file: string): string | QuickJsProgramModuleSource | void {
		if (file === "varhub:config") return `export default ${this.#configJson}`;
		if (file === "varhub:events") return eventEmitterSource;
		const possibleApiModuleName = this.#apiModuleHelper.getPossibleApiModuleName(file);
		if (possibleApiModuleName != null) return this.#apiModuleHelper.createApiSource(possibleApiModuleName);
		return this.#source[file];
	}
	
	[Symbol.dispose](){
		this.#program?.dispose();
		this.#rpcController.removeHandler(this.#rpcHandler)
		this.#room?.[Symbol.dispose]();
	}
}