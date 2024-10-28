import type { QuickJSAsyncWASMModule, QuickJSWASMModule } from "quickjs-emscripten";
import type { ConsoleHandler } from "./scope/ConsoleManager.js";
import { type Room, ApiHelperController, TypedEventEmitter } from "@flinbein/varhub";
import { QuickJsProgram } from "./QuickJsProgram.js";
import { RoomModuleHelper } from "./RoomModuleHelper.js";
import { ApiModuleHelper } from "./ApiModuleHelper.js";
import { PerformanceModuleHelper } from "./PerformanceModuleHelper.js";
import eventEmitterSource from "./innerSource/EventEmitterSource.js";
import { rpcSourceModified, rpcSourceInner } from "./innerSource/RpcSourceModified.js";
import playersSource from "./innerSource/PlayersSource.js";


export interface QuickJSControllerCode {
	main: string,
	source: Record<string, string>
}

export interface ControllerOptions {
	apiHelperController?: ApiHelperController,
	config?: {};
}

export type QuickJSControllerEvents = {
	console: Parameters<ConsoleHandler>;
	dispose: []
}

const baseModules: Partial<Record<string, string>> = {
	"varhub:events": eventEmitterSource,
	"varhub:rpc": rpcSourceModified,
	"varhub:rpc#inner": rpcSourceInner,
	"varhub:players": playersSource,
}

export class QuickJSController extends TypedEventEmitter<QuickJSControllerEvents> implements Disposable  {
	readonly #quickJS: QuickJSWASMModule | QuickJSAsyncWASMModule;
	readonly #room: Room;
	readonly #apiHelperController: ApiHelperController | undefined;
	#apiModuleHelper: ApiModuleHelper | undefined;
	readonly #program: QuickJsProgram;
	readonly #mainModuleName: string;
	readonly #source: Record<string, string>;
	readonly #configJson: string;
	
	constructor(room: Room, quickJS: QuickJSWASMModule, code: QuickJSControllerCode, options: ControllerOptions = {}) {
		super();
		try {
			this.#room = room;
			this.#quickJS = quickJS;
			room.on("destroy", this[Symbol.dispose].bind(this));
			this.#apiHelperController = options.apiHelperController;
			this.#source = {...code.source};
			this.#configJson = JSON.stringify(options.config) ?? "undefined";
			
			this.#program = new QuickJsProgram(quickJS, this.#getSource.bind(this), {
				consoleHandler: this.#consoleHandler,
				disposeHandler: () => this[Symbol.dispose]()
			});
			
			this.#mainModuleName = code.main;
		} catch (error) {
			this[Symbol.dispose]();
			throw error;
		}
	}
	
	
	#started = false;
	start(): this{
		this.#startModules();
		const module = this.#program.createModule(this.#mainModuleName, this.#source[this.#mainModuleName]);
		const keys = module.withModule(val => val.getKeys());
		if (keys && keys.length > 0) this.#program.startRpc(module);
		return this;
	}
	
	async startAsync(): Promise<this> {
		this.#startModules();
		const module = await this.#program.createModuleAsync(this.#mainModuleName, this.#source[this.#mainModuleName]);
		const keys = module.withModule(val => val.getKeys());
		if (keys && keys.length > 0) await this.#program.startRpcAsync(module);
		return this;
	}
	
	#startModules(){
		if (this.#started) throw new Error("already starting");
		this.#started = true;
		new RoomModuleHelper(this.#room, this.#program, "varhub:room");
		new PerformanceModuleHelper(this.#program, "varhub:performance");
		this.#apiModuleHelper = new ApiModuleHelper(this.#apiHelperController, this.#program, "varhub:api/");
	}
	
	#consoleHandler: ConsoleHandler = (level, ...args: any[]) => {
		this.emit("console", level, ...args);
	}
	
	get room(){
		return this.#room;
	}
	
	#getSource(file: string, program: QuickJsProgram): string | void | Promise<string|void> {
		if (file === "varhub:config") return `export default ${this.#configJson}`;
		if (file in baseModules) return baseModules[file];
		const possibleApiModuleName = this.#apiModuleHelper?.getPossibleApiModuleName(file);
		if (possibleApiModuleName != null) return this.#apiModuleHelper?.createApiSource(possibleApiModuleName, program);
		if (file in this.#source) return this.#source[file];
		if ("evalCodeAsync" in this.#quickJS) {
			const url = this.#tryGetUrl(file);
			if (url) return this.#fetchSource(url);
		}
		return undefined;
	}
	
	#tryGetUrl(descriptor: string){
		try {
			return new URL(descriptor);
		} catch {
			return undefined;
		}
	}
	
	async #fetchSource(url: URL): Promise<string> {
		const response = await fetch(url);
		return await response.text();
	}
	
	#disposed = false;
	
	get disposed() {
		return this.#disposed;
	}
	
	[Symbol.dispose](){
		if (this.#disposed) return;
		this.#disposed = true;
		this.#program?.dispose();
		this.emit("dispose");
	}
}