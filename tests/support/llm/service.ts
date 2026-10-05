/** Node test port for the shared request protocol; not shipped in the app. */
import { LlmService as ProtocolService, type LlmServiceOptions as ProtocolOptions } from '../../../src/core/services/llm';
import { nodeServiceRuntime } from '../service-runtime';
export * from '../../../src/core/services/llm';
export type LlmServiceOptions = Omit<ProtocolOptions, 'runtime'>;
export class LlmService extends ProtocolService {
  constructor(options: LlmServiceOptions) { super({ ...options, runtime: nodeServiceRuntime }); }
}
