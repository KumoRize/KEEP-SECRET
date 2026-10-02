export const MODALITIES = ['image', 'video', '3d', 'website', 'app', 'game', 'music'] as const;
export type Modality = (typeof MODALITIES)[number];

export interface GenerationParams {
  durationSec?: number;
  aspectRatio?: '1:1' | '16:9' | '9:16' | '4:3' | '3:4';
}

export interface GenerationRequest {
  generationId: string;
  prompt: string;
  modality: Modality;
  params: GenerationParams;
}

export interface OutputFile {
  filename: string;
  contentType: string;
  data: Buffer;
}

export interface ProviderResult {
  files: OutputFile[];
  /** Actual provider cost if the API reports usage; otherwise the estimate is used. */
  costUsd?: number;
}

export interface ModelLicense {
  /** Whether outputs may be used commercially under the provider/model terms (verify before enabling). */
  commercialUse: boolean;
  note: string;
}

export interface ProviderModel {
  /** Globally unique id: `${providerId}:${model}`. */
  id: string;
  providerId: string;
  model: string;
  modality: Modality;
  label: string;
  /** Relative output quality used for routing (1-10). */
  quality: number;
  license: ModelLicense;
  maxDurationSec?: number;
  /** Upper-bound cost in USD for the given request; used to hold credits. */
  estimateCostUsd(prompt: string, params: GenerationParams): number;
}

export interface ProviderAdapter {
  id: string;
  name: string;
  isConfigured(): boolean;
  models(): ProviderModel[];
  run(model: ProviderModel, req: GenerationRequest, signal: AbortSignal): Promise<ProviderResult>;
}

/**
 * retriable: transient (429/5xx/timeout) - try the next provider.
 * unavailable: misconfiguration/auth - try the next provider and trip the breaker.
 * rejected: the provider refused the content or input - never route around it.
 */
export type ProviderErrorKind = 'retriable' | 'unavailable' | 'rejected';

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly kind: ProviderErrorKind,
    public readonly status?: number,
  ) {
    super(message);
  }
}
