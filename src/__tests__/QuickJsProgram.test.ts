import { getQuickJS } from "quickjs-emscripten"
import { default as assert } from "node:assert";
import { describe, it } from "node:test";
import {QuickJsProgram, QuickJsProgramSourceConfig} from "../QuickJsProgram.js"

const quickJS = await getQuickJS();

describe("test program",() => {
	it("simple methods", async () => {
		const sourceConfig: QuickJsProgramSourceConfig = {
			sources: {
				"index.js": `
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
			}
		}
		
		const program = new QuickJsProgram(quickJS, sourceConfig);
		
		const result1 = program.call("increment", undefined, 10);
		assert.equal(result1, 11);

		const result2 = await program.call("asyncIncrement", undefined, 20);
		assert.equal(result2, 21);

		assert.throws(() => {
			program.call("throwIncrement", undefined, 30);
		}, (error) => error === 31);

		await assert.rejects(async () => {
			await program.call("throwAsyncIncrement", undefined, 40);
		}, (error) => error === 41);
		
		try {
			await program.call("throwAsyncPromiseIncrement", undefined, 50);
		} catch (error) {
			assert.ok(error instanceof Promise, "throws error as promise");
			assert.equal(await error, 51, "throws error 51");
		}
		
		try {
			await program.call("throwAsyncRejectIncrement", undefined, 60);
		} catch (error) {
			assert.ok(error instanceof Promise, "throws error as promise");
			await assert.rejects(async () => {
				await error;
			}, (error) => error === 61);
		}
	});
	
	it("simple getters", () => {
		const sourceConfig: QuickJsProgramSourceConfig = {
			sources: {
				"index.js": `
					export let value = 1;
					export function setValue(x){
						value = x;
					}
				`
			}
		}
		
		const program = new QuickJsProgram(quickJS, sourceConfig);
		assert.equal(program.getProp("value"), 1, "base value is 1");
		
		program.call("setValue", undefined, 2);
		assert.equal(program.getProp("value"), 2, "next value is 2");
		
	});
	
	it("simple modules", () => {
		const sourceConfig: QuickJsProgramSourceConfig = {
			sources: {
				"index.js": `
					export * from "inner/methods.js";
				`,
				"inner/methods.js": `
					import {secret} from "../secret.js";
					export function add(a, b){
						return a+b;
					}
					export {secret};
				`,
				"secret.js": `
					export const secret = 100;
				`
			}
		}
		
		const program = new QuickJsProgram(quickJS, sourceConfig);
		
		const result = program.call("add", undefined, 1, 2);
		assert.equal(result, 3, "call add success");
		assert.equal(program.getProp("secret"), 100, "secret");
	});
	
	it("simple json", () => {
		const sourceConfig: QuickJsProgramSourceConfig = {
			sources: {
				"index.js": `
					import data from "inner/data.json";
					export const foo = data.foo;
				`,
				"inner/data.json": `{"foo": "bar"}`
			}
		}
		
		const program = new QuickJsProgram(quickJS, sourceConfig);
		assert.equal(program.getProp("foo"), "bar", "json imported");
	})
	
	it("simple text", () => {
		const sourceConfig: QuickJsProgramSourceConfig = {
			sources: {
				"index.js": `
					import data from "inner/data.txt";
					export {data as text}
				`,
				"inner/data.txt": "Hello world"
			}
		}
		
		const program = new QuickJsProgram(quickJS, sourceConfig);
		assert.equal(program.getProp("text"), "Hello world", "txt imported");
	});
	
	it("immediate", async () => {
		const sourceConfig: QuickJsProgramSourceConfig = {
			sources: {
				"index.js": `
					export function test() {
						return new Promise(r => {
							let x = 0;
							setImmediate(() => r(x));
							x++;
						});
					}
				`
			}
		}
		
		const program = new QuickJsProgram(quickJS, sourceConfig);
		const result = await program.call("test")
		assert.equal(result, 1, "txt imported");
	})
	
	it("deadlocks", async () => {
		const sourceConfig: QuickJsProgramSourceConfig = {
			sources: {
				"index.js": `
					export function cycle(x){
						let c = 0;
						for (let i=0; i<x; i++);
						return c;
					}
					
					export async function asyncCycle(x){
						let c = 0;
						for (let i=0; i<x; i++);
						return c;
					}
				`,
			}
		}
		
		const program = new QuickJsProgram(quickJS, sourceConfig);
		program.call("cycle", null, 1);
		program.call("cycle", null, 100);
		program.call("cycle", null, 100000);
		assert.throws(() => {
			program.call("cycle", null, Infinity);
		}, (error: any) => error.message === 'interrupted', "should interrupt");
		program.call("cycle", null, 10);
		
		await program.call("asyncCycle", null, 1);
		await program.call("asyncCycle", null, 100);
		await program.call("asyncCycle", null, 100000);
		await assert.rejects(async () => {
			await program.call("asyncCycle", null, Infinity);
		}, (error: any) => error.message === 'interrupted', "should interrupt async");
		await program.call("asyncCycle", null, 10);
	});
	
	it("deadlocks in timeout", async () => {
		const sourceConfig: QuickJsProgramSourceConfig = {
			sources: {
				"index.js": `
					export async function asyncCycle(){
						await new Promise(r => setTimeout(r, 1));
						while (true);
						return "newer";
					}
				`,
			}
		}

		const program = new QuickJsProgram(quickJS, sourceConfig);
		await assert.rejects(async () => {
			await program.call("asyncCycle", undefined);
		}, (error: any) => error.message === 'interrupted', "should reject deadlock");
		
	})
})