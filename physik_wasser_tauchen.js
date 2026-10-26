/*
 * Module 6: physik_wasser_tauchen.js
 * Factory: createWaterSimulationSystem()
 *
 * Features:
 * - Animated Gerstner water surface.
 * - Shared rendering / gameplay surface queries.
 * - Ocean, river, pool and custom water regions.
 * - Currents, buoyancy, drag and simplified fluid forces.
 * - Swimming, diving, surfacing and oxygen state machine.
 * - Underwater visibility and audio integration hooks.
 * - Dive locations, wrecks, persistent salvage and collectibles.
 *
 * Units: meters, seconds, kilograms, Newtons.
 */

const WATER_CONFIG = Object.freeze({
  gravityMps2: 9.81,
  freshwaterDensityKgM3: 1000,
  seawaterDensityKgM3: 1025,

  oceanBaseY: -1.6,
  riverBaseY: -0.16,
  riverWidthM: 58,

  surfaceUpdateInterval: 1 / 15,
  normalUpdateInterval: 1 / 8,

  normalSwimmingSpeedMps: 2.1,
  sprintSwimmingSpeedMps: 3.1,
  diveSpeedMps: 1.6,
  surfacingSpeedMps: 2.3,

  defaultLungCapacitySeconds: 30,
  drowningDamagePerSecond: 4
});

const DEFAULT_WAVES = Object.freeze([
  {
    directionX: 0.96,
    directionZ: 0.28,
    wavelengthM: 42,
    amplitudeM: 0.18,
    steepness: 0.34,
    phase: 0.3
  },
  {
    directionX: 0.23,
    directionZ: 0.97,
    wavelengthM: 24,
    amplitudeM: 0.09,
    steepness: 0.25,
    phase: 1.8
  },
  {
    directionX: -0.66,
    directionZ: 0.75,
    wavelengthM: 13,
    amplitudeM: 0.045,
    steepness: 0.17,
    phase: 3.1
  },
  {
    directionX: 0.72,
    directionZ: -0.69,
    wavelengthM: 8,
    amplitudeM: 0.022,
    steepness: 0.12,
    phase: 5.4
  }
]);

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}

function finite(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function normalizeVector2(x, z) {
  const length = Math.hypot(x, z) || 1;
  return { x: x / length, z: z / length };
}

function cubicEase(t) {
  const v = clamp(t, 0, 1);
  return v * v * (3 - 2 * v);
}

/* ------------------------------------------------------------------ */
/* Gerstner surface                                                     */
/* ------------------------------------------------------------------ */

function createWaveSet(scale = 1) {
  return DEFAULT_WAVES.map(wave => ({
    ...wave,
    amplitudeM: wave.amplitudeM * scale
  }));
}

function evaluateWaveComponents(x, z, time, waves, intensity = 1) {
  let height = 0;
  let displacementX = 0;
  let displacementZ = 0;

  let dHeightDx = 0;
  let dHeightDz = 0;

  let orbitalVelocityX = 0;
  let orbitalVelocityY = 0;
  let orbitalVelocityZ = 0;

  for (const wave of waves) {
    const direction = normalizeVector2(
      wave.directionX,
      wave.directionZ
    );

    const wavelength = Math.max(0.1, wave.wavelengthM);
    const k = 2 * Math.PI / wavelength;

    // Gravity-wave dispersion approximation for deep water.
    const omega = Math.sqrt(9.81 * k);
    const amplitude = Math.max(0, wave.amplitudeM * intensity);
    const theta =
      k * (direction.x * x + direction.z * z) -
      omega * time +
      wave.phase;

    const sinTheta = Math.sin(theta);
    const cosTheta = Math.cos(theta);
    const horizontalAmplitude =
      clamp(wave.steepness, 0, 0.9) * amplitude;

    height += amplitude * sinTheta;

    displacementX +=
      horizontalAmplitude * direction.x * cosTheta;

    displacementZ +=
      horizontalAmplitude * direction.z * cosTheta;

    dHeightDx +=
      amplitude * k * direction.x * cosTheta;

    dHeightDz +=
      amplitude * k * direction.z * cosTheta;

    orbitalVelocityX +=
      horizontalAmplitude * omega * direction.x * sinTheta;

    orbitalVelocityY -=
      amplitude * omega * cosTheta;

    orbitalVelocityZ +=
      horizontalAmplitude * omega * direction.z * sinTheta;
  }

  return {
    height,
    displacementX,
    displacementZ,
    normal: { x: -dHeightDx, y: 1, z: -dHeightDz },
    orbitalVelocity: {
      x: orbitalVelocityX,
      y: orbitalVelocityY,
      z: orbitalVelocityZ
    }
  };
}

/* ------------------------------------------------------------------ */
/* Mesh generation and dynamic vertex update                            */
/* ------------------------------------------------------------------ */

function buildWaterGrid(B, scene, options) {
  const {
    name,
    width,
    depth,
    subdivisions,
    baseY,
    material,
    regionId
  } = options;

  const mesh = B.MeshBuilder.CreateGround(
    name,
    {
      width,
      height: depth,
      subdivisions,
      updatable: true
    },
    scene
  );

  const original = mesh.getVerticesData(
    B.VertexBuffer.PositionKind
  );

  if (!original) {
    mesh.dispose();
    throw new Error(`Unable to read vertices for ${name}.`);
  }

  const originalPositions = new Float32Array(original);
  const currentPositions = new Float32Array(original);
  const normals = new Float32Array(original.length);

  for (let i = 0; i < currentPositions.length; i += 3) {
    currentPositions[i + 1] = baseY;
  }

  mesh.updateVerticesData(
    B.VertexBuffer.PositionKind,
    currentPositions,
    false,
    false
  );

  const indices = mesh.getIndices();

  B.VertexData.ComputeNormals(
    currentPositions,
    indices,
    normals
  );

  mesh.updateVerticesData(
    B.VertexBuffer.NormalKind,
    normals,
    false,
    false
  );

  mesh.material = material;
  mesh.isPickable = false;
  mesh.checkCollisions = false;

  mesh.metadata = {
    ...(mesh.metadata || {}),
    isWaterSurface: true,
    waterRegionId: regionId,
    baseWaterY: baseY
  };

  return {
    mesh,
    originalPositions,
    currentPositions,
    normals,
    indices,
    baseY
  };
}

function buildWaterDisc(B, scene, options) {
  const { name, radius, baseY, material, regionId, centerX = 0, centerZ = 0 } = options;
  const mesh = B.MeshBuilder.CreateDisc(
    name,
    { radius, tessellation: 48, sideOrientation: B.Mesh.DOUBLESIDE },
    scene
  );
  const original = mesh.getVerticesData(B.VertexBuffer.PositionKind);
  if (!original) {
    mesh.dispose();
    throw new Error(`Unable to read vertices for ${name}.`);
  }
  const originalPositions = new Float32Array(original);
  const currentPositions = new Float32Array(original);
  const normals = new Float32Array(original.length);
  const indices = mesh.getIndices();

  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(centerX, baseY, centerZ);
  mesh.material = material;
  mesh.isPickable = false;
  mesh.checkCollisions = false;
  mesh.metadata = {
    ...(mesh.metadata || {}),
    isWaterSurface: true,
    waterRegionId: regionId,
    baseWaterY: baseY
  };
  B.VertexData.ComputeNormals(currentPositions, indices, normals);
  mesh.updateVerticesData(B.VertexBuffer.PositionKind, currentPositions, false, false);
  mesh.updateVerticesData(B.VertexBuffer.NormalKind, normals, false, false);

  return {
    mesh,
    originalPositions,
    currentPositions,
    normals,
    indices,
    baseY,
    orientation: "disc"
  };
}

function buildWaterRibbon(B, scene, options) {
  const {
    name,
    material,
    points,
    width,
    regionId
  } = options;

  const positions = [];
  const indices = [];

  for (let i = 0; i < points.length; i++) {
    const before = points[Math.max(0, i - 1)];
    const after = points[Math.min(points.length - 1, i + 1)];

    const tx = after.x - before.x;
    const tz = after.z - before.z;
    const length = Math.hypot(tx, tz) || 1;

    const nx = tz / length;
    const nz = -tx / length;

    positions.push(
      points[i].x - nx * width * 0.5, points[i].y, points[i].z - nz * width * 0.5,
      points[i].x + nx * width * 0.5, points[i].y, points[i].z + nz * width * 0.5
    );
  }

  for (let i = 0; i < points.length - 1; i++) {
    const a = i * 2;
    const b = a + 1;
    const c = a + 2;
    const d = a + 3;

    // Winding order is chosen so the face points upward.
    indices.push(a, b, c, b, d, c);
  }

  const mesh = new B.Mesh(name, scene);
  const vertexData = new B.VertexData();

  vertexData.positions = positions;
  vertexData.indices = indices;

  const normals = [];
  B.VertexData.ComputeNormals(positions, indices, normals);
  vertexData.normals = normals;
  vertexData.applyToMesh(mesh, true);

  mesh.material = material;
  mesh.isPickable = false;
  mesh.checkCollisions = false;

  mesh.metadata = {
    ...(mesh.metadata || {}),
    isWaterSurface: true,
    waterRegionId: regionId
  };

  return {
    mesh,
    originalPositions: new Float32Array(positions),
    currentPositions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: mesh.getIndices(),
    baseY: points[0]?.y ?? WATER_CONFIG.riverBaseY
  };
}

/* ------------------------------------------------------------------ */
/* Water material                                                       */
/* ------------------------------------------------------------------ */

function createWaterMaterial(B, scene, graphics, name, options = {}) {
  const material = graphics?.createPBRMaterial?.(name, {
    albedo: options.color ?? "#267f9c",
    metallic: options.metallic ?? 0.12,
    roughness: options.roughness ?? 0.19,
    emissive: options.emissive ?? "#061820"
  });

  if (material) {
    material.alpha = clamp(options.alpha ?? 0.82, 0.05, 1);
    material.backFaceCulling = false;

    if (B.PBRMaterial?.PBRMATERIAL_ALPHABLEND !== undefined) {
      material.transparencyMode =
        B.PBRMaterial.PBRMATERIAL_ALPHABLEND;
    }

    return material;
  }

  const fallback = new B.StandardMaterial(name, scene);

  fallback.diffuseColor = B.Color3.FromHexString(
    options.color ?? "#267f9c"
  );

  fallback.emissiveColor = B.Color3.FromHexString(
    options.emissive ?? "#061820"
  );

  fallback.specularColor = new B.Color3(0.85, 0.95, 1);
  fallback.specularPower = 96;
  fallback.alpha = clamp(options.alpha ?? 0.82, 0.05, 1);
  fallback.backFaceCulling = false;

  return fallback;
}

/* ------------------------------------------------------------------ */
/* Main factory                                                         */
/* ------------------------------------------------------------------ */

export async function createWaterSimulationSystem({
  runtime,
  scene,
  engine,
  camera,
  services,
  entities,
  logger
}) {
  if (!runtime || !scene || !camera) {
    throw new TypeError(
      "Water system requires the shared runtime, scene and camera."
    );
  }

  const B = globalThis.BABYLON;

  if (!B) throw new Error("Babylon.js is unavailable.");

  const graphics = services.get("graphics");
  let weather = services.get("weather");
  let world = services.get("world");

  let initialized = false;
  let running = false;
  let disposed = false;

  let simulationTime = 0;
  let lastSurfaceUpdate = 0;
  let lastNormalUpdate = 0;

  const eventDisposers = [];
  const serviceDisposers = [];

  const customRegions = new Map();
  const swimmers = new Map();
  const diveSites = new Map();
  const waterMeshes = [];
  const waterMaterials = [];
  const activeSplashes = new Set();

  let nextRegionId = 1;
  let nextDiveSiteId = 1;

  const oceanWaves = createWaveSet(1.0);
  const riverWaves = createWaveSet(0.36);

  const oceanMaterial = createWaterMaterial(
    B,
    scene,
    graphics,
    "water-ocean-material",
    {
      color: "#236b91",
      roughness: 0.18,
      metallic: 0.15,
      alpha: 0.86
    }
  );

  const riverMaterial = createWaterMaterial(
    B,
    scene,
    graphics,
    "water-river-material",
    {
      color: "#326d67",
      roughness: 0.26,
      metallic: 0.07,
      alpha: 0.83
    }
  );

  waterMaterials.push(oceanMaterial, riverMaterial);

  if ("useLogarithmicDepth" in oceanMaterial) {
    oceanMaterial.useLogarithmicDepth = false;
  }

  const waterTextureCanvas = document.createElement("canvas");
  waterTextureCanvas.width = 256;
  waterTextureCanvas.height = 256;

  const waterContext = waterTextureCanvas.getContext("2d");

  if (waterContext) {
    const image = waterContext.createImageData(256, 256);

    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 256; x++) {
        const i = (y * 256 + x) * 4;
        const wave = Math.sin(x * 0.09 + Math.sin(y * 0.035)) *
          Math.sin(y * 0.13);

        const value = clamp(
          100 + wave * 55 + Math.sin(x * 0.025 + y * 0.033) * 28,
          20,
          220
        );

        image.data[i] = value * 0.70;
        image.data[i + 1] = value * 0.92;
        image.data[i + 2] = value;
        image.data[i + 3] = 255;
      }
    }

    waterContext.putImageData(image, 0, 0);
  }

  const rippleTexture = (() => {
    try {
      const texture = new B.DynamicTexture(
        "water-ripple-texture",
        waterTextureCanvas,
        scene,
        false
      );
      texture.wrapU = B.Texture.WRAP_ADDRESSMODE;
      texture.wrapV = B.Texture.WRAP_ADDRESSMODE;
      texture.update(false);
      return texture;
    } catch {
      return null;
    }
  })();

  if (rippleTexture) {
    oceanMaterial.bumpTexture = rippleTexture;
    riverMaterial.bumpTexture = rippleTexture;
  }

  function getWindScale(position) {
    const sample = weather?.getWeatherAt?.(position);

    if (!sample) return 1;

    const wind = clamp(finite(sample.windSpeed, 2), 0, 70);

    return clamp(0.55 + wind / 35, 0.45, 2.1);
  }

  function getWaveIntensity(position, type) {
    const windScale = getWindScale(position);

    if (type === "pool") return 0.03;

    if (type === "river") {
      return clamp(0.4 + windScale * 0.12, 0.3, 0.75);
    }

    return clamp(windScale, 0.35, 2.1);
  }

  function waveHeightAt(x, z, time, region) {
    const isRiver = region.type === "river";
    const waves = isRiver ? riverWaves : oceanWaves;

    const intensity = getWaveIntensity({ x, z }, region.type);
    const wave = evaluateWaveComponents(
      x, z, time, waves, intensity
    );

    return region.baseY + wave.height;
  }

  function sampleWater(position, time = simulationTime, options = {}) {
    const region = getWaterRegionAt(position, { ...options, time });

    if (!region) return null;

    const x = finite(position.x);
    const z = finite(position.z);

    const baseY = region.baseY;
    const amplitudeScale = getWaveIntensity({ x, z }, region.type);

    const waves = region.type === "river" ? riverWaves : oceanWaves;
    const wave = evaluateWaveComponents(
      x, z, time, waves, amplitudeScale
    );

    // Estimate the surface gradient at a small finite spatial distance.
    const epsilon = 0.35;

    const heightLeft = waveHeightAt(x - epsilon, z, time, region);
    const heightRight = waveHeightAt(x + epsilon, z, time, region);
    const heightBack = waveHeightAt(x, z - epsilon, time, region);
    const heightForward = waveHeightAt(x, z + epsilon, time, region);

    const gradientX = (heightRight - heightLeft) / (2 * epsilon);
    const gradientZ = (heightForward - heightBack) / (2 * epsilon);

    const normal = new B.Vector3(
      -gradientX, 1, -gradientZ
    ).normalize();

    const flowDirection = region.flowDirection
      ? new B.Vector3(
          region.flowDirection.x,
          0,
          region.flowDirection.z
        ).normalize()
      : B.Vector3.Zero();

    const flow = flowDirection.scale(region.flowSpeedMps);

    return {
      regionId: region.id,
      type: region.type,

      height: baseY + wave.height,

      displacedPosition: new B.Vector3(
        x + wave.displacementX,
        baseY + wave.height,
        z + wave.displacementZ
      ),

      normal,

      flowVelocity: flow,
      orbitalVelocity: new B.Vector3(
        wave.orbitalVelocity.x,
        wave.orbitalVelocity.y,
        wave.orbitalVelocity.z
      ),

      densityKgM3: region.densityKgM3,
      approximateDepthM: region.depthM,
      turbidity: region.turbidity,
      temperatureC: region.temperatureC
    };
  }

  function getRiverCenterline(x) {
    if (world?.riverZ) return world.riverZ(x);

    // This fallback matches the world architecture's river curve.
    return 92 * Math.sin(x / 258) +
      23 * Math.sin(x / 116 + 1.4) - 24;
  }

  function getWaterRegionAt(position, options = {}) {
    if (!position) return null;

    const x = finite(position.x);
    const y = finite(position.y, 0);
    const z = finite(position.z);
    const queryTime = finite(options.time, simulationTime);

    for (const region of customRegions.values()) {
      let inside = false;

      if (region.shape === "circle") {
        inside = Math.hypot(x - region.x, z - region.z) <= region.radius;
      } else if (region.shape === "bounds") {
        inside =
          x >= region.minX && x <= region.maxX &&
          z >= region.minZ && z <= region.maxZ;
      } else if (typeof region.contains === "function") {
        inside = Boolean(region.contains({ x, y, z }));
      }

      if (!inside) continue;

      const surfaceHeight = waveHeightAt(
        x, z, queryTime, region
      );

      // Prevent the swimming state machine from treating a high bridge
      // deck or an upper floor as being in the water underneath it.
      if (
        !options.ignoreHeight &&
        y > surfaceHeight + region.heightToleranceM
      ) {
        // Another overlapping region may still contain the sample.
        continue;
      }

      return region;
    }

    const riverCenterZ = getRiverCenterline(x);
    const riverDistance = Math.abs(z - riverCenterZ);

    const riverRegion = {
      id: "leonida-river",
      type: "river",
      shape: "river",
      baseY: WATER_CONFIG.riverBaseY,
      depthM: 8,
      densityKgM3: WATER_CONFIG.freshwaterDensityKgM3,
      flowDirection: normalizeRiverDirection(x),
      flowSpeedMps: 1.1,
      turbidity: 0.48,
      temperatureC: 26,
      heightToleranceM: 0.45
    };

    if (
      x > -1500 &&
      x < 1500 &&
      riverDistance < WATER_CONFIG.riverWidthM / 2
    ) {
      const surfaceHeight = waveHeightAt(
        x, z, queryTime, riverRegion
      );

      if (
        options.ignoreHeight ||
        y <= surfaceHeight + riverRegion.heightToleranceM
      ) {
        return riverRegion;
      }

      return null;
    }

    const oceanExtent = 950;

    if (
      Math.abs(x) > oceanExtent ||
      Math.abs(z) > oceanExtent
    ) {
      const oceanRegion = {
        id: "leonida-ocean",
        type: "ocean",
        shape: "ocean",
        baseY: WATER_CONFIG.oceanBaseY,
        depthM: 160,
        densityKgM3: WATER_CONFIG.seawaterDensityKgM3,
        flowDirection: normalizeVector2(0.82, 0.57),
        flowSpeedMps: 0.55,
        turbidity: 0.16,
        temperatureC: 27,
        heightToleranceM: 0.65
      };

      const height = waveHeightAt(
        x, z, queryTime, oceanRegion
      );

      if (
        options.ignoreHeight ||
        y <= height + oceanRegion.heightToleranceM
      ) {
        return oceanRegion;
      }
    }

    return null;
  }

  function normalizeRiverDirection(x) {
    const epsilon = 0.5;

    const previous = getRiverCenterline(x - epsilon);
    const next = getRiverCenterline(x + epsilon);

    return normalizeVector2(
      1,
      (next - previous) / (2 * epsilon)
    );
  }

  function getSurfaceHeight(position, time = simulationTime) {
    const sample = sampleWater(position, time, { ignoreHeight: true });
    return sample ? sample.height : null;
  }

  function registerWaterRegion(options) {
    if (!options || typeof options !== "object") {
      throw new TypeError("A water region requires a definition.");
    }

    const id = options.id ?? `water-region-${nextRegionId++}`;

    if (customRegions.has(id)) {
      throw new Error(`Water region already registered: ${id}`);
    }

    const type = options.type ?? "pool";
    const shape = options.shape ?? "circle";
    if (shape === "bounds") {
      if (![options.minX, options.maxX, options.minZ, options.maxZ].every(Number.isFinite) ||
          options.maxX <= options.minX || options.maxZ <= options.minZ) {
        throw new RangeError("Bounds water regions require finite, increasing min/max coordinates.");
      }
    } else if (shape !== "circle" && typeof options.contains !== "function") {
      throw new TypeError("A water region requires circle/bounds geometry or a contains() function.");
    }

    const region = {
      id,
      type,
      shape,
      x: finite(options.x),
      z: finite(options.z),

      minX: finite(options.minX, -Infinity),
      maxX: finite(options.maxX, Infinity),
      minZ: finite(options.minZ, -Infinity),
      maxZ: finite(options.maxZ, Infinity),

      radius: Math.max(0.1, finite(options.radius, 10)),
      baseY: finite(options.baseY, 0),
      depthM: clamp(finite(options.depthM, 2), 0.1, 300),

      densityKgM3: clamp(
        finite(
          options.densityKgM3,
          type === "ocean" ? 1025 : 1000
        ),
        500,
        1500
      ),

      flowDirection: normalizeVector2(
        finite(options.flowDirection?.x, 0),
        finite(options.flowDirection?.z, 0)
      ),

      flowSpeedMps: clamp(finite(options.flowSpeedMps, 0), 0, 15),
      turbidity: clamp(finite(options.turbidity, 0.2), 0, 1),
      temperatureC: clamp(finite(options.temperatureC, 25), -2, 50),
      heightToleranceM: clamp(
        finite(options.heightToleranceM, 2),
        0.2,
        10
      ),

      contains: typeof options.contains === "function"
        ? options.contains
        : null
    };

    customRegions.set(id, region);

    if (options.visual !== false &&
        (region.shape === "circle" || region.shape === "bounds")) {
      const safeId = String(id).replace(/[^a-zA-Z0-9_-]/g, "_");
      const material = createWaterMaterial(
        B, scene, graphics, `water-region-${safeId}-material`,
        {
          color: options.color ?? (type === "pool" ? "#2a91b5" : "#286d78"),
          roughness: clamp(finite(options.roughness, 0.22), 0.02, 1),
          metallic: clamp(finite(options.metallic, 0.08), 0, 1),
          alpha: clamp(finite(options.alpha, 0.82), 0.05, 1)
        }
      );
      try {
        let surface;
        if (region.shape === "circle") {
          surface = buildWaterDisc(B, scene, {
            name: `water-region-${safeId}-surface`,
            radius: region.radius,
            baseY: region.baseY,
            material,
            regionId: id,
            centerX: region.x,
            centerZ: region.z
          });
        } else {
          const width = region.maxX - region.minX;
          const depth = region.maxZ - region.minZ;
          if (!(width > 0) || !(depth > 0) || !Number.isFinite(width) || !Number.isFinite(depth)) {
            throw new RangeError("Bounds water regions require finite increasing bounds.");
          }
          surface = buildWaterGrid(B, scene, {
            name: `water-region-${safeId}-surface`,
            width,
            depth,
            subdivisions: clamp(Math.ceil(Math.max(width, depth) / 8), 4, 64),
            baseY: region.baseY,
            material,
            regionId: id
          });
          surface.mesh.position.x = (region.minX + region.maxX) * 0.5;
          surface.mesh.position.z = (region.minZ + region.maxZ) * 0.5;
        }
        region.surfaceRecord = surface;
        region.material = material;
        waterMeshes.push(surface);
        waterMaterials.push(material);
      } catch (error) {
        customRegions.delete(id);
        material.dispose();
        throw error;
      }
    }

    return Object.freeze({
      id,
      dispose: () => {
        const current = customRegions.get(id);
        if (!current) return false;
        if (current.surfaceRecord) {
          const index = waterMeshes.indexOf(current.surfaceRecord);
          if (index >= 0) waterMeshes.splice(index, 1);
          if (!current.surfaceRecord.mesh.isDisposed()) {
            current.surfaceRecord.mesh.dispose(false, false);
          }
        }
        if (current.material) {
          const index = waterMaterials.indexOf(current.material);
          if (index >= 0) waterMaterials.splice(index, 1);
          current.material.dispose();
        }
        return customRegions.delete(id);
      },
      getRegion: () => customRegions.get(id) ?? null
    });
  }

  function calculateBuoyancy(body, dt) {
    if (!body || typeof body !== "object") {
      throw new TypeError("Buoyancy requires a body object.");
    }

    const position = body.position;
    const velocity = body.velocity;

    if (!position || !velocity) {
      throw new TypeError("Buoyancy requires position and velocity.");
    }

    const mass = finite(body.massKg, NaN);
    const volume = finite(body.volumeM3, NaN);

    if (!(mass > 0) || !(volume > 0)) {
      throw new RangeError("Body massKg and volumeM3 must be positive.");
    }

    const sample = sampleWater(position, simulationTime, { ignoreHeight: true });

    if (!sample) {
      return {
        submergedFraction: 0,
        buoyancyForceN: 0,
        dragForce: B.Vector3.Zero(),
        netForce: new B.Vector3(0, -mass * WATER_CONFIG.gravityMps2, 0)
      };
    }

    const approximateHalfHeight = Math.max(
      0.01,
      finite(body.halfHeightM, Math.cbrt(volume) * 0.5)
    );

    const bottom = position.y - approximateHalfHeight;
    const top = position.y + approximateHalfHeight;
    const submergedHeight = clamp(sample.height - bottom, 0, top - bottom);
    const submergedFraction = clamp(
      submergedHeight / Math.max(0.02, top - bottom),
      0,
      1
    );

    const buoyancyForceN =
      sample.densityKgM3 *
      WATER_CONFIG.gravityMps2 *
      volume *
      submergedFraction;

    const bodyVelocity = new B.Vector3(
      finite(velocity.x),
      finite(velocity.y),
      finite(velocity.z)
    );

    const relativeVelocity = bodyVelocity.subtract(sample.flowVelocity);
    const speed = relativeVelocity.length();

    const dragCoefficient = clamp(finite(body.dragCoefficient, 0.8), 0, 5);
    const areaM2 = clamp(finite(body.areaM2, 1), 0.01, 100);
    const dragMagnitude =
      0.5 * sample.densityKgM3 *
      dragCoefficient * areaM2 * speed * speed;

    const dragForce = speed > 1e-6
      ? relativeVelocity.scale(-dragMagnitude / speed)
      : B.Vector3.Zero();

    const netForce = new B.Vector3(
      dragForce.x,
      buoyancyForceN - mass * WATER_CONFIG.gravityMps2 + dragForce.y,
      dragForce.z
    );

    const maximumForceN = mass * 50;

    if (netForce.length() > maximumForceN) {
      netForce.normalize().scaleInPlace(maximumForceN);
    }

    if (typeof body.applyForce === "function") {
      body.applyForce(netForce, dt);
    }

    return {
      submergedFraction,
      buoyancyForceN,
      dragForce,
      netForce,
      water: sample
    };
  }

  /* ---------------------------------------------------------------- */
  /* Swimmer state machine                                            */
  /* ---------------------------------------------------------------- */

  function createSwimController(characterId, options = {}) {
    if (typeof characterId !== "string" || !characterId.trim()) {
      throw new TypeError("Swim controller requires a character ID.");
    }

    const controller = {
      characterId,

      state: "onLand",
      previousState: "onLand",
      regionId: null,

      oxygenSeconds: clamp(
        finite(
          options.lungCapacitySeconds,
          WATER_CONFIG.defaultLungCapacitySeconds
        ),
        5,
        180
      ),

      maximumOxygenSeconds: clamp(
        finite(
          options.lungCapacitySeconds,
          WATER_CONFIG.defaultLungCapacitySeconds
        ),
        5,
        180
      ),

      gear: {
        scuba: options.scuba === true,
        fins: options.fins === true,
        lifeVest: options.lifeVest === true
      },

      transition: 0,
      drowningSeconds: 0,
      elapsed: 0
    };

    swimmers.set(characterId, controller);
    return controller;
  }

  function changeSwimmerState(controller, newState, details = {}) {
    if (controller.state === newState) return;

    const previousState = controller.state;

    controller.previousState = previousState;
    controller.state = newState;
    controller.transition = 0;

    runtime.events.emit("water:swimmerStateChanged", {
      characterId: controller.characterId,
      from: previousState,
      to: newState,
      regionId: controller.regionId,
      ...details
    });
  }

  function updateSwimmer(controller, body, input, dt) {
    if (!controller || !body?.position) {
      return {
        ok: false,
        message: "Invalid swimmer controller or body position."
      };
    }

    dt = clamp(finite(dt), 0, 0.1);

    controller.elapsed += dt;
    controller.transition += dt;

    const position = body.position;
    const waterRegion = getWaterRegionAt(position, { ignoreHeight: false });
    const sample = waterRegion ? sampleWater(position) : null;

    if (!waterRegion || !sample) {
      if (controller.state !== "onLand" &&
          controller.state !== "exiting") {
        changeSwimmerState(controller, "exiting");
      }

      if (controller.state === "exiting" &&
          controller.transition >= 0.3) {
        controller.regionId = null;
        changeSwimmerState(controller, "onLand");
      }

      controller.oxygenSeconds = Math.min(
        controller.maximumOxygenSeconds,
        controller.oxygenSeconds + dt * 2.8
      );

      controller.drowningSeconds = 0;

      return {
        ok: true,
        inWater: false,
        state: controller.state,
        underwater: false,
        characterId: controller.characterId,
        oxygenSeconds: controller.oxygenSeconds,
        force: B.Vector3.Zero(),
        verticalSpeedMps: 0,
        surfaceHeight: null,
        damagePerSecond: 0,
        water: null
      };
    }

    controller.regionId = waterRegion.id;

    const depthBelowSurface = sample.height - position.y;
    const wantsDive = Boolean(input?.dive);
    const wantsSurface = Boolean(input?.surface || input?.jump);

    if (
      controller.state === "onLand" ||
      controller.state === "exiting"
    ) {
      changeSwimmerState(controller, "entering");
    }

    if (
      controller.state === "entering" &&
      controller.transition >= 0.12
    ) {
      changeSwimmerState(controller, "surface");
    }

    if (controller.state === "surface" ||
        controller.state === "swimming") {
      if (wantsDive && depthBelowSurface < 1.2) {
        changeSwimmerState(controller, "diving");
      } else if (Math.abs(finite(input?.moveY)) > 0.12 ||
                 Math.abs(finite(input?.moveX)) > 0.12) {
        changeSwimmerState(controller, "swimming");
      } else if (depthBelowSurface > 1.2) {
        changeSwimmerState(controller, "surface");
      }
    }

    if (
      controller.state === "diving" &&
      (depthBelowSurface > 0.45 || wantsDive)
    ) {
      changeSwimmerState(controller, "underwater");
    }

    if (
      controller.state === "underwater" &&
      (wantsSurface || !wantsDive) &&
      depthBelowSurface < waterRegion.depthM
    ) {
      changeSwimmerState(controller, "surfacing");
    }

    if (controller.state === "drowning" && depthBelowSurface < 0.35) {
      changeSwimmerState(controller, "surface", { recoveredAtSurface: true });
    }

    if (
      controller.state === "surfacing" &&
      depthBelowSurface < 0.35
    ) {
      changeSwimmerState(controller, "surface");
    }

    const underwater =
      controller.state === "diving" ||
      controller.state === "underwater" ||
      controller.state === "surfacing" ||
      controller.state === "drowning";

    if (underwater && !controller.gear.scuba) {
      const lungFactor = 1 + clamp(
        finite(input?.lungVolumeBonus, 0),
        0,
        1.5
      );

      controller.oxygenSeconds = Math.max(
        0,
        controller.oxygenSeconds -
        dt / lungFactor
      );
    } else if (!underwater) {
      controller.oxygenSeconds = Math.min(
        controller.maximumOxygenSeconds,
        controller.oxygenSeconds + dt * 2.4
      );
    }

    if (controller.oxygenSeconds <= 0 && !controller.gear.scuba && depthBelowSurface >= 0.35) {
      if (controller.state !== "drowning") {
        changeSwimmerState(controller, "drowning");
      }

      controller.drowningSeconds += dt;
    } else {
      controller.drowningSeconds = 0;
    }

    const inputX = clamp(finite(input?.moveX), -1, 1);
    const inputY = clamp(finite(input?.moveY), -1, 1);

    const requestedSpeed =
      input?.sprint
        ? WATER_CONFIG.sprintSwimmingSpeedMps
        : WATER_CONFIG.normalSwimmingSpeedMps;

    const depthFactor = clamp(
      1 - Math.max(0, depthBelowSurface) * 0.006,
      0.6,
      1
    );

    let verticalSpeed = 0;

    if (controller.state === "surfacing") {
      verticalSpeed = WATER_CONFIG.surfacingSpeedMps;
    } else if (
      controller.state === "diving" ||
      controller.state === "underwater"
    ) {
      verticalSpeed = wantsDive
        ? -WATER_CONFIG.diveSpeedMps
        : 0.2;
    } else if (controller.state === "drowning") {
      verticalSpeed = 0.35;
    }

    if (wantsSurface && underwater) {
      verticalSpeed = WATER_CONFIG.surfacingSpeedMps;
    }

    const movementForce = new B.Vector3(
      finite(input?.directionX) * requestedSpeed * depthFactor,
      verticalSpeed,
      finite(input?.directionZ) * requestedSpeed * depthFactor
    );

    // Return forces and constraints; the character controller owns actual
    // movement and collision resolution.
    const buoyancy = calculateBuoyancy({
      position,
      velocity: body.velocity ?? B.Vector3.Zero(),
      massKg: finite(body.massKg, 75),
      volumeM3: finite(body.volumeM3, 0.075),
      halfHeightM: finite(body.halfHeightM, 0.85),
      dragCoefficient: 1.2,
      areaM2: 0.75
    }, dt);

    const damagePerSecond =
      controller.state === "drowning"
        ? WATER_CONFIG.drowningDamagePerSecond
        : 0;

    return {
      ok: true,
      inWater: true,
      position: position.clone?.() ?? { x: position.x, y: position.y, z: position.z },
      deltaSeconds: dt,
      regionId: waterRegion.id,
      regionType: waterRegion.type,
      state: controller.state,
      underwater,
      depthBelowSurface,
      oxygenSeconds: controller.oxygenSeconds,
      surfaceHeight: sample.height,
      surfaceNormal: sample.normal,
      verticalSpeedMps: verticalSpeed,
      waterVelocity: sample.flowVelocity,
      movementForce,
      buoyancy,
      damagePerSecond,
      water: sample
    };
  }

  /* ---------------------------------------------------------------- */
  /* Underwater presentation                                            */
  /* ---------------------------------------------------------------- */

  let wasUnderwater = false;
  let underwaterBlend = 0;
  let bubbleSpawnAccumulator = 0;
  const activeBubbles = new Set();
  const normalFogMode = scene.fogMode;
  const normalFogDensity = scene.fogDensity;
  const normalFogColor = scene.fogColor.clone();

  function spawnBubble(position, intensity = 0.5) {
    if (!position || activeBubbles.size >= 28) return null;
    const mesh = B.MeshBuilder.CreateSphere(
      `underwater-bubble-${Math.floor(simulationTime * 1000)}-${activeBubbles.size}`,
      { diameter: lerp(0.035, 0.11, clamp(intensity, 0, 1)), segments: 6 },
      scene
    );
    mesh.position.set(
      finite(position.x) + (Math.random() - 0.5) * 0.55,
      finite(position.y) + 1.35 + Math.random() * 0.35,
      finite(position.z) + (Math.random() - 0.5) * 0.55
    );
    mesh.isPickable = false;
    mesh.checkCollisions = false;
    const material = new B.StandardMaterial(
      `underwater-bubble-material-${Math.floor(simulationTime * 1000)}-${activeBubbles.size}`,
      scene
    );
    material.diffuseColor = new B.Color3(0.52, 0.82, 0.91);
    material.emissiveColor = new B.Color3(0.08, 0.16, 0.2);
    material.alpha = 0.34;
    material.backFaceCulling = false;
    mesh.material = material;
    const bubble = {
      mesh, material, age: 0, duration: lerp(1.1, 2.4, Math.random()),
      riseSpeed: lerp(0.5, 1.4, Math.random()),
      driftX: (Math.random() - 0.5) * 0.18,
      driftZ: (Math.random() - 0.5) * 0.18
    };
    activeBubbles.add(bubble);
    return bubble;
  }

  function updateBubbles(dt) {
    for (const bubble of [...activeBubbles]) {
      bubble.age += dt;
      bubble.mesh.position.y += bubble.riseSpeed * dt;
      bubble.mesh.position.x += bubble.driftX * dt;
      bubble.mesh.position.z += bubble.driftZ * dt;
      const remaining = clamp(1 - bubble.age / bubble.duration, 0, 1);
      bubble.material.alpha = 0.34 * remaining;
      if (remaining <= 0) {
        bubble.mesh.dispose(false, false);
        bubble.material.dispose();
        activeBubbles.delete(bubble);
      }
    }
  }

  function updateUnderwaterPresentation(result) {
    const underwater = result?.underwater === true;
    const dt = clamp(finite(result?.deltaSeconds, 1 / 60), 0, 0.1);
    underwaterBlend = lerp(
      underwaterBlend,
      underwater ? 1 : 0,
      expSmoothing(3.5, dt)
    );

    if (underwater) {
      bubbleSpawnAccumulator += dt;
      while (bubbleSpawnAccumulator >= 0.42 && activeBubbles.size < 28) {
        bubbleSpawnAccumulator -= 0.42;
        spawnBubble(result.position, 0.45 + Math.random() * 0.45);
      }
    } else {
      bubbleSpawnAccumulator = 0;
    }

    if (underwater !== wasUnderwater) {
      wasUnderwater = underwater;
      runtime.state.patch({ isUnderwater: underwater }, "underwater-presentation");
      runtime.events.emit("water:underwaterChanged", {
        underwater,
        characterId: result?.characterId ?? null,
        regionId: result?.regionId ?? null
      });

      const audio = services.get("audio");
      if (typeof audio?.setUnderwater === "function") {
        audio.setUnderwater(underwater);
      }
      runtime.events.emit("audio:underwaterStateChanged", {
        underwater,
        characterId: result?.characterId ?? null,
        regionId: result?.regionId ?? null
      });
    }

    const depth = Math.max(0, finite(result?.depthBelowSurface));
    const depthFactor = clamp(depth / 45, 0, 1);
    const shallowColor = B.Color3.FromHexString("#145d64");
    const deepColor = B.Color3.FromHexString("#071c39");
    const underwaterColor = B.Color3.Lerp(shallowColor, deepColor, depthFactor);
    const targetDensity = lerp(0.008, 0.048, depthFactor);
    const baseDensity = clamp(finite(normalFogDensity, 0.0008), 0, 0.02);

    scene.fogMode = underwaterBlend > 0.01
      ? B.Scene.FOGMODE_EXP2
      : normalFogMode;
    scene.fogDensity = lerp(baseDensity, targetDensity, underwaterBlend);
    scene.fogColor = B.Color3.Lerp(normalFogColor, underwaterColor, underwaterBlend);
  }

  /* ---------------------------------------------------------------- */
  /* Dive locations and salvage                                         */
  /* ---------------------------------------------------------------- */

  function registerDiveSite(options) {
    if (!options || typeof options !== "object") {
      throw new TypeError("Dive site requires a definition.");
    }

    if (!options.position ||
        !Number.isFinite(options.position.x) ||
        !Number.isFinite(options.position.y) ||
        !Number.isFinite(options.position.z)) {
      throw new TypeError("Dive site position must contain x, y and z.");
    }

    const id = options.id ?? `dive-site-${nextDiveSiteId++}`;

    if (diveSites.has(id)) {
      throw new Error(`Dive site already registered: ${id}`);
    }

    const position = new B.Vector3(
      options.position.x,
      options.position.y,
      options.position.z
    );

    const site = {
      id,
      name: String(options.name ?? id),
      type: options.type ?? "salvage",
      position,
      requiredDepthM: clamp(finite(options.requiredDepthM, 1), 0, 200),
      interactionRadiusM: clamp(
        finite(options.interactionRadiusM, 2.5),
        0.5,
        20
      ),
      rewardCents: Math.max(0, Math.floor(finite(options.rewardCents, 0))),
      itemId: options.itemId ?? null,
      collected: false,
      persistent: options.persistent !== false,
      hazardId: options.hazardId ?? null,
      mesh: null,
      materials: []
    };

    if (options.visual !== false) {
      const root = new B.TransformNode(`dive-site-root-${String(id)}`, scene);
      root.position.copyFrom(position);
      root.rotation.y = finite(options.rotationY, 0.4);
      root.metadata = {
        ...(root.metadata || {}),
        diveSiteId: id,
        salvageSite: true,
        diveSiteType: site.type
      };
      site.mesh = root;

      const makeMaterial = (suffix, color, roughness = 0.95, metallic = 0.05) => {
        const material = new B.StandardMaterial(`dive-site-material-${String(id)}-${suffix}`, scene);
        material.diffuseColor = B.Color3.FromHexString(color);
        material.specularColor = new B.Color3(0.12, 0.12, 0.12);
        material.roughness = roughness;
        if ("metallic" in material) material.metallic = metallic;
        site.materials.push(material);
        return material;
      };
      const rust = makeMaterial("rust", "#51463a", 0.93, 0.12);
      const timber = makeMaterial("timber", "#493b2b", 0.96, 0.02);
      const metal = makeMaterial("metal", "#626c70", 0.78, 0.38);
      const crateMaterial = makeMaterial("crate", "#725839", 0.98, 0.01);

      const addPart = (name, size, localPosition, material, rotation = null) => {
        const part = B.MeshBuilder.CreateBox(
          `dive-site-${String(id)}-${name}`,
          { width: size.x, height: size.y, depth: size.z },
          scene
        );
        part.parent = root;
        part.position.set(localPosition.x, localPosition.y, localPosition.z);
        if (rotation) part.rotation.set(rotation.x ?? 0, rotation.y ?? 0, rotation.z ?? 0);
        part.material = material;
        part.isPickable = false;
        part.checkCollisions = false;
        return part;
      };

      if (site.type === "wreck") {
        // A broken small fishing trawler, assembled from independent hull, deck,
        // cabin and displaced beam pieces rather than a single placeholder box.
        addPart("hull", new B.Vector3(5.8, 0.85, 1.75), new B.Vector3(0, -0.24, 0), rust, new B.Vector3(0, 0, -0.08));
        addPart("deck", new B.Vector3(4.7, 0.18, 1.58), new B.Vector3(0.05, 0.28, 0), timber);
        addPart("stern-cabin", new B.Vector3(1.2, 1.0, 1.1), new B.Vector3(-1.55, 0.77, -0.03), rust, new B.Vector3(0.03, 0.18, 0.02));
        addPart("cabin-roof", new B.Vector3(1.55, 0.16, 1.28), new B.Vector3(-1.55, 1.33, -0.03), metal);
        addPart("broken-mast", new B.Vector3(0.12, 2.2, 0.12), new B.Vector3(1.1, 0.95, 0.12), timber, new B.Vector3(0.12, 0, 0.62));
        addPart("broken-side-beam", new B.Vector3(2.25, 0.16, 0.16), new B.Vector3(1.7, 0.12, 0.85), timber, new B.Vector3(0.35, 0.08, -0.32));
        addPart("bow-fragment", new B.Vector3(1.75, 0.3, 0.72), new B.Vector3(2.35, -0.35, -0.1), rust, new B.Vector3(0.16, 0.1, 0.2));
      } else if (site.type === "aircraft-wreck") {
        // Fuselage, broken wings, tail and two engine pods form a recognizable
        // submerged aircraft debris scene with an asymmetric crash layout.
        addPart("fuselage", new B.Vector3(5.1, 0.62, 0.74), new B.Vector3(0, 0, 0), metal, new B.Vector3(0.08, 0.18, -0.06));
        addPart("left-wing", new B.Vector3(2.8, 0.12, 1.25), new B.Vector3(-0.3, -0.08, -0.95), metal, new B.Vector3(0.12, 0, 0.05));
        addPart("right-wing-fragment", new B.Vector3(1.7, 0.14, 0.9), new B.Vector3(0.6, -0.22, 1.05), rust, new B.Vector3(-0.16, 0.04, -0.28));
        addPart("tail-section", new B.Vector3(1.45, 0.36, 0.66), new B.Vector3(-2.15, 0.16, -0.08), metal, new B.Vector3(0.08, 0, -0.16));
        addPart("engine-pod-left", new B.Vector3(0.82, 0.48, 0.52), new B.Vector3(0.3, -0.28, -1.15), rust, new B.Vector3(0, 0.2, 0.15));
        addPart("loose-panel", new B.Vector3(1.1, 0.08, 0.52), new B.Vector3(2.15, -0.55, 0.42), rust, new B.Vector3(0.3, 0.1, -0.32));
      } else {
        addPart("salvage-crate", new B.Vector3(1.0, 0.7, 0.85), new B.Vector3(0, 0, 0), crateMaterial);
        addPart("crate-band-a", new B.Vector3(1.04, 0.07, 0.09), new B.Vector3(0, 0.05, 0), metal);
        addPart("crate-band-b", new B.Vector3(0.09, 0.74, 0.9), new B.Vector3(0, 0, 0), metal);
      }
    }
    diveSites.set(id, site);

    try {
      entities.register(id, site);
    } catch (error) {
      logger.warn("Dive site could not be added to entity registry.", error);
    }

    runtime.events.emit("water:diveSiteRegistered", {
      id,
      type: site.type,
      position
    });

    return {
      ok: true,
      id,
      get: () => diveSites.get(id) ?? null,
      dispose: () => {
        const current = diveSites.get(id);
        if (!current) return false;

        current.mesh?.dispose(false, false);
        for (const material of current.materials ?? []) {
          try { material.dispose(); } catch {}
        }
        try { entities.unregister(id); } catch {}
        diveSites.delete(id);
        return true;
      }
    };
  }

  function findNearbyDiveSites(position, radius = 12) {
    const results = [];

    for (const site of diveSites.values()) {
      if (site.collected) continue;

      const distance = B.Vector3.Distance(position, site.position);
      if (distance > radius) continue;

      results.push({
        id: site.id,
        name: site.name,
        type: site.type,
        distanceM: distance,
        requiredDepthM: site.requiredDepthM
      });
    }

    return results.sort((a, b) => a.distanceM - b.distanceM);
  }

  function collectDiveSite(id, characterPosition, swimmerController = null) {
    const site = diveSites.get(id);

    if (!site) {
      return { ok: false, message: "Unknown dive site." };
    }

    if (site.collected) {
      return { ok: false, message: "This salvage site is already collected." };
    }

    const distance = B.Vector3.Distance(
      characterPosition,
      site.position
    );

    if (distance > site.interactionRadiusM) {
      return { ok: false, message: "Move closer to the salvage site." };
    }

    const sample = sampleWater(characterPosition);
    const depthBelowSurface = sample
      ? sample.height - characterPosition.y
      : 0;

    if (depthBelowSurface < site.requiredDepthM) {
      return {
        ok: false,
        message: "The required diving depth has not been reached."
      };
    }

    if (
      swimmerController &&
      !["underwater", "drowning"].includes(swimmerController.state)
    ) {
      return {
        ok: false,
        message: "The character must be underwater to collect this item."
      };
    }

    // Update the persistent state before notifying reward consumers.
    site.collected = true;
    site.mesh?.setEnabled(false);

    runtime.events.emit("water:salvageCollected", {
      siteId: site.id,
      itemId: site.itemId,
      rewardCents: site.rewardCents,
      position: site.position.clone(),
      persistent: site.persistent
    });

    return {
      ok: true,
      siteId: site.id,
      rewardCents: site.rewardCents,
      itemId: site.itemId
    };
  }

  /* ---------------------------------------------------------------- */
  /* Dynamic water geometry                                             */
  /* ---------------------------------------------------------------- */

  const oceanSurface = buildWaterGrid(B, scene, {
    name: "leonida-open-ocean",
    width: 3400,
    depth: 3400,
    subdivisions: 80,
    baseY: WATER_CONFIG.oceanBaseY,
    material: oceanMaterial,
    regionId: "leonida-ocean"
  });

  const riverPoints = [];

  for (let i = 0; i <= 160; i++) {
    const x = lerp(-1400, 1400, i / 160);

    riverPoints.push(new B.Vector3(
      x,
      WATER_CONFIG.riverBaseY,
      getRiverCenterline(x)
    ));
  }

  const riverSurface = buildWaterRibbon(B, scene, {
    name: "leonida-curved-river",
    points: riverPoints,
    width: WATER_CONFIG.riverWidthM,
    material: riverMaterial,
    regionId: "leonida-river"
  });

  oceanSurface.currentPositions = new Float32Array(
    oceanSurface.currentPositions
  );

  waterMeshes.push(oceanSurface, riverSurface);

  function updateWaterMesh(record, baseY, type, time, intensity, updateNormals) {
    const original = record.originalPositions;
    const positions = record.currentPositions;
    const waves = type === "river" ? riverWaves : oceanWaves;
    const offsetX = finite(record.mesh.position.x);
    const offsetZ = finite(record.mesh.position.z);

    for (let i = 0; i < original.length; i += 3) {
      if (record.orientation === "disc") {
        // Disc vertices use local XY rotated into world XZ. Local Z is height.
        const worldX = offsetX + original[i];
        const worldZ = offsetZ - original[i + 1];
        const wave = evaluateWaveComponents(worldX, worldZ, time, waves, intensity);
        positions[i] = original[i] + wave.displacementX;
        positions[i + 1] = original[i + 1] - wave.displacementZ;
        positions[i + 2] = wave.height;
      } else {
        const worldX = original[i] + offsetX;
        const worldZ = original[i + 2] + offsetZ;
        const wave = evaluateWaveComponents(worldX, worldZ, time, waves, intensity);
        positions[i] = original[i] + wave.displacementX;
        positions[i + 1] = baseY + wave.height;
        positions[i + 2] = original[i + 2] + wave.displacementZ;
      }
    }

    record.mesh.updateVerticesData(
      B.VertexBuffer.PositionKind,
      positions,
      false,
      false
    );

    if (updateNormals) {
      B.VertexData.ComputeNormals(positions, record.indices, record.normals);
      record.mesh.updateVerticesData(
        B.VertexBuffer.NormalKind,
        record.normals,
        false,
        false
      );
    }
  }

  function updateSplashes(dt) {
    for (const splash of [...activeSplashes]) {
      splash.elapsed += dt;

      const age = splash.elapsed / splash.duration;
      splash.mesh.scaling.x = lerp(0.2, 2.8, cubicEase(age));
      splash.mesh.scaling.z = lerp(0.2, 2.8, cubicEase(age));
      splash.material.alpha = Math.max(0, 0.7 * (1 - age));

      if (age >= 1) {
        splash.mesh.dispose();
        splash.material.dispose();
        activeSplashes.delete(splash);
      }
    }
  }

  function spawnSplash(position, intensity = 0.5) {
    if (!position || activeSplashes.size >= 24) return null;

    const mesh = B.MeshBuilder.CreateTorus(
      `water-splash-${Math.floor(simulationTime * 1000)}`,
      {
        diameter: 1.3,
        thickness: 0.06,
        tessellation: 20
      },
      scene
    );

    mesh.position.set(
      position.x,
      position.y + 0.05,
      position.z
    );

    mesh.rotation.x = Math.PI / 2;
    mesh.isPickable = false;
    mesh.checkCollisions = false;

    const material = new B.StandardMaterial(
      `water-splash-material-${activeSplashes.size}`,
      scene
    );

    material.diffuseColor = new B.Color3(0.51, 0.82, 0.91);
    material.emissiveColor = new B.Color3(0.08, 0.18, 0.24);
    material.alpha = clamp(intensity, 0.1, 0.9);
    material.backFaceCulling = false;

    mesh.material = material;

    const splash = {
      mesh,
      material,
      elapsed: 0,
      duration: lerp(0.55, 1.2, clamp(intensity, 0, 1))
    };

    activeSplashes.add(splash);

    runtime.events.emit("water:splash", {
      position: { x: position.x, y: position.y, z: position.z },
      intensity: clamp(intensity, 0, 1)
    });

    return splash;
  }

  /* ---------------------------------------------------------------- */
  /* System lifecycle                                                   */
  /* ---------------------------------------------------------------- */

  async function initialize() {
    if (initialized) return { ok: true };

    weather = services.get("weather") ?? weather;
    world = services.get("world") ?? world;
    if (!world) {
      throw new Error("Water simulation requires the initialized 'world' service.");
    }
    if (!weather) {
      throw new Error("Water simulation requires the initialized 'weather' service.");
    }

    // Register several persistent exploration objectives in open water.
    registerDiveSite({
      id: "wreck-coastal-trawler",
      name: "Sunken Coastal Trawler",
      type: "wreck",
      position: { x: 1050, y: -7, z: 180 },
      requiredDepthM: 3,
      interactionRadiusM: 3.0,
      rewardCents: 12500,
      itemId: "trawler-logbook"
    });

    registerDiveSite({
      id: "wreck-aircraft-fragment",
      name: "Aircraft Debris Field",
      type: "aircraft-wreck",
      position: { x: -1110, y: -13, z: -270 },
      requiredDepthM: 5,
      interactionRadiusM: 3.2,
      rewardCents: 22000,
      itemId: "aircraft-black-box"
    });

    registerDiveSite({
      id: "salvage-lockbox-01",
      name: "Sealed Salvage Lockbox",
      type: "salvage",
      position: { x: 1185, y: -5, z: 450 },
      requiredDepthM: 2.5,
      interactionRadiusM: 2.2,
      rewardCents: 7600,
      itemId: "lockbox-01"
    });

    registerDiveSite({
      id: "river-sunken-crate",
      name: "River Cargo Crate",
      type: "salvage",
      position: {
        x: 140,
        y: WATER_CONFIG.riverBaseY - 2,
        z: getRiverCenterline(140)
      },
      requiredDepthM: 1.3,
      interactionRadiusM: 2.4,
      rewardCents: 3400,
      itemId: "river-cargo-01"
    });

    serviceDisposers.push(
      runtime.services.register("water", {
        getWaterRegionAt,
        sampleWater,
        getSurfaceHeight,
        registerWaterRegion,
        calculateBuoyancy,

        createSwimController,
        updateSwimmer,
        updateUnderwaterPresentation,

        registerDiveSite,
        findNearbyDiveSites,
        collectDiveSite,

        spawnSplash,
        getSnapshot: () => ({
          time: simulationTime,
          regions: customRegions.size + 2,
          swimmers: swimmers.size,
          diveSites: diveSites.size,
          collectedDiveSites: [...diveSites.values()]
            .filter(site => site.collected).length,
          activeSplashes: activeSplashes.size,
          oceanVertices: oceanSurface.currentPositions.length / 3,
          riverVertices: riverSurface.currentPositions.length / 3
        })
      })
    );

    eventDisposers.push(
      runtime.events.on("water:splashRequested", payload => {
        if (payload?.position) {
          spawnSplash(
            payload.position,
            finite(payload.intensity, 0.5)
          );
        }
      })
    );

    eventDisposers.push(
      runtime.events.on("world:weatherChanged", () => {
        // Actual wave amplitude is sampled from the current weather
        // profile each update; no duplicate weather state is maintained.
        logger.debug("Water system received a weather-state change.");
      })
    );

    initialized = true;
    logger.info("Water and dive simulation initialized.", {
      oceanGridVertices: oceanSurface.currentPositions.length / 3,
      riverVertices: riverSurface.currentPositions.length / 3,
      diveSites: diveSites.size
    });

    return { ok: true };
  }

  function start() {
    running = true;
    return { ok: true };
  }

  function update(context) {
    if (!initialized || !running || disposed) return;

    const dt = clamp(finite(context.gameDeltaSeconds), 0, 0.1);

    simulationTime += dt;

    updateSplashes(dt);
    updateBubbles(dt);

    for (const controller of swimmers.values()) {
      controller.elapsed += 0;
      // Controllers update only when their owning character submits the
      // current position and movement input via updateSwimmer().
    }

    const windScale = getWindScale(
      camera.globalPosition || camera.position
    );

    if (simulationTime - lastSurfaceUpdate >=
        WATER_CONFIG.surfaceUpdateInterval) {
      lastSurfaceUpdate = simulationTime;

      updateWaterMesh(
        oceanSurface,
        WATER_CONFIG.oceanBaseY,
        "ocean",
        simulationTime,
        windScale,
        simulationTime - lastNormalUpdate >=
          WATER_CONFIG.normalUpdateInterval
      );

      updateWaterMesh(
        riverSurface,
        WATER_CONFIG.riverBaseY,
        "river",
        simulationTime,
        clamp(windScale * 0.36, 0.15, 0.8),
        simulationTime - lastNormalUpdate >=
          WATER_CONFIG.normalUpdateInterval
      );

      for (const region of customRegions.values()) {
        if (!region.surfaceRecord) continue;
        updateWaterMesh(
          region.surfaceRecord,
          region.baseY,
          region.type,
          simulationTime,
          getWaveIntensity({ x: region.x, z: region.z }, region.type),
          simulationTime - lastNormalUpdate >= WATER_CONFIG.normalUpdateInterval
        );
      }

      if (simulationTime - lastNormalUpdate >=
          WATER_CONFIG.normalUpdateInterval) {
        lastNormalUpdate = simulationTime;
      }
    }
  }

  function stop() {
    running = false;
    return { ok: true };
  }

  function dispose() {
    if (disposed) return;

    disposed = true;
    running = false;

    for (const off of eventDisposers.splice(0)) {
      try { off(); } catch {}
    }

    for (const off of serviceDisposers.splice(0)) {
      try { off(); } catch {}
    }

    for (const record of waterMeshes) {
      record.mesh.dispose();
    }

    for (const splash of activeSplashes) {
      splash.mesh.dispose();
      splash.material.dispose();
    }

    for (const bubble of activeBubbles) {
      bubble.mesh.dispose(false, false);
      bubble.material.dispose();
    }

    for (const site of diveSites.values()) {
      site.mesh?.dispose(false, false);
      for (const material of site.materials ?? []) {
        try { material.dispose(); } catch {}
      }
      try { entities.unregister(site.id); } catch {}
    }

    for (const material of waterMaterials) {
      try { material.dispose(); } catch {}
    }

    rippleTexture?.dispose();

    customRegions.clear();
    swimmers.clear();
    diveSites.clear();
    activeSplashes.clear();
    activeBubbles.clear();
  }

  return Object.freeze({
    initialize,
    start,
    update,
    stop,
    dispose,

    getWaterRegionAt,
    sampleWater,
    getSurfaceHeight,
    registerWaterRegion,
    calculateBuoyancy,
    createSwimController,
    updateSwimmer,
    registerDiveSite,
    findNearbyDiveSites,
    collectDiveSite
  });
}
