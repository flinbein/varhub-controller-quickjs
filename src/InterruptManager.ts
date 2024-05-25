import { hrtime } from "node:process";

export class InterruptManager {
	#maxExecutionTime: bigint;
	readonly #poolTime: bigint;
	readonly #maxWorkTimeInPool: bigint;
	
	constructor(maxExecutionTimeNs: bigint, poolTimeNs: bigint, maxWorkTimeInPoolNs: bigint) {
		this.#maxExecutionTime = maxExecutionTimeNs;
		this.#poolTime = poolTimeNs;
		this.#maxWorkTimeInPool = maxWorkTimeInPoolNs;
	}
	
	#longStartHandleTime: bigint = 0n;
	#longPoolAccum: bigint = 0n;
	
	#startHandleTime = 0n;
	
	handle = <T>(fn: () => T, overrideExecutionTime?: bigint): T => {
		// throw on double-context
		if (this.#startHandleTime) return fn();
		
		this.#checkAndSetTimers();
		
		const lastExecutionTime = this.#maxExecutionTime; // zone?
		try {
			if (overrideExecutionTime) this.#maxExecutionTime = overrideExecutionTime
			return fn();
		} finally {
			this.#maxExecutionTime = lastExecutionTime;
			const handleTime = hrtime.bigint() - this.#startHandleTime;
			this.#longPoolAccum += handleTime;
			this.#startHandleTime = 0n;
		}
	}
	
	handleIgnoreErrors = (fn: () => any, overrideExecutionTime?: bigint): void => {
		try {
			this.handle(fn, overrideExecutionTime);
		} catch {}
	}
	
	
	#checkAndSetTimers = () => {
		this.#startHandleTime = hrtime.bigint();
		
		// set new longStartHandleTime
		if (this.#longStartHandleTime === 0n || this.#longStartHandleTime < this.#startHandleTime - this.#poolTime) {
			this.#longStartHandleTime = this.#startHandleTime;
			this.#longPoolAccum = 0n;
		}
	}
	
	onInterrupt = () => {
		// throw if no context;
		if (!this.#startHandleTime) {
			this.#startHandleTime = hrtime.bigint();
		}
		
		
		const currentHandleTime = hrtime.bigint() - this.#startHandleTime;
		
		// throw on overdue;
		if (currentHandleTime > this.#maxExecutionTime) {
			return true;
		}
		
		// throw on overdue;
		if (this.#longPoolAccum + currentHandleTime > this.#maxWorkTimeInPool){
			return true;
		}
	}
}