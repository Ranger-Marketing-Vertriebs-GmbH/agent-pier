import { LocalRpcBroker } from "../../lib/local-rpc-broker.js";
import { memoryResponse } from "./memory-protocol.js";

export class MemoryBroker extends LocalRpcBroker {
  constructor(memory) {
    super({
      root: memory.root,
      name: "memory",
      respond: (credential, request) => memoryResponse(memory, credential, request),
    });
    this.memory = memory;
  }
}
