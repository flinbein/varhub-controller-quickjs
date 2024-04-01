import { getQuickJS } from "quickjs-emscripten"
import { default as assert } from "node:assert";
import { describe, it } from "node:test";
import {QuickJsProgram, QuickJsProgramSourceConfig} from "../QuickJsProgram.js"

const quickJS = await getQuickJS();

await describe("test program",async  () => {
	await it("simple methods", async () => {
		const sourceConfig: QuickJsProgramSourceConfig = {
			main: "index.js",
			sources: {
				["index.js"]: {
					type: "js",
					source: `
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
					`
				}
			}
		}
		
		const program = new QuickJsProgram(quickJS, sourceConfig);
		
		const result1 = program.call("increment", undefined, 10);
		assert.equal(result1, 11);
		
		const result2 = await program.call("asyncIncrement", undefined, 20);
		assert.equal(result2, 21);
		
		assert.throws(() => {
			program.call("throwIncrement", undefined, 30)
		}, (error) => error === 31);
		
		await assert.rejects(async () => {
			await program.call("throwAsyncIncrement", undefined, 40)
		}, (error) => error === 41);
	});
})