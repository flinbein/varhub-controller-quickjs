export class PerformanceModuleHelper {
    #initTime;
    getNow = () => performance.now() - this.#initTime;
    constructor(program, moduleName) {
        this.#initTime = performance.now();
        /* language=javascript */
        const innerModule = program.createModule(`${moduleName}#inner`, "export let now; export const $set = s => now = s;", true);
        innerModule.withModule((wrapper) => {
            void wrapper.getProp("$set").call(undefined, wrapper.newFunction(this.getNow));
        });
        /* language=javascript */
        program.createModule(moduleName, `export { now } from "#inner";`, true);
    }
}
//# sourceMappingURL=PerformanceModuleHelper.js.map