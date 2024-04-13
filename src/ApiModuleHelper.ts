import type { ApiHelperController, PlayerController, Room } from "@flinbein/varhub";
import { QuickJsProgram, QuickJsProgramModuleSource } from "./QuickJsProgram.js";
import { QuickJsProgramModule } from "./QuickJsProgramModule.js";

const EVENT_EMITTER_MODULE_NAME = "@varhub/EventEmitter";
export class ApiModuleHelper {
	readonly #apiHelperController: ApiHelperController | undefined;
	readonly #apiPrefix: string;
	readonly #program: QuickJsProgram;
	
	constructor(apiCtrl: ApiHelperController | undefined, program: QuickJsProgram, apiPrefix: string) {
		this.#apiPrefix = apiPrefix;
		this.#program = program;
		this.#apiHelperController = apiCtrl;
		const innerModule = this.#program.createModule(
			apiPrefix+"#inner",
			// language=JavaScript
			`export let $; export const set = a => {$ = a}`
		);
		innerModule.withModule(wrapper => {
			wrapper.callMethod("set", wrapper.newFunction(this.callApi));
		});
	}
	
	
	
	getPossibleApiModuleName(file: string){
		if (file.startsWith(this.#apiPrefix)) return file.substring(this.#apiPrefix.length);
	}
	
	createApiSource(apiName: string): QuickJsProgramModuleSource | void {
		const api = this.#apiHelperController?.getOrCreateApi(apiName);
		if (!api) return;
		const methods = Object.getOwnPropertyNames(api);
		
		// language=JavaScript
		const innerModuleCode = `
			import {$} from ${JSON.stringify(this.#apiPrefix+"#inner")};
			const createMethod = (name) => (...args) => $(${JSON.stringify(apiName)}, name, ...args);
			export default Object.freeze({
				${methods.map((methodName) => (
                    // language=JavaScript prefix="export default {" suffix="}"
					`[${JSON.stringify(methodName)}]: createMethod(${JSON.stringify(methodName)})`
				)).join(",")}
			})
		`
		return {
			source: innerModuleCode,
			builtin: true,
		}
	}
	
	callApi = (apiName: unknown, method: unknown, ...args: unknown[]) => {
		const api = this.#apiHelperController?.getApi(String(apiName));
		if (!api) throw new Error(`api not initialized: ${apiName}`);
		const methodName = String(method);
		const methods = Object.getOwnPropertyNames(api);
		if (!methods.includes(methodName))  throw new Error(`api has no method: ${methodName}`);
		return api[methodName]?.(...args);
	}
}