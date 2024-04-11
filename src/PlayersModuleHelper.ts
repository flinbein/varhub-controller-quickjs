import { Connection, PlayerController, Room } from "@flinbein/varhub";
import { QuickJsProgram } from "./QuickJsProgram.js";
import { QuickJsProgramModule } from "./QuickJsProgramModule.js";
import { QuickJSHandle } from "quickjs-emscripten";

export class RoomModuleHelper {
	#playerController: PlayerController;
	#program: QuickJsProgram;
	#innerModule: QuickJsProgramModule;
	
	
	constructor(playerController: PlayerController, program: QuickJsProgram) {
		this.#playerController = playerController;
		this.#program = program;
		if (!program.hasModule("@varhub/EventEmitter")){
			program.createModule("@varhub/EventEmitter", eventEmitterSource);
		}
		this.#innerModule = program.createModule("@varhub/players:inner", playerInnerSource);
		// todo:
		program.createModule("@varhub/players", playerSource);
	}
}

const playerSource = `
	export default 0;
`
const playerInnerSource = `export let $; export const set = (...a) => {$ = a}`

const eventEmitterSource = `
	export default class EventEmitter {
    	/** @type {Record<string, Array<{listener: Function, once?: boolean}>>} */
		#eventMap = {};
        on(eventName, listener){
            let list = this.#eventMap[eventName]
            if (!list) list = this.#eventMap[eventName] = [];
            list.push({listener});
            return this;
        }
        once(eventName, listener){
            let list = this.#eventMap[eventName]
            if (!list) list = this.#eventMap[eventName] = [];
            list.push({listener, once: true});
            return this;
        }
        off(eventName, listener){
            if (!listener){
                delete this.#eventMap[eventName];
                return this;
            }
            let list = this.#eventMap[eventName];
            if (!list) return this;
            const index = list.findIndex(item => item.listener === listener);
            if (index !== -1) list.splice(index, 1);
            return this;
        }
        emit(eventName, ...args){
            let list = this.#eventMap[eventName];
            if (!list || list.length === 0) return false;
            for (const {listener, once} of list){
                if (once) this.off(eventName, listener);
                listener.apply(this, args)
            }
            return true;
        }
	}
`