import assert from "node:assert";
import { describe, it } from "node:test";
import { EventEmitter } from "node:events";
import { QuickJSController, QuickJSControllerCode } from "../src/QuickJSController.js";
import { Room, ApiSource, ApiHelper, ApiHelperController, Connection, RPCController } from "@flinbein/varhub";
import quickJsAsyncVariant from "@jitl/quickjs-ng-wasmfile-release-asyncify"

import { getQuickJS, newQuickJSAsyncWASMModuleFromVariant } from "quickjs-emscripten"
const quickJS = await getQuickJS();
const quickJSAsync = await newQuickJSAsyncWASMModuleFromVariant(quickJsAsyncVariant as any);



class Counter implements ApiHelper {
	#value = 0;
	next = () => ++this.#value;
	current = () => this.#value;
	error = () => { throw this.#value }
	[Symbol.dispose](){}
}

class Network implements ApiHelper {
	fetch = async (url: unknown) => {
		await new Promise(r => setTimeout(r, 100))
		return {status: 200, data: `fetched:`+url}
	}
	fetchWithError = async (url: unknown) => {
		await new Promise(r => setTimeout(r, 100))
		throw {status: 400, data: `fetched:`+url}
	}
	[Symbol.dispose](){}
}

const apiSource: ApiSource = {Counter, Network}

class Client {
	private _connection: Connection
	private readonly _room: Room;
	private readonly _params: any[];
	private readonly _eventLog: unknown[] = [];
	private _nextRpcId = 0;
	private _rpcResultEmitter = new EventEmitter();
	private _rpcEventEmitter = new EventEmitter();
	private _closeReason: string | null | undefined = undefined;
	private _resolvers = (Promise as any).withResolvers();
	private _closeResolvers = (Promise as any).withResolvers();
	readonly promise: Promise<this> = this._resolvers.promise
	readonly closePromise: Promise<this> = this._closeResolvers.promise
	constructor(room: Room, ...params: any[]) {
		this._room = room;
		this._params = params;
		this._resolvers.promise.catch(() => {});
		this._connection = this._room.createConnection()
		.on("disconnect", (ignored, reason) => {
			this._resolvers.reject(reason);
			this._closeResolvers.resolve(this);
			this._closeReason = reason;
			for (let eventName of this._rpcResultEmitter.eventNames()) {
				this._rpcResultEmitter.emit(eventName, 3);
			}
		})
		.on("join", () => {
			this._resolvers.resolve(this);
		})
		.on("event", (...eventArgs) => {
			const [eventId, channelId, operationId, ...args] = eventArgs;
			if (eventId !== "$rpc" || channelId !== undefined) return;
			if (operationId === 0 || operationId === 3) {
				const [callId, callResult] = args;
				this._rpcResultEmitter.emit(callId, operationId, callResult);
			}
			if (operationId === 4) {
				const [path, values] = args;
				this._rpcEventEmitter.emit(path[0], ...values);
				this._eventLog.push(args);
			}
		})
	}
	
	enter(): this {
		this._connection.enter(...this._params);
		return this;
	}
	
	open(){
		this._room!.join(this._connection!);
		return this;
	}
	
	get eventLog(){
		return this._eventLog;
	}
	
	get closeReason(){
		return this._closeReason;
	}
	
	get params(){
		return this._params;
	}
	
	call(methodName: string, ...args: any[]): unknown {
		if (this.status !== "joined") throw new Error("client not joined");
		const rpcId = this._nextRpcId++;
		let code: [unknown, unknown] | undefined = undefined
		let resolver: [(arg: unknown) => void, (arg: unknown) => void] | undefined = undefined;
		this._rpcResultEmitter.once(rpcId as any, (errorCode, result) => {
			code = [errorCode, result];
			if (!resolver) return;
			if (errorCode) resolver[1](result);
			resolver[0](result);
		})
		this._connection!.message("$rpc", undefined, 0, rpcId, [methodName], args);
		if (code) {
			if (code[0]) throw code[1];
			return code[1];
		}
		return new Promise((success, fail) => {
			resolver = [success, fail];
		})
	}
	
	sendRaw(...args: any[]){
		this._connection.message(...args);
	}
	
	onRawEvent(handler: (...args: any[]) => void) {
		this._connection.on("event", handler);
		return () => void this._connection!.off("event", handler);
	}
	
	get status(){
		return this._connection!.status
	}
	
	leave(reason?: string | null){
		return this._connection!.leave(reason);
	}
	
	on(eventName: string, handler: (...args: unknown[]) => void): this{
		this._rpcEventEmitter.on(eventName, handler);
		return this;
	}
}

describe("test controller",() => {

	it("simple ctrl methods", {timeout: 500}, async () => {
		const code: QuickJSControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
					import room from "varhub:room";
					import Players from "varhub:players";
					const players = new Players(room, (con, name) => name);

					export function greet(){
						return "Hello, " + players.get(room.useConnection()).name + "!";
					}

					export function getPlayers(){
						return [...players].map(p => p.name);
					}
				`
			}
		}

		const room = new Room();
		new QuickJSController(room, quickJS, code, {
			apiHelperController: new ApiHelperController(room, apiSource)
		}).start();
		const bobClient = new Client(room, "Bob").enter();
		const greetMessage = bobClient.call("greet");
		assert.equal(greetMessage, "Hello, Bob!", "greet message for Bob");

		const bobClient2 = new Client(room, "Bob").enter();
		const greetMessage2 = bobClient2.call("greet");
		assert.equal(greetMessage2, "Hello, Bob!", "greet message 2 for Bob");

		const aliceClient = new Client(room, "Alice").enter();
		const greetMessage3 = aliceClient.call("greet");
		assert.equal(greetMessage3, "Hello, Alice!", "greet message for Alice");

		const players = aliceClient.call("getPlayers");
		assert.deepEqual(players, ["Bob", "Alice"], "get all players");
	});

	it("async ctrl methods", {timeout: 500}, async () => {
		const code: QuickJSControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
					import room from "varhub:room";
					export async function greet(){
						const connection = room.useConnection();
						await new Promise(r => setTimeout(r, 1));
						return "Hello, " + connection.parameters[0] + "!";
					}
				`
			}
		}

		const room = new Room();
		new QuickJSController(room, quickJS, code, {
			apiHelperController: new ApiHelperController(room, apiSource)
		}).start();
		const bobClient = new Client(room, "Bob").enter();
		const greetResult = await bobClient.call("greet");
		assert.equal(greetResult, "Hello, Bob!", "greet bob");
	});

	it("api methods", {timeout: 500}, async () => {
		const code: QuickJSControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
					import counter from "varhub:api/Counter";
					export const getCurrent = () => counter.current()
					export const getNext = () => counter.next()
				`
			}
		}

		const room = new Room();
		new QuickJSController(room, quickJS, code, {
			apiHelperController: new ApiHelperController(room, apiSource)
		}).start();
		const client = new Client(room, "Bob").enter();
		assert.equal(client.call("getCurrent"), 0, "current = 0");
		assert.equal(client.call("getNext"), 1, "next = 0");
		assert.equal(client.call("getCurrent"), 1, "current = 1");
	});

	it("api error methods", {timeout: 500}, async () => {
		const code: QuickJSControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
					import counter from "varhub:api/Counter";
					export const getError = () => counter.error();
				`
			}
		}

		const room = new Room();
		new QuickJSController(room, quickJS, code, {
			apiHelperController: new ApiHelperController(room, apiSource)
		}).start();
		const client = new Client(room, "Bob").enter();
		assert.throws(
			() => client.call("getError"),
			(error) => error === 0,
			"error = 0"
		);
	});

	it("async api methods", {timeout: 500}, async () => {
		const code: QuickJSControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
					import network from "varhub:api/Network";
					export const fetch = async (url) => {
						const response = await network.fetch(url);
						return response.data;
					}
				`
			}
		}

		const room = new Room();
		new QuickJSController(room, quickJS, code, {
			apiHelperController: new ApiHelperController(room, apiSource)
		}).start();
		const client = new Client(room, "Bob").enter();
		assert.equal(
			await client.call("fetch", "https://google.com"),
			"fetched:https://google.com",
			"fetched url"
		);
	});

	it("async api error methods", {timeout: 500}, async () => {
		const code: QuickJSControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
					import network from "varhub:api/Network";
					export const fetchWithError = async (url) => {
						const response = await network.fetchWithError(url);
						return response.data;
					}
				`
			}
		}

		const room = new Room();
		new QuickJSController(room, quickJS, code, {
			apiHelperController: new ApiHelperController(room, apiSource)
		}).start();
		const client = new Client(room, "Bob").enter();
		await assert.rejects(
			async () => await client.call("fetchWithError", "https://google.com"),
			(error: any) => error.status === 400,
			"fetched url error"
		);
	});

	it("room message", {timeout: 500}, async () => {
		const code: QuickJSControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
					import room from "varhub:room";
					export const getRoomMessage = () => room.message
					export const setRoomMessage = (msg) => room.message = msg;
				`
			}
		}

		const room = new Room();
		new QuickJSController(room, quickJS, code, {
			apiHelperController: new ApiHelperController(room, apiSource)
		}).start();
		const client = new Client(room, "Bob").enter();
		assert.equal(client.call("getRoomMessage"), null, "default message is null");
		client.call("setRoomMessage", "test");
		assert.equal(room.publicMessage, "test", "message is test");
		assert.equal(client.call("getRoomMessage"), "test", "next message is test");
	});

	it("room closed", {timeout: 500}, async () => {
		const code: QuickJSControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
					import room from "varhub:room";
					let closed = false;
					room.on("connection", con => {
						closed ? con.close("room-closed") : con.open();
					});
					export const getRoomClosed = () => closed
					export const setRoomClosed = (msg) => closed = msg;
				`
			}
		}

		const room = new Room();
		new QuickJSController(room, quickJS, code, {
			apiHelperController: new ApiHelperController(room, apiSource)
		}).start();
		const bobClient = new Client(room, "Bob").enter();
		assert.equal(bobClient.call("getRoomClosed"), false, "default closed is false");

		const eveClient = new Client(room, "Eve").enter();
		assert.equal(eveClient.status, "joined", "Eve joined");

		bobClient.call("setRoomClosed", true);
		assert.equal(bobClient.call("getRoomClosed"), true, "next closed is true");

		const aliceClient = new Client(room, "Alice").enter();
		assert.equal(aliceClient.status, "disconnected", "alice can not join");
	});

	it("room destroy", {timeout: 500}, async () => {
		const code: QuickJSControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
					import room from "varhub:room";
					export const destroy = () => room.destroy();
				`
			}
		}

		const room = new Room();
		new QuickJSController(room, quickJS, code, {
			apiHelperController: new ApiHelperController(room, apiSource)
		}).start();
		const bobClient = new Client(room, "Bob").enter();
		assert.equal(room.destroyed, false, "room not destroyed");
		assert.throws(() => bobClient.call("destroy"), "call destroy throws");
		assert.equal(room.destroyed, true, "room destroyed");
	});

	it("room player status, kick", {timeout: 500}, async () => {
		const code: QuickJSControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
					import room from "varhub:room";
					import Players from "varhub:players";

					const players = new Players(room, (_c, name) => name);

					export function isPlayerOnline(name){
						return players.get(name)?.online;
					}
					export function hasPlayer(name){
						return players.get(name)?.registered ?? false
					}
					export function kick(name){
						players.get(name).kick();
					};
				`
			}
		}

		const room = new Room();
		new QuickJSController(room, quickJS, code, {
			apiHelperController: new ApiHelperController(room, apiSource)
		}).start();
		const bobClient = new Client(room, "Bob").enter();
		assert.equal(bobClient.call("isPlayerOnline", "Alice"), undefined, "Alice online is undefined");
		assert.equal(bobClient.call("hasPlayer", "Alice"), false, "no player Alice");

		const aliceClient = new Client(room, "Alice").enter();

		assert.equal(bobClient.call("isPlayerOnline", "Alice"), true, "Alice online is true");
		assert.equal(bobClient.call("hasPlayer", "Alice"), true, "has player Alice");

		aliceClient.leave();

		assert.equal(bobClient.call("isPlayerOnline", "Alice"), false, "Alice online is false after leave");
		assert.equal(bobClient.call("hasPlayer", "Alice"), true, "has player Alice after leave");

		bobClient.call("kick", "Alice");

		assert.equal(bobClient.call("isPlayerOnline", "Alice"), undefined, "Alice online is undefined after kick");
		assert.equal(bobClient.call("hasPlayer", "Alice"), false, "no player Alice after kick");

		assert.throws(() => bobClient.call("kick", "Bob"), "self-kick throws");
		assert.equal(bobClient.status, "disconnected", "Bob kick himself");
	});

	it("room send, broadcast", {timeout: 500}, async () => {
		const code: QuickJSControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
					import room from "varhub:room";
					room.on("connection", con => con.open());
					export function send(receiver, eventName,  ...args){
						for (const con of room.getConnections()){
							if (con.parameters[0] === receiver) con.send("$rpc", undefined, 4, [eventName], args)
						}
					}
					export const broadcast = room.broadcast;
				`
			}
		}

		const room = new Room();
		new QuickJSController(room, quickJS, code, {
			apiHelperController: new ApiHelperController(room, apiSource)
		}).start();
		const bobClient = new Client(room, "Bob").enter();
		const aliceClient = new Client(room, "Alice").enter();
		const aliceMessages: any[] = [];
		aliceClient.on("message", value => aliceMessages.push(value));

		bobClient.call("send", "Alice", "message", "hello");
		assert.deepEqual(aliceMessages, ["hello"], "alice receives first message");

		bobClient.call("broadcast", "$rpc", undefined, 4, ["message"], ["hi"]);
		assert.deepEqual(aliceMessages, ["hello", "hi"], "alice receives next message");
	});

	it("room player data", {timeout: 500}, async () => {
		const code: QuickJSControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
					import room from "varhub:room";
					room.on("connection", con => con.open());
					export function getPlayerData(name){
						for (const con of room.getConnections()){
							if (con.parameters[0] === name) return con.parameters[1];
						}
					}
				`
			}
		}

		const room = new Room();
		new QuickJSController(room, quickJS, code, {
			apiHelperController: new ApiHelperController(room, apiSource)
		}).start();
		const bobClient = new Client(room, "Bob", {foo: "bar"}).enter();
		const bobData = bobClient.call("getPlayerData", "Bob");
		assert.deepEqual(bobData, {foo: "bar"}, "Bob data is same");
	});

	it("room on off", {timeout: 500}, async () => {
		const code: QuickJSControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
					import room from "varhub:room";
					room.on("connection", con => con.open());

					let last = undefined;
					const onJoin = (con) => last = con.parameters[0];
					room.on("connectionOpen", onJoin);

					export const getLast = () => last;
					export const stopListen = () => room.off("connectionOpen", onJoin);
				`
			}
		}

		const room = new Room();
		new QuickJSController(room, quickJS, code, {
			apiHelperController: new ApiHelperController(room, apiSource)
		}).start();
		const bobClient = new Client(room, "Bob").enter();
		assert.equal(bobClient.call("getLast"), "Bob", "Bob is last");

		new Client(room, "Alice").enter();
		assert.equal(bobClient.call("getLast"), "Alice", "Alice is last");

		bobClient.call("stopListen");
		new Client(room, "Eve").enter();
		assert.equal(bobClient.call("getLast"), "Alice", "Alice is still last");
	});


	it("room once", {timeout: 500}, async () => {
		const code: QuickJSControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
					import room from "varhub:room";
					room.on("connection", con => con.open());

					let last = undefined;
					const onOffline = (con) => last = con.parameters[0];
					room.once("connectionClose", onOffline);

					export const getLast = () => last;
				`
			}
		}

		const room = new Room();
		new QuickJSController(room, quickJS, code, {
			apiHelperController: new ApiHelperController(room, apiSource)
		}).start();
		const bobClient = await new Client(room, "Bob").enter().promise;
		assert.equal(await bobClient.call("getLast"), undefined, "no offline");

		const aliceClient = await new Client(room, "Alice").enter().promise;
		aliceClient.leave();
		assert.equal(await bobClient.call("getLast"), "Alice", "Alice disconnected first");

		const eveClient = await new Client(room, "Eve").enter().promise;
		eveClient.leave();
		assert.equal(await bobClient.call("getLast"), "Alice", "Alice still disconnected first");;
	});

	it("config", {timeout: 500}, async () => {
		const code: QuickJSControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
					import config from "varhub:config";
					export const getConfig = () => config
				`
			}
		}

		const room = new Room();
		new QuickJSController(room, quickJS, code, {config: {foo: "bar"}}).start();

		const bobClient = new Client(room, "Bob").enter();
		assert.deepEqual(bobClient.call("getConfig"), {foo: "bar"}, "config is same");
	});

	it("empty config", {timeout: 500}, async () => {
		const code: QuickJSControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
					import config from "varhub:config";
					export const getConfig = () => config
				`
			}
		}

		const room = new Room();
		new QuickJSController(room, quickJS, code).start();

		const bobClient = new Client(room, "Bob").enter();
		assert.deepEqual(bobClient.call("getConfig"), undefined, "config is empty");
	});

	it("logger", {timeout: 500}, async () => {
		const code: QuickJSControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
					export const doConsole = (level, ...args) => console[level](...args);
				`
			}
		}

		const room = new Room();
		const consoleEvents: unknown[] = [];
		new QuickJSController(room, quickJS, code)
		.on("console", (...data) => consoleEvents.push(data))
		.start()
		;

		const bobClient = new Client(room, "Bob").enter();
		assert.deepEqual(consoleEvents, [], "no events");
		bobClient.call("doConsole", "log", 1, 2, 3);
		assert.deepEqual(consoleEvents, [["log", 1, 2, 3]], "1 console event");
		bobClient.call("doConsole", "error", "x");
		assert.deepEqual(consoleEvents, [["log", 1, 2, 3], ["error", "x"]], "2 console event");
		bobClient.call("doConsole", "info");
		assert.deepEqual(consoleEvents, [["log", 1, 2, 3], ["error", "x"], ["info"]], "3 console event");
	});

	it("kick other connections", {timeout: 500}, async () => {
		const code: QuickJSControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
					import room from "varhub:room";
					room.on("connection", con => con.open());

					export function kickOther(){
						const currentConnection = room.useConnection();
						const connections = room.getConnections();
						for (const c of connections){
							if (c === currentConnection) continue;
							c.close("kick-reason");
						}
					}
				`
			}
		}

		const room = new Room();
		new QuickJSController(room, quickJS, code).start();

		const bobClient1 = new Client(room, "Bob").enter();
		const bobClient2 = new Client(room, "Bob").enter();
		const bobClient3 = new Client(room, "Bob").enter();
		assert.equal(bobClient1.status, "joined");
		assert.equal(bobClient2.status, "joined");
		assert.equal(bobClient3.status, "joined");
		bobClient1.call("kickOther");
		assert.equal(bobClient1.status, "joined");
		assert.equal(bobClient2.status, "disconnected");
		assert.equal(bobClient3.status, "disconnected");
	});

	it("import remote", {timeout: 10500}, async () => {
		const code: QuickJSControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
					import { createEvent, createStore} from 'https://cdn.jsdelivr.net/npm/effector/effector.mjs'

					export const add = createEvent();
					const $counter = createStore(0);
					$counter.on(add, (count, num) => count + num);

					export const getCounter = () => $counter.getState();
				`
			}
		}

		const room = new Room();
		await new QuickJSController(room, quickJSAsync, code).startAsync();
		const client = new Client(room, "Bob").enter();
		client.call("add", 5);
		client.call("add", 10);
		assert.equal(client.call("getCounter"), 15, "effector counter works");
	});

	it("receive events on join", {timeout: 100}, async () => {
		const code: QuickJSControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
					import room from "varhub:room";
					room.on("connection", (con) => {
						con.open();
						con.send("$rpc", undefined, 4, ["joined"], [])
					});
				`
			}
		}

		const room = new Room();
		await new QuickJSController(room, quickJSAsync, code).startAsync();
		let joined = false;
		new Client(room, "Bob")
			.on("joined", () => joined = true)
			.enter()
		;
		assert.ok(joined, "client receive entered message");
	});

	it("varhub:performance", {timeout: 100}, async () => {
		const code: QuickJSControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
					import * as performance from "varhub:performance";
					export function f() {
						const a = performance.now();
						for (let i=0; i<100; i++);
						const b = performance.now();
						return [a, b];
					}
				`
			}
		}

		const room = new Room();
		await new QuickJSController(room, quickJSAsync, code).startAsync();
		const client = await new Client(room, "Bob").enter().promise
		const result = await client.call("f") as any;
		assert.equal(typeof result[0], "number", "a is number");
		assert.equal(typeof result[1], "number", "a is number");
		assert.ok(result[1] > result[0], "performance works");
	});
	
	it("export class RPCSource sync", {timeout: 100}, async () => {
		const code: QuickJSControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
					import RPCSource from "varhub:rpc";
					export class Deck extends RPCSource {
						constructor(baseState) {
							// noinspection JSAnnotator
							const con = new.target.connection;
							super({
								getMyName() {
									return String(con.parameters[0]);
								},
								changeState: (value) => {
									this.setState(value)
								}
							}, baseState);
						}
					}
				`
			}
		}
		
		const room = new Room();
		new QuickJSController(room, quickJSAsync, code).start();
		const client = await new Client(room, "Bob").enter().promise;
		
		const channelData1 = await new Promise(resolve => {
			const unsubscribe = client.onRawEvent((key, channel, command, data) => {
				if (key !== "$rpc" || channel !== 88 || command !== 2) return;
				unsubscribe();
				resolve(data);
			});
			client.sendRaw("$rpc", undefined, 2, 88, ["Deck"], [99]);
		})
		assert.equal(channelData1, 99, "1st channel state");
		
		const callResult = await new Promise(resolve => {
			const unsubscribe = client.onRawEvent((key, channel, command, callId, data) => {
				if (key !== "$rpc" || channel !== 88 || command !== 0 || callId !== 777) return;
				unsubscribe();
				resolve(data);
			})
			client.sendRaw("$rpc", 88, 0, 777, ["getMyName"], []);
		});
		assert.equal(callResult, "Bob", "get name success");
		
		const channelData2 = await new Promise(resolve => {
			const unsubscribe = client.onRawEvent((key, channel, command, data) => {
				if (key !== "$rpc" || channel !== 88 || command !== 2) return;
				unsubscribe();
				resolve(data);
			});
			client.sendRaw("$rpc", 88, 0, 666, ["changeState"], [22]);
		})
		assert.equal(channelData2, 22, "2nd channel state");
		
	})
	
	it("export class RPCSource async", {timeout: 100}, async () => {
		const code: QuickJSControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
					import RPCSource from "varhub:rpc";
					export class Deck extends RPCSource {
						constructor(baseState) {
							// noinspection JSAnnotator
							const con = new.target.connection;
							super({
								getMyName() {
									return String(con.parameters[0]);
								},
								changeState: (value) => {
									this.setState(value)
								}
							}, baseState);
						}
					}
				`
			}
		}
		
		const room = new Room();
		await new QuickJSController(room, quickJSAsync, code).startAsync()
		const client = await new Client(room, "Bob").enter().promise;
		
		const channelData1 = await new Promise(resolve => {
			const unsubscribe = client.onRawEvent((key, channel, command, data) => {
				if (key !== "$rpc" || channel !== 88 || command !== 2) return;
				unsubscribe();
				resolve(data);
			});
			client.sendRaw("$rpc", undefined, 2, 88, ["Deck"], [99]);
		})
		assert.equal(channelData1, 99, "1st channel state");
		
		const callResult = await new Promise(resolve => {
			const unsubscribe = client.onRawEvent((key, channel, command, callId, data) => {
				if (key !== "$rpc" || channel !== 88 || command !== 0 || callId !== 777) return;
				unsubscribe();
				resolve(data);
			})
			client.sendRaw("$rpc", 88, 0, 777, ["getMyName"], []);
		});
		assert.equal(callResult, "Bob", "get name success");
		
		const channelData2 = await new Promise(resolve => {
			const unsubscribe = client.onRawEvent((key, channel, command, data) => {
				if (key !== "$rpc" || channel !== 88 || command !== 2) return;
				unsubscribe();
				resolve(data);
			});
			client.sendRaw("$rpc", 88, 0, 666, ["changeState"], [22]);
		})
		assert.equal(channelData2, 22, "2nd channel state");
		
	})
	
	it("RPCSource.default", {timeout: 300}, async () => {
		
		const code: QuickJSControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
					import RPCSource from "varhub:rpc";
					export function emit(...data){
						RPCSource.default.emit("customEvent", ...data)
					}
				`
			}
		}
		
		const room = new Room();
		await new QuickJSController(room, quickJSAsync, code).startAsync();
		
		const client = await new Client(room, "Bob").enter().promise;
		const channelEvent = await new Promise(resolve => {
			client.on("customEvent", (...args) => resolve(args));
			client.call("emit", 1, 2);
		});
		assert.deepEqual(channelEvent, [1, 2], "got event");
	});
	
	it("room validators", {timeout: 500}, async () => {
		
		const code: QuickJSControllerCode = {
			main: "index.js",
			source: {
				"room.js": /* language=JavaScript */ `
					import room from "varhub:room";
					export default room.withType().validate({
						parameters: (s) => s.length >= 2 && s.every(v => typeof v === "string"),
						clientMessage: (s) => s.length >= 2 && s.every(v => typeof v === "number")
					}).withType();
				`,
				"index.js": /* language=JavaScript */ `
					import room from "./room.js";
					const conEvents = [];
					const msgEvents = [];
					const nextRoom = room
						.on("connection", (c, ...args) => conEvents.push(args))
						.on("connectionMessage", (c, ...args) => msgEvents.push(args))
						.on("connectionClose", () => room.broadcast(conEvents, msgEvents));
					if (nextRoom !== room) throw new Error("method 'on' returns not this");
				`
			}
		}
		
		const room = new Room();
		await new QuickJSController(room, quickJSAsync, code).startAsync();
		
		await new Client(room).enter().closePromise;
		await new Client(room, "Bob").enter().closePromise;
		const client1 = await new Client(room, "Bob", "player1").enter().promise;
		const client2 = await new Client(room, "Bob", "player2").enter().promise;
		let eventsData: any[];
		client1.onRawEvent((...args) => eventsData = args);
		client1.sendRaw(1, 2, 3);
		client2.sendRaw(1);
		await client2.closePromise;
		assert.equal(client1.status, "joined");
		assert.equal(client2.status, "disconnected");
		
		assert.deepEqual(eventsData![0], [
			["Bob", "player1"],
			["Bob", "player2"],
		]);
		assert.deepEqual(eventsData![1], [
			[1, 2, 3],
		]);
	})
	
	it("room this in event", {timeout: 2500}, async () => {
		
		const code: QuickJSControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
					import room from "varhub:room";
					room.on("connection", function(connection){
						connection.open();
						connection.send(this === room);
					})
				`
			}
		}
		
		const room = new Room();
		await new QuickJSController(room, quickJSAsync, code).startAsync();
		
		const promiseRes = Promise.withResolvers();
		const client = new Client(room);
		client.onRawEvent(promiseRes.resolve);
		await client.enter().promise;
		await new Promise(r => setTimeout(r, 1000));
		assert.equal(await promiseRes.promise, true, "this value is room");
	});
	
	it("connection this in event", {timeout: 2500}, async () => {
		const code: QuickJSControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
					import room from "varhub:room";
					room.on("connection", (connection) => {
						connection.on("message", function(){
							connection.send(this === connection);
						});
					});
				`
			}
		}
		
		const room = new Room();
		await new QuickJSController(room, quickJSAsync, code).startAsync();
		
		const client = await new Client(room).enter().promise;
		const result = await new Promise(resolve => {
			client.onRawEvent(resolve);
			client.sendRaw(1);
		})
		assert.equal(result, true, "this value is connection");
	})
});