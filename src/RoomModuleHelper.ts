import { Connection, PlayerController, Room } from "@flinbein/varhub";
import { QuickJsProgram } from "./QuickJsProgram.js";
import { QuickJsProgramModule } from "./QuickJsProgramModule.js";
import { QuickJSHandle } from "quickjs-emscripten";

export class RoomModuleHelper {
	#room: Room;
	#program: QuickJsProgram;
	#roomInnerModule: QuickJsProgramModule;
	
	
	constructor(room: Room, program: QuickJsProgram) {
		this.#room = room;
		this.#program = program;
		this.#roomInnerModule = program.createModule("@varhub/room:inner", roomInnerSource);
		this.#program.withProxyFunctions(
			[this.#destroyRoom.bind(this), this.#getRoomMessage.bind(this), this.#setRoomMessage.bind(this)],
			(destroyRoom, getRoomMessage, setRoomMessage) => {
				this.#roomInnerModule.call("set", undefined, {destroyRoom, getRoomMessage, setRoomMessage});
			}
		);
		program.createModule("@varhub/room", roomSource);
	}
	
	#destroyRoom(){
		this.#room.destroy();
	}
	#setRoomMessage(message: string | null){
		this.#room.publicMessage = message;
	}
	#getRoomMessage(){
		return this.#room.publicMessage
	}
}

const roomSource = `
	import {$} from ":inner";
	export default Object.freeze({
        destroy: $.destroyRoom(),
        get message(){
            return $.getRoomMessage();
        },
        set message(message){
            $.setRoomMessage(message);
        }
	})
`;
const roomInnerSource = `export let $; export const set = (...a) => {$ = a}`