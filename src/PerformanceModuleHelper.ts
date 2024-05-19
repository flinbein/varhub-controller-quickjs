import type { QuickJsProgram } from "./QuickJsProgram.js";

export class PerformanceModuleHelper {
	readonly #initTime: number;
	
	getNow = () => performance.now() - this.#initTime;
	
	constructor(program: QuickJsProgram, moduleName: string) {
		this.#initTime = performance.now();
		
		/* language=javascript */
		const innerModule = program.createModule(
			`${moduleName}#inner`,
			"export let now; export const $set = s => now = s;",
			true
		);
		innerModule.withModule((wrapper) => {
			void wrapper.callMethod("$set", wrapper.newFunction(this.getNow));
		});
		/* language=javascript */
		program.createModule(moduleName, `export { now } from "#inner";`, true);
	}
}