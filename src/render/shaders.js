/**
 * Ultracraft - GLSL ES 3.00 shader sources.
 *
 * Design goals
 *  - one attribute layout shared by the terrain, shadow and water passes so a
 *    single vertex buffer serves every pass (12 bytes per vertex)
 *  - physically motivated but cheap: baked voxel AO + smooth light, one
 *    directional light with cascaded shadow maps, image based sky ambient,
 *    normal-mapped specular and exponential height fog
 *  - every effect can be switched off with a #define so low-end devices get a
 *    genuinely cheaper shader instead of a branch
 */

// ===========================================================================
//  shared chunks
// ===========================================================================

const COMMON = /* glsl */`
// The sun direction lives in COMMON because fog, shadows and lighting all
// use it, and a uniform may only be declared once per stage.
uniform vec3 uSunDir;
const float PI = 3.14159265;

float lightCurve(float x) { return x * x * (3.0 - 2.0 * x); }

float hash1(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash1(i), b = hash1(i + vec2(1.0, 0.0));
  float c = hash1(i + vec2(0.0, 1.0)), d = hash1(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm2(vec2 p, int oct) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 6; i++) {
    if (i >= oct) break;
    s += a * vnoise(p);
    p *= 2.03; a *= 0.5;
  }
  return s;
}
`;

const FOG = /* glsl */`
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uFogHeightFalloff;
uniform float uFogSunAmount;

vec3 applyFog(vec3 col, float dist, float worldY, vec3 viewDir) {
  // Height fog: density falls off with altitude, thicker in hollows.
  float h = max(worldY - uFogHeightFalloff, 0.0);
  float density = uFogDensity * exp(-h * 0.035);
  float f = 1.0 - exp(-dist * density);
  f = clamp(f, 0.0, 1.0);
  // Inscattering: fog glows towards the sun.
  float sunAmt = clamp(dot(viewDir, uSunDir) * 0.5 + 0.5, 0.0, 1.0);
  vec3 fog = mix(uFogColor, uFogColor * 1.6 + vec3(0.16, 0.11, 0.06), pow(sunAmt, 4.0) * uFogSunAmount);
  return mix(col, fog, f);
}
`;

const SHADOW = /* glsl */`
uniform highp sampler2DArrayShadow uShadowMap;
uniform mat4 uCascadeMat[4];
uniform float uCascadeDist[4];
uniform float uCascadeBias[4];
uniform int uCascadeCount;
uniform float uShadowTexel;
uniform int uShadowQuality;
uniform float uShadowStrength;

float shadowAt(vec3 worldPos, vec3 n, float ndl, float viewZ) {
  if (uCascadeCount <= 0 || ndl <= 0.001) return 1.0;
  int idx = uCascadeCount - 1;
  for (int i = 0; i < 4; i++) {
    if (i >= uCascadeCount) break;
    if (viewZ < uCascadeDist[i]) { idx = i; break; }
  }
  vec3 offset = n * uCascadeBias[idx];
  vec4 lp = uCascadeMat[idx] * vec4(worldPos + offset, 1.0);
  vec3 proj = lp.xyz / lp.w;
  vec2 uv = proj.xy * 0.5 + 0.5;
  if (uv.x < 0.002 || uv.x > 0.998 || uv.y < 0.002 || uv.y > 0.998 || proj.z > 1.0) return 1.0;
  float ref = proj.z * 0.5 + 0.5;
  float sum = 0.0;
  if (uShadowQuality >= 2) {
    // 3x3 rotated-ish PCF
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        sum += texture(uShadowMap, vec4(uv + vec2(float(x), float(y)) * uShadowTexel, float(idx), ref));
      }
    }
    sum *= 0.111111;
  } else if (uShadowQuality == 1) {
    vec2 o = uShadowTexel * 0.75;
    sum  = texture(uShadowMap, vec4(uv + vec2(-o.x, -o.y), float(idx), ref));
    sum += texture(uShadowMap, vec4(uv + vec2( o.x, -o.y), float(idx), ref));
    sum += texture(uShadowMap, vec4(uv + vec2(-o.x,  o.y), float(idx), ref));
    sum += texture(uShadowMap, vec4(uv + vec2( o.x,  o.y), float(idx), ref));
    sum *= 0.25;
  } else {
    sum = texture(uShadowMap, vec4(uv, float(idx), ref));
  }
  return mix(1.0, sum, uShadowStrength);
}
`;

/** Directional + ambient lighting shared by terrain and entities. */
const LIGHTING = /* glsl */`
uniform vec3 uSunColor;
uniform vec3 uSkyTop;
uniform vec3 uSkyHorizon;
uniform vec3 uTorchColor;
uniform float uAmbient;
uniform float uSunIntensity;
uniform float uNightFactor;

vec3 ambientLight(vec3 n, float skyLight) {
  float up = clamp(n.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 sky = mix(uSkyHorizon, uSkyTop, up);
  float l = lightCurve(clamp(skyLight, 0.0, 1.0));
  return (sky * (0.35 + 0.65 * l) + vec3(uAmbient)) * (0.25 + 0.75 * l);
}

vec3 shadeSurface(vec3 albedo, vec3 n, vec3 viewDir, float skyLight, float blockLight,
                  float shadow, float rough, float metal, float specular, float emissive, float ao) {
  vec3 N = normalize(n);
  float ndl = max(dot(N, uSunDir), 0.0);
  // wrapped diffuse keeps shadowed faces from going pitch black
  float wrap = clamp((dot(N, uSunDir) + 0.25) / 1.25, 0.0, 1.0);
  float sunVis = clamp(skyLight * 1.05, 0.0, 1.0) * (1.0 - uNightFactor * 0.65);
  vec3 sun = uSunColor * uSunIntensity * (ndl * 0.85 + wrap * 0.15) * shadow * sunVis;

  vec3 amb = ambientLight(N, skyLight);
  vec3 torch = uTorchColor * lightCurve(clamp(blockLight, 0.0, 1.0)) * 1.15;

  vec3 diffuse = albedo * (sun + amb + torch);

  // cheap energy-conserving specular
  vec3 H = normalize(uSunDir + viewDir);
  float ndoth = max(dot(N, H), 0.0);
  float shininess = mix(4.0, 220.0, 1.0 - clamp(rough, 0.0, 1.0));
  float spec = pow(ndoth, shininess) * (1.0 - rough) * specular * sunVis * shadow;
  vec3 specColor = mix(vec3(1.0), albedo, metal) * spec * 1.4;

  vec3 emissiveCol = albedo * emissive * 1.6;
  return (diffuse + specColor) * mix(0.35, 1.0, ao) + emissiveCol;
}
`;

const TANGENT = /* glsl */`
vec3 applyNormalMap(vec3 n, vec3 tn, float strength) {
  vec3 N = normalize(n);
  vec3 up = abs(N.y) > 0.99 ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 1.0, 0.0);
  vec3 T = normalize(cross(up, N));
  vec3 B = normalize(cross(N, T));
  vec3 t = tn * 2.0 - 1.0;
  t.xy *= strength;
  return normalize(T * t.x + B * t.y + N * t.z);
}
`;

// ===========================================================================
//  terrain
// ===========================================================================
const CHUNK_VERT = /* glsl */`#version 300 es
precision highp float;
precision highp sampler2DArray;

layout(location = 0) in vec3 aPos;      // u8 normalised, x16 = local position
layout(location = 1) in vec2 aUV;       // u8 normalised
layout(location = 2) in uint aTex;      // texture array layer
layout(location = 3) in uint aNorm;     // 0..5 face normal index
layout(location = 4) in vec3 aLight;    // ao, block light, sky light (0..1)

uniform mat4 uViewProj;
uniform vec3 uChunkOrigin;
uniform float uTime;

${COMMON}

out vec2 vUV;
flat out int vLayer;
out vec3 vNormal;
out vec3 vWorld;
out vec3 vLight;
out float vViewZ;

const vec3 NORMALS[6] = vec3[6](
  vec3( 1.0, 0.0, 0.0), vec3(-1.0, 0.0, 0.0),
  vec3( 0.0, 1.0, 0.0), vec3( 0.0,-1.0, 0.0),
  vec3( 0.0, 0.0, 1.0), vec3( 0.0, 0.0,-1.0)
);

#ifdef WATER
uniform float uWaveStrength;
out float vWave;
#endif

void main() {
  vec3 local = aPos * 16.0;
  vec3 world = uChunkOrigin + local;
#ifdef WATER
  // gentle vertex swell on the surface only
  float w = 0.0;
  if (aNorm == 2u) {
    w = sin(world.x * 0.45 + uTime * 1.1) * 0.5 + sin(world.z * 0.37 - uTime * 0.9) * 0.5;
    w += sin((world.x + world.z) * 0.21 + uTime * 0.6) * 0.4;
    world.y += w * uWaveStrength;
    // and a touch on the sides so the surface lines up
  } else {
    w = sin(world.x * 0.45 + uTime * 1.1) * 0.5 + sin(world.z * 0.37 - uTime * 0.9) * 0.5;
    world.y += max(0.0, w) * uWaveStrength * 0.25;
  }
  vWave = w;
#endif
  vec4 clip = uViewProj * vec4(world, 1.0);
  gl_Position = clip;
  vUV = aUV;
  vLayer = int(aTex);
  vNormal = NORMALS[aNorm];
  vWorld = world;
  // AO is stored pre-curved on the CPU; lights are 0..1
  vLight = vec3(aLight.x, lightCurve(aLight.y), lightCurve(aLight.z));
  vViewZ = clip.w;
}
`;

const CHUNK_FRAG = /* glsl */`#version 300 es
precision highp float;
precision highp sampler2DArray;

in vec2 vUV;
flat in int vLayer;
in vec3 vNormal;
in vec3 vWorld;
in vec3 vLight;
in float vViewZ;

layout(location = 0) out vec4 outColor;

uniform sampler2DArray uAlbedo;
uniform sampler2DArray uNormalMap;
uniform sampler2D uMaterial;   // 256 x rows : row0 tint+emissive, row1 rough/metal/spec/_
uniform vec3 uCameraPos;
uniform float uMatRow0;
uniform float uMatRow1;
uniform int uAlphaTest;
uniform float uNormalStrength;
uniform int uNormalMaps;
uniform float uMipBias;
uniform vec3 uSelectionTint;
uniform int uBreakStage;
uniform float uTime;

${COMMON}
${FOG}
${SHADOW}
${LIGHTING}
${TANGENT}

void main() {
  vec2 uv = vUV;
  float layer = float(vLayer);
  vec4 tex = texture(uAlbedo, vec3(uv, layer), uMipBias);
#ifdef PORTAL
  // swirling nether/end portal
  vec2 p = uv * 2.0;
  float n = fbm2(p * 2.0 + vec2(uTime * 0.25, -uTime * 0.18), 4);
  float n2 = fbm2(p * 3.0 - vec2(uTime * 0.15, uTime * 0.22), 3);
  tex.rgb = mix(tex.rgb * (0.5 + n), vec3(0.75, 0.35, 1.0), n2 * 0.75);
  tex.a = 1.0;
#endif
  if (uAlphaTest == 1 && tex.a < 0.5) discard;

  vec4 mat0 = texture(uMaterial, vec2((layer + 0.5) / 256.0, uMatRow0));
  vec4 mat1 = texture(uMaterial, vec2((layer + 0.5) / 256.0, uMatRow1));

  vec3 albedo = tex.rgb * mat0.rgb;
  float emissive = mat0.a;
  float rough = mat1.r;
  float metal = mat1.g;
  float specular = mat1.b;

  vec3 N = vNormal;
  if (uNormalMaps == 1) {
    vec3 tn = texture(uNormalMap, vec3(uv, layer), uMipBias).rgb;
    N = applyNormalMap(N, tn, uNormalStrength);
  }

  vec3 viewDir = normalize(uCameraPos - vWorld);
  float ndl = max(dot(N, uSunDir), 0.0);
  float shadow = shadowAt(vWorld, N, ndl, vViewZ);

  vec3 col = shadeSurface(albedo, N, viewDir, vLight.z, vLight.y, shadow,
                          rough, metal, specular, emissive, vLight.x);

  float dist = length(uCameraPos - vWorld);
  col = applyFog(col, dist, vWorld.y, -viewDir);

#ifdef SELECTION
  col = mix(col, uSelectionTint, 0.12 + 0.06 * sin(uTime * 4.0));
#endif

  outColor = vec4(col, tex.a);
}
`;

const CHUNK_SHADOW_FRAG = /* glsl */`#version 300 es
precision highp float;
precision highp sampler2DArray;

in vec2 vUV;
flat in int vLayer;
in vec3 vNormal;
in vec3 vWorld;
in vec3 vLight;
in float vViewZ;

uniform sampler2DArray uAlbedo;
uniform int uAlphaTest;

void main() {
  if (uAlphaTest == 1) {
    vec4 tex = texture(uAlbedo, vec3(vUV, float(vLayer)));
    if (tex.a < 0.5) discard;
  }
}
`;

// ===========================================================================
//  water
// ===========================================================================
const WATER_FRAG = /* glsl */`#version 300 es
precision highp float;
precision highp sampler2DArray;

in vec2 vUV;
flat in int vLayer;
in vec3 vNormal;
in vec3 vWorld;
in vec3 vLight;
in float vViewZ;
in float vWave;

layout(location = 0) out vec4 outColor;

uniform sampler2D uReflection;
uniform sampler2D uRefraction;
uniform sampler2D uDepthTex;
uniform sampler2D uWaterNormal;
uniform sampler2DArray uAlbedo;
uniform vec2 uScreenSize;
uniform vec3 uCameraPos;
uniform vec3 uWaterColor;
uniform vec3 uDeepColor;
uniform float uTime;
uniform int uReflections;
uniform int uRefractions;
uniform float uNear;
uniform float uFar;
uniform vec4 uClipPlane;

${COMMON}
${FOG}
${SHADOW}
${LIGHTING}

float linearDepth(float d) {
  float z = d * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
}

vec3 waterNormal(vec2 p, float t) {
  vec3 n1 = texture(uWaterNormal, p * 0.035 + vec2(t * 0.012, t * 0.008)).rgb * 2.0 - 1.0;
  vec3 n2 = texture(uWaterNormal, p * 0.09 - vec2(t * 0.02, t * 0.014)).rgb * 2.0 - 1.0;
  vec3 n3 = texture(uWaterNormal, p * 0.21 + vec2(t * 0.03, -t * 0.02)).rgb * 2.0 - 1.0;
  vec3 n = normalize(vec3(n1.x + n2.x * 0.6 + n3.x * 0.3, 1.4, n1.z + n2.z * 0.6 + n3.z * 0.3));
  return n;
}

void main() {
  vec3 viewDir = normalize(uCameraPos - vWorld);
  bool top = vNormal.y > 0.5;
  vec3 N = top ? normalize(vec3(waterNormal(vWorld.xz, uTime).x, 3.0, waterNormal(vWorld.xz, uTime).z)) : vNormal;

  vec2 screenUV = gl_FragCoord.xy / uScreenSize;
  float depth = texture(uDepthTex, screenUV).r;
  float sceneZ = linearDepth(depth);
  float waterZ = linearDepth(gl_FragCoord.z);
  float depthDiff = clamp(sceneZ - waterZ, 0.0, 30.0);

  float fres = pow(clamp(1.0 - max(dot(N, viewDir), 0.0), 0.0, 1.0), 4.0);
  fres = mix(0.03, 1.0, fres);

  vec2 distort = N.xz * 0.045 / (1.0 + depthDiff * 0.2);
  vec3 refl = mix(uSkyHorizon, uSkyTop, 0.55);
  if (uReflections == 1) {
    vec2 ruv = clamp(screenUV + distort * 1.4, vec2(0.001), vec2(0.999));
    refl = texture(uReflection, ruv).rgb;
  }
  vec3 refr = uDeepColor;
  if (uRefractions == 1) {
    vec2 tuv = clamp(screenUV + distort * 0.5, vec2(0.001), vec2(0.999));
    refr = texture(uRefraction, tuv).rgb;
  }
  float absorb = clamp(depthDiff * 0.11, 0.0, 1.0);
  refr = mix(refr, uDeepColor * 0.75, absorb);

  vec3 col = mix(refr, refl, fres);

  // sun specular glint
  vec3 H = normalize(uSunDir + viewDir);
  float spec = pow(max(dot(N, H), 0.0), 240.0) * uSunIntensity;
  col += uSunColor * spec * 2.2 * (1.0 - uNightFactor * 0.8);

  // shallow water brightens towards the surface colour
  col = mix(uWaterColor * 0.85 + col * 0.35, col, clamp(depthDiff * 0.5, 0.0, 1.0));

  // shoreline foam
  float edge = 1.0 - clamp(depthDiff * 3.0, 0.0, 1.0);
  float foamNoise = fbm2(vWorld.xz * 1.4 + vec2(uTime * 0.4, uTime * 0.3), 3);
  float foam = smoothstep(0.55, 0.95, foamNoise + edge * 0.55) * edge;
  col = mix(col, vec3(0.95, 0.98, 1.0), foam * 0.55);

  float shadow = shadowAt(vWorld, vec3(0.0, 1.0, 0.0), 1.0, vViewZ);
  col *= mix(0.82, 1.0, shadow);
  col *= mix(0.35, 1.0, vLight.x);
  col += uTorchColor * lightCurve(clamp(vLight.y, 0.0, 1.0)) * 0.8;

  float dist = length(uCameraPos - vWorld);
  col = applyFog(col, dist, vWorld.y, -viewDir);

  float alpha = clamp(0.72 + fres * 0.25 + absorb * 0.3, 0.0, 1.0);
  outColor = vec4(col, alpha);
}
`;

// ===========================================================================
//  sky
// ===========================================================================
const SKY_VERT = /* glsl */`#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
out vec2 vUV;
void main() { vUV = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 1.0, 1.0); }
`;

const SKY_FRAG = /* glsl */`#version 300 es
precision highp float;

in vec2 vUV;
layout(location = 0) out vec4 outColor;

uniform mat4 uInvViewProj;
uniform vec3 uCameraPos;
uniform vec3 uMoonDir;
uniform vec3 uZenithColor;
uniform vec3 uHorizonColor;
uniform vec3 uSunColor;
uniform vec3 uGroundColor;
uniform float uTime;
uniform float uNightFactor;
uniform int uClouds;
uniform float uCloudCoverage;
uniform float uCloudHeight;
uniform float uRain;
uniform vec2 uResolution;

${COMMON}

float cloudDensity(vec2 p, float t) {
  float c = fbm2(p * 0.0035 + vec2(t * 0.004, t * 0.0015), 5);
  c = smoothstep(uCloudCoverage, uCloudCoverage + 0.28, c);
  return c;
}

void main() {
  vec4 ndc = vec4(vUV * 2.0 - 1.0, 1.0, 1.0);
  vec4 world = uInvViewProj * ndc;
  vec3 dir = normalize(world.xyz / world.w - uCameraPos);

  float upness = clamp(dir.y, -1.0, 1.0);
  float t = pow(clamp(upness, 0.0, 1.0), 0.55);
  vec3 col = mix(uHorizonColor, uZenithColor, t);
  if (dir.y < 0.0) col = mix(uHorizonColor, uGroundColor, clamp(-dir.y * 4.0, 0.0, 1.0));

  // sun & moon
  float sd = dot(dir, uSunDir);
  float sunDisc = smoothstep(0.99965, 0.99985, sd);
  float sunGlow = pow(clamp(sd, 0.0, 1.0), 900.0) * 3.0 + pow(clamp(sd, 0.0, 1.0), 24.0) * 0.35;
  col += uSunColor * (sunDisc * 12.0 + sunGlow) * (1.0 - uNightFactor * 0.9);

  float md = dot(dir, uMoonDir);
  float moonDisc = smoothstep(0.99955, 0.9998, md);
  float moonGlow = pow(clamp(md, 0.0, 1.0), 500.0) * 0.5;
  float moonMask = smoothstep(0.35, 0.75, fbm2(dir.xz * 40.0, 3));
  col += vec3(0.85, 0.88, 1.0) * (moonDisc * (2.0 + moonMask * 1.5) + moonGlow) * uNightFactor;

  // stars
  if (uNightFactor > 0.05) {
    vec3 sp = dir * 90.0;
    vec2 cell = floor(sp.xy + sp.z * 0.5);
    float r = hash1(cell);
    float star = smoothstep(0.9975, 0.9998, r);
    float tw = 0.6 + 0.4 * sin(uTime * 2.0 + r * 90.0);
    col += vec3(1.0, 0.98, 0.92) * star * tw * uNightFactor * clamp(dir.y * 2.0, 0.0, 1.0) * 1.6;
  }

  // clouds (cheap single-scatter slab)
  if (uClouds == 1 && dir.y > 0.005) {
    float tHit = (uCloudHeight - uCameraPos.y) / max(dir.y, 0.0001);
    if (tHit > 0.0 && tHit < 26000.0) {
      vec2 p = uCameraPos.xz + dir.xz * tHit;
      float d = cloudDensity(p, uTime);
      // parallax second layer for volume
      vec2 p2 = p + dir.xz * 220.0;
      float d2 = cloudDensity(p2, uTime * 1.3) * 0.6;
      float cov = clamp(d + d2 * (1.0 - d), 0.0, 1.0);
      float fade = 1.0 - smoothstep(6000.0, 16000.0, tHit);
      cov *= fade;
      vec3 cloudCol = mix(uHorizonColor * 1.05, vec3(1.0), 0.55) * (0.55 + 0.45 * (1.0 - uNightFactor));
      cloudCol += uSunColor * pow(clamp(dot(dir, uSunDir), 0.0, 1.0), 8.0) * 0.6;
      col = mix(col, cloudCol, cov * 0.92);
    }
  }

  // overcast rain darkening
  col = mix(col, col * 0.55 + uHorizonColor * 0.2, uRain * 0.6);

  outColor = vec4(col, 1.0);
}
`;

// ===========================================================================
//  entities & particles (dynamic, CPU-built geometry)
// ===========================================================================
const ENTITY_VERT = /* glsl */`#version 300 es
precision highp float;
precision highp sampler2DArray;

layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec4 aColor;
layout(location = 3) in vec2 aUV;
layout(location = 4) in float aTex;      // <0 = solid colour
layout(location = 5) in vec2 aLight;     // block, sky

uniform mat4 uViewProj;
out vec3 vNormal;
out vec4 vColor;
out vec2 vUV;
out float vTex;
out vec3 vWorld;
out vec2 vLight;
out float vViewZ;

void main() {
  vec4 clip = uViewProj * vec4(aPos, 1.0);
  gl_Position = clip;
  vNormal = aNormal;
  vColor = aColor;
  vUV = aUV;
  vTex = aTex;
  vWorld = aPos;
  vLight = aLight;
  vViewZ = clip.w;
}
`;

const ENTITY_FRAG = /* glsl */`#version 300 es
precision highp float;
precision highp sampler2DArray;

in vec3 vNormal;
in vec4 vColor;
in vec2 vUV;
in float vTex;
in vec3 vWorld;
in vec2 vLight;
in float vViewZ;

layout(location = 0) out vec4 outColor;

uniform sampler2DArray uAlbedo;
uniform sampler2D uMaterial;
uniform vec3 uCameraPos;
uniform int uAlphaTest;
uniform vec4 uTint;
uniform float uFlash;

${COMMON}
${FOG}
${SHADOW}
${LIGHTING}

void main() {
  vec4 col4 = vColor;
  float rough = 0.85, metal = 0.0, specular = 0.12, emissive = 0.0;
  float texLayer = floor(vTex * 255.0 + 0.5);
  if (texLayer < 254.5) {
    vec4 tex = texture(uAlbedo, vec3(vUV, texLayer));
    if (uAlphaTest == 1 && tex.a < 0.5) discard;
    col4 = vec4(tex.rgb * vColor.rgb, tex.a * vColor.a);
    if (col4.a < 0.01) discard;
  }
  col4 *= uTint;
  vec3 N = normalize(vNormal);
  vec3 viewDir = normalize(uCameraPos - vWorld);
  float ndl = max(dot(N, uSunDir), 0.0);
  float shadow = shadowAt(vWorld, N, ndl, vViewZ);
  vec3 col = shadeSurface(col4.rgb, N, viewDir, vLight.y, vLight.x, shadow,
                          rough, metal, specular, emissive, 1.0);
  float dist = length(uCameraPos - vWorld);
  col = applyFog(col, dist, vWorld.y, -viewDir);
  col = mix(col, vec3(1.0, 0.35, 0.3), uFlash);
  outColor = vec4(col, col4.a);
}
`;

const PARTICLE_VERT = /* glsl */`#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec2 aUV;
layout(location = 2) in vec4 aColor;
layout(location = 3) in float aTex;
layout(location = 4) in vec2 aLight;

uniform mat4 uViewProj;
out vec2 vUV;
out vec4 vColor;
out float vTex;
out vec3 vWorld;
out vec2 vLight;
out float vViewZ;

void main() {
  vec4 clip = uViewProj * vec4(aPos, 1.0);
  gl_Position = clip;
  vUV = aUV; vColor = aColor; vTex = aTex; vWorld = aPos; vLight = aLight; vViewZ = clip.w;
}
`;

const PARTICLE_FRAG = /* glsl */`#version 300 es
precision highp float;
precision highp sampler2DArray;

in vec2 vUV;
in vec4 vColor;
in float vTex;
in vec3 vWorld;
in vec2 vLight;
in float vViewZ;

layout(location = 0) out vec4 outColor;
uniform sampler2DArray uAlbedo;
uniform vec3 uCameraPos;

${COMMON}
${FOG}
${LIGHTING}

void main() {
  vec4 col4 = vColor;
  if (vTex >= 0.0) {
    vec4 t = texture(uAlbedo, vec3(vUV, vTex));
    col4 = vec4(t.rgb * vColor.rgb, t.a * vColor.a);
    if (col4.a < 0.02) discard;
  }
  vec3 amb = ambientLight(vec3(0.0, 1.0, 0.0), vLight.y);
  vec3 torch = uTorchColor * lightCurve(clamp(vLight.x, 0.0, 1.0));
  vec3 col = col4.rgb * (amb * 1.6 + torch * 1.2 + uSunColor * uSunIntensity * 0.35);
  float dist = length(uCameraPos - vWorld);
  col = applyFog(col, dist, vWorld.y, normalize(vWorld - uCameraPos));
  outColor = vec4(col, col4.a);
}
`;

const LINE_VERT = /* glsl */`#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec4 aColor;
uniform mat4 uViewProj;
out vec4 vColor;
void main() { gl_Position = uViewProj * vec4(aPos, 1.0); vColor = aColor; }
`;

const LINE_FRAG = /* glsl */`#version 300 es
precision highp float;
in vec4 vColor;
layout(location = 0) out vec4 outColor;
void main() { outColor = vColor; }
`;

// ===========================================================================
//  post processing
// ===========================================================================
const POST_VERT = /* glsl */`#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
out vec2 vUV;
void main() { vUV = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const BRIGHT_FRAG = /* glsl */`#version 300 es
precision highp float;
in vec2 vUV;
layout(location = 0) out vec4 outColor;
uniform sampler2D uScene;
uniform float uThreshold;
uniform float uSoftKnee;
void main() {
  vec3 c = texture(uScene, vUV).rgb;
  float br = max(c.r, max(c.g, c.b));
  float knee = uThreshold * uSoftKnee + 1e-5;
  float soft = clamp(br - uThreshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee);
  float contrib = max(soft, br - uThreshold) / max(br, 1e-5);
  outColor = vec4(c * contrib, 1.0);
}
`;

const BLUR_FRAG = /* glsl */`#version 300 es
precision highp float;
in vec2 vUV;
layout(location = 0) out vec4 outColor;
uniform sampler2D uScene;
uniform vec2 uTexelDir;
void main() {
  // 9-tap gaussian using 5 bilinear fetches
  vec3 sum = texture(uScene, vUV).rgb * 0.227027;
  vec2 o1 = uTexelDir * 1.3846153846;
  vec2 o2 = uTexelDir * 3.2307692308;
  sum += (texture(uScene, vUV + o1).rgb + texture(uScene, vUV - o1).rgb) * 0.3162162162;
  sum += (texture(uScene, vUV + o2).rgb + texture(uScene, vUV - o2).rgb) * 0.0702702703;
  outColor = vec4(sum, 1.0);
}
`;

const GODRAY_FRAG = /* glsl */`#version 300 es
precision highp float;
in vec2 vUV;
layout(location = 0) out vec4 outColor;
uniform sampler2D uScene;
uniform vec2 uSunScreen;
uniform float uIntensity;
uniform vec3 uColor;
uniform float uDecay;
const int SAMPLES = 24;
void main() {
  vec2 delta = (vUV - uSunScreen) / float(SAMPLES);
  vec2 uv = vUV;
  float illum = 1.0;
  vec3 acc = vec3(0.0);
  for (int i = 0; i < SAMPLES; i++) {
    uv -= delta;
    vec3 s = texture(uScene, uv).rgb;
    acc += s * illum;
    illum *= uDecay;
  }
  acc /= float(SAMPLES);
  outColor = vec4(acc * uColor * uIntensity, 1.0);
}
`;

const COPY_FRAG = /* glsl */`#version 300 es
precision highp float;
in vec2 vUV;
layout(location = 0) out vec4 outColor;
uniform sampler2D uScene;
void main() { outColor = vec4(texture(uScene, vUV).rgb, 1.0); }
`;

const COMPOSITE_FRAG = /* glsl */`#version 300 es
precision highp float;
in vec2 vUV;
layout(location = 0) out vec4 outColor;

uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform sampler2D uGodrays;
uniform vec2 uResolution;
uniform float uBloomAmount;
uniform float uGodrayAmount;
uniform float uExposure;
uniform float uSaturation;
uniform float uContrast;
uniform float uVignette;
uniform float uUnderwater;
uniform vec3 uUnderwaterColor;
uniform int uFxaa;
uniform float uDamageFlash;
uniform float uFade;

// ACES filmic approximation
vec3 acesFilm(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

vec3 fxaa(sampler2D tex, vec2 uv, vec2 texel) {
  vec3 rgbNW = texture(tex, uv + vec2(-1.0, -1.0) * texel).rgb;
  vec3 rgbNE = texture(tex, uv + vec2( 1.0, -1.0) * texel).rgb;
  vec3 rgbSW = texture(tex, uv + vec2(-1.0,  1.0) * texel).rgb;
  vec3 rgbSE = texture(tex, uv + vec2( 1.0,  1.0) * texel).rgb;
  vec3 rgbM  = texture(tex, uv).rgb;
  float lNW = luma(rgbNW), lNE = luma(rgbNE), lSW = luma(rgbSW), lSE = luma(rgbSE), lM = luma(rgbM);
  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), ((lNW + lSW) - (lNE + lSE)));
  float lSum = lNW + lNE + lSW + lSE;
  float dirReduce = max(lSum * 0.25 * 0.03125, 0.0078125);
  float rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
  dir = clamp(dir * rcpDirMin, vec2(-8.0), vec2(8.0)) * texel;
  vec3 rgbA = 0.5 * (texture(tex, uv + dir * (1.0 / 3.0 - 0.5)).rgb +
                     texture(tex, uv + dir * (2.0 / 3.0 - 0.5)).rgb);
  vec3 rgbB = rgbA * 0.5 + 0.25 * (texture(tex, uv + dir * -0.5).rgb +
                                   texture(tex, uv + dir *  0.5).rgb);
  float lB = luma(rgbB);
  return (lB < lMin || lB > lMax) ? rgbA : rgbB;
}

void main() {
  vec2 texel = 1.0 / uResolution;
  vec3 col = uFxaa == 1 ? fxaa(uScene, vUV, texel) : texture(uScene, vUV).rgb;
  col += texture(uBloom, vUV).rgb * uBloomAmount;
  col += texture(uGodrays, vUV).rgb * uGodrayAmount;

  if (uUnderwater > 0.001) {
    float d = length(vUV - 0.5);
    col = mix(col, uUnderwaterColor, clamp(uUnderwater * (0.65 + d * 0.5), 0.0, 1.0));
  }

  col *= uExposure;
  col = acesFilm(col);

  // grade
  float l = luma(col);
  col = mix(vec3(l), col, uSaturation);
  col = (col - 0.5) * uContrast + 0.5;

  if (uVignette > 0.0) {
    vec2 d = (vUV - 0.5) * vec2(1.0, 0.92);
    float v = 1.0 - dot(d, d) * uVignette;
    col *= clamp(v, 0.0, 1.0);
  }
  col = mix(col, vec3(0.55, 0.02, 0.02), clamp(uDamageFlash, 0.0, 1.0));
  col *= uFade;

  // subtle dither kills banding in the sky gradient
  float dither = fract(sin(dot(vUV * uResolution, vec2(12.9898, 78.233))) * 43758.5453) / 255.0;
  col += dither;

  outColor = vec4(pow(max(col, 0.0), vec3(1.0 / 2.2)), 1.0);
}
`;

export const SHADERS = {
  chunk: { vert: CHUNK_VERT, frag: CHUNK_FRAG },
  chunkSelection: { vert: CHUNK_VERT, frag: CHUNK_FRAG.replace('void main()', '#define SELECTION\nvoid main()') },
  chunkCutout: { vert: CHUNK_VERT, frag: CHUNK_FRAG.replace('void main()', '#define PORTAL\nvoid main()') },
  chunkShadow: { vert: CHUNK_VERT, frag: CHUNK_SHADOW_FRAG },
  water: {
    vert: CHUNK_VERT.replace('#ifdef WATER', '#define WATER\n#ifdef WATER'),
    frag: WATER_FRAG,
  },
  sky: { vert: SKY_VERT, frag: SKY_FRAG },
  entity: { vert: ENTITY_VERT, frag: ENTITY_FRAG },
  particle: { vert: PARTICLE_VERT, frag: PARTICLE_FRAG },
  line: { vert: LINE_VERT, frag: LINE_FRAG },
  post: { vert: POST_VERT, frag: COPY_FRAG },
  bright: { vert: POST_VERT, frag: BRIGHT_FRAG },
  blur: { vert: POST_VERT, frag: BLUR_FRAG },
  godray: { vert: POST_VERT, frag: GODRAY_FRAG },
  composite: { vert: POST_VERT, frag: COMPOSITE_FRAG },
};

export default SHADERS;
