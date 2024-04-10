import { hrtime } from "node:process";

export class InterruptManager {
	#maxExecutionTimeNs: bigint;
	
	constructor(maxExecutionTimeNs: bigint) {
		this.#maxExecutionTimeNs = maxExecutionTimeNs;
	}
	
	#interruptImmediate: ReturnType<typeof setImmediate> | undefined = undefined;
	#interruptTime: bigint | undefined = undefined;
	onInterrupt = () => {
		if (this.#interruptImmediate == null) {
			this.#interruptImmediate = setImmediate(() => {
				this.#interruptImmediate = undefined;
				this.#interruptTime = undefined;
			});
			this.#interruptTime = hrtime.bigint();
			return false;
		}
		if (this.#interruptTime == null) return false;
		const diff = hrtime.bigint() - this.#interruptTime;
		if (diff > this.#maxExecutionTimeNs) return true;
		
		return false;
	}
	
	clear(){
		this.#interruptImmediate = undefined;
		this.#interruptTime = undefined;
	}
	
	readonly alive: boolean = true;
	
	dispose() {
	}
}