import { Room } from "@flinbein/varhub";

export class QuickJsProgramModule {
	constructor(moduleName: string, source: string) {
		const inner = `
			export const subscribers = {}
			export function event(eventName, ...args){
				subscribers.eventName?.(...args);
			}
		`
	}
	callInner(method: string, ...args: any[]){
	
	}
}


const m = new QuickJsProgramModule("room", `
	import subscribers from "@inner";
	subscribers.connectionEnter = () => {
 
	}
	const room = {
        getPlayers();
	}
	export default room;
	
`)
declare const room: Room;
room.on("connectionEnter", (connection, ...args) => {
	m.callInner(connection.)
})