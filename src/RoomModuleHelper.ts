import type { Connection, Room } from "@flinbein/varhub";
import type { QuickJsProgram } from "./QuickJsProgram.js";
import { roomInnerSource, roomSource } from "./innerSource/RoomSource.js";

export class RoomModuleHelper {
	readonly #room: Room;
	
	constructor(room: Room, program: QuickJsProgram, moduleName: string) {
		this.#room = room;
		const innerModule = program.createModule(`${moduleName}#inner`, roomInnerSource);
		innerModule.withModule((wrapper) => {
			void wrapper.getProp("set").call(undefined, {
				destroy: wrapper.newFunction(this.destroy.bind(this)),
				getRoomMessage: wrapper.newFunction(this.getRoomMessage.bind(this)),
				setRoomMessage: wrapper.newFunction(this.setRoomMessage.bind(this)),
				kick: wrapper.newFunction(this.kick.bind(this)),
				open: wrapper.newFunction(this.open.bind(this)),
				broadcast: wrapper.newFunction(this.broadcast.bind(this)),
				send: wrapper.newFunction(this.send.bind(this)),
				isOnline: wrapper.newFunction(this.isOnline.bind(this)),
			});
		});
		program.createModule(moduleName, roomSource, true);
		
		this.#room.prependListener("connectionJoin", (connection) => {
			innerModule.callMethodIgnored("onJoin", undefined, connection.id);
		});
		
		this.#room.prependListener("connectionClosed", (connection, wasOnline, reason) => {
			innerModule.callMethodIgnored("onClose", undefined, connection.id, wasOnline, reason);
		});
		
		this.#room.prependListener("connectionEnter", (connection, ...args) => {
			innerModule.callMethodIgnored("onEnter", undefined, connection.id, ...args);
		});
		
		this.#room.prependListener("connectionMessage", (connection, ...args) => {
			innerModule.call("onMessage", undefined, connection.id, ...args);
		});
	}
	
	destroy(){
		this.#room.destroy();
	}
	setRoomMessage(message: unknown){
		this.#room.publicMessage = message == null ? null : String(message);
	}
	getRoomMessage(){
		return this.#room.publicMessage
	}
	kick(nameOrId?: unknown, reason?: unknown){
		const connection = this.#getConnection(Number(nameOrId));
		if (!connection) return false;
		connection.leave(reason == null ? null : String(reason));
		return true;
	}
	open(nameOrId?: unknown){
		const connection = this.#getConnection(Number(nameOrId));
		if (!connection) return false;
		return this.#room.join(connection);
	}
	broadcast(...args: unknown[]){
		for (let con of this.#room.getJoinedConnections()) {
			con.sendEvent(...args);
		}
	}
	send(nameOrId?: unknown, ...args: unknown[]){
		const connection = this.#getConnection(Number(nameOrId));
		if (!connection) return false;
		connection.sendEvent(...args);
		return true;
	}
	isOnline(nameOrId?: unknown){
		const connection = this.#getConnection(Number(nameOrId));
		if (!connection) return false;
		return connection.status === "joined";
	}
	#getConnection(connectionId: number): Connection | undefined {
		let connection = this.#room.getJoinedConnections().find(({id}) => id === connectionId);
		if (connection == undefined) connection = this.#room.getLobbyConnections().find(({id}) => id === connectionId);
		return connection
	}
}