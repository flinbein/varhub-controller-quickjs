import { QuickJSContext, Scope } from "quickjs-emscripten"
export class PerformanceManager {
	#basePerformance = performance.now();
	
	settleContext(context: QuickJSContext){
		Scope.withScope((scope) => {
			const performanceHandle = scope.manage(context.newObject())
			const methodHandle = scope.manage(context.newFunction("now", () => {
				return context.newNumber(performance.now() - this.#basePerformance);
			}));
			context.defineProp(performanceHandle, "now", {
				value: methodHandle,
				enumerable: true,
				configurable: false,
			});
			context.setProp(context.global, "performance", performanceHandle);
		})
	}
}