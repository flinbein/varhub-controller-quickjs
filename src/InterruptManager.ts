import { hrtime } from "node:process";

export class InterruptManager {
	#maxExecutionTimeNs: bigint;
	
	constructor(maxExecutionTimeNs: bigint) {
		this.#maxExecutionTimeNs = maxExecutionTimeNs;
	}
	
	#interruptImmediate: ReturnType<typeof setImmediate> | undefined = undefined;
	#interruptTime = 0n;
	
	#interruptTimeout: ReturnType<typeof setTimeout> | undefined = undefined;
	#interruptTimeSum = 0n;
	
	onInterrupt = () => {
		if (this.#interruptTimeout == null) {
			this.#interruptTimeSum = 0n;
			this.#interruptTimeout = setTimeout(() => {
				this.#interruptTimeout = undefined;
			}, 10);
		}
		
		if (this.#interruptImmediate == null) {
			this.#interruptImmediate = setImmediate(() => {
				this.#interruptImmediate = undefined;
				this.#interruptTimeSum += hrtime.bigint() - this.#interruptTime;
			});
			this.#interruptTime = hrtime.bigint();
		}
		const diff = hrtime.bigint() - this.#interruptTime;
		if (diff > this.#maxExecutionTimeNs) return true;
		return this.#interruptTimeSum > 10_000_000n / 5n;
		
		
	}
	
	clear(){
		this.#interruptImmediate = undefined;
		this.#interruptTimeout = undefined;
	}
}