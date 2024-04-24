import assert from "node:assert";
import { describe, it } from "node:test";
import { EventEmitter } from "node:events";
import { QuickJSController, QuickJSControllerCode } from "../src/QuickJSController.js";
import { Room, ApiSource, ApiHelper, ApiHelperController, Connection, RPCController } from "@flinbein/varhub";

import { getQuickJS } from "quickjs-emscripten"
const quickJS = await getQuickJS();



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
	readonly #connection: Connection
	readonly #id: string;
	readonly #password: string | undefined;
	readonly #config: unknown;
	readonly #eventLog: unknown[] = [];
	#nextRpcId = 0;
	#rpcResultEmitter = new EventEmitter();
	#rpcEventEmitter = new EventEmitter();
	#closeReason: string | null | undefined = undefined;
	constructor(room: Room, id: string, password?: string|undefined, config?: unknown) {
		this.#id = id;
		this.#password = password;
		this.#config = config;
		const connection = this.#connection = room.createConnection(id, password, config);
		connection.on("disconnect", (ignored, reason) => {
			this.#closeReason = reason;
		})
		connection.on("event", (eventName, ...eventArgs) => {
			const [eventId, ...args] = eventArgs;
			if (eventName === "$rpcResult") {
				this.#rpcResultEmitter.emit(eventId, ...args);
			} else if (eventName === "$rpcEvent") {
				this.#eventLog.push(eventArgs);
				this.#rpcEventEmitter.emit(eventId, ...args);
			}
		});
	}
	
	get eventLog(){
		return this.#eventLog;
	}
	
	get closeReason(){
		return this.#closeReason;
	}
	
	get config(){
		return this.#config;
	}
	get id(){
		return this.#id;
	}
	get password(){
		return this.#password;
	}
	call(methodName: string, ...args: any[]): unknown {
		const rpcId = this.#nextRpcId++;
		let code: [unknown, unknown] | undefined = undefined
		let resolver: [(arg: unknown) => void, (arg: unknown) => void] | undefined = undefined;
		this.#rpcResultEmitter.once(rpcId as any, (errorCode, result) => {
			code = [errorCode, result];
			if (!resolver) return;
			if (errorCode === 2) resolver[1](new Error(`no method: ${methodName}`));
			if (errorCode) resolver[1](result);
			resolver[0](result);
		})
		this.#connection.message("$rpc", rpcId, methodName, ...args);
		if (code) {
			if (code[0] === 2) throw new Error(`no method: ${methodName}`);
			if (code[0]) throw code[1];
			return code[1];
		}
		return new Promise((success, fail) => {
			resolver = [success, fail];
		})
	}
	
	get status(){
		return this.#connection.status
	}
	
	leave(reason?: string | null){
		return this.#connection.leave(reason);
	}
	
	on(eventName: string, handler: (...args: unknown[]) => void){
		this.#rpcEventEmitter.on(eventName, handler);
	}
}

describe("test controller",() => {
	
	it("simple ctrl methods", {timeout: 500}, async () => {
		const code: QuickJSControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
					import room from "varhub:room";

					export function greet(){
    					return "Hello, " + this.player + "!";
					}

                    export function getPlayers(){
                        return room.getPlayers();
					}
				`
			}
		}

		const room = new Room();
		new QuickJSController(room, quickJS, code, {
			apiHelperController: new ApiHelperController(room, apiSource)
		}).start();
		const bobClient = new Client(room, "Bob");
		const greetMessage = bobClient.call("greet");
		assert.equal(greetMessage, "Hello, Bob!", "greet message for Bob");

		const bobClient2 = new Client(room, "Bob");
		const greetMessage2 = bobClient2.call("greet");
		assert.equal(greetMessage2, "Hello, Bob!", "greet message 2 for Bob");

		const aliceClient = new Client(room, "Alice");
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
                    export async function greet(){
                        await new Promise(r => setTimeout(r, 1));
                        return "Hello, " + this.player + "!";
                    }
				`
			}
		}

		const room = new Room();
		new QuickJSController(room, quickJS, code, {
			apiHelperController: new ApiHelperController(room, apiSource)
		}).start();
		const bobClient = new Client(room, "Bob");
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
		const client = new Client(room, "Bob");
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
		const client = new Client(room, "Bob");
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
		const client = new Client(room, "Bob");
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
		const client = new Client(room, "Bob");
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
		const client = new Client(room, "Bob");
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
                    export const getRoomClosed = () => room.closed
                    export const setRoomClosed = (msg) => room.closed = msg;
				`
			}
		}

		const room = new Room();
		new QuickJSController(room, quickJS, code, {
			apiHelperController: new ApiHelperController(room, apiSource)
		}).start();
		const bobClient = new Client(room, "Bob");
		assert.equal(bobClient.call("getRoomClosed"), false, "default closed is false");

		const eveClient = new Client(room, "Eve");
		assert.equal(eveClient.status, "joined", "Eve joined");

		bobClient.call("setRoomClosed", true);
		assert.equal(bobClient.call("getRoomClosed"), true, "next closed is true");

		const aliceClient = new Client(room, "Alice");
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
		const bobClient = new Client(room, "Bob");
		assert.equal(room.destroyed, false, "room not destroyed");
		bobClient.call("destroy");
		assert.equal(room.destroyed, true, "room destroyed");
	});

	it("room player status, kick", {timeout: 500}, async () => {
		const code: QuickJSControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
                    import room from "varhub:room";
                    export const isPlayerOnline = room.isPlayerOnline;
                    export const hasPlayer = room.hasPlayer;
                    export const kick = room.kick;
				`
			}
		}

		const room = new Room();
		new QuickJSController(room, quickJS, code, {
			apiHelperController: new ApiHelperController(room, apiSource)
		}).start();
		const bobClient = new Client(room, "Bob");
		assert.equal(bobClient.call("isPlayerOnline", "Alice"), undefined, "Alice online is undefined");
		assert.equal(bobClient.call("hasPlayer", "Alice"), false, "no player Alice");

		const aliceClient = new Client(room, "Alice");

		assert.equal(bobClient.call("isPlayerOnline", "Alice"), true, "Alice online is true");
		assert.equal(bobClient.call("hasPlayer", "Alice"), true, "has player Alice");

		aliceClient.leave();

		assert.equal(bobClient.call("isPlayerOnline", "Alice"), false, "Alice online is false after leave");
		assert.equal(bobClient.call("hasPlayer", "Alice"), true, "has player Alice after leave");

		bobClient.call("kick", "Alice");

		assert.equal(bobClient.call("isPlayerOnline", "Alice"), undefined, "Alice online is undefined after kick");
		assert.equal(bobClient.call("hasPlayer", "Alice"), false, "no player Alice after kick");

		bobClient.call("kick", "Bob");
		assert.equal(bobClient.status, "disconnected", "Bob kick himself");
	});

	it("room send, broadcast", {timeout: 500}, async () => {
		const code: QuickJSControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
                    import room from "varhub:room";
                    export const send = room.send;
                    export const broadcast = room.broadcast;
				`
			}
		}

		const room = new Room();
		new QuickJSController(room, quickJS, code, {
			apiHelperController: new ApiHelperController(room, apiSource)
		}).start();
		const bobClient = new Client(room, "Bob");
		const aliceClient = new Client(room, "Alice");
		const aliceMessages: any[] = [];
		aliceClient.on("message", value => aliceMessages.push(value));

		bobClient.call("send", "Alice", "message", "hello");
		assert.deepEqual(aliceMessages, ["hello"], "alice receives first message");

		bobClient.call("broadcast", "message", "hi");
		assert.deepEqual(aliceMessages, ["hello", "hi"], "alice receives next message");
	});

	it("room player data", {timeout: 500}, async () => {
		const code: QuickJSControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
                    import room from "varhub:room";
                    export const getPlayerData = room.getPlayerData;
				`
			}
		}

		const room = new Room();
		new QuickJSController(room, quickJS, code, {
			apiHelperController: new ApiHelperController(room, apiSource)
		}).start();
		const bobClient = new Client(room, "Bob", "", {foo: "bar"});
		const bobData = bobClient.call("getPlayerData", "Bob");
		assert.deepEqual(bobData, {foo: "bar"}, "Bob data is same");
	});

	it("room on off", {timeout: 500}, async () => {
		const code: QuickJSControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
                    import room from "varhub:room";

					let last = undefined;
					const onJoin = (name) => last = name;
                    room.on("join", onJoin);

                    export const getLast = () => last;
                    export const stopListen = () => room.off("join", onJoin);
				`
			}
		}

		const room = new Room();
		new QuickJSController(room, quickJS, code, {
			apiHelperController: new ApiHelperController(room, apiSource)
		}).start();
		const bobClient = new Client(room, "Bob");
		assert.equal(bobClient.call("getLast"), "Bob", "Bob is last");

		new Client(room, "Alice");
		assert.equal(bobClient.call("getLast"), "Alice", "Alice is last");

		bobClient.call("stopListen");
		new Client(room, "Eve");
		assert.equal(bobClient.call("getLast"), "Alice", "Alice is still last");
	});


	it("room once", {timeout: 500}, async () => {
		const code: QuickJSControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
                    import room from "varhub:room";

                    let last = undefined;
                    const onOffline = (name) => last = name;
                    room.once("offline", onOffline);

                    export const getLast = () => last;
				`
			}
		}

		const room = new Room();
		new QuickJSController(room, quickJS, code, {
			apiHelperController: new ApiHelperController(room, apiSource)
		}).start();
		const bobClient = new Client(room, "Bob");
		assert.equal(bobClient.call("getLast"), undefined, "no offline");

		new Client(room, "Alice").leave();
		assert.equal(bobClient.call("getLast"), "Alice", "Alice disconnected first");

		new Client(room, "Eve").leave();
		assert.equal(bobClient.call("getLast"), "Alice", "Alice still disconnected first");
	});
	
	it("multi controllers with same api", {timeout: 500}, async () => {
		const codeFoo: QuickJSControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
                    import counter from "varhub:api/Counter";
                    export const foo = () => "Foo"

                    export const fooCurrent = () => counter.current()
				`
			}
		}
		
		const codeBar: QuickJSControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
                    import counter from "varhub:api/Counter";
                    export const bar = () => "Bar"

                    export const barNext = () => counter.next()
				`
			}
		}
		
		const room = new Room();
		const apiHelperController = new ApiHelperController(room, apiSource);
		const rpcController = new RPCController(room);
		new QuickJSController(room, quickJS, codeFoo, {apiHelperController, rpcController}).start();
		new QuickJSController(room, quickJS, codeBar, {apiHelperController, rpcController}).start();
		
		const bobClient = new Client(room, "Bob");
		assert.equal(bobClient.call("foo"), "Foo", "call runtime Foo");
		assert.equal(bobClient.call("bar"), "Bar", "call runtime Bar");
		
		assert.equal(bobClient.call("fooCurrent"), 0, "current counter in Foo = 0");
		bobClient.call("barNext"); // increment counter in Bar
		assert.equal(bobClient.call("fooCurrent"), 1, "current counter in Foo = 1");
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
		
		const bobClient = new Client(room, "Bob");
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
		
		const bobClient = new Client(room, "Bob");
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
		
		const bobClient = new Client(room, "Bob");
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
                    export function kickOther(){
    					const {player, connection} = this;
                        const connections = room.getPlayerConnections(player);
                        for (const c of connections){
                            if (c === connection) continue;
                            room.kick(c);
						}
					}
				`
			}
		}
		
		const room = new Room();
		new QuickJSController(room, quickJS, code).start();
		
		const bobClient1 = new Client(room, "Bob");
		const bobClient2 = new Client(room, "Bob");
		const bobClient3 = new Client(room, "Bob");
		assert.equal(bobClient1.status, "joined");
		assert.equal(bobClient2.status, "joined");
		assert.equal(bobClient3.status, "joined");
		bobClient1.call("kickOther");
		assert.equal(bobClient1.status, "joined");
		assert.equal(bobClient2.status, "disconnected");
		assert.equal(bobClient3.status, "disconnected");
	});
	
	it("send other connections", {timeout: 500}, async () => {
		const code: QuickJSControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
					import room from "varhub:room";
                    export function sendOther(){
    					const {player, connection} = this;
                        const connections = room.getPlayerConnections(player);
                        for (const c of connections){
                            if (c === connection) continue;
                            room.send(c, "msg");
						}
					}
				`
			}
		}
		
		const room = new Room();
		new QuickJSController(room, quickJS, code).start();
		
		const bobClient1 = new Client(room, "Bob");
		const bobClient2 = new Client(room, "Bob");
		assert.deepEqual(bobClient1.eventLog, []);
		assert.deepEqual(bobClient2.eventLog, []);
		bobClient1.call("sendOther");
		assert.deepEqual(bobClient1.eventLog, []);
		assert.deepEqual(bobClient2.eventLog, [["msg"]]);
	});
	
	it("kick other on join", {timeout: 500}, async () => {
		const code: QuickJSControllerCode = {
			main: "index.js",
			source: {
				"index.js": /* language=JavaScript */ `
					import room from "varhub:room";
					room.on("connectionJoin", (player, connection) => {
                        const connections = room.getPlayerConnections(player);
                        for (const c of connections){
                            if (c === connection) continue;
                            room.kick(c, "only 1 connection allowed");
                        }
					});
				`
			}
		}
		
		const room = new Room();
		new QuickJSController(room, quickJS, code).start();
		
		const bobClient1 = new Client(room, "Bob");
		assert.deepEqual(bobClient1.status, "joined");
		const bobClient2 = new Client(room, "Bob");
		assert.deepEqual(bobClient2.status, "joined");
		assert.deepEqual(bobClient1.status, "disconnected");
		assert.deepEqual(bobClient1.closeReason, "only 1 connection allowed");
	})
});