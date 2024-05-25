import { default as assert } from "node:assert";
import { describe, it } from "node:test";
import { QuickJsProgram, QuickJsProgramSource } from "../src/QuickJsProgram.js"

import { newQuickJSAsyncWASMModule } from "quickjs-emscripten"
const quickJS = await newQuickJSAsyncWASMModule();

function sources(sourceMap: Record<string, string>): QuickJsProgramSource {
	return (file: string) => {
		const [ ,t] = file.match(/@longtime-(\d*)/) ?? [0];
		if (t) {
			return new Promise(r => setTimeout(r, Number(t), `export const x = 'value-longtime-${t}'`));
		}
		return new Promise(r => setTimeout(r, 10, sourceMap[file]));
	}
}

function sourcesWithApi(
	sourceMap: Record<string, string>,
	apiConstructors: Record<string, () => (...args: any) => any>
): QuickJsProgramSource {
	return (file, program) => {
		if (file.startsWith("@varhub/api/") && !file.includes("#")) {
			const apiName = file.substring(12);
			const apiConstructor = apiConstructors[apiName];
			if (!apiConstructor) return `export default null`;
			const innerModuleCode = `export let h; export let f = x => h = x`
			const innerModule = program.createModule(file + "#inner", innerModuleCode)
			innerModule.withModule(wrapper => {
				wrapper.callMethod("f", wrapper.newFunction(apiConstructor()))
			});
			return `import {h} from "#inner"; export default h`;
		}
		if (file in sourceMap) return sourceMap[file];
	}
}

describe("test async program",() => {
	it("simple methods", async () => {
		const sourceConfig = sources({
			"index.js": /* language=JavaScript */ `
				await new Promise(r => setTimeout(r, 10));

				export function increment(x){
					return x+1;
				}
				export async function asyncIncrement(x){
					await new Promise(r => setTimeout(r, 1));
					return x+1;
				}
				export function throwIncrement(x){
					throw x+1;
				}
				export async function throwAsyncIncrement(x){
					await new Promise(r => setTimeout(r, 1));
					throw x+1;
				}
				export async function throwAsyncPromiseIncrement(x){
					throw asyncIncrement(x);
				}
				export async function throwAsyncRejectIncrement(x){
					throw throwAsyncIncrement(x);
				}
			`
		})

		const program = new QuickJsProgram(quickJS, sourceConfig);
		const indexModule = await program.createModuleAsync("index.js");

		const result1 = indexModule.call("increment", undefined, 10);
		assert.equal(result1, 11);

		const result2 = await indexModule.call("asyncIncrement", undefined, 20);
		assert.equal(result2, 21);

		assert.throws(() => {
			indexModule.call("throwIncrement", undefined, 30);
		}, (error) => error === 31);

		await assert.rejects(async () => {
			await indexModule.call("throwAsyncIncrement", undefined, 40);
		}, (error) => error === 41);

		try {
			await indexModule.call("throwAsyncPromiseIncrement", undefined, 50);
		} catch (error) {
			assert.ok(error instanceof Promise, "throws error as promise");
			assert.equal(await error, 51, "throws error 51");
		}

		try {
			await indexModule.call("throwAsyncRejectIncrement", undefined, 60);
		} catch (error) {
			assert.ok(error instanceof Promise, "throws error as promise");
			await assert.rejects(async () => {
				await error;
			}, (error) => error === 61);
		}
	});

	it("simple getProp", async () => {
		const sourceConfig = sources({
			"index.js": /* language=JavaScript */ `
				export let value = 1;
				export function setValue(x){
					value = x;
				}
			`
		});

		const program = new QuickJsProgram(quickJS, sourceConfig);
		const indexModule = await program.createModuleAsync("index.js");
		assert.equal(indexModule.getProp("value"), 1, "base value is 1");

		indexModule.call("setValue", undefined, 2);
		assert.equal(indexModule.getProp("value"), 2, "next value is 2");

	});

	it("with props", async () => {
		const sourceConfig = sources({
			"index.js": /* language=JavaScript */ `
				export const a = {};
				export const b = {};
				export const isA = (x) => x === a;
			`
		})

		const program = new QuickJsProgram(quickJS, sourceConfig);
		const indexModule = await program.createModuleAsync("index.js");
		const result = indexModule.withModule(module => ({
			aIsA: indexModule.call("isA", undefined, module.getProp("a")),
			bIsA: indexModule.call("isA", undefined, module.getProp("b"))
		}))
		assert.equal(result.aIsA, true, "a is a");
		assert.equal(result.bIsA, false, "b is a");
	});

	it("with call result", async () => {
		const sourceConfig = sources({
			"index.js": /* language=JavaScript */ `
				const a = {};
				const b = {};
				export const getA = () => a;
				export const getB = () => b;
				export const isA = (x) => x === a;
			`
		})

		const program = new QuickJsProgram(quickJS, sourceConfig);
		const indexModule = await program.createModuleAsync("index.js");

		const result = indexModule.withModule((wrapper) => {
			const aHandle = wrapper.callMethod("getA");
			return indexModule.call("isA", undefined, aHandle);
		});
		assert.equal(result, true, "a is a");

		const result2 = indexModule.withModule((wrapper) => {
			const aHandle = wrapper.callMethod("getB");
			return indexModule.call("isA", undefined, aHandle);
		})
		assert.equal(result2, false, "b is a");
	});

	it("with call error", async () => {
		const sourceConfig = sources({
			"index.js": /* language=JavaScript */ `
				const a = {};
				const b = {};
				export const throwA = () => {throw a};
				export const throwB = () => {throw b};
				export const isA = (x) => x === a;
			`
		})

		const program = new QuickJsProgram(quickJS, sourceConfig);
		const indexModule = await program.createModuleAsync("index.js");
		const result = indexModule.withModule((wrapper) => {
			try {
				wrapper.callMethod("throwA");
			} catch (aHandle) {
				return indexModule.call("isA", undefined, aHandle);
			}
			throw new Error("a is not thrown");
		})
		assert.equal(result, true, "a is a");

		const result2 = indexModule.withModule((wrapper) => {
			try {
				wrapper.callMethod("throwB");
			} catch (bHandle) {
				return indexModule.call("isA", undefined, bHandle);
			}
			throw new Error("b is not thrown");
		})
		assert.equal(result2, false, "b is a");
	});

	it("simple modules", async () => {
		const sourceConfig = sources({
			"index.js": /* language=JavaScript */ `
				export * from "inner/methods.js";
			`,
			"inner/methods.js": /* language=JavaScript */ `
				import {innerSecret as secret} from "../secret.js";
				export function add(a, b){
					return a+b;
				}
				export {secret};
			`,
			"secret.js": /* language=JavaScript */ `
				export const innerSecret = 100;
			`
		})

		const program = new QuickJsProgram(quickJS, sourceConfig);
		const indexModule = await program.createModuleAsync("index.js");

		const result = indexModule.call("add", undefined, 1, 2);
		assert.equal(result, 3, "call add success");
		assert.equal(indexModule.getProp("secret"), 100, "secret");

		const secretModule = await program.createModuleAsync("secret.js");
		assert.equal(secretModule.getProp("innerSecret"), 100, "inner secret");
	});

	it("simple json", async () => {
		const sourceConfig = sources({
			"index.js": /* language=JavaScript */ `
				import data from "inner/data.json";
				export const foo = data.foo;
			`,
			"inner/data.json": /* language=JSON */  `{"foo": "bar"}`
		})

		const program = new QuickJsProgram(quickJS, sourceConfig);
		const indexModule = await program.createModuleAsync("index.js");
		assert.equal(indexModule.getProp("foo"), "bar", "json imported");
	})

	it("simple text", async () => {
		const sourceConfig = sources({
			"index.js": /* language=JavaScript */ `
				import data from "inner/data.txt";
				export {data as text}
			`,
			"inner/data.txt": "Hello world"
		});

		const program = new QuickJsProgram(quickJS, sourceConfig);
		const indexModule = await program.createModuleAsync("index.js");
		assert.equal(indexModule.getProp("text"), "Hello world", "txt imported");
	});

	it("simple inner module", async () => {
		const sourceConfig = sources({
			"index.js": /* language=JavaScript */ `export * from "#inner";`,
			"index.js#inner": /* language=JavaScript */ `export const name = "index-inner";`,
			"evil.js": /* language=JavaScript */ `export * from "holy.js#inner";`,
			"holy.js#inner": /* language=JavaScript */ `export const name = "holy-inner";`
		});

		const program = new QuickJsProgram(quickJS, sourceConfig);
		const indexModule = await program.createModuleAsync("index.js");
		assert.equal(indexModule.getProp("name"), "index-inner");

		assert.rejects(program.createModuleAsync("evil.js"));
	})

	it("immediate", async () => {
		const sourceConfig = sources({
			"index.js": /* language=JavaScript */ `
				export function test() {
					return new Promise(r => {
						let x = 0;
						setImmediate(() => r(x));
						x++;
					});
				}
			`
		});

		const program = new QuickJsProgram(quickJS, sourceConfig);
		const indexModule = await program.createModuleAsync("index.js");
		const result = await indexModule.call("test")
		assert.equal(result, 1, "txt imported");
	})

	it("deadlocks", {timeout: 1000}, async () => {
		const sourceConfig = sources({
			"index.js": /* language=JavaScript */ `
				export function cycle(x){while (x --> 0);}
				export async function asyncCycle(x){while (x --> 0);}
			`
		});

		const program = new QuickJsProgram(quickJS, sourceConfig);
		const indexModule = await program.createModuleAsync("index.js");
		indexModule.call("cycle", null, 1, "no deadlock in 1");
		indexModule.call("cycle", null, 100, "no deadlock in 100");
		indexModule.call("cycle", null, 1000, "no deadlock in 1000");
		assert.throws(() => {
			indexModule.call("cycle", null, Infinity);
		}, (error: any) => error.message === 'interrupted', "should interrupt");

		await indexModule.call("asyncCycle", null, 1, "no async deadlock in 1");
		await indexModule.call("asyncCycle", null, 100, "no async deadlock in 100");
		await indexModule.call("asyncCycle", null, 1000, "no async deadlock in 1000");
		await assert.rejects(async () => {
			await indexModule.call("asyncCycle", null, Infinity);
		}, (error: any) => error.message === 'interrupted', "should interrupt async");

		await indexModule.call("asyncCycle", null, 10);
	});

	it( "deadlocks in timeout", {timeout: 1000}, async () => {
		const sourceConfig = sources({
			"index.js": /* language=JavaScript */ `
				export async function asyncCycle(){
					await new Promise(r => setTimeout(r, 1));
					while (true);
					return "newer";
				}

				export async function asyncDeadlock() {
					while (true) {
						let x = 10000;
						while (x --> 0);
						await new Promise(setImmediate);
					}
				}
			`,
		});

		const program = new QuickJsProgram(quickJS, sourceConfig);
		const indexModule = await program.createModuleAsync("index.js");
		await assert.rejects(async () => {
			await indexModule.call("asyncCycle", undefined);
		}, (error: any) => error.message === 'interrupted', "should reject deadlock");

		await assert.rejects(async () => {
			await indexModule.call("asyncDeadlock");
		}, "must dead on asyncDeadlock");

	});

	it("simple api", async () => {

		const sourceConfig = sourcesWithApi({
			"index.js": /* language=JavaScript */ `
				export {default as notExist} from "@varhub/api/notExist"
				import repeat from "@varhub/api/repeat"
				import repeatThrow from "@varhub/api/repeatThrow"
				import repeatAsync from "@varhub/api/repeatAsync"
				import repeatAsyncThrow from "@varhub/api/repeatAsyncThrow"

				export const testRepeat = () => repeat(1,2,3);
				export const testRepeatThrow = () => repeatThrow(1,2,3);
				export const testRepeatAsync = () => repeatAsync(1,2,3);
				export const testRepeatAsyncThrow = () => repeatAsyncThrow(1,2,3);

			`
		}, {
			repeat(){
				return (...args) => ["repeat", ...args];
			},
			repeatThrow(){
				return (...args) => {throw ["repeatThrow", ...args]};
			},
			repeatAsync(){
				return async (...args) => ["repeatAsync", ...args];
			},
			repeatAsyncThrow(){
				return async (...args) => {throw ["repeatAsyncThrow", ...args]};
			}
		})

		const program = new QuickJsProgram(quickJS, sourceConfig);
		const indexModule = await program.createModuleAsync("index.js");
		assert.equal(indexModule.getProp("notExist"), null);

		assert.deepEqual(indexModule.call("testRepeat"), ["repeat", 1, 2, 3]);

		try {
			indexModule.call("testRepeatThrow");
			assert.fail("must throw in testRepeatThrow");
		} catch (error){
			assert.deepEqual(error, ["repeatThrow", 1, 2, 3]);
		}

		const resultOfAsync = indexModule.call("testRepeatAsync");
		assert.ok(resultOfAsync instanceof Promise, "result of testRepeatAsync is promise");
		assert.deepEqual(await resultOfAsync, ["repeatAsync", 1, 2, 3]);

		const resultOfAsyncThrow = indexModule.call("testRepeatAsyncThrow");
		assert.ok(resultOfAsyncThrow instanceof Promise, "result of testRepeatAsyncThrow is promise");
		try {
			await resultOfAsyncThrow;
			assert.fail("should not complete");
		} catch (error) {
			assert.deepEqual(error, ["repeatAsyncThrow", 1, 2, 3])
		}
	});
	
	it("deadlock in module", {timeout: 500}, async () => {
		const sourceConfig = sources({
			"index.js": /* language=JavaScript */ `import "test.js"`,
			"test.js": /* language=JavaScript */ `while (true);`
		});
		
		const program = new QuickJsProgram(quickJS, sourceConfig);
		await assert.rejects(program.createModuleAsync("index.js"), "throws in module");
	});
	
	it("longtime-100", {timeout: 1000}, async () => {
		const sourceConfig = sources({
			"index.js": /* language=JavaScript */ `export { x } from "@longtime-100"`,
		});
		
		const program = new QuickJsProgram(quickJS, sourceConfig);
		await program.createModuleAsync("index.js");
	});
	
	it("longtime-500", {timeout: 1000}, async () => {
		const sourceConfig = sources({
			"index.js": /* language=JavaScript */ `export { x } from "@longtime-500"`,
		});
		
		const program = new QuickJsProgram(quickJS, sourceConfig);
		await assert.rejects(async () => {
			const t = setTimeout(() => program.dispose(), 200);
			await program.createModuleAsync("index.js");
			clearTimeout(t);
		}, "throws in module");
	});
})