import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { WorkspaceEvent } from "@cutucircuits/core";
export class EventHub {
  private emitter = new EventEmitter();
  constructor() {
    this.emitter.setMaxListeners(0);
  }
  publish(projectId: string, type: WorkspaceEvent["type"], data: unknown) {
    const event: WorkspaceEvent = {
      id: randomUUID(),
      projectId,
      type,
      timestamp: new Date().toISOString(),
      data,
    };
    this.emitter.emit(projectId, event);
    return event;
  }
  subscribe(projectId: string, listener: (event: WorkspaceEvent) => void) {
    this.emitter.on(projectId, listener);
    return () => {
      this.emitter.off(projectId, listener);
    };
  }
}
