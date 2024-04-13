import type { PlayerController, Room } from "@flinbein/varhub";
import type { QuickJsProgram } from "./QuickJsProgram.js";

export class RoomModuleHelper {
	readonly #room: Room;
	readonly #playerController: PlayerController;
	
	constructor(room: Room, playerController: PlayerController, program: QuickJsProgram, moduleName: string) {
		this.#room = room;
		this.#playerController = playerController;
		const innerModule = program.createModule(`${moduleName}#inner`, roomInnerSource);
		innerModule.withModule((wrapper) => {
			void wrapper.callMethod("set", {
				destroyRoom: wrapper.newFunction(this.destroyRoom.bind(this)),
				getRoomMessage: wrapper.newFunction(this.getRoomMessage.bind(this)),
				setRoomMessage: wrapper.newFunction(this.setRoomMessage.bind(this)),
				getRoomClosed: wrapper.newFunction(this.getRoomClosed.bind(this)),
				setRoomClosed: wrapper.newFunction(this.setRoomClosed.bind(this)),
				kickPlayer: wrapper.newFunction(this.kickPlayer.bind(this)),
				broadcast: wrapper.newFunction(this.broadcast.bind(this)),
				getPlayerData: wrapper.newFunction(this.getPlayerData.bind(this)),
				getPlayerOnline: wrapper.newFunction(this.getPlayerOnline.bind(this)),
				getPlayers: wrapper.newFunction(this.getPlayers.bind(this)),
				sendEventToPlayer: wrapper.newFunction(this.sendEventToPlayer.bind(this)),
			});
		});
		program.createModule(moduleName, roomSource, true);
		
		for (const eventName of ["join", "leave", "online", "offline"] as const) {
			playerController.on(eventName, (player) => {
				innerModule.call("emit", undefined, eventName, playerController.getPlayerId(player))
			});
		}
	}
	
	destroyRoom(){
		this.#room.destroy();
	}
	setRoomMessage(message: unknown){
		this.#room.publicMessage = message == null ? null : String(message);
	}
	getRoomMessage(){
		return this.#room.publicMessage
	}
	setRoomClosed(closed?: unknown){
		if (closed != null) this.#playerController.closed = Boolean(closed);
	}
	getRoomClosed(){
		return this.#playerController.closed;
	}
	kickPlayer(name?: unknown, reason?: unknown){
		const player = this.#playerController.getPlayerById(String(name));
		if (!player) return false;
		return this.#playerController.kick(player, reason == null ? reason : String(reason));
	}
	getPlayerData(name?: unknown){
		const player = this.#playerController.getPlayerById(String(name));
		if (!player) return undefined;
		return player.config;
	}
	getPlayerOnline(name?: unknown){
		const player = this.#playerController.getPlayerById(String(name));
		if (!player) return undefined;
		return player.online;
	}
	getPlayers(){
		return Array.from(this.#playerController.getPlayers().keys());
	}
	broadcast(...args: unknown[]){
		this.#playerController.broadcastEvent("$rpcEvent", ...args);
	}
	sendEventToPlayer(name?: unknown, ...args: unknown[]){
		const player = this.#playerController.getPlayerById(String(name));
		if (!player) return false;
		if (!player.online) return false
		player.sendEvent("$rpcEvent", ...args);
		return true;
	}
}

// language=JavaScript
const roomSource = `
	import {$, e} from "#inner";
	export default Object.freeze({
        get message(){
            return $.getRoomMessage();
        },
        set message(message){
            $.setRoomMessage(message);
        },
        get closed(){
            return $.getRoomClosed();
        },
        set closed(v){
            $.setRoomClosed(v);
        },
        destroy: $.destroyRoom,
        isPlayerOnline: (name) => $.getPlayerOnline(name),
        hasPlayer: (name) => $.getPlayerOnline(name) != null,
        kick: $.kickPlayer,
        send: $.sendEventToPlayer,
        broadcast: $.broadcast,
        getPlayerData: $.getPlayerData,
        getPlayers: $.getPlayers,
        on: e.on.bind(e),
        once: e.once.bind(e),
        off: e.off.bind(e)
	})
`;

// language=JavaScript
const roomInnerSource = `
	import { EventEmitter } from "varhub:events";
	export let $;
    export const set = a => {$ = a}
    export const e = new EventEmitter();
    export const emit = (...args) => {e.emit(...args)}
`