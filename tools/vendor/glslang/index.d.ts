export interface ShaderInput { source: string; name?: string; }
export interface PassInput {
  vertex: string | ShaderInput;
  fragment: string | ShaderInput;
  defines?: Record<string, string | number | boolean>;
}
export interface Diagnostic {
  severity: 'warning' | 'error';
  stage: 'vertex' | 'fragment' | 'link';
  code: string;
  message: string;
  source?: string;
  /** One-based compiler source line; source directives are honored. */
  line?: number;
}
export interface CheckResult {
  status: 'pass' | 'failed';
  backend: 'glslang-wasm';
  diagnostics: Diagnostic[];
  stages: Array<{ stage: Diagnostic['stage']; success: boolean; log: string; debugLog: string }>;
  coverage: {
    defaultVersion: 300;
    defaultProfile: 'es';
    explicitVersionPreserved: true;
    defines: Record<string, string | number | boolean>;
    resourceProfile: string;
    staticLink: boolean;
    driverValidation: false;
  };
}
export interface Validator {
  readonly version: Readonly<{ glslang: string; abi: number; wasmSha256: string }>;
  readonly memoryBytes: number;
  /** Synchronous. Use a Worker when enforcing a hard timeout. */
  checkPass(input: PassInput): CheckResult;
  dispose(): void;
}
export class ValidatorRuntimeError extends Error {
  code: string;
  constructor(code: string, message: string, options?: ErrorOptions);
}
export function createValidator(options?: { wasmBinary?: Uint8Array }): Promise<Validator>;
