const EVENT_EMITTER_MODULE_NAME = "@varhub/EventEmitter";
export class RoomModuleHelper {
    #room;
    #playerController;
    constructor(room, playerController, program) {
        this.#room = room;
        this.#playerController = playerController;
        if (!program.hasModule(EVENT_EMITTER_MODULE_NAME)) {
            program.createModule(EVENT_EMITTER_MODULE_NAME, eventEmitterSource);
        }
        const innerModule = program.createModule("@varhub/room:inner", roomInnerSource);
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
                sendEventToPlayer: wrapper.newFunction(this.getPlayers.bind(this)),
            });
        });
        program.createModule("@varhub/room", roomSource);
        for (const eventName of ["join", "leave", "online", "offline"]) {
            playerController.on(eventName, (player) => {
                innerModule.call("emit", undefined, eventName, playerController.getPlayerId(player));
            });
        }
    }
    destroyRoom() {
        this.#room.destroy();
    }
    setRoomMessage(message) {
        this.#room.publicMessage = message == null ? null : String(message);
    }
    getRoomMessage() {
        return this.#room.publicMessage;
    }
    setRoomClosed(closed) {
        if (closed != null)
            this.#playerController.closed = Boolean(closed);
    }
    getRoomClosed() {
        return this.#playerController.closed;
    }
    kickPlayer(name, reason) {
        const player = this.#playerController.getPlayerById(String(name));
        if (!player)
            return false;
        return this.#playerController.kick(player, reason == null ? reason : String(reason));
    }
    getPlayerData(name) {
        const player = this.#playerController.getPlayerById(String(name));
        if (!player)
            return undefined;
        return player.config;
    }
    getPlayerOnline(name) {
        const player = this.#playerController.getPlayerById(String(name));
        if (!player)
            return undefined;
        return player.online;
    }
    getPlayers() {
        return Array.from(this.#playerController.getPlayers().keys());
    }
    broadcast(...args) {
        this.#playerController.broadcastEvent(...args);
    }
    sendEventToPlayer(name, ...args) {
        const player = this.#playerController.getPlayerById(String(name));
        if (!player)
            return undefined;
        return player.sendEvent(...args);
    }
}
// language=JavaScript
const roomSource = `
	import {$, e} from ":inner";
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
        getPlayerData: $.getPlayerData,
        getPlayers: $.getPlayers,
        on: e.on.bind(e),
        once: e.once.bind(e),
        off: e.off.bind(e)
	})
`;
// language=JavaScript
const roomInnerSource = `
	import EventEmitter from ${JSON.stringify(String(EVENT_EMITTER_MODULE_NAME))};
	export let $;
    export const set = a => {$ = a}
    export const e = EventEmitter();
    export const emit = (...args) => {e.emit(...args)}
`;
// language=JavaScript
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
`;
