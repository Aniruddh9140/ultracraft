import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import createGlslangModule from './glslang-validator.mjs';

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

export class ValidatorRuntimeError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'ValidatorRuntimeError';
    this.code = code;
  }
}

function sourceInput(input, stage) {
  const value = typeof input === 'string' ? { source: input } : input;
  if (!value || typeof value.source !== 'string' || !value.source.trim()) {
    throw new TypeError(`${stage}.source must be a non-empty GLSL string`);
  }
  const name = value.name ?? `${stage === 'vertex' ? 'shader.vert' : 'shader.frag'}`;
  if (typeof name !== 'string' || !name || /[\0\r\n]/.test(name) || name.length > 1024) {
    throw new TypeError(`${stage}.name must be a non-empty single-line name of at most 1024 characters`);
  }
  if (value.source.includes('\0')) throw new TypeError(`${stage}.source must not contain NUL`);
  if (Buffer.byteLength(value.source) > MAX_SOURCE_BYTES) throw new RangeError(`${stage}.source exceeds 2 MiB`);
  return { source: value.source, name };
}

function preambleFor(defines = {}) {
  if (!defines || typeof defines !== 'object' || Array.isArray(defines)) throw new TypeError('defines must be an object');
  const lines = [];
  for (const [name, value] of Object.entries(defines).sort(([a], [b]) => a.localeCompare(b))) {
    if (!/^[A-Za-z_]\w*$/.test(name) || name.startsWith('GL_') || name.includes('__')) {
      throw new TypeError(`Invalid or reserved define name: ${name}`);
    }
    if (!['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) {
      throw new TypeError(`Define ${name} must be a string, finite number, or boolean`);
    }
    const text = typeof value === 'boolean' ? String(Number(value)) : String(value);
    if (/[\0\r\n]/.test(text)) throw new TypeError(`Define ${name} must not contain NUL or newlines`);
    lines.push(`#define ${name} ${text}\n`);
  }
  const result = lines.join('');
  if (Buffer.byteLength(result) > 65536) throw new RangeError('defines exceed 64 KiB');
  return result;
}

function diagnosticsFor(stages, sources) {
  return stages.flatMap(stage => {
    const diagnostics = [];
    let active;
    for (const line of stage.log.split(/\r?\n/)) {
      const match = /^(ERROR|WARNING):\s*(.*)$/.exec(line);
      if (match) {
        // Prefer the exact caller name: names may themselves contain ':42: '.
        // A #line source override falls back to the compiler's source:line form.
        const source = sources[stage.stage];
        const local = source && match[2].startsWith(source + ':')
          ? /^(\d+):\s*(.*)$/.exec(match[2].slice(source.length + 1)) : null;
        const located = local ? [local[0], source, local[1], local[2]] : /^(.*?):(\d+):\s+(.*)$/.exec(match[2]);
        active = {
          severity: match[1] === 'ERROR' ? 'error' : 'warning',
          stage: stage.stage,
          code: stage.stage === 'link' ? 'shader-link-diagnostic' : 'shader-compile-diagnostic',
          message: located ? located[3] : match[2],
          ...(located ? { source: located[1], line: Number(located[2]) } : {}),
        };
        diagnostics.push(active);
      } else if (active && line.trim()) active.message += `\n${line}`;
    }
    if (!stage.success && !diagnostics.some(d => d.severity === 'error')) {
      diagnostics.push({ severity: 'error', stage: stage.stage, code: 'shader-check-failed', message: stage.log || stage.debugLog || `${stage.stage} validation failed` });
    }
    return diagnostics;
  });
}

/** Load a local, integrity-checked module. No network, compiler, or GPU is used. */
export async function createValidator(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('options must be an object');
  if (options.wasmBinary !== undefined && !(options.wasmBinary instanceof Uint8Array)) throw new TypeError('wasmBinary must be a Uint8Array');
  let manifest, wasmBinary;
  try {
    manifest = JSON.parse(await readFile(new URL('./manifest.json', import.meta.url), 'utf8'));
    if (!/^[a-f0-9]{64}$/.test(manifest?.files?.['glslang-validator.wasm']?.sha256 ?? '') ||
        typeof manifest?.toolchain?.glslang?.tag !== 'string' || manifest?.toolchain?.abiVersion !== 1 ||
        typeof manifest?.toolchain?.resourceProfile !== 'string') throw new Error('Invalid validator manifest');
    wasmBinary = options.wasmBinary ?? await readFile(new URL('./glslang-validator.wasm', import.meta.url));
  } catch (cause) {
    throw new ValidatorRuntimeError('wasm-artifact-load-failed', 'Cannot load the local glslang WASM artifacts', { cause });
  }
  const actual = createHash('sha256').update(wasmBinary).digest('hex');
  if (actual !== manifest.files['glslang-validator.wasm'].sha256) {
    throw new ValidatorRuntimeError('wasm-integrity-mismatch', 'WASM bytes do not match the pinned manifest');
  }
  let module;
  try {
    module = await createGlslangModule({
      wasmBinary,
      print: () => {},
      printErr: () => {},
    });
    if (!module._validator_initialize()) throw new Error('glslang InitializeProcess failed');
  } catch (cause) {
    throw new ValidatorRuntimeError('wasm-initialization-failed', 'Cannot initialize glslang WASM', { cause });
  }
  let disposed = false;
  let poisoned = false;
  return {
    version: Object.freeze({ glslang: manifest.toolchain.glslang.tag, abi: manifest.toolchain.abiVersion, wasmSha256: actual }),
    get memoryBytes() { return module._validator_heap_bytes(); },
    /** Synchronous. A caller requiring a hard timeout must use a Worker. */
    checkPass(request) {
      if (disposed || poisoned) throw new ValidatorRuntimeError('validator-unavailable', 'Create a new validator after dispose or a WASM runtime failure');
      if (!request || typeof request !== 'object') throw new TypeError('checkPass requires a request object');
      const vertex = sourceInput(request.vertex, 'vertex');
      const fragment = sourceInput(request.fragment, 'fragment');
      const preamble = preambleFor(request.defines);
      const pointers = [];
      try {
        for (const value of [vertex.source, fragment.source, vertex.name, fragment.name, preamble]) {
          const size = module.lengthBytesUTF8(value) + 1;
          const pointer = module._malloc(size);
          if (!pointer) throw new Error('WASM allocation failed');
          pointers.push(pointer);
          module.stringToUTF8(value, pointer, size);
        }
        const raw = JSON.parse(module.UTF8ToString(module._validator_validate(...pointers)));
        if (raw.status === 'incomplete') throw new Error('glslang is not initialized');
        return {
          status: raw.status,
          backend: 'glslang-wasm',
          diagnostics: diagnosticsFor(raw.stages, { vertex: vertex.name, fragment: fragment.name }),
          stages: raw.stages,
          coverage: {
            defaultVersion: 300,
            defaultProfile: 'es',
            explicitVersionPreserved: true,
            defines: { ...request.defines },
            resourceProfile: manifest.toolchain.resourceProfile,
            staticLink: raw.stages.some(stage => stage.stage === 'link'),
            driverValidation: false,
          },
        };
      } catch (cause) {
        poisoned = true;
        throw new ValidatorRuntimeError('wasm-execution-failed', 'glslang WASM execution failed; this is not a shader diagnostic', { cause });
      } finally {
        if (!poisoned) for (const pointer of pointers) module._free(pointer);
      }
    },
    dispose() {
      if (!disposed && !poisoned) module._validator_shutdown();
      disposed = true;
    },
  };
}
