export class RoomModuleHelper {
    #room;
    #playerController;
    constructor(room, playerController, program, moduleName) {
        this.#room = room;
        this.#playerController = playerController;
        const innerModule = program.createModule(`${moduleName}#inner`, roomInnerSource);
        innerModule.withModule((wrapper) => {
            void wrapper.getProp("set").call(undefined, {
                destroyRoom: wrapper.newFunction(this.destroyRoom.bind(this)),
                getRoomMessage: wrapper.newFunction(this.getRoomMessage.bind(this)),
                setRoomMessage: wrapper.newFunction(this.setRoomMessage.bind(this)),
                getRoomClosed: wrapper.newFunction(this.getRoomClosed.bind(this)),
                setRoomClosed: wrapper.newFunction(this.setRoomClosed.bind(this)),
                kickPlayer: wrapper.newFunction(this.kick.bind(this)),
                broadcast: wrapper.newFunction(this.broadcast.bind(this)),
                getPlayerData: wrapper.newFunction(this.getPlayerData.bind(this)),
                getPlayerOnline: wrapper.newFunction(this.getPlayerOnline.bind(this)),
                getPlayers: wrapper.newFunction(this.getPlayers.bind(this)),
                sendEventToPlayer: wrapper.newFunction(this.sendEvent.bind(this)),
                isOnline: wrapper.newFunction(this.isOnline.bind(this)),
                getPlayerConnections: wrapper.newFunction(this.getPlayerConnections.bind(this)),
            });
        });
        program.createModule(moduleName, roomSource, true);
        for (const eventName of ["join", "leave", "online", "offline"]) {
            playerController.on(eventName, (player) => {
                innerModule.call("emit", undefined, eventName, player.id);
                program.executePendingJobs();
            });
        }
        room.prependListener("connectionJoin", (connection) => {
            const player = playerController.getPlayerOfConnection(connection);
            innerModule.call("emit", undefined, "connectionJoin", player?.id, connection.id);
        });
        room.prependListener("connectionClosed", (connection, online, reason) => {
            const player = playerController.getPlayerOfConnection(connection);
            innerModule.call("emit", undefined, "connectionClosed", player?.id, connection.id, reason);
        });
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
    getPlayerConnections(playerId) {
        const player = this.#playerController.getPlayerById(String(playerId));
        const connections = player?.getConnections();
        if (!connections)
            return undefined;
        return [...connections].map(({ id }) => id);
    }
    kick(nameOrId, reason) {
        if (typeof nameOrId === "string") {
            const player = this.#playerController.getPlayerById(String(nameOrId));
            if (!player)
                return false;
            return this.#playerController.kick(player, reason == null ? reason : String(reason));
        }
        else if (typeof nameOrId === "number") {
            const connection = this.#getConnection(nameOrId);
            if (!connection)
                return false;
            connection.leave(reason == null ? null : String(reason));
            return true;
        }
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
        this.#playerController.broadcastEvent("$rpcEvent", ...args);
    }
    sendEvent(nameOrId, ...args) {
        if (typeof nameOrId === "string") {
            const player = this.#playerController.getPlayerById(String(nameOrId));
            if (!player)
                return false;
            if (!player.online)
                return false;
            player.sendEvent("$rpcEvent", ...args);
            return true;
        }
        else if (typeof nameOrId === "number") {
            const connection = this.#getConnection(nameOrId);
            if (!connection)
                return false;
            connection.sendEvent("$rpcEvent", ...args);
            return true;
        }
    }
    isOnline(nameOrId) {
        if (typeof nameOrId === "string") {
            const player = this.#playerController.getPlayerById(String(nameOrId));
            return player?.online ?? false;
        }
        else if (typeof nameOrId === "number") {
            const connection = this.#getConnection(nameOrId);
            if (!connection)
                return false;
            return connection.status === "joined";
        }
    }
    #getConnection(connectionId) {
        let connection = this.#room.getJoinedConnections().find(({ id }) => id === connectionId);
        if (connection == undefined)
            connection = this.#room.getLobbyConnections().find(({ id }) => id === connectionId);
        return connection;
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
        isOnline: (name) => $.isOnline(name),
        hasPlayer: (name) => $.getPlayerOnline(name) != null,
        kick: $.kickPlayer,
        send: $.sendEventToPlayer,
        broadcast: $.broadcast,
        getPlayerData: $.getPlayerData,
        getPlayers: $.getPlayers,
        getPlayerConnections: $.getPlayerConnections,
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
`;
//# sourceMappingURL=RoomModuleHelper.js.map