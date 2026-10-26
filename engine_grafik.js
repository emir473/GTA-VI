/*
 * Module: engine_grafik.js
 * Responsibility: renderer creation, shared scene, camera, lighting,
 * post-processing, quality profiles, PBR materials, LOD, visibility
 * budgeting, resource accounting and performance metrics.
 *
 * Dependency: Babylon.js loaded by index.html.
 * Public factory: createGraphicsRuntime({ canvas, runtime }).
 */

const QUALITY_PROFILES = Object.freeze({
  low: Object.freeze({
    hardwareScaling: 1.5,
    shadowSize: 1024,
    shadows: false,
    cascadedShadows: false,
    bloom: false,
    fxaa: false,
    fogQuality: 0,
    maxOcclusionTests: 1,
    targetFps: 30
  }),

  medium: Object.freeze({
    hardwareScaling: 1.15,
    shadowSize: 1536,
    shadows: true,
    cascadedShadows: false,
    bloom: true,
    fxaa: true,
    fogQuality: 1,
    maxOcclusionTests: 2,
    targetFps: 45
  }),

  high: Object.freeze({
    hardwareScaling: 1.0,
    shadowSize: 2048,
    shadows: true,
    cascadedShadows: true,
    bloom: true,
    fxaa: true,
    fogQuality: 2,
    maxOcclusionTests: 4,
    targetFps: 60
  }),

  ultra: Object.freeze({
    hardwareScaling: 0.8,
    shadowSize: 4096,
    shadows: true,
    cascadedShadows: true,
    bloom: true,
    fxaa: true,
    fogQuality: 3,
    maxOcclusionTests: 6,
    targetFps: 60
  })
});

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function clamp01(value) {
  return clampNumber(Number(value) || 0, 0, 1);
}

function chooseInitialProfile() {
  const coarsePointer = globalThis.matchMedia?.("(pointer: coarse)").matches;
  const smallScreen = Math.min(
    globalThis.innerWidth || 1024,
    globalThis.innerHeight || 768
  ) < 760;

  return coarsePointer || smallScreen ? "medium" : "high";
}

function asBabylonColor(B, value, fallback = "#808080") {
  const color = typeof value === "string" ? value : fallback;
  return B.Color3.FromHexString(color);
}

function stableSeed01(value) {
  const input = String(value ?? "window-interior");
  let hash = 2166136261;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xFFFFFFFF;
}

/* ------------------------------------------------------------------ */
/* Engine construction                                                 */
/* ------------------------------------------------------------------ */

async function createEngine(canvas, B, logger) {
  const errors = [];

  if (typeof B.WebGPUEngine === "function") {
    try {
      const supported = await B.WebGPUEngine.IsSupportedAsync;

      if (supported) {
        const webgpu = new B.WebGPUEngine(canvas, {
          antialias: true
        });

        await webgpu.initAsync();

        logger.info("WebGPU renderer initialized.");
        return {
          engine: webgpu,
          backend: "webgpu",
          fallbackErrors: errors
        };
      }

      errors.push("WebGPU is not supported by this runtime or device.");
    } catch (error) {
      errors.push(`WebGPU initialization failed: ${error.message}`);
      logger.warn("WebGPU initialization failed; attempting WebGL2.", error);
    }
  } else {
    errors.push("This Babylon.js build does not expose WebGPUEngine.");
  }

  try {
    /*
     * Babylon Engine manages WebGL2 where supported. The graphics
     * backend must be chosen before the Scene and its GPU resources
     * are created; the existing scene is not switched in place.
     */
    const webgl = new B.Engine(
      canvas,
      true,
      {
        preserveDrawingBuffer: false,
        stencil: true,
        disableWebGL2Support: false,
        powerPreference: "high-performance"
      },
      true
    );

    logger.info("WebGL renderer initialized.");

    return {
      engine: webgl,
      backend: "webgl",
      fallbackErrors: errors
    };
  } catch (error) {
    logger.error("WebGL renderer initialization failed.", error);
    throw new Error(
      "No usable Babylon.js graphics backend could be initialized."
    );
  }
}

/* ------------------------------------------------------------------ */
/* Graphics resource ledger                                           */
/* ------------------------------------------------------------------ */

function createResourceLedger(logger) {
  const resources = new Map();
  let nextId = 1;

  function register(resource, options = {}) {
    if (!resource || typeof resource !== "object") {
      throw new TypeError("Tracked resource must be an object.");
    }

    const id = nextId++;
    const record = {
      id,
      kind: String(options.kind ?? "unknown"),
      label: String(options.label ?? `resource-${id}`),
      estimatedBytes: Number.isFinite(options.estimatedBytes)
        ? Math.max(0, options.estimatedBytes)
        : null,
      resource,
      released: false
    };

    resources.set(id, record);

    return Object.freeze({
      id,

      release() {
        const existing = resources.get(id);
        if (!existing || existing.released) return false;

        existing.released = true;
        resources.delete(id);
        return true;
      }
    });
  }

  function disposeAll() {
    for (const record of [...resources.values()]) {
      try {
        if (typeof record.resource.dispose === "function") {
          record.resource.dispose();
        }
      } catch (error) {
        logger.warn(
          `Could not dispose tracked resource "${record.label}".`,
          error
        );
      }

      resources.delete(record.id);
    }
  }

  return Object.freeze({
    register,
    disposeAll,

    getSnapshot() {
      const counts = {};
      let knownEstimatedBytes = 0;
      let unknownSizeCount = 0;

      for (const record of resources.values()) {
        counts[record.kind] = (counts[record.kind] ?? 0) + 1;

        if (record.estimatedBytes === null) {
          unknownSizeCount++;
        } else {
          knownEstimatedBytes += record.estimatedBytes;
        }
      }

      return {
        count: resources.size,
        counts,
        knownEstimatedBytes,
        unknownSizeCount
      };
    }
  });
}

/* ------------------------------------------------------------------ */
/* Quality and post-processing                                         */
/* ------------------------------------------------------------------ */

function configurePipeline(pipeline, quality) {
  if (!pipeline) return;

  try {
    pipeline.samples = 1;
    pipeline.fxaaEnabled = quality.fxaa;
    pipeline.imageProcessingEnabled = true;

    if (pipeline.imageProcessing) {
      pipeline.imageProcessing.exposure = 1;
      pipeline.imageProcessing.contrast = 1.08;

      if (pipeline.imageProcessing.toneMappingEnabled !== undefined) {
        pipeline.imageProcessing.toneMappingEnabled = true;
      }

      const aces = globalThis.BABYLON
        ?.ImageProcessingConfiguration?.TONEMAPPING_ACES;

      if (
        aces !== undefined &&
        "toneMappingType" in pipeline.imageProcessing
      ) {
        pipeline.imageProcessing.toneMappingType = aces;
      }
    }

    pipeline.bloomEnabled = quality.bloom;
    pipeline.bloomThreshold = 0.82;
    pipeline.bloomWeight = 0.18;
    pipeline.bloomKernel = quality.fogQuality >= 2 ? 64 : 32;
    pipeline.bloomScale = 0.5;

    // DOF remains disabled by default to protect gameplay readability.
    pipeline.depthOfFieldEnabled = false;
    pipeline.chromaticAberrationEnabled = false;
    pipeline.grainEnabled = false;
  } catch (error) {
    console.warn("Some optional pipeline settings were rejected.", error);
  }
}

/* ------------------------------------------------------------------ */
/* Shadow generator                                                   */
/* ------------------------------------------------------------------ */

function createShadowSystem(B, scene, directionalLight, quality, logger) {
  let generator = null;
  let technique = "disabled";

  function disposeCurrent() {
    if (generator) {
      try {
        generator.dispose();
      } catch (error) {
        logger.warn("Could not dispose the previous shadow generator.", error);
      }
    }
    generator = null;
    technique = "disabled";
  }

  function rebuild(profile) {
    disposeCurrent();
    scene.shadowsEnabled = Boolean(profile.shadows);

    if (!profile.shadows) return null;

    // Prefer cascaded maps for high/ultra quality only when the loaded
    // Babylon build exposes the documented class and required members.
    if (profile.cascadedShadows && typeof B.CascadedShadowGenerator === "function") {
      try {
        const candidate = new B.CascadedShadowGenerator(
          profile.shadowSize,
          directionalLight
        );

        if (!("numCascades" in candidate)) {
          candidate.dispose?.();
          throw new Error("Cascaded shadow API lacks numCascades.");
        }

        candidate.numCascades = 4;
        if ("lambda" in candidate) candidate.lambda = 0.72;
        if ("stabilizeCascades" in candidate) candidate.stabilizeCascades = true;
        if ("bias" in candidate) candidate.bias = 0.0005;
        if ("normalBias" in candidate) candidate.normalBias = 0.025;

        generator = candidate;
        technique = "cascaded-shadow-maps";
        return generator;
      } catch (error) {
        logger.warn(
          "Cascaded shadows are unavailable in this Babylon build; using ESM instead.",
          error
        );
      }
    }

    try {
      generator = new B.ShadowGenerator(profile.shadowSize, directionalLight);
      generator.useExponentialShadowMap = true;
      generator.bias = 0.0005;
      generator.normalBias = 0.025;

      if ("filteringQuality" in generator &&
          B.ShadowGenerator.QUALITY_MEDIUM !== undefined) {
        generator.filteringQuality = B.ShadowGenerator.QUALITY_MEDIUM;
      }

      technique = "exponential-shadow-maps";
      return generator;
    } catch (error) {
      scene.shadowsEnabled = false;
      generator = null;
      technique = "disabled";
      logger.warn("Shadow generator could not be created.", error);
      return null;
    }
  }

  rebuild(quality);

  return Object.freeze({
    rebuild,
    getGenerator: () => generator,
    getTechnique: () => technique,

    dispose() {
      disposeCurrent();
      scene.shadowsEnabled = false;
    }
  });
}

/* ------------------------------------------------------------------ */
/* PBR material helpers                                                */
/* ------------------------------------------------------------------ */

function createPBRMaterial(B, scene, name, options = {}) {
  const material = new B.PBRMaterial(name, scene);

  material.albedoColor = asBabylonColor(
    B,
    options.albedo,
    "#888888"
  );

  material.metallic = clamp01(options.metallic ?? 0);
  material.roughness = clampNumber(
    Number(options.roughness ?? 0.75),
    0.025,
    1
  );

  if (options.emissive) {
    material.emissiveColor = asBabylonColor(
      B,
      options.emissive,
      "#000000"
    );
  }

  if (options.alpha !== undefined) {
    material.alpha = clamp01(options.alpha);
  }

  if (options.backFaceCulling !== undefined) {
    material.backFaceCulling = Boolean(options.backFaceCulling);
  }

  material.metadata = {
    ...(material.metadata || {}),
    leonidaMaterial: true,
    baseRoughness: material.roughness,
    baseMetallic: material.metallic
  };

  return material;
}

function applyMaterialWetness(material, wetness) {
  if (!material || !material.metadata?.leonidaMaterial) {
    return { ok: false, message: "Material is not a registered PBR material." };
  }

  const amount = clamp01(wetness);
  const baseRoughness = material.metadata.baseRoughness;

  // Water makes a surface optically smoother. Geometry, traction and
  // vehicle tire physics must still be handled by their own game systems.
  material.roughness = clampNumber(
    baseRoughness * (1 - 0.62 * amount),
    0.025,
    1
  );

  material.metadata.wetness = amount;

  return { ok: true, wetness: amount };
}

/* ------------------------------------------------------------------ */
/* LOD helper                                                          */
/* ------------------------------------------------------------------ */

function createLODGroup(baseMesh, levels = []) {
  if (!baseMesh || typeof baseMesh.addLODLevel !== "function") {
    throw new TypeError("LOD base mesh does not support addLODLevel().");
  }

  const sorted = [...levels].sort(
    (a, b) => a.distance - b.distance
  );

  let previousDistance = 0;

  for (const entry of sorted) {
    if (!Number.isFinite(entry.distance) || entry.distance <= previousDistance) {
      throw new RangeError(
        "LOD levels must have strictly increasing positive distances."
      );
    }

    if (
      entry.mesh !== null &&
      (!entry.mesh || typeof entry.mesh !== "object")
    ) {
      throw new TypeError("LOD level mesh must be a mesh or null.");
    }

    baseMesh.addLODLevel(entry.distance, entry.mesh);
    previousDistance = entry.distance;
  }

  return Object.freeze({
    mesh: baseMesh,
    levels: sorted.map(level => ({
      distance: level.distance,
      meshId: level.mesh?.id ?? null
    }))
  });
}

/* ------------------------------------------------------------------ */
/* Visibility budget and optional ray-based occlusion                 */
/* ------------------------------------------------------------------ */

function createVisibilityBudget({
  B,
  scene,
  camera,
  getQuality
}) {
  const entries = new Map();
  let elapsed = 0;
  let cursor = 0;
  let lastOcclusionTests = 0;

  function register(mesh, options = {}) {
    if (!mesh || typeof mesh.isInFrustum !== "function") {
      throw new TypeError("Visibility registration requires a mesh.");
    }

    if (entries.has(mesh.uniqueId)) {
      throw new Error(`Mesh already registered: ${mesh.name}`);
    }

    const record = {
      mesh,
      maxDistance: Number.isFinite(options.maxDistance)
        ? Math.max(0, options.maxDistance)
        : 1600,

      allowRayOcclusion: options.occlusion === true,
      originalVisibility: mesh.isVisible,
      originalEnabled: mesh.isEnabled()
    };

    entries.set(mesh.uniqueId, record);

    return () => {
      const existing = entries.get(mesh.uniqueId);
      if (!existing) return;

      // Restore original visibility on unregister.
      existing.mesh.isVisible = existing.originalVisibility;
      entries.delete(mesh.uniqueId);
    };
  }

  function update(deltaSeconds) {
    elapsed += Math.max(0, Number(deltaSeconds) || 0);

    if (elapsed < 0.25 || entries.size === 0) return;
    elapsed = 0;

    const list = [...entries.values()];
    const quality = getQuality();
    const maximumTests = Math.max(0, quality.maxOcclusionTests);
    let tests = 0;

    if (!camera || !camera.position) return;

    const planes = B.Frustum.GetPlanes(
      camera.getTransformationMatrix()
    );

    /*
     * This is deliberately a bounded CPU visibility pass, not a claim
     * of hardware GPU occlusion querying. Only meshes explicitly marked
     * as occlusion candidates use the additional ray test.
     */
    const countToInspect = Math.min(list.length, 80);

    for (let index = 0; index < countToInspect; index++) {
      const arrayIndex = (cursor + index) % list.length;
      const record = list[arrayIndex];
      const mesh = record.mesh;

      if (mesh.isDisposed()) continue;

      if (!record.originalEnabled) {
        mesh.isVisible = record.originalVisibility;
        continue;
      }

      mesh.isVisible = record.originalVisibility;

      if (!mesh.isInFrustum(planes)) {
        mesh.isVisible = false;
        continue;
      }

      const center = mesh.getBoundingInfo()
        .boundingSphere.centerWorld;

      const distance = B.Vector3.Distance(
        camera.globalPosition || camera.position,
        center
      );

      if (distance > record.maxDistance) {
        mesh.isVisible = false;
        continue;
      }

      if (
        record.allowRayOcclusion &&
        tests < maximumTests &&
        mesh.metadata?.occlusionCandidate === true
      ) {
        const directionVector = center.subtract(
          camera.globalPosition || camera.position
        );
        const radius = mesh.getBoundingInfo()
          .boundingSphere.radiusWorld;

        const maxLength = Math.max(0.01, directionVector.length() - radius);

        if (directionVector.length() > 0.01) {
          const rayOrigin = (camera.globalPosition || camera.position).clone();
          const ray = new B.Ray(
            rayOrigin,
            directionVector.normalize(),
            maxLength
          );

          const hit = scene.pickWithRay(
            ray,
            candidate =>
              candidate !== mesh &&
              candidate.isEnabled() &&
              candidate.isVisible &&
              candidate.visibility > 0 &&
              candidate.metadata?.occlusionOccluder === true,
            true
          );

          tests++;

          if (hit?.hit) {
            mesh.isVisible = false;
          }
        }
      }
    }

    cursor = (cursor + countToInspect) % Math.max(1, list.length);
    lastOcclusionTests = tests;
  }

  return Object.freeze({
    register,
    update,

    getStats() {
      return {
        registeredMeshes: entries.size,
        lastOcclusionTests
      };
    },

    clear() {
      for (const record of entries.values()) {
        if (!record.mesh.isDisposed()) {
          record.mesh.isVisible = record.originalVisibility;
        }
      }
      entries.clear();
    }
  });
}

/* ------------------------------------------------------------------ */
/* Window-interior material                                            */
/* ------------------------------------------------------------------ */

function createWindowInteriorMaterial({
  B,
  scene,
  backend,
  name,
  logger
}) {
  /*
   * WebGL supports this GLSL impostor shader. On WebGPU, return an
   * explicit PBR fallback rather than pretending the GLSL shader has
   * been compiled for WGSL.
   */
  if (backend !== "webgl" || !B.ShaderMaterial || !B.Effect?.ShadersStore) {
    const fallback = createPBRMaterial(B, scene, name, {
      albedo: "#29343d",
      metallic: 0.08,
      roughness: 0.46,
      emissive: "#252a2b"
    });

    fallback.metadata.windowInteriorMode = "pbr-fallback";

    return Object.freeze({
      material: fallback,
      mode: "pbr-fallback",
      dispose: () => fallback.dispose()
    });
  }

  const vertexShader = `
    precision highp float;

    attribute vec3 position;
    attribute vec2 uv;

    uniform mat4 worldViewProjection;

    varying vec2 vUV;

    void main(void) {
      vUV = uv;
      gl_Position = worldViewProjection * vec4(position, 1.0);
    }
  `;

  const fragmentShader = `
    precision highp float;

    varying vec2 vUV;

    uniform vec2 viewOffset;
    uniform vec3 wallColor;
    uniform vec3 roomColor;
    uniform float time;
    uniform float seed;

    void main(void) {
      vec2 repeatedUV = vUV * vec2(1.0, 1.25) + viewOffset;
      vec2 localUV = fract(repeatedUV);

      float frameX = step(0.075, localUV.x) *
                     step(localUV.x, 0.925);

      float frameY = step(0.075, localUV.y) *
                     step(localUV.y, 0.925);

      float insideRoom = frameX * frameY;

      vec2 insetUV = (localUV - 0.075) / 0.85;

      float horizontalRoomLine =
        1.0 - step(0.94, fract(insetUV.y * 2.0));

      float verticalRoomLine =
        1.0 - step(0.94, fract(insetUV.x * 1.4));

      float divider = max(horizontalRoomLine, verticalRoomLine) * 0.17;

      float variation =
        0.86 +
        0.10 * sin(seed * 17.0 + floor(repeatedUV.x) * 2.1) +
        0.06 * cos(seed * 11.0 + floor(repeatedUV.y) * 3.0);

      float warmLight =
        0.80 +
        0.18 * sin(time * 0.2 + seed * 4.0);

      vec3 litRoom = roomColor * variation * warmLight;
      litRoom *= (1.0 - divider);

      vec3 finalColor = mix(wallColor, litRoom, insideRoom);

      gl_FragColor = vec4(finalColor, 1.0);
    }
  `;

  B.Effect.ShadersStore["leonidaInteriorVertexShader"] = vertexShader;
  B.Effect.ShadersStore["leonidaInteriorFragmentShader"] = fragmentShader;

  let seed = stableSeed01(name);

  const material = new B.ShaderMaterial(
    name,
    scene,
    "leonidaInterior",
    {
      attributes: ["position", "uv"],
      uniforms: [
        "worldViewProjection",
        "viewOffset",
        "wallColor",
        "roomColor",
        "time",
        "seed"
      ],
      needAlphaBlending: false,
      needAlphaTesting: false
    }
  );

  material.setVector2("viewOffset", new B.Vector2(0, 0));
  material.setVector3("wallColor", new B.Vector3(0.11, 0.14, 0.16));
  material.setVector3("roomColor", new B.Vector3(0.91, 0.70, 0.43));
  material.setFloat("time", 0);
  material.setFloat("seed", seed);

  let elapsed = 0;

  const updateObserver = scene.onBeforeRenderObservable.add(() => {
    elapsed += scene.getEngine().getDeltaTime() / 1000;
    material.setFloat("time", elapsed);
  });

  /*
   * The window mesh can be attached as material.metadata.ownerMesh
   * by the architecture module. The camera-facing offset is then
   * calculated from the actual scene geometry.
   */
  const bindObserver = material.onBindObservable.add(() => {
    const owner = material.metadata?.ownerMesh;
    const camera = scene.activeCamera;

    if (!owner || !camera) return;

    const position = owner.getAbsolutePosition();
    const toCamera = camera.globalPosition.subtract(position);
    const distance = toCamera.length();

    if (distance < 0.001) return;

    toCamera.scaleInPlace(1 / distance);

    material.setVector2(
      "viewOffset",
      new B.Vector2(
        clampNumber(toCamera.x * 0.045, -0.045, 0.045),
        clampNumber(toCamera.y * 0.045, -0.045, 0.045)
      )
    );
  });

  material.metadata = {
    ...(material.metadata || {}),
    windowInteriorMode: "glsl-parallax-impostor"
  };

  logger.debug("Created WebGL window-interior impostor material.", { name });

  return Object.freeze({
    material,
    mode: "glsl-parallax-impostor",

    setSeed(value) {
      seed = clamp01(value);
      material.setFloat("seed", seed);
    },

    dispose() {
      scene.onBeforeRenderObservable.remove(updateObserver);
      material.onBindObservable.remove(bindObserver);
      material.dispose();
    }
  });
}

/* ------------------------------------------------------------------ */
/* Main factory                                                        */
/* ------------------------------------------------------------------ */

export async function createGraphicsRuntime({ canvas, runtime }) {
  if (!canvas) {
    throw new TypeError("Graphics runtime requires a canvas.");
  }

  if (!runtime?.logger || !runtime?.events) {
    throw new TypeError("Graphics runtime requires the shared runtime.");
  }

  const B = globalThis.BABYLON;

  if (!B) {
    throw new Error(
      "Babylon.js is unavailable. Verify the script loaded in index.html."
    );
  }

  const logger = runtime.logger;

  const created = await createEngine(canvas, B, logger);
  const engine = created.engine;
  const backend = created.backend;

  const initialProfile = chooseInitialProfile();
  let profileName = initialProfile;
  let quality = { ...QUALITY_PROFILES[profileName] };
  let disposed = false;
  let renderFailureCount = 0;
  let beforeRenderTime = 0;

  const ledger = createResourceLedger(logger);

  /*
   * One Engine and one Scene belong to the entire runtime. Other
   * modules receive these exact references through their factory args.
   */
  const scene = new B.Scene(engine);
  // Global coordinate contract for every gameplay module:
  // Babylon left-handed coordinates, +Y up, +Z forward, world units in meters.
  scene.useRightHandedSystem = false;

  // Keep the canvas transparent so the full-screen title/loading composition
  // from index.html remains visible until a world sky/environment is ready.
  scene.clearColor = new B.Color4(0.035, 0.050, 0.065, 0);

  scene.collisionsEnabled = true;
  scene.autoClear = true;
  scene.autoClearDepthAndStencil = true;

  scene.fogMode = B.Scene.FOGMODE_NONE;

  const camera = new B.UniversalCamera(
    "leonida-main-camera",
    new B.Vector3(0, 2.5, -10),
    scene
  );

  camera.minZ = 0.1;
  camera.maxZ = 12000;
  camera.fov = 0.95;
  camera.inertia = 0.72;
  camera.speed = 0;

  camera.setTarget(new B.Vector3(0, 0, 0));

  /*
   * Camera inputs are not attached here. The character/vehicle modules
   * own the gameplay camera and must not compete with a free-camera
   * mouse handler.
   */
  camera.inputs.clear();
  scene.activeCamera = camera;

  const hemisphericLight = new B.HemisphericLight(
    "leonida-ambient-light",
    new B.Vector3(0, 1, 0),
    scene
  );

  hemisphericLight.intensity = 0.55;
  hemisphericLight.diffuse = new B.Color3(0.76, 0.83, 0.90);
  hemisphericLight.groundColor = new B.Color3(0.15, 0.17, 0.19);

  const sunLight = new B.DirectionalLight(
    "leonida-sun-light",
    new B.Vector3(-0.42, -0.84, 0.28),
    scene
  );

  sunLight.position = new B.Vector3(300, 500, -200);
  sunLight.intensity = 2.25;

  const shadows = createShadowSystem(
    B,
    scene,
    sunLight,
    quality,
    logger
  );

  let pipeline = null;

  try {
    if (typeof B.DefaultRenderingPipeline === "function") {
      pipeline = new B.DefaultRenderingPipeline(
        "leonida-default-pipeline",
        true,
        scene,
        [camera]
      );

      configurePipeline(pipeline, quality);

      if (pipeline.isSupported === false) {
        pipeline.dispose();
        pipeline = null;

        logger.warn(
          "The default rendering pipeline is unsupported by this backend."
        );
      }
    }
  } catch (error) {
    pipeline = null;
    logger.warn(
      "Optional post-processing initialization failed.",
      error
    );
  }

  const originalRoughness = new WeakMap();

  function registerPBRMaterial(material) {
    if (!originalRoughness.has(material)) {
      originalRoughness.set(
        material,
        Number(material.roughness ?? 1)
      );
    }
    return material;
  }

  function setWetnessOnMaterial(material, amount) {
    if (!material || !Number.isFinite(amount)) {
      return { ok: false, message: "Invalid material or wetness." };
    }

    if (material instanceof B.PBRMaterial) {
      registerPBRMaterial(material);

      const base = originalRoughness.get(material) ?? material.roughness;
      const wetness = clamp01(amount);

      material.roughness = clampNumber(
        base * (1 - 0.62 * wetness),
        0.025,
        1
      );

      return { ok: true, wetness };
    }

    return {
      ok: false,
      message: "Wetness currently supports registered PBR materials."
    };
  }

  const visibility = createVisibilityBudget({
    B,
    scene,
    camera,
    getQuality: () => quality
  });

  const performanceStats = {
    frameTimeMs: 0,
    fps: 0,
    samples: 0,
    lastRenderError: null,
    drawCalls: null,
    estimatedTotalGpuBytes: null
  };

  function getMetrics() {
    let textureCount = 0;

    try {
      textureCount = scene.textures.length;
    } catch {
      // Texture count is a reported scene metric, not a GPU-memory claim.
    }

    return {
      backend,
      profile: profileName,
      fps: Number(engine.getFps().toFixed(1)),
      frameTimeMs: Number(performanceStats.frameTimeMs.toFixed(2)),
      meshCount: scene.meshes.length,
      activeMeshes: scene.getActiveMeshes().length,
      lightCount: scene.lights.length,
      textureCount,
      maxTextureSize: engine.getCaps()?.maxTextureSize ?? null,
      shadowTechnique: shadows.getTechnique(),
      lastRenderError: performanceStats.lastRenderError,
      performanceSamples: performanceStats.samples,

      // Babylon doesn't provide a stable exact GPU-memory and draw-call
      // measurement here. Null means unavailable, not zero.
      drawCalls: performanceStats.drawCalls,
      estimatedTotalGpuBytes: performanceStats.estimatedTotalGpuBytes,

      resources: ledger.getSnapshot(),
      visibility: visibility.getStats(),
      overloadCount: runtime.overloadCount
    };
  }

  async function setQualityProfile(requestedProfile) {
    const name = String(requestedProfile).toLowerCase();

    if (!Object.hasOwn(QUALITY_PROFILES, name)) {
      return {
        ok: false,
        message: `Unknown graphics profile: ${requestedProfile}`
      };
    }

    const previousName = profileName;
    const previousQuality = { ...quality };
    const nextQuality = { ...QUALITY_PROFILES[name] };

    try {
      engine.setHardwareScalingLevel(nextQuality.hardwareScaling);
      engine.resize();
      shadows.rebuild(nextQuality);
      configurePipeline(pipeline, nextQuality);

      quality = nextQuality;
      profileName = name;

      runtime.state?.patch?.({ qualityProfile: name }, "graphics-quality");
      runtime.events.emit("graphics:qualityChanged", {
        profile: name,
        backend,
        hardwareScaling: nextQuality.hardwareScaling,
        shadowTechnique: shadows.getTechnique()
      });

      logger.info(`Graphics profile selected: ${name}.`);
      return { ok: true, profile: name, shadowTechnique: shadows.getTechnique() };
    } catch (error) {
      logger.error("Graphics quality update failed; restoring previous profile.", error);

      quality = previousQuality;
      profileName = previousName;

      try {
        engine.setHardwareScalingLevel(previousQuality.hardwareScaling);
        engine.resize();
        shadows.rebuild(previousQuality);
        configurePipeline(pipeline, previousQuality);
      } catch (rollbackError) {
        logger.error("Graphics quality rollback failed.", rollbackError);
      }

      return {
        ok: false,
        message: error?.message ?? String(error)
      };
    }
  }

  function setAtmosphere(options = {}) {
    if (options.clearColor) {
      const color = options.clearColor;

      scene.clearColor = new B.Color4(
        clamp01(color.r),
        clamp01(color.g),
        clamp01(color.b),
        clamp01(color.a ?? 1)
      );
    }

    if (options.fog) {
      const fog = options.fog;

      if (fog.mode === "none") {
        scene.fogMode = B.Scene.FOGMODE_NONE;
      } else if (fog.mode === "linear") {
        scene.fogMode = B.Scene.FOGMODE_LINEAR;
        scene.fogStart = Math.max(0, Number(fog.start) || 0);
        scene.fogEnd = Math.max(
          scene.fogStart + 1,
          Number(fog.end) || 1000
        );
      } else if (fog.mode === "exponential") {
        scene.fogMode = B.Scene.FOGMODE_EXP;
        scene.fogDensity = clampNumber(
          Number(fog.density) || 0.0005,
          0.000001,
          0.1
        );
      } else if (fog.mode === "exponential-squared") {
        scene.fogMode = B.Scene.FOGMODE_EXP2;
        scene.fogDensity = clampNumber(
          Number(fog.density) || 0.0002,
          0.000001,
          0.1
        );
      }

      if (fog.color) {
        scene.fogColor = new B.Color3(
          clamp01(fog.color.r),
          clamp01(fog.color.g),
          clamp01(fog.color.b)
        );
      }
    }

    if (Number.isFinite(options.ambientIntensity)) {
      hemisphericLight.intensity =
        clampNumber(options.ambientIntensity, 0, 4);
    }

    if (Number.isFinite(options.sunIntensity)) {
      sunLight.intensity =
        clampNumber(options.sunIntensity, 0, 8);
    }
  }

  const cloudLayers = new Set();

  function createCloudLayer(options = {}) {
    const name = String(options.name ?? "leonida-cloud-layer");
    const width = Math.max(200, Number(options.width) || 6000);
    const depth = Math.max(200, Number(options.depth) || 6000);
    const altitudeMin = Number.isFinite(options.altitudeMin)
      ? options.altitudeMin
      : 180;
    const altitudeMax = Math.max(
      altitudeMin + 20,
      Number.isFinite(options.altitudeMax) ? options.altitudeMax : altitudeMin + 180
    );
    const opacity = clampNumber(
      Number.isFinite(options.opacity) ? options.opacity : 0.66,
      0.05,
      0.95
    );
    const requestedCount = Number.isFinite(options.count)
      ? Math.floor(options.count)
      : profileName === "low" ? 6 : profileName === "medium" ? 12 : 20;
    const count = Math.floor(clampNumber(requestedCount, 1, 40));

    let density = clamp01(options.density ?? 0.7);
    let windX = Number.isFinite(options.wind?.x) ? options.wind.x : 0.8;
    let windZ = Number.isFinite(options.wind?.z) ? options.wind.z : 0.15;
    let disposedLayer = false;

    const root = new B.TransformNode(name, scene);
    const material = new B.StandardMaterial(`${name}-material`, scene);
    material.diffuseColor = new B.Color3(0.78, 0.84, 0.90);
    material.emissiveColor = new B.Color3(0.16, 0.19, 0.22);
    material.specularColor = new B.Color3(0.02, 0.02, 0.02);
    material.alpha = opacity;
    material.backFaceCulling = false;
    if ("transparencyMode" in material &&
        B.Material.MATERIAL_ALPHABLEND !== undefined) {
      material.transparencyMode = B.Material.MATERIAL_ALPHABLEND;
    }

    // Deterministic PRNG: the same seed creates the same cloud layout.
    let randomState = Math.floor(
      stableSeed01(options.seed ?? name) * 0xFFFFFFFF
    ) >>> 0;
    const random = () => {
      randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
      return randomState / 0x100000000;
    };

    const clouds = [];

    for (let index = 0; index < count; index++) {
      const cloud = new B.TransformNode(`${name}-volume-${index}`, scene);
      cloud.parent = root;
      cloud.position = new B.Vector3(
        (random() - 0.5) * width,
        altitudeMin + random() * (altitudeMax - altitudeMin),
        (random() - 0.5) * depth
      );
      cloud.rotation.y = (random() - 0.5) * 0.4;

      const puffCount = 3 + Math.floor(random() * 4);
      for (let puffIndex = 0; puffIndex < puffCount; puffIndex++) {
        const puff = B.MeshBuilder.CreateSphere(
          `${name}-cloud-${index}-puff-${puffIndex}`,
          { diameter: 1, segments: 8 },
          scene
        );
        puff.parent = cloud;
        puff.material = material;
        puff.isPickable = false;
        puff.checkCollisions = false;
        puff.receiveShadows = false;
        puff.position = new B.Vector3(
          (random() - 0.5) * 70,
          (random() - 0.5) * 13,
          (random() - 0.5) * 55
        );
        puff.scaling = new B.Vector3(
          18 + random() * 36,
          8 + random() * 14,
          18 + random() * 32
        );
      }

      clouds.push(cloud);
    }

    const api = Object.freeze({
      name,
      root,
      get density() { return density; },
      get count() { return clouds.length; },

      setDensity(value) {
        if (!Number.isFinite(value)) {
          return { ok: false, message: "Cloud density must be a finite number." };
        }
        density = clamp01(value);
        const activeCount = Math.ceil(clouds.length * density);
        clouds.forEach((cloud, index) => cloud.setEnabled(index < activeCount));
        return { ok: true, density, activeClouds: activeCount };
      },

      setWind(wind = {}) {
        if (!Number.isFinite(wind.x) || !Number.isFinite(wind.z)) {
          return { ok: false, message: "Cloud wind requires finite x and z components." };
        }
        windX = clampNumber(wind.x, -80, 80);
        windZ = clampNumber(wind.z, -80, 80);
        return { ok: true, wind: { x: windX, z: windZ } };
      },

      setOpacity(value) {
        if (!Number.isFinite(value)) {
          return { ok: false, message: "Cloud opacity must be finite." };
        }
        material.alpha = clampNumber(value, 0.05, 0.95);
        return { ok: true, opacity: material.alpha };
      },

      update(deltaSeconds) {
        if (disposedLayer) return;
        const dt = clampNumber(Number(deltaSeconds) || 0, 0, 0.25);
        for (const cloud of clouds) {
          if (!cloud.isEnabled()) continue;
          cloud.position.x += windX * dt;
          cloud.position.z += windZ * dt;
          if (cloud.position.x > width / 2) cloud.position.x = -width / 2;
          if (cloud.position.x < -width / 2) cloud.position.x = width / 2;
          if (cloud.position.z > depth / 2) cloud.position.z = -depth / 2;
          if (cloud.position.z < -depth / 2) cloud.position.z = depth / 2;
        }
      },

      dispose() {
        if (disposedLayer) return;
        disposedLayer = true;
        for (const cloud of clouds) cloud.dispose(false, false);
        root.dispose(false, false);
        material.dispose();
        cloudLayers.delete(api);
      }
    });

    clouds.forEach((cloud, index) => cloud.setEnabled(index < Math.ceil(count * density)));
    cloudLayers.add(api);
    return api;
  }

  function createAssetManager() {
    const manager = new B.AssetsManager(scene);
    let loadPromise = null;
    let loadStarted = false;

    return Object.freeze({
      manager,

      load({ onProgress, allowFailedTasks = false } = {}) {
        if (loadPromise) return loadPromise;
        if (loadStarted) {
          return Promise.reject(new Error("Asset manager load is already in progress."));
        }
        loadStarted = true;

        loadPromise = new Promise((resolve, reject) => {
          manager.onProgress = (remainingCount, totalCount, task) => {
            if (typeof onProgress === "function") {
              try {
                onProgress({
                  remainingCount,
                  totalCount,
                  completedCount: Math.max(0, totalCount - remainingCount),
                  taskName: task?.name ?? null
                });
              } catch (error) {
                logger.warn("Asset progress listener failed.", error);
              }
            }
          };

          manager.onFinish = tasks => {
            const failed = tasks.filter(
              task => task.taskState === B.AssetTaskState.ERROR
            );

            if (failed.length > 0 && !allowFailedTasks) {
              reject(new Error(
                `Asset manager reported ${failed.length} failed task(s): ` +
                failed.map(task => task.name).join(", ")
              ));
              return;
            }

            if (failed.length > 0) {
              logger.warn("Optional asset load completed with failures.", {
                failed: failed.map(task => task.name)
              });
            }

            // Preserve the long-standing API contract: callers receive the
            // original task array and can inspect task.taskState for failures.
            resolve(tasks);
          };

          try {
            manager.load();
          } catch (error) {
            reject(error);
          }
        });

        return loadPromise;
      }
    });
  }

  let unregisterGraphicsService = () => {};

  const graphicsAPI = {
    engine,
    scene,
    camera,
    backend,
    get profileName() {
      return profileName;
    },

    getBackendName: () => backend,
    getMetrics,
    setAtmosphere,
    createAssetManager,
    createCloudLayer,

    setQualityProfile,

    createPBRMaterial(name, options) {
      const material = createPBRMaterial(B, scene, name, options);
      registerPBRMaterial(material);
      ledger.register(material, {
        kind: "material",
        label: name
      });

      return material;
    },

    setMaterialWetness: setWetnessOnMaterial,

    createLODGroup,

    registerVisibilityCandidate(mesh, options) {
      return visibility.register(mesh, options);
    },

    createWindowInteriorMaterial(name, options = {}) {
      return createWindowInteriorMaterial({
        B,
        scene,
        backend,
        name,
        logger,
        ...options
      });
    },

    registerResource(resource, options) {
      return ledger.register(resource, options);
    },

    async initialize() {
      return { ok: true, backend };
    },

    start() {
      return { ok: true };
    },

    update(context) {
      visibility.update(context.realDeltaSeconds);
    },

    stop() {
      // Renderer stays alive so the menu and settings remain usable.
      return { ok: true };
    },

    dispose() {
      if (disposed) return;
      disposed = true;

      engine.stopRenderLoop(renderFrame);

      shadows.dispose();
      visibility.clear();
      pipeline?.dispose();
      for (const cloudLayer of [...cloudLayers]) cloudLayer.dispose();
      ledger.disposeAll();
      unregisterGraphicsService();
      scene.dispose();
      engine.dispose();
    }
  };

  const resize = () => {
    if (disposed) return;
    engine.resize();

    runtime.events.emit("viewport:resized", {
      width: canvas.clientWidth,
      height: canvas.clientHeight,
      devicePixelRatio: globalThis.devicePixelRatio || 1
    });
  };

  window.addEventListener("resize", resize);

  const beforeObserver = scene.onBeforeRenderObservable.add(() => {
    beforeRenderTime = performance.now();
  });

  const afterObserver = scene.onAfterRenderObservable.add(() => {
    const end = performance.now();

    if (beforeRenderTime > 0) {
      const current = end - beforeRenderTime;

      performanceStats.frameTimeMs =
        performanceStats.samples === 0
          ? current
          : performanceStats.frameTimeMs * 0.9 + current * 0.1;

      performanceStats.samples++;
    }

    performanceStats.fps = engine.getFps();
  });

  const renderFrame = () => {
    if (disposed) return;

    try {
      const deltaSeconds = Math.max(0, engine.getDeltaTime() / 1000);

      runtime.advanceFrame(deltaSeconds);
      for (const cloudLayer of cloudLayers) {
        cloudLayer.update(deltaSeconds);
      }
      scene.render();

      runtime.events.emit("renderer:frame", {
        backend,
        deltaSeconds,
        fps: engine.getFps()
      });

      renderFailureCount = 0;
    } catch (error) {
      renderFailureCount++;
      performanceStats.lastRenderError = error.message;

      logger.error("Render frame failed.", error);

      if (renderFailureCount >= 5) {
        engine.stopRenderLoop(renderFrame);

        runtime.notify(
          "Rendering stopped after repeated frame errors. Open diagnostics for details.",
          "error"
        );
      }
    }
  };

  runtime.addDisposer(() => {
    window.removeEventListener("resize", resize);
    scene.onBeforeRenderObservable.remove(beforeObserver);
    scene.onAfterRenderObservable.remove(afterObserver);
  });

  unregisterGraphicsService = runtime.services.register("graphics", graphicsAPI);
  runtime.engine = engine;
  runtime.scene = scene;
  runtime.camera = camera;

  // Start at the selected profile. Quality can be changed at runtime.
  runtime.state?.patch?.({ qualityProfile: profileName }, "graphics-initial-quality");
  engine.setHardwareScalingLevel(quality.hardwareScaling);
  engine.resize();
  engine.runRenderLoop(renderFrame);

  runtime.events.emit("renderer:ready", {
    backend,
    version: B.Engine.Version ?? "unknown",
    fallbackErrors: created.fallbackErrors
  });

  logger.info("Shared scene and renderer are ready.", {
    backend,
    profile: profileName,
    hardwareScaling: quality.hardwareScaling
  });

  return graphicsAPI;
}
