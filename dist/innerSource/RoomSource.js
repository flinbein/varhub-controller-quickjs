export const roomSource = /* language=JavaScript */ `
import {$, roomEmitter, getConnections, validate, useConnection} from "#inner";
const room = Object.freeze({
	get message(){return $.getRoomMessage()},
	set message(message){$.setRoomMessage(message)},
	get ready(){return true},
	get closed(){return false},
	get id(){return "unknown"},
	get integrity(){return "unknown"},
	get promise(){return roomResultPromise},
	withType(){return this},
	validate(...args){validate(...args); return this},
	destroy: $.destroy,
	broadcast(...args){$.broadcast(...args); return this},
	getConnections,
	on(...args){ return roomEmitter.on.apply(this, args)},
	once(...args){ return roomEmitter.once.apply(this, args)},
	off(...args){ return roomEmitter.off.apply(this, args)},
	useConnection,
	[Symbol.dispose](){this.destroy()},
	[Symbol.asyncDispose](){this.destroy(); return Promise.resolve()}
})
const roomResultPromise = Promise.resolve([room]);
export default room;`;
export const roomInnerSource = /* language=JavaScript */ `import EventEmitter from "varhub:events";
export let $;
export const set = a => {$ = a}
export const /** @type {Node.EventEmitter} */ roomEmitter = new EventEmitter();
let context;

const /** @type {Map<number, Connection>} */ connections = new Map();
const /** @type {WeakSet<Connection>} */ readyConnections = new WeakSet();
const /** @type {WeakMap<Connection, EventEmitter>} */ connectionEmitters = new WeakMap();
let /** @type {Function|undefined} */ clientMessageValidator;
let /** @type {Function|undefined} */ parametersValidator;
class Connection {
	#id;
	#parameters;
	#emitter = new EventEmitter();
	#initResolver = Promise.withResolvers();
	#deferred = false;

	constructor(id, parameters){
		this.#parameters = parameters;
		connectionEmitters.set(this, this.#emitter);
		this.#id = id;
		this.#initResolver.promise.catch(() => {});
		this.#emitter.on("open", () => this.#initResolver.resolve());
		this.#emitter.on("close", (reason) => this.#initResolver.reject(reason));
	}
	
	get promise(){
		return this.#initResolver.promise;
	}
	
	get parameters() {
		return this.#parameters;
	}

	get ready(){
		return !this.closed && readyConnections.has(this);
	}

	get deferred() {
		return this.#deferred && !this.ready && !this.closed;
	}
	
	defer(fn, ...args) {
		this.#deferred = true;
		try {
			const result = fn.call(this, this, ...args);
			if (result && typeof result === "object" && "then" in result && typeof result.then === "function") {
				return result.then((val) => {
					if (this.deferred) this.open();
					return val;
				}, (error) => {
					if (this.deferred) this.close(error == null ? error : String(error));
					throw error;
				});
			}
			return result;
		}
		catch (e) {
			this.close(e == null ? null : String(e));
			throw e;
		}
	}
	
	open(){
		$.open(this.#id);
		return this;
	}

	get closed(){
		return !connections.has(this.#id);
	}
	
	send(...args){
		$.send(this.#id, ...args);
		return this;
	}

	on(...args){ this.#emitter.on.call(this, ...args)}
	once(...args){ this.#emitter.once.call(this, ...args)}
	off(...args){ this.#emitter.off.call(this, ...args)}
	
	close(reason){
		$.kick(this.#id, reason);
	}
	
	toString(){
		return "Connection("+this.#id+")";
	}
	
	valueOf() {
		return this.#id;
	}
}
export function useConnection(){
	if (context?.connection == null) throw new Error("useContext error: context is undefined");
	return context?.connection;
}
function runWithContext(value, fn, ...args){
	try {
		context = value;
		return fn(...args);
	} finally {
		context = undefined;
	}
}
export const onEnter = (conId, ...args) => {
	if (!parametersValidator) return handleEnter(conId, ...args);
	try {
		const validateResult = parametersValidator(args);
		if (!validateResult) return $.kick(conId, "invalid parameters");
		handleEnter(conId, ...(Array.isArray(validateResult) ? validateResult : args));
	} catch {
		$.kick(conId, "invalid parameters");
	}
}

function handleEnter(conId, ...parameters) {
	const connection = new Connection(conId, parameters);
	connections.set(conId, connection);
	runWithContext({connection, parameters}, () => {
		roomEmitter.emitWithTry("connection", connection, ...parameters);
		if (!connection.deferred) connection.open();
	});
}

export const onJoin = (conId) => {
	let connection = connections.get(conId);
	if (!connection) {
		connection = new Connection(conId);
		connections.set(conId, connection);
	}
	readyConnections.add(connection);
	runWithContext({connection}, () => {
		connectionEmitters.get(connection)?.emitWithTry("open");
		roomEmitter.emitWithTry("connectionOpen", connection);
	})
}

export const onClose = (conId, wasOnline, reason) => {
	const connection = connections.get(conId);
	connections.delete(conId);
	if (connection) {
		readyConnections.delete(connection);
		const emitter = connectionEmitters.get(connection);
		connectionEmitters.delete(connection);
		runWithContext({connection, reason, wasOnline}, () => {
			emitter?.emitWithTry("close", reason, wasOnline);
			roomEmitter.emitWithTry("connectionClose", connection, reason, wasOnline);
		});
	}
}

export const onMessage = (conId, ...args) => {
	if (!clientMessageValidator) return handleMessage(conId, ...args);
	try {
		const validateResult = clientMessageValidator(args);
		if (!validateResult) return $.kick(conId, "invalid message");
		handleMessage(conId, ...(Array.isArray(validateResult) ? validateResult : args));
	} catch {
		$.kick(conId, "invalid message");
	}
}

function handleMessage(conId, ...message){
	let connection = connections.get(conId);
	if (!connection) {
		connection = new Connection(conId);
		connections.set(conId, connection);
	}
	runWithContext({connection, message: message}, () => {
		connectionEmitters.get(connection)?.emitWithTry("message", ...message);
		roomEmitter.emitWithTry("connectionMessage", connection, ...message);
	});
}

export const getConnections = (options) => {
	const connectionsList = [...connections.values()];
	return new Set(connectionsList.filter((con) => {
		if (options) for (let key of Object.keys(options)) {
			if (con[key] !== options[key]) return false;
		}
		return true;
	}));
}

export function validate({clientMessage, parameters}){
	clientMessageValidator = clientMessage;
	parametersValidator = parameters;
}`;
//# sourceMappingURL=RoomSource.js.map