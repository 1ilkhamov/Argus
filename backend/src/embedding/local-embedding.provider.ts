import { Logger } from '@nestjs/common';

// Lazy-loaded to avoid import issues when not used
let pipeline: any;
let env: any;

const DEFAULT_LOCAL_MODEL = 'Xenova/multilingual-e5-small';

/**
 * Local embedding provider using Transformers.js (ONNX runtime).
 * No external server needed — runs entirely in Node.js.
 *
 * E5 models expect prefixed input:
 *   - "query: <text>" for search queries
 *   - "passage: <text>" for documents being indexed
 */
export class LocalEmbeddingProvider {
  private readonly logger = new Logger(LocalEmbeddingProvider.name);
  private readonly modelName: string;
  private extractor: any = null;
  private dimensions = 0;
  private ready = false;

  constructor(modelName?: string) {
    this.modelName = modelName || DEFAULT_LOCAL_MODEL;
  }

  async init(): Promise<boolean> {
    try {
      const transformers = await import('@xenova/transformers');
      pipeline = transformers.pipeline;
      env = transformers.env;

      // Disable local model check — always download from hub if needed
      env.allowLocalModels = false;

      this.logger.log(`Loading local embedding model: ${this.modelName}...`);
      this.extractor = await pipeline('feature-extraction', this.modelName);

      // Probe dimensions with a test embedding
      const testOutput = await this.extractor('test', { pooling: 'mean', normalize: true });
      this.dimensions = testOutput.dims[testOutput.dims.length - 1];
      this.ready = true;

      this.logger.log(
        `Local embedding model loaded: ${this.modelName}, dimensions=${this.dimensions}`,
      );
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to load local embedding model: ${message}`);
      this.ready = false;
      return false;
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  getDimensions(): number {
    return this.dimensions;
  }

  getModelName(): string {
    return this.modelName;
  }

  async embed(text: string): Promise<number[] | undefined> {
    if (!this.ready || !this.extractor) return undefined;

    try {
      const prefixed = this.addPrefix(text, false);
      const output = await this.extractor(prefixed, { pooling: 'mean', normalize: true });
      return Array.from(output.data as Float32Array).slice(0, this.dimensions);
    } catch (error) {
      this.logger.warn(
        `Local embed failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  async embedBatch(texts: string[]): Promise<number[][] | undefined> {
    if (!this.ready || !this.extractor || texts.length === 0) return undefined;

    try {
      const prefixed = texts.map((t) => this.addPrefix(t, false));
      const output = await this.extractor(prefixed, { pooling: 'mean', normalize: true });

      const results: number[][] = [];
      const flat = output.data as Float32Array;

      for (let i = 0; i < texts.length; i++) {
        const start = i * this.dimensions;
        results.push(Array.from(flat.slice(start, start + this.dimensions)));
      }

      return results;
    } catch (error) {
      this.logger.warn(
        `Local embedBatch failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  async embedQuery(text: string): Promise<number[] | undefined> {
    if (!this.ready || !this.extractor) return undefined;

    try {
      const prefixed = this.addPrefix(text, true);
      const output = await this.extractor(prefixed, { pooling: 'mean', normalize: true });
      return Array.from(output.data as Float32Array).slice(0, this.dimensions);
    } catch (error) {
      this.logger.warn(
        `Local embedQuery failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  /**
   * E5 models use prefixed input for better quality:
   * "query: ..." for search queries, "passage: ..." for documents.
   */
  private addPrefix(text: string, isQuery: boolean): string {
    const isE5 = this.modelName.toLowerCase().includes('e5');
    if (!isE5) return text;
    return isQuery ? `query: ${text}` : `passage: ${text}`;
  }
}
