/** Node test port for the shared request protocol; not shipped in the app. */
import { TranslationService as ProtocolService, type TranslationServiceOptions as ProtocolOptions } from '../../../src/core/services/translation';
import { nodeServiceRuntime } from '../service-runtime';
export * from '../../../src/core/services/translation';
export type TranslationServiceOptions = Omit<ProtocolOptions, 'runtime'>;
export class TranslationService extends ProtocolService {
  constructor(options: TranslationServiceOptions) { super({ ...options, runtime: nodeServiceRuntime }); }
}
