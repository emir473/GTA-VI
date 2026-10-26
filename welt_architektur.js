/*
 * Module 5: welt_architektur.js
 * Factory: createWorldArchitectureSystem()
 *
 * Responsibilities:
 * - World regions and chunk activation.
 * - Curved road network with shared rendering/navigation geometry.
 * - Directed routing graph and A* pathfinding.
 * - Road shoulders, sidewalks, lane markings, junctions and bridges.
 * - Spatial grid, local queries and entity registration.
 * - Procedural terrain, parcels, buildings, vegetation and interiors.
 * - Explicit collision / walkability metadata for gameplay systems.
 *
 * Coordinates: X/Z horizontal, Y vertical; one world unit = one meter.
 */

const WORLD_CONFIG = Object.freeze({
  seed: 902771,
  gridColumns: 9,
  gridRows: 9,
  gridSpacingM: 218,
  terrainCellResolution: 6,
  terrainChunkRadius: 2,
  riverWidthM: 58,
  baseGroundY: -0.35,
  baseRoadY: 0.10,
  maxBuildingsPerBlock: 5
});

const ROAD_TYPES = Object.freeze({
  street: Object.freeze({
    lanes: 2,
    laneWidthM: 3.35,
    shoulderM: 1.0,
    sidewalkM: 4.2,
    speedLimitMps: 13.9,
    asphaltColor: "#252a30",
    classCost: 1.0,
    oneWayChance: 0.08
  }),

  avenue: Object.freeze({
    lanes: 4,
    laneWidthM: 3.55,
    shoulderM: 1.6,
    sidewalkM: 5.2,
    speedLimitMps: 19.4,
    asphaltColor: "#242a30",
    classCost: 0.82,
    oneWayChance: 0.12
  }),

  highway: Object.freeze({
    lanes: 4,
    laneWidthM: 3.75,
    shoulderM: 2.8,
    sidewalkM: 0,
    speedLimitMps: 33.3,
    asphaltColor: "#20262b",
    classCost: 0.67,
    oneWayChance: 0.5
  })
});

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}

function finite(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function smoothstep(t) {
  const v = clamp(t, 0, 1);
  return v * v * (3 - 2 * v);
}

function makeRNG(seed) {
  let a = seed >>> 0;

  return () => {
    a += 0x6D2B79F5;

    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clampPointToCell(position, originX, originZ, cellSize) {
  return {
    x: Math.floor((position.x - originX) / cellSize),
    z: Math.floor((position.z - originZ) / cellSize)
  };
}

function vectorDistance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function cubicBezierPoint(B, p0, p1, p2, p3, t) {
  const inv = 1 - t;
  const inv2 = inv * inv;
  const t2 = t * t;

  return new B.Vector3(
    inv2 * inv * p0.x +
      3 * inv2 * t * p1.x +
      3 * inv * t2 * p2.x +
      t2 * t * p3.x,

    inv2 * inv * p0.y +
      3 * inv2 * t * p1.y +
      3 * inv * t2 * p2.y +
      t2 * t * p3.y,

    inv2 * inv * p0.z +
      3 * inv2 * t * p1.z +
      3 * inv * t2 * p2.z +
      t2 * t * p3.z
  );
}

function estimateBezierLength(points) {
  let length = 0;

  for (let i = 1; i < points.length; i++) {
    length += vectorDistance(points[i - 1], points[i]);
  }

  return length;
}

function nearestPointOnSegment2D(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const denominator = dx * dx + dz * dz;

  const t = denominator <= 1e-8
    ? 0
    : clamp(((px - ax) * dx + (pz - az) * dz) / denominator, 0, 1);

  const x = ax + dx * t;
  const z = az + dz * t;

  return {
    x,
    z,
    t,
    distance: Math.hypot(px - x, pz - z)
  };
}

function pointInRadius2D(position, center, radius) {
  return Math.hypot(
    position.x - center.x,
    position.z - center.z
  ) <= radius;
}

/* ------------------------------------------------------------------ */
/* Spatial grid                                                        */
/* ------------------------------------------------------------------ */

class SpatialGrid {
  constructor(cellSize = 64) {
    if (!Number.isFinite(cellSize) || cellSize <= 0) {
      throw new RangeError("Spatial grid cellSize must be positive.");
    }

    this.cellSize = cellSize;
    this.cells = new Map();
    this.objectCells = new Map();
  }

  cellKey(ix, iz) {
    return `${ix}:${iz}`;
  }

  getCellCoords(position) {
    return {
      x: Math.floor(position.x / this.cellSize),
      z: Math.floor(position.z / this.cellSize)
    };
  }

  insert(id, object, position) {
    if (this.objectCells.has(id)) {
      throw new Error(`Spatial entity already exists: ${id}`);
    }

    const coords = this.getCellCoords(position);
    const key = this.cellKey(coords.x, coords.z);

    if (!this.cells.has(key)) this.cells.set(key, new Map());

    this.cells.get(key).set(id, object);

    this.objectCells.set(id, {
      key,
      coords,
      object
    });

    return true;
  }

  remove(id) {
    const record = this.objectCells.get(id);
    if (!record) return false;

    const cell = this.cells.get(record.key);
    cell?.delete(id);

    if (cell?.size === 0) this.cells.delete(record.key);

    this.objectCells.delete(id);
    return true;
  }

  update(id, object, position) {
    const record = this.objectCells.get(id);

    if (!record) {
      return this.insert(id, object, position);
    }

    const next = this.getCellCoords(position);
    const nextKey = this.cellKey(next.x, next.z);

    record.object = object;

    if (record.key === nextKey) {
      const cell = this.cells.get(record.key);
      if (cell) cell.set(id, object);
      record.coords = next;
      return false;
    }

    this.remove(id);
    this.insert(id, object, position);
    return true;
  }

  queryRadius(position, radius) {
    const minX = Math.floor((position.x - radius) / this.cellSize);
    const maxX = Math.floor((position.x + radius) / this.cellSize);
    const minZ = Math.floor((position.z - radius) / this.cellSize);
    const maxZ = Math.floor((position.z + radius) / this.cellSize);

    const results = [];

    for (let ix = minX; ix <= maxX; ix++) {
      for (let iz = minZ; iz <= maxZ; iz++) {
        const cell = this.cells.get(this.cellKey(ix, iz));
        if (!cell) continue;

        for (const [id, object] of cell) {
          const objectPosition = object.position ??
            object.root?.position ??
            object.mesh?.position;

          if (!objectPosition) continue;

          const distance = Math.hypot(
            position.x - objectPosition.x,
            position.z - objectPosition.z
          );

          if (distance <= radius) results.push({ id, object, distance });
        }
      }
    }

    return results.sort((a, b) => a.distance - b.distance);
  }

  queryCell(ix, iz) {
    return [...(this.cells.get(this.cellKey(ix, iz)) ?? new Map()).entries()]
      .map(([id, object]) => ({ id, object }));
  }

  clear() {
    this.cells.clear();
    this.objectCells.clear();
  }

  get size() {
    return this.objectCells.size;
  }
}

/* ------------------------------------------------------------------ */
/* Geometry builders                                                   */
/* ------------------------------------------------------------------ */

function makeRibbon(B, scene, name, path, width, material, metadata = {}) {
  if (!Array.isArray(path) || path.length < 2) return null;

  const positions = [];
  const indices = [];

  for (let i = 0; i < path.length; i++) {
    const before = path[Math.max(0, i - 1)];
    const after = path[Math.min(path.length - 1, i + 1)];

    const tx = after.x - before.x;
    const tz = after.z - before.z;
    const length = Math.hypot(tx, tz) || 1;

    // Road-normal is calculated from the local curve tangent.
    const nx = tz / length;
    const nz = -tx / length;

    positions.push(
      path[i].x - nx * width * 0.5,
      path[i].y,
      path[i].z - nz * width * 0.5,

      path[i].x + nx * width * 0.5,
      path[i].y,
      path[i].z + nz * width * 0.5
    );
  }

  for (let i = 0; i < path.length - 1; i++) {
    const a = i * 2;
    const b = a + 1;
    const c = a + 2;
    const d = a + 3;

    indices.push(a, c, b, b, c, d);
  }

  const mesh = new B.Mesh(name, scene);
  const vertexData = new B.VertexData();

  vertexData.positions = positions;
  vertexData.indices = indices;

  B.VertexData.ComputeNormals(positions, indices, vertexData.normals);

  vertexData.applyToMesh(mesh, false);
  mesh.material = material;
  mesh.isPickable = true;
  mesh.checkCollisions = false;
  mesh.metadata = {
    ...(mesh.metadata || {}),
    ...metadata
  };

  return mesh;
}

function makeStripeMesh(B, scene, name, stripes, material, metadata = {}) {
  const positions = [];
  const indices = [];

  for (const stripe of stripes) {
    const { a, b, width = 0.14 } = stripe;

    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const length = Math.hypot(dx, dz) || 1;

    const nx = dz / length;
    const nz = -dx / length;

    const index = positions.length / 3;

    positions.push(
      a.x - nx * width / 2, a.y, a.z - nz * width / 2,
      a.x + nx * width / 2, a.y, a.z + nz * width / 2,
      b.x - nx * width / 2, b.y, b.z - nz * width / 2,
      b.x + nx * width / 2, b.y, b.z + nz * width / 2
    );

    indices.push(
      index, index + 2, index + 1,
      index + 1, index + 2, index + 3
    );
  }

  if (positions.length === 0) return null;

  const mesh = new B.Mesh(name, scene);
  const data = new B.VertexData();

  data.positions = positions;
  data.indices = indices;
  B.VertexData.ComputeNormals(positions, indices, data.normals);
  data.applyToMesh(mesh, false);

  mesh.material = material;
  mesh.isPickable = false;
  mesh.checkCollisions = false;
  mesh.metadata = { ...(mesh.metadata || {}), ...metadata };

  return mesh;
}

function appendQuad(batch, a, b, c, d) {
  const first = batch.positions.length / 3;

  batch.positions.push(
    a.x, a.y, a.z,
    b.x, b.y, b.z,
    c.x, c.y, c.z,
    d.x, d.y, d.z
  );

  batch.indices.push(
    first, first + 1, first + 2,
    first, first + 2, first + 3
  );
}

function appendBox(batch, B, center, size, rotationY = 0) {
  const sx = size.x * 0.5;
  const sy = size.y * 0.5;
  const sz = size.z * 0.5;

  const corners = [
    [-sx, -sy, -sz], [sx, -sy, -sz],
    [sx, sy, -sz], [-sx, sy, -sz],
    [-sx, -sy, sz], [sx, -sy, sz],
    [sx, sy, sz], [-sx, sy, sz]
  ];

  const cosine = Math.cos(rotationY);
  const sine = Math.sin(rotationY);

  const transformed = corners.map(([x, y, z]) => ({
    x: center.x + x * cosine - z * sine,
    y: center.y + y,
    z: center.z + x * sine + z * cosine
  }));

  const faces = [
    [0, 1, 2, 3],
    [5, 4, 7, 6],
    [4, 0, 3, 7],
    [1, 5, 6, 2],
    [3, 2, 6, 7],
    [4, 5, 1, 0]
  ];

  for (const face of faces) {
    const points = face.map(i => transformed[i]);
    appendQuad(batch, points[0], points[1], points[2], points[3]);
  }
}

function finalizeBatch(B, scene, name, batch, material, metadata = {}) {
  if (!batch.positions.length) return null;

  const mesh = new B.Mesh(name, scene);
  const data = new B.VertexData();

  data.positions = batch.positions;
  data.indices = batch.indices;

  B.VertexData.ComputeNormals(
    batch.positions,
    batch.indices,
    data.normals
  );

  data.applyToMesh(mesh, false);

  mesh.material = material;
  mesh.isPickable = false;
  mesh.checkCollisions = false;
  mesh.metadata = { ...(mesh.metadata || {}), ...metadata };

  return mesh;
}

function sampleCurve(edge, t) {
  const count = edge.points.length;
  const normalized = clamp(t, 0, 1) * (count - 1);

  const index = Math.min(count - 2, Math.floor(normalized));
  const amount = normalized - index;

  const a = edge.points[index];
  const b = edge.points[index + 1];

  return {
    x: lerp(a.x, b.x, amount),
    y: lerp(a.y, b.y, amount),
    z: lerp(a.z, b.z, amount)
  };
}

function tangentCurve(edge, t) {
  const delta = 0.002;
  const a = sampleCurve(edge, clamp(t - delta, 0, 1));
  const b = sampleCurve(edge, clamp(t + delta, 0, 1));

  const length = Math.hypot(b.x - a.x, b.z - a.z) || 1;

  return {
    x: (b.x - a.x) / length,
    y: 0,
    z: (b.z - a.z) / length
  };
}

function makeStripesForEdge(edge) {
  const stripes = [];
  const spec = ROAD_TYPES[edge.type];

  const totalWidth =
    spec.lanes * spec.laneWidthM + spec.shoulderM * 2;

  const centerLanes = spec.lanes;
  const laneHalfWidth = spec.laneWidthM / 2;

  function addOffsetDashes(offset, colorType) {
    const dashLength = edge.type === "highway" ? 6 : 3.7;
    const gapLength = edge.type === "highway" ? 8 : 6.4;
    const cycle = dashLength + gapLength;

    for (let distance = 4; distance < edge.lengthM; distance += cycle) {
      const t0 = distance / edge.lengthM;
      const t1 = Math.min(1, (distance + dashLength) / edge.lengthM);

      const p0 = sampleCurve(edge, t0);
      const p1 = sampleCurve(edge, t1);
      const n0 = tangentCurve(edge, t0);
      const n1 = tangentCurve(edge, t1);

      p0.x += n0.z * offset;
      p0.z -= n0.x * offset;
      p1.x += n1.z * offset;
      p1.z -= n1.x * offset;

      p0.y += 0.055;
      p1.y += 0.055;

      stripes.push({
        a: p0,
        b: p1,
        width: colorType === "yellow" ? 0.19 : 0.13,
        colorType
      });
    }
  }

  if (spec.lanes === 2 && !edge.oneWay) {
    addOffsetDashes(0, "yellow");
  } else {
    // Lane separators are measured from the road centerline. Shoulders are
    // outside the lane span and must not be subtracted twice.
    const laneSpan = spec.lanes * spec.laneWidthM;
    for (let i = 1; i < centerLanes; i++) {
      const offset = -laneSpan / 2 + i * spec.laneWidthM;
      addOffsetDashes(offset, "white");
    }
  }

  return stripes;
}

/* ------------------------------------------------------------------ */
/* Main world architecture                                             */
/* ------------------------------------------------------------------ */

export async function createWorldArchitectureSystem({
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
      "World architecture requires the shared runtime, scene and camera."
    );
  }

  const B = globalThis.BABYLON;
  if (!B) throw new Error("Babylon.js is unavailable.");

  let initialized = false;
  let running = false;
  let disposed = false;

  const eventDisposers = [];
  const serviceDisposers = [];

  const rng = makeRNG(WORLD_CONFIG.seed);
  const graphics = services.get("graphics");

  const originX =
    -((WORLD_CONFIG.gridColumns - 1) * WORLD_CONFIG.gridSpacingM) / 2;

  const originZ =
    -((WORLD_CONFIG.gridRows - 1) * WORLD_CONFIG.gridSpacingM) / 2;

  const grid = new SpatialGrid(64);

  const nodes = new Map();
  const edges = new Map();
  const adjacency = new Map();
  const worldEntities = new Map();
  const chunks = new Map();
  const buildings = new Map();
  const interiors = new Map();
  const surfaceMaterials = new Set();
  const meshes = new Set();

  let nextEntityId = 1;
  let activeChunkKeys = new Set();
  let lastStreamCell = null;
  let spatialQueryCount = 0;

  const materials = {
    terrain: graphics?.createPBRMaterial?.("world-terrain", {
      albedo: "#6b7956",
      metallic: 0,
      roughness: 0.94
    }),

    terrainSuburb: graphics?.createPBRMaterial?.("world-terrain-suburb", {
      albedo: "#718060",
      metallic: 0,
      roughness: 0.94
    }),

    grass: graphics?.createPBRMaterial?.("world-grass", {
      albedo: "#4c6748",
      metallic: 0,
      roughness: 1
    }),

    asphalt: graphics?.createPBRMaterial?.("world-asphalt", {
      albedo: "#292e34",
      metallic: 0.04,
      roughness: 0.88
    }),

    avenueAsphalt: graphics?.createPBRMaterial?.("world-avenue-asphalt", {
      albedo: "#252b31",
      metallic: 0.05,
      roughness: 0.82
    }),

    highwayAsphalt: graphics?.createPBRMaterial?.("world-highway-asphalt", {
      albedo: "#22272d",
      metallic: 0.06,
      roughness: 0.76
    }),

    sidewalk: graphics?.createPBRMaterial?.("world-sidewalk", {
      albedo: "#99958c",
      metallic: 0.02,
      roughness: 0.92
    }),

    curb: graphics?.createPBRMaterial?.("world-curb", {
      albedo: "#c1b8a6",
      metallic: 0,
      roughness: 0.85
    }),

    roadMarking: graphics?.createPBRMaterial?.("world-road-marking", {
      albedo: "#e7e4d9",
      metallic: 0,
      roughness: 0.72,
      emissive: "#111111"
    }),

    yellowMarking: graphics?.createPBRMaterial?.("world-yellow-marking", {
      albedo: "#e5bd56",
      metallic: 0,
      roughness: 0.72
    }),

    window: graphics?.createPBRMaterial?.("world-window", {
      albedo: "#50717e",
      metallic: 0.45,
      roughness: 0.22
    }),

    glassLit: graphics?.createPBRMaterial?.("world-window-lit", {
      albedo: "#e7bf82",
      metallic: 0.12,
      roughness: 0.32,
      emissive: "#574126"
    })
  };

  for (const [key, material] of Object.entries(materials)) {
    if (!material) {
      materials[key] = new B.StandardMaterial(`fallback-${key}`, scene);
    }

    materials[key].checkReadyOnEveryCall = false;
    surfaceMaterials.add(materials[key]);
  }

  const buildingPalette = [
    "#b7afa0",
    "#c6b9a3",
    "#a8b0b3",
    "#6c7e86",
    "#d1c4af",
    "#8b999c",
    "#b2b6ac",
    "#d6d1c1"
  ].map((color, i) => {
    const material = graphics?.createPBRMaterial?.(
      `world-building-material-${i}`,
      {
        albedo: color,
        metallic: i % 3 === 0 ? 0.12 : 0.04,
        roughness: 0.78
      }
    );

    const result = material ?? new B.StandardMaterial(
      `fallback-building-${i}`,
      scene
    );

    if (!material) result.diffuseColor = B.Color3.FromHexString(color);

    return result;
  });

  function registerMesh(mesh, chunkKey = null) {
    if (!mesh) return null;

    meshes.add(mesh);

    if (chunkKey) {
      if (!chunks.has(chunkKey)) {
        chunks.set(chunkKey, {
          key: chunkKey,
          meshes: new Set(),
          lights: new Set(),
          active: false,
          lastActivated: 0
        });
      }

      const chunk = chunks.get(chunkKey);
      chunk.meshes.add(mesh);
      // World generation creates every region once. Hide geometry belonging
      // to inactive chunks immediately; the first streaming pass must not
      // leave distant chunks visible by default.
      mesh.setEnabled?.(chunk.active);
    }

    return mesh;
  }

  function terrainColorAt(x, z) {
    const region = regionAt(x, z);

    switch (region) {
      case "wetlands": return "#475b42";
      case "industrial": return "#676d63";
      case "coastal": return "#b7a682";
      case "airport": return "#777d78";
      case "downtown": return "#686e66";
      default: return "#697957";
    }
  }

  function riverZ(x) {
    return 92 * Math.sin(x / 258) +
      23 * Math.sin(x / 116 + 1.4) - 24;
  }

  function distanceToRiver(x, z) {
    return Math.abs(z - riverZ(x));
  }

  function regionAt(x, z) {
    if (Math.abs(z) > 770 && x > -200 && x < 520) {
      return "coastal";
    }

    if (z > 490 && x < -180) {
      return "airport";
    }

    if (x > 400 && z < 340 && distanceToRiver(x, z) > 70) {
      return "industrial";
    }

    if (x < -370 && z < 180 && distanceToRiver(x, z) < 145) {
      return "wetlands";
    }

    if (Math.abs(x) < 340 && Math.abs(z) < 340) {
      return "downtown";
    }

    if (distanceToRiver(x, z) < 150) {
      return "wetlands";
    }

    return "suburbs";
  }

  function chunkKeyForPosition(x, z) {
    const cell = clampPointToCell(
      { x, z },
      originX,
      originZ,
      WORLD_CONFIG.gridSpacingM
    );

    const maxCol = WORLD_CONFIG.gridColumns - 2;
    const maxRow = WORLD_CONFIG.gridRows - 2;

    return `${clamp(cell.x, 0, maxCol)}:${clamp(cell.z, 0, maxRow)}`;
  }

  function registerWorldEntity(entity) {
    const id = entity.id ?? `world-entity-${nextEntityId++}`;

    if (worldEntities.has(id)) {
      throw new Error(`Duplicate world entity ID: ${id}`);
    }

    const record = {
      ...entity,
      id,
      region: entity.region ?? regionAt(
        entity.position?.x ?? 0,
        entity.position?.z ?? 0
      )
    };

    worldEntities.set(id, record);

    if (record.position) {
      grid.insert(id, record, record.position);
    }

    try {
      entities.register(id, record);
    } catch (error) {
      // World records can coexist with runtime records only through this
      // explicit collision check; never silently overwrite another entity.
      grid.remove(id);
      worldEntities.delete(id);
      throw error;
    }

    return record;
  }

  function unregisterWorldEntity(id) {
    grid.remove(id);
    worldEntities.delete(id);

    try {
      entities.unregister(id);
    } catch {
      // The central registry may have already unloaded the entity.
    }
  }

  function addNode(id, position, metadata = {}) {
    if (nodes.has(id)) throw new Error(`Duplicate road node: ${id}`);

    const node = {
      id,
      position: new B.Vector3(position.x, position.y ?? 0, position.z),
      edges: [],
      metadata: { ...metadata }
    };

    nodes.set(id, node);
    adjacency.set(id, []);

    return node;
  }

  function addDirectedConnection(fromId, toId, edge, directionSign) {
    adjacency.get(fromId).push({
      to: toId,
      edge,
      directionSign
    });
  }

  function getNodeId(column, row) {
    return `junction-${column}-${row}`;
  }

  function curveCrossesRiver(points) {
    for (let i = 0; i < points.length; i++) {
      if (distanceToRiver(points[i].x, points[i].z) < 40) {
        return true;
      }
    }
    return false;
  }

  function buildEdgeControlPoints(start, end, curvature) {
    const dx = end.x - start.x;
    const dz = end.z - start.z;
    const distance = Math.hypot(dx, dz) || 1;

    const nx = dz / distance;
    const nz = -dx / distance;

    const p1 = new B.Vector3(
      start.x + dx / 3 + nx * curvature,
      start.y,
      start.z + dz / 3 + nz * curvature
    );

    const p2 = new B.Vector3(
      start.x + dx * 2 / 3 + nx * curvature,
      end.y,
      start.z + dz * 2 / 3 + nz * curvature
    );

    return [p1, p2];
  }

  function generateRoadEdge(startNode, endNode, options = {}) {
    const type = options.type ?? "street";
    const spec = ROAD_TYPES[type];

    if (!spec) throw new Error(`Unknown road type: ${type}`);

    const start = startNode.position;
    const end = endNode.position;

    const delta = end.subtract(start);
    const distance = Math.hypot(delta.x, delta.z);

    const curvatureScale =
      type === "highway" ? 0.10 :
      type === "avenue" ? 0.08 : 0.12;

    const curvature = options.curvature ??
      (rng() - 0.5) * distance * curvatureScale;

    const [p1, p2] = buildEdgeControlPoints(
      start,
      end,
      curvature
    );

    const basePoints = [];
    const sampleCount = type === "highway" ? 40 : 28;

    for (let i = 0; i <= sampleCount; i++) {
      const t = i / sampleCount;
      basePoints.push(
        cubicBezierPoint(B, start, p1, p2, end, t)
      );
    }

    const bridge = options.bridge ?? curveCrossesRiver(basePoints);
    const bridgeHeight = bridge
      ? clamp(options.bridgeHeight ?? 8.5, 4.5, 13)
      : 0;

    const points = basePoints.map((point, index) => {
      const t = index / sampleCount;

      /*
       * The road profile shares its geometry with route interpolation.
       * This vertical arch creates bridges with gradual approaches.
       */
      const heightProfile = bridge
        ? bridgeHeight * Math.pow(Math.sin(Math.PI * t), 2)
        : 0;

      return new B.Vector3(
        point.x,
        point.y + WORLD_CONFIG.baseRoadY + heightProfile,
        point.z
      );
    });

    const lengthM = estimateBezierLength(points);

    const oneWay = options.oneWay ?? (
      type === "highway" ? rng() < spec.oneWayChance : false
    );

    const directionForward = options.directionForward ?? rng() >= 0.5;

    const id = options.id ??
      `road-${startNode.id}-${endNode.id}`;

    const edge = {
      id,
      startNodeId: startNode.id,
      endNodeId: endNode.id,
      type,
      points,
      lengthM,
      widthM: spec.lanes * spec.laneWidthM + spec.shoulderM * 2,
      lanes: spec.lanes,
      laneWidthM: spec.laneWidthM,
      shoulderM: spec.shoulderM,
      sidewalkM: spec.sidewalkM,
      speedLimitMps: spec.speedLimitMps,
      classCost: spec.classCost,
      oneWay,
      directionForward,
      bridge,
      blocked: false,
      wetness: 0,
      metadata: {
        speedLimitMps: spec.speedLimitMps,
        roadType: type,
        isBridge: bridge
      }
    };

    edges.set(id, edge);
    startNode.edges.push(id);
    endNode.edges.push(id);

    if (!oneWay) {
      addDirectedConnection(startNode.id, endNode.id, edge, 1);
      addDirectedConnection(endNode.id, startNode.id, edge, -1);
    } else if (directionForward) {
      addDirectedConnection(startNode.id, endNode.id, edge, 1);
    } else {
      addDirectedConnection(endNode.id, startNode.id, edge, -1);
    }

    return edge;
  }

  function edgePoint(edge, t, directionSign = 1) {
    return directionSign === 1
      ? sampleCurve(edge, t)
      : sampleCurve(edge, 1 - t);
  }

  function edgeTangent(edge, t, directionSign = 1) {
    const tangent = tangentCurve(
      edge,
      directionSign === 1 ? t : 1 - t
    );

    if (directionSign === -1) {
      tangent.x *= -1;
      tangent.z *= -1;
    }

    return tangent;
  }

  function edgeCost(edge, options = {}) {
    const speedFactor = clamp(
      finite(options.speedPreference, 1),
      0.3,
      2
    );

    const avoidHighways = options.avoidHighways === true;
    const blockedPenalty = edge.blocked ? Infinity : 0;
    const highwayPenalty =
      avoidHighways && edge.type === "highway" ? 2.5 : 1;

    return edge.lengthM * edge.classCost *
      speedFactor * highwayPenalty + blockedPenalty;
  }

  function nearestRoadNode(position, maxDistance = Infinity) {
    let closest = null;
    let closestDistance = maxDistance;

    for (const node of nodes.values()) {
      const distance = Math.hypot(
        position.x - node.position.x,
        position.z - node.position.z
      );

      if (distance < closestDistance) {
        closestDistance = distance;
        closest = node;
      }
    }

    return closest
      ? { node: closest, distance: closestDistance }
      : null;
  }

  function appendRoutePoint(path, point, epsilon = 0.06) {
    const vector = point instanceof B.Vector3
      ? point.clone()
      : new B.Vector3(finite(point?.x), finite(point?.y), finite(point?.z));
    const previous = path[path.length - 1];
    if (previous && vectorDistance(previous, vector) <= epsilon) return;
    path.push(vector);
  }

  function appendEdgeSegment(path, edge, startT, endT) {
    if (!edge?.points?.length) return;
    const maxIndex = edge.points.length - 1;
    const a = clamp(startT, 0, 1);
    const b = clamp(endT, 0, 1);

    appendRoutePoint(path, sampleCurve(edge, a));

    if (b >= a) {
      const first = Math.floor(a * maxIndex) + 1;
      const last = Math.ceil(b * maxIndex) - 1;
      for (let index = first; index <= last; index++) {
        if (index > 0 && index < maxIndex) {
          appendRoutePoint(path, edge.points[index]);
        }
      }
    } else {
      const first = Math.ceil(a * maxIndex) - 1;
      const last = Math.floor(b * maxIndex) + 1;
      for (let index = first; index >= last; index--) {
        if (index > 0 && index < maxIndex) {
          appendRoutePoint(path, edge.points[index]);
        }
      }
    }

    appendRoutePoint(path, sampleCurve(edge, b));
  }

  function routeDirectionAllowed(edge, directionSign) {
    return !edge.oneWay ||
      (edge.directionForward && directionSign === 1) ||
      (!edge.directionForward && directionSign === -1);
  }

  function getRoadAttachmentCandidates(snap, role, options = {}) {
    const edge = edges.get(snap?.edgeId);
    if (!edge || edge.blocked) return [];

    const t = clamp(snap.t, 0, 1);
    const candidates = [];
    const routeScale = edgeCost(edge, options) / Math.max(edge.lengthM, 0.001);

    if (role === "start") {
      if (routeDirectionAllowed(edge, 1)) {
        candidates.push({
          nodeId: edge.endNodeId,
          edge,
          fromT: t,
          toT: 1,
          directionSign: 1,
          cost: (1 - t) * edge.lengthM * routeScale
        });
      }
      if (routeDirectionAllowed(edge, -1)) {
        candidates.push({
          nodeId: edge.startNodeId,
          edge,
          fromT: t,
          toT: 0,
          directionSign: -1,
          cost: t * edge.lengthM * routeScale
        });
      }
    } else {
      if (routeDirectionAllowed(edge, 1)) {
        candidates.push({
          nodeId: edge.startNodeId,
          edge,
          fromT: 0,
          toT: t,
          directionSign: 1,
          cost: t * edge.lengthM * routeScale
        });
      }
      if (routeDirectionAllowed(edge, -1)) {
        candidates.push({
          nodeId: edge.endNodeId,
          edge,
          fromT: 1,
          toT: t,
          directionSign: -1,
          cost: (1 - t) * edge.lengthM * routeScale
        });
      }
    }

    return candidates;
  }

  function findRoute(startId, endId, options = {}) {
    if (!nodes.has(startId) || !nodes.has(endId)) {
      return {
        ok: false,
        reason: "unknown-node",
        path: [],
        edgeIds: [],
        distanceM: 0,
        cost: Infinity
      };
    }

    if (startId === endId) {
      return {
        ok: true,
        path: [nodes.get(startId).position.clone()],
        nodeIds: [startId],
        edgeIds: [],
        segments: [],
        distanceM: 0,
        cost: 0
      };
    }

    const open = new Set([startId]);
    const cameFrom = new Map();
    const connectionFrom = new Map();
    const gScore = new Map([[startId, 0]]);
    const fScore = new Map([[startId, 0]]);
    const closed = new Set();
    const minimumRoadCostFactor = Math.min(
      ...Object.values(ROAD_TYPES).map(spec => spec.classCost)
    ) * 0.3;

    function heuristic(aId, bId) {
      const a = nodes.get(aId).position;
      const b = nodes.get(bId).position;
      return Math.hypot(a.x - b.x, a.z - b.z) * minimumRoadCostFactor;
    }

    fScore.set(startId, heuristic(startId, endId));

    let iterations = 0;
    const maxIterations = Math.max(20000, nodes.size * nodes.size);

    while (open.size && iterations++ < maxIterations) {
      let currentId = null;
      let best = Infinity;

      for (const id of open) {
        const score = fScore.get(id) ?? Infinity;
        if (score < best) {
          best = score;
          currentId = id;
        }
      }

      if (currentId === null) break;

      if (currentId === endId) {
        const nodeIds = [currentId];
        const routeConnections = [];

        while (cameFrom.has(currentId)) {
          routeConnections.unshift(connectionFrom.get(currentId));
          currentId = cameFrom.get(currentId);
          nodeIds.unshift(currentId);
        }

        const path = [];
        for (const connection of routeConnections) {
          const edge = connection.edge;
          appendEdgeSegment(
            path,
            edge,
            connection.directionSign === 1 ? 0 : 1,
            connection.directionSign === 1 ? 1 : 0
          );
        }

        const edgeIds = routeConnections.map(connection => connection.edge.id);
        const distanceM = routeConnections.reduce(
          (sum, connection) => sum + connection.edge.lengthM,
          0
        );

        return {
          ok: true,
          path,
          nodeIds,
          edgeIds,
          segments: routeConnections.map(connection => ({
            edgeId: connection.edge.id,
            directionSign: connection.directionSign,
            type: connection.edge.type,
            lengthM: connection.edge.lengthM
          })),
          distanceM,
          cost: gScore.get(endId) ?? distanceM
        };
      }

      open.delete(currentId);
      closed.add(currentId);

      for (const connection of adjacency.get(currentId) ?? []) {
        const edge = connection.edge;
        const neighborId = connection.to;
        if (closed.has(neighborId) || edge.blocked) continue;

        const tentative = (gScore.get(currentId) ?? Infinity) +
          edgeCost(edge, options);

        if (tentative >= (gScore.get(neighborId) ?? Infinity)) continue;

        cameFrom.set(neighborId, currentId);
        connectionFrom.set(neighborId, connection);
        gScore.set(neighborId, tentative);
        fScore.set(neighborId, tentative + heuristic(neighborId, endId));
        open.add(neighborId);
      }
    }

    return {
      ok: false,
      reason: iterations >= maxIterations ? "search-limit" : "unreachable",
      path: [],
      edgeIds: [],
      distanceM: 0,
      cost: Infinity
    };
  }

  function findRouteBetweenPositions(startPosition, endPosition, options = {}) {
    if (!startPosition || !endPosition ||
        !Number.isFinite(startPosition.x) || !Number.isFinite(startPosition.z) ||
        !Number.isFinite(endPosition.x) || !Number.isFinite(endPosition.z)) {
      return { ok: false, reason: "invalid-position", path: [], edgeIds: [], distanceM: 0 };
    }

    const maxSnapDistance = Math.max(0, finite(options.maxSnapDistance, 350));
    const startSnap = closestPointOnRoad(startPosition, maxSnapDistance);
    const endSnap = closestPointOnRoad(endPosition, maxSnapDistance);

    if (!startSnap || !endSnap) {
      return { ok: false, reason: "no-nearby-road-segment", path: [], edgeIds: [], distanceM: 0 };
    }

    const startCandidates = getRoadAttachmentCandidates(startSnap, "start", options);
    const endCandidates = getRoadAttachmentCandidates(endSnap, "end", options);

    if (!startCandidates.length || !endCandidates.length) {
      return { ok: false, reason: "no-legal-road-direction", path: [], edgeIds: [], distanceM: 0 };
    }

    const startPoint = new B.Vector3(startSnap.x, startSnap.y, startSnap.z);
    const endPoint = new B.Vector3(endSnap.x, endSnap.y, endSnap.z);
    const exactStart = new B.Vector3(startPosition.x, finite(startPosition.y), startPosition.z);
    const exactEnd = new B.Vector3(endPosition.x, finite(endPosition.y), endPosition.z);
    const startAccessDistance = vectorDistance(exactStart, startPoint);
    const endAccessDistance = vectorDistance(exactEnd, endPoint);

    let best = null;

    for (const startCandidate of startCandidates) {
      for (const endCandidate of endCandidates) {
        const core = findRoute(startCandidate.nodeId, endCandidate.nodeId, options);
        if (!core.ok) continue;

        const totalCost = startCandidate.cost + core.cost + endCandidate.cost;
        if (best && totalCost >= best.totalCost) continue;

        const path = [];
        appendRoutePoint(path, exactStart);
        appendRoutePoint(path, startPoint);
        appendEdgeSegment(
          path,
          startCandidate.edge,
          startCandidate.fromT,
          startCandidate.toT
        );
        for (const point of core.path) appendRoutePoint(path, point);
        appendEdgeSegment(
          path,
          endCandidate.edge,
          endCandidate.fromT,
          endCandidate.toT
        );
        appendRoutePoint(path, endPoint);
        appendRoutePoint(path, exactEnd);

        const edgeIds = [];
        if (startCandidate.edge.lengthM > 0.01) edgeIds.push(startCandidate.edge.id);
        edgeIds.push(...core.edgeIds);
        if (endCandidate.edge.lengthM > 0.01) edgeIds.push(endCandidate.edge.id);

        best = {
          ok: true,
          path,
          nodeIds: core.nodeIds.slice(),
          edgeIds,
          segments: [
            { edgeId: startCandidate.edge.id, directionSign: startCandidate.directionSign, access: "start" },
            ...core.segments,
            { edgeId: endCandidate.edge.id, directionSign: endCandidate.directionSign, access: "destination" }
          ],
          distanceM: startAccessDistance +
            startCandidate.edge.lengthM * Math.abs(startCandidate.toT - startCandidate.fromT) +
            core.distanceM +
            endCandidate.edge.lengthM * Math.abs(endCandidate.toT - endCandidate.fromT) +
            endAccessDistance,
          cost: totalCost,
          startSnapDistanceM: startAccessDistance,
          endSnapDistanceM: endAccessDistance,
          startRoadPoint: startPoint,
          endRoadPoint: endPoint
        };
      }
    }

    if (!best) {
      return { ok: false, reason: "unreachable", path: [], edgeIds: [], distanceM: 0 };
    }

    return best;
  }

  function closestPointOnRoad(position, maxDistance = Infinity) {
    let best = null;

    for (const edge of edges.values()) {
      for (let i = 0; i < edge.points.length - 1; i++) {
        const a = edge.points[i];
        const b = edge.points[i + 1];

        const result = nearestPointOnSegment2D(
          position.x, position.z,
          a.x, a.z,
          b.x, b.z
        );

        if (result.distance > maxDistance) continue;
        if (best && result.distance >= best.distance) continue;

        best = {
          edgeId: edge.id,
          startNodeId: edge.startNodeId,
          endNodeId: edge.endNodeId,
          type: edge.type,
          x: result.x,
          y: lerp(a.y, b.y, result.t),
          z: result.z,
          distance: result.distance,
          t: (i + result.t) / (edge.points.length - 1),
          speedLimitMps: edge.speedLimitMps,
          oneWay: edge.oneWay,
          directionForward: edge.directionForward,
          lengthM: edge.lengthM,
          blocked: edge.blocked
        };
      }
    }

    return best;
  }

  function sampleGroundHeight(x, z) {
    // Terrain and road surfaces carry walkable metadata and are sampled
    // with an actual scene ray, so elevated bridge decks are respected.
    const origin = new B.Vector3(x, 120, z);

    const ray = new B.Ray(
      origin,
      new B.Vector3(0, -1, 0),
      240
    );

    const hit = scene.pickWithRay(
      ray,
      mesh => mesh.isEnabled() &&
        mesh.isVisible &&
        mesh.metadata?.isWalkable === true,
      false
    );

    return hit?.hit && hit.pickedPoint
      ? hit.pickedPoint.y
      : null;
  }

  function getRoadEdge(id) {
    return edges.get(id) ?? null;
  }

  function setRoadBlocked(id, blocked, reason = "unspecified") {
    const edge = edges.get(id);
    if (!edge) {
      return { ok: false, message: `Unknown road edge: ${id}` };
    }

    const next = Boolean(blocked);
    if (edge.blocked === next) return { ok: true, changed: false };

    edge.blocked = next;

    runtime.events.emit("world:roadBlockChanged", {
      edgeId: id,
      blocked: next,
      reason
    });

    return { ok: true, changed: true };
  }

  function buildTerrainTile(chunkKey, x, z, size, material) {
    const tileCount = WORLD_CONFIG.terrainCellResolution;
    const step = size / tileCount;

    const positions = [];
    const indices = [];

    for (let tz = 0; tz < tileCount; tz++) {
      for (let tx = 0; tx < tileCount; tx++) {
        const x0 = x - size / 2 + tx * step;
        const z0 = z - size / 2 + tz * step;
        const x1 = x0 + step;
        const z1 = z0 + step;

        const cx = (x0 + x1) / 2;
        const cz = (z0 + z1) / 2;

        // Remove tiles from the river corridor, leaving a curved channel
        // instead of covering water with a continuous terrain plane.
        if (distanceToRiver(cx, cz) < WORLD_CONFIG.riverWidthM * 0.56) {
          continue;
        }

        const base = positions.length / 3;

        const y = WORLD_CONFIG.baseGroundY;

        positions.push(
          x0, y, z0,
          x1, y, z0,
          x1, y, z1,
          x0, y, z1
        );

        indices.push(
          base, base + 1, base + 2,
          base, base + 2, base + 3
        );
      }
    }

    if (positions.length === 0) return null;

    const mesh = new B.Mesh(`terrain-${chunkKey}`, scene);
    const data = new B.VertexData();

    data.positions = positions;
    data.indices = indices;
    B.VertexData.ComputeNormals(positions, indices, data.normals);
    data.applyToMesh(mesh, false);

    mesh.material = material;
    mesh.isPickable = true;
    mesh.checkCollisions = false;

    mesh.metadata = {
      ...(mesh.metadata || {}),
      worldChunk: chunkKey,
      isWalkable: true,
      isGroundSurface: true,
      surfaceType: "terrain"
    };

    return registerMesh(mesh, chunkKey);
  }

  function makeBuildingMaterial(index) {
    return buildingPalette[index % buildingPalette.length];
  }

  function createBuilding(
    chunkKey,
    buildingIndex,
    x,
    z,
    width,
    depth,
    height,
    rotationY,
    region
  ) {
    const id = `building-${buildingIndex}`;
    const floors = Math.max(1, Math.floor(height / 3.35));

    const body = B.MeshBuilder.CreateBox(
      `${id}-body`,
      {
        width,
        height,
        depth,
        updatable: false
      },
      scene
    );

    body.position.set(x, height / 2 + WORLD_CONFIG.baseGroundY, z);
    body.rotation.y = rotationY;

    body.material = makeBuildingMaterial(buildingIndex);
    body.isPickable = true;
    // The building's main box is also its static collision proxy; metadata
    // alone does not make Babylon collision resolution active.
    body.checkCollisions = true;

    body.metadata = {
      ...(body.metadata || {}),
      worldEntityId: id,
      buildingId: id,
      region,
      blocksPlayer: true,
      isBuilding: true,
      isGroundSurface: false
    };

    registerMesh(body, chunkKey);

    // The façade detail is batched to keep the number of draw calls
    // lower than one independent mesh per window.
    const windows = { positions: [], indices: [] };

    const bayCount = clamp(
      Math.floor(width / (region === "downtown" ? 3.3 : 4.8)),
      2,
      10
    );

    const floorHeight = 3.35;
    const windowWidth = Math.min(
      region === "downtown" ? 1.8 : 2.5,
      width / (bayCount * 1.5)
    );

    const windowHeight = region === "downtown" ? 1.8 : 1.65;

    for (let floor = 0; floor < floors; floor++) {
      const centerY = WORLD_CONFIG.baseGroundY +
        floorHeight * floor + floorHeight * 0.56;

      for (let bay = 0; bay < bayCount; bay++) {
        const xOffset =
          -width / 2 + (bay + 0.5) * width / bayCount;

        const frontZ = depth / 2 + 0.025;
        const backZ = -depth / 2 - 0.025;

        appendBox(
          windows,
          B,
          { x: xOffset, y: centerY - height / 2, z: frontZ },
          { x: windowWidth, y: windowHeight, z: 0.06 }
        );

        appendBox(
          windows,
          B,
          { x: xOffset, y: centerY - height / 2, z: backZ },
          { x: windowWidth, y: windowHeight, z: 0.06 }
        );
      }
    }

    const windowMesh = finalizeBatch(
      B,
      scene,
      `${id}-windows`,
      windows,
      buildingIndex % 4 === 0 ? materials.glassLit : materials.window,
      {
        worldChunk: chunkKey,
        buildingId: id,
        isWalkable: false,
        blocksPlayer: false
      }
    );

    if (windowMesh) {
      windowMesh.position.set(
        x, height / 2 + WORLD_CONFIG.baseGroundY, z
      );
      windowMesh.rotation.y = rotationY;
      registerMesh(windowMesh, chunkKey);
    }

    const roof = B.MeshBuilder.CreateBox(
      `${id}-roof-cap`,
      {
        width: width + 0.8,
        height: 0.3,
        depth: depth + 0.8
      },
      scene
    );

    roof.position.set(
      x,
      height + WORLD_CONFIG.baseGroundY + 0.15,
      z
    );

    roof.rotation.y = rotationY;
    roof.material = materials.sidewalk;
    roof.isPickable = false;

    registerMesh(roof, chunkKey);

    // Rooftop units, water tanks, parapets and service rooms.
    if (height > 12) {
      for (let unit = 0; unit < Math.min(4, Math.floor(width / 10)); unit++) {
        const unitMesh = B.MeshBuilder.CreateBox(
          `${id}-rooftop-unit-${unit}`,
          {
            width: 1.7 + rng() * 1.5,
            height: 1.2 + rng() * 1.6,
            depth: 1.7 + rng() * 1.5
          },
          scene
        );

        unitMesh.position.set(
          x + (rng() - 0.5) * Math.max(1, width - 5),
          height + WORLD_CONFIG.baseGroundY + 0.7,
          z + (rng() - 0.5) * Math.max(1, depth - 5)
        );

        unitMesh.material = materials.curb;
        unitMesh.isPickable = false;

        registerMesh(unitMesh, chunkKey);
      }
    }

    const record = registerWorldEntity({
      id,
      type: "building",
      region,
      position: new B.Vector3(x, 0, z),
      dimensions: { width, height, depth },
      mesh: body,
      interiorId: null,
      persistentState: {
        doorState: "closed",
        owned: false,
        alarmState: "inactive"
      }
    });

    buildings.set(id, record);
    return record;
  }

  function createIntersection(node, chunkKey, radius) {
    const pad = B.MeshBuilder.CreateCylinder(
      `junction-pad-${node.id}`,
      {
        diameter: radius * 2,
        height: 0.12,
        tessellation: 24
      },
      scene
    );

    pad.position.set(
      node.position.x,
      WORLD_CONFIG.baseRoadY - 0.01,
      node.position.z
    );

    pad.material = materials.asphalt;
    pad.isPickable = true;
    pad.checkCollisions = false;

    pad.metadata = {
      ...(pad.metadata || {}),
      isWalkable: true,
      isRoadSurface: true,
      junctionId: node.id
    };

    registerMesh(pad, chunkKey);
  }

  function createRoadVisuals(edge) {
    const chunkKey = chunkKeyForPosition(
      (edge.points[0].x + edge.points[edge.points.length - 1].x) / 2,
      (edge.points[0].z + edge.points[edge.points.length - 1].z) / 2
    );

    const type = edge.type;
    const spec = ROAD_TYPES[type];
    const roadMaterial =
      type === "highway" ? materials.highwayAsphalt :
      type === "avenue" ? materials.avenueAsphalt :
      materials.asphalt;

    // Sidewalks / kerbs are parallel strips offset from the same curved
    // centerline, so they cannot drift away from the actual road curve.
    const sidewalkPaths = [];

    if (spec.sidewalkM > 0) {
      for (const side of [-1, 1]) {
        const sidewalk = edge.points.map((point, i) => {
          const previous = edge.points[Math.max(0, i - 1)];
          const next = edge.points[Math.min(edge.points.length - 1, i + 1)];

          const tx = next.x - previous.x;
          const tz = next.z - previous.z;
          const length = Math.hypot(tx, tz) || 1;
          const nx = tz / length;
          const nz = -tx / length;

          const offset = edge.widthM / 2 +
            spec.sidewalkM / 2;

          return new B.Vector3(
            point.x + nx * offset * side,
            point.y - (edge.bridge ? 0 : 0.05),
            point.z - nz * offset * side
          );
        });

        sidewalkPaths.push({
          side,
          path: sidewalk
        });

        const sidewalkMesh = makeRibbon(
          B,
          scene,
          `sidewalk-${edge.id}-${side}`,
          sidewalk,
          spec.sidewalkM,
          materials.sidewalk,
          {
            worldChunk: chunkKey,
            isWalkable: true,
            surfaceType: "sidewalk",
            roadId: edge.id
          }
        );

        registerMesh(sidewalkMesh, chunkKey);

        const curbPath = edge.points.map((point, i) => {
          const previous = edge.points[Math.max(0, i - 1)];
          const next = edge.points[Math.min(edge.points.length - 1, i + 1)];

          const tx = next.x - previous.x;
          const tz = next.z - previous.z;
          const length = Math.hypot(tx, tz) || 1;

          const nx = tz / length;
          const nz = -tx / length;
          const offset = edge.widthM / 2 + 0.15;

          return new B.Vector3(
            point.x + nx * offset * side,
            point.y + 0.04,
            point.z - nz * offset * side
          );
        });

        registerMesh(
          makeRibbon(
            B,
            scene,
            `curb-${edge.id}-${side}`,
            curbPath,
            0.3,
            materials.curb,
            {
              worldChunk: chunkKey,
              isWalkable: true,
              surfaceType: "curb",
              roadId: edge.id
            }
          ),
          chunkKey
        );
      }
    }

    const shoulderWidth = edge.widthM;

    const roadMesh = makeRibbon(
      B,
      scene,
      `road-${edge.id}`,
      edge.points,
      shoulderWidth,
      roadMaterial,
      {
        worldChunk: chunkKey,
        roadId: edge.id,
        roadType: type,
        isRoadSurface: true,
        isWalkable: true,
        isGroundSurface: true,
        isBridge: edge.bridge,
        blocksPlayer: false,
        laneCount: edge.lanes,
        speedLimitMps: edge.speedLimitMps
      }
    );

    registerMesh(roadMesh, chunkKey);

    if (edge.bridge) {
      // Bridge piers are static support geometry, visually spaced along
      // the raised deck. Their positions use the same road curve.
      for (let t = 0.16; t < 0.95; t += 0.2) {
        const point = sampleCurve(edge, t);

        if (point.y <= WORLD_CONFIG.baseRoadY + 1) continue;

        const pierHeight = point.y - WORLD_CONFIG.baseGroundY;

        const pier = B.MeshBuilder.CreateBox(
          `bridge-pier-${edge.id}-${Math.round(t * 100)}`,
          {
            width: 2.2,
            height: pierHeight,
            depth: 2.2
          },
          scene
        );

        pier.position.set(
          point.x,
          WORLD_CONFIG.baseGroundY + pierHeight / 2,
          point.z
        );

        pier.material = materials.sidewalk;
        pier.isPickable = true;

        pier.metadata = {
          ...(pier.metadata || {}),
          isWalkable: false,
          blocksPlayer: true,
          isBridgeSupport: true
        };

        registerMesh(pier, chunkKey);
      }
    }

    const allStripes = makeStripesForEdge(edge);
    const whiteStripes = allStripes.filter(s => s.colorType === "white");
    const yellowStripes = allStripes.filter(s => s.colorType === "yellow");

    registerMesh(
      makeStripeMesh(
        B, scene, `road-markings-white-${edge.id}`,
        whiteStripes, materials.roadMarking,
        { worldChunk: chunkKey, roadId: edge.id }
      ),
      chunkKey
    );

    registerMesh(
      makeStripeMesh(
        B, scene, `road-markings-yellow-${edge.id}`,
        yellowStripes, materials.yellowMarking,
        { worldChunk: chunkKey, roadId: edge.id }
      ),
      chunkKey
    );

    if (type === "highway") {
      const barrierOffset = edge.widthM / 2 - 1.1;

      for (const side of [-1, 1]) {
        const barrierPath = edge.points.map((point, i) => {
          const tangent = tangentCurve(edge, i / (edge.points.length - 1));

          return new B.Vector3(
            point.x + tangent.z * barrierOffset * side,
            point.y + 0.66,
            point.z - tangent.x * barrierOffset * side
          );
        });

        registerMesh(
          makeRibbon(
            B,
            scene,
            `highway-barrier-${edge.id}-${side}`,
            barrierPath,
            0.35,
            materials.curb,
            {
              worldChunk: chunkKey,
              isWalkable: false,
              blocksPlayer: true,
              isRoadBarrier: true
            }
          ),
          chunkKey
        );
      }
    }
  }

  function createStreetNetwork() {
    const cols = WORLD_CONFIG.gridColumns;
    const rows = WORLD_CONFIG.gridRows;
    const spacing = WORLD_CONFIG.gridSpacingM;

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const baseX = originX + col * spacing;
        const baseZ = originZ + row * spacing;

        const jitterX = col === 0 || col === cols - 1
          ? 0
          : (rng() - 0.5) * 15;

        const jitterZ = row === 0 || row === rows - 1
          ? 0
          : (rng() - 0.5) * 15;

        addNode(
          getNodeId(col, row),
          {
            x: baseX + jitterX,
            y: 0,
            z: baseZ + jitterZ
          },
          {
            column: col,
            row,
            region: regionAt(baseX, baseZ)
          }
        );
      }
    }

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const current = nodes.get(getNodeId(col, row));

        if (col < cols - 1) {
          const next = nodes.get(getNodeId(col + 1, row));

          const type =
            row === 0 || row === rows - 1
              ? "highway"
              : row === Math.floor(rows / 2) || col === Math.floor(cols / 2)
                ? "avenue"
                : "street";

          const edge = generateRoadEdge(current, next, { type });

          createRoadVisuals(edge);
        }

        if (row < rows - 1) {
          const next = nodes.get(getNodeId(col, row + 1));

          const type =
            col === 0 || col === cols - 1
              ? "highway"
              : col === Math.floor(cols / 2)
                ? "avenue"
                : "street";

          const edge = generateRoadEdge(current, next, { type });

          createRoadVisuals(edge);
        }
      }
    }

    for (const node of nodes.values()) {
      const maxWidth = Math.max(
        ...node.edges.map(id => edges.get(id)?.widthM ?? 12)
      );

      const chunkKey = chunkKeyForPosition(
        node.position.x,
        node.position.z
      );

      createIntersection(
        node,
        chunkKey,
        Math.max(8.5, maxWidth * 0.58)
      );
    }
  }

  function createTerrainAndBuildings() {
    const cols = WORLD_CONFIG.gridColumns - 1;
    const rows = WORLD_CONFIG.gridRows - 1;
    const spacing = WORLD_CONFIG.gridSpacingM;

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const x = originX + col * spacing + spacing / 2;
        const z = originZ + row * spacing + spacing / 2;

        const chunkKey = `${col}:${row}`;
        const region = regionAt(x, z);

        const baseMaterial =
          region === "coastal" ? materials.terrainSuburb :
          region === "wetlands" ? materials.grass :
          materials.terrain;

        // A tile mesh is subdivided so a curving river channel can be
        // omitted at local scale rather than creating a straight trench.
        buildTerrainTile(
          chunkKey,
          x,
          z,
          spacing - 2.0,
          baseMaterial
        );

        if (distanceToRiver(x, z) < 95) continue;

        const buildingCount = region === "downtown"
          ? 5
          : region === "industrial"
            ? 3
            : 4;

        for (let b = 0; b < buildingCount; b++) {
          const quadrantX = b % 2 === 0 ? -1 : 1;
          const quadrantZ = b < 2 ? -1 : 1;

          const offsetX =
            quadrantX * (spacing * 0.22 + rng() * 15);

          const offsetZ =
            quadrantZ * (spacing * 0.22 + rng() * 15);

          const buildingX = x + offsetX;
          const buildingZ = z + offsetZ;

          if (distanceToRiver(buildingX, buildingZ) < 65) continue;

          let width;
          let depth;
          let height;

          if (region === "downtown") {
            width = 25 + rng() * 30;
            depth = 25 + rng() * 30;
            height = 18 + Math.pow(rng(), 0.48) * 145;
          } else if (region === "industrial") {
            width = 28 + rng() * 36;
            depth = 32 + rng() * 42;
            height = 8 + rng() * 20;
          } else if (region === "airport") {
            width = 28 + rng() * 32;
            depth = 24 + rng() * 35;
            height = 9 + rng() * 18;
          } else {
            width = 17 + rng() * 22;
            depth = 19 + rng() * 25;
            height = 5.5 + rng() * 14;
          }

          const rotation = (rng() - 0.5) *
            (region === "downtown" ? 0.13 : 0.28);

          const index = nextEntityId++;

          createBuilding(
            chunkKey,
            index,
            buildingX,
            buildingZ,
            width,
            depth,
            height,
            rotation,
            region
          );
        }

        // Low-rise shops, parking areas and road-side structures.
        if (region === "downtown" || region === "suburbs") {
          if (rng() > 0.24) {
            const shop = B.MeshBuilder.CreateBox(
              `shop-${col}-${row}`,
              {
                width: 19 + rng() * 14,
                height: 4.5 + rng() * 2.5,
                depth: 11 + rng() * 8
              },
              scene
            );

            shop.position.set(
              x + (rng() - 0.5) * 28,
              2.4,
              z + (rng() - 0.5) * 28
            );

            shop.material = buildingPalette[
              Math.floor(rng() * buildingPalette.length)
            ];
            shop.isPickable = true;
            shop.checkCollisions = true;

            shop.metadata = {
              ...(shop.metadata || {}),
              isBuilding: true,
              blocksPlayer: true,
              region,
              isWalkable: false
            };

            registerMesh(shop, chunkKey);
          }
        }
      }
    }
  }

  function createVegetation() {
    const trunkMaterial = graphics?.createPBRMaterial?.(
      "palm-trunk-material",
      {
        albedo: "#68503a",
        metallic: 0,
        roughness: 0.95
      }
    ) ?? materials.curb;

    const leafMaterial = graphics?.createPBRMaterial?.(
      "palm-leaf-material",
      {
        albedo: "#355f3e",
        metallic: 0,
        roughness: 0.94
      }
    ) ?? materials.grass;

    const palmMaster = B.MeshBuilder.CreateCylinder(
      "palm-trunk-master",
      {
        height: 8,
        diameterTop: 0.22,
        diameterBottom: 0.6,
        tessellation: 7
      },
      scene
    );

    palmMaster.material = trunkMaterial;
    palmMaster.isVisible = false;
    palmMaster.isPickable = false;
    meshes.add(palmMaster);

    const leafMaster = B.MeshBuilder.CreateCylinder(
      "palm-frond-master",
      {
        height: 4.2,
        diameterTop: 0.02,
        diameterBottom: 0.45,
        tessellation: 5
      },
      scene
    );

    leafMaster.material = leafMaterial;
    leafMaster.isVisible = false;
    leafMaster.isPickable = false;
    meshes.add(leafMaster);

    for (let i = 0; i < 112; i++) {
      const x = originX - 50 + rng() *
        (WORLD_CONFIG.gridColumns * WORLD_CONFIG.gridSpacingM + 100);

      const z = originZ - 50 + rng() *
        (WORLD_CONFIG.gridRows * WORLD_CONFIG.gridSpacingM + 100);

      if (distanceToRiver(x, z) < 58) continue;

      const region = regionAt(x, z);
      const onStreetEdge = rng() > 0.35;

      if (region === "downtown" && rng() > 0.16) continue;
      if (region === "industrial" && rng() > 0.22) continue;

      let px = x;
      let pz = z;

      if (onStreetEdge) {
        const nearest = closestPointOnRoad({ x, y: 0, z }, 38);

        if (nearest) {
          const angle = rng() * Math.PI * 2;
          const offset = 13 + rng() * 15;

          px = nearest.x + Math.cos(angle) * offset;
          pz = nearest.z + Math.sin(angle) * offset;
        }
      }

      if (distanceToRiver(px, pz) < 45) continue;

      const chunkKey = chunkKeyForPosition(px, pz);
      const heightScale = 0.75 + rng() * 0.8;

      const trunk = palmMaster.createInstance(`palm-trunk-${i}`);

      trunk.isVisible = true;
      trunk.position.set(px, 4 * heightScale, pz);
      trunk.scaling.y = heightScale;

      trunk.metadata = {
        ...(trunk.metadata || {}),
        isVegetation: true,
        windAffected: true
      };

      registerMesh(trunk, chunkKey);

      for (let frond = 0; frond < 6; frond++) {
        const leaf = leafMaster.createInstance(
          `palm-frond-${i}-${frond}`
        );

        const angle = frond * Math.PI / 3 + rng() * 0.15;
        const length = 2.8 + rng() * 1.3;

        leaf.isVisible = true;
        leaf.position.set(
          px + Math.cos(angle) * length * 0.28,
          7.2 * heightScale,
          pz + Math.sin(angle) * length * 0.28
        );

        leaf.rotation.z = -Math.PI / 3;
        leaf.rotation.y = angle;
        leaf.scaling.set(
          0.8 + rng() * 0.4,
          heightScale,
          0.8 + rng() * 0.4
        );

        leaf.metadata = {
          ...(leaf.metadata || {}),
          isVegetation: true,
          windAffected: true
        };

        registerMesh(leaf, chunkKey);
      }
    }
  }

  function createNamedLandmarks() {
    const specs = [
      {
        id: "star-island-villa", name: "Star Island Luxury Villa",
        x: -260, z: 310, width: 64, depth: 52, height: 11,
        region: "coastal", exteriorColor: "#e1d4bb",
        interiorId: "interior-star-island-villa", kind: "villa",
        category: "property", marker: "villa", interiorTheme: "villa"
      },
      {
        id: "vice-city-general-hospital", name: "Vice City General Hospital",
        x: 315, z: 220, width: 68, depth: 57, height: 36,
        region: "downtown", exteriorColor: "#bbc6cc",
        interiorId: "interior-hospital", kind: "hospital",
        category: "public-service", marker: "hospital", interiorTheme: "hospital"
      },
      {
        id: "leonida-state-penitentiary", name: "Leonida State Penitentiary",
        x: -610, z: 525, width: 96, depth: 70, height: 21,
        region: "airport", exteriorColor: "#85877f",
        interiorId: "interior-penitentiary", kind: "prison",
        category: "public-service", marker: "prison", interiorTheme: "prison"
      },
      {
        id: "port-gellhorn", name: "Port Gellhorn",
        x: 580, z: -480, width: 112, depth: 72, height: 16,
        region: "industrial", exteriorColor: "#7a878b",
        interiorId: null, kind: "port", category: "transport", marker: "port"
      },
      {
        id: "fort-zancudo", name: "Fort Zancudo",
        x: -760, z: 680, width: 90, depth: 80, height: 12,
        region: "airport", exteriorColor: "#777d74",
        interiorId: null, kind: "military-base", category: "restricted", marker: "military"
      },
      {
        id: "neon-palms", name: "Neon Palms Gentlemen's Club",
        x: 110, z: -215, width: 48, depth: 38, height: 8.5,
        region: "downtown", exteriorColor: "#282b48",
        interiorId: "interior-neon-palms", kind: "stripclub",
        category: "nightlife", marker: "nightlife", interiorTheme: "neon-palms",
        accentColor: "#ed4cba", secondaryColor: "#48d8ed"
      },
      {
        id: "velvet-current", name: "Velvet Current Club",
        x: 495, z: -185, width: 54, depth: 40, height: 9,
        region: "industrial", exteriorColor: "#382a43",
        interiorId: "interior-velvet-current", kind: "stripclub",
        category: "nightlife", marker: "nightlife", interiorTheme: "velvet-current",
        accentColor: "#b176ff", secondaryColor: "#f4b65d"
      },
      {
        id: "ammu-nation-downtown", name: "Ammu-Nation — Downtown",
        x: -110, z: 120, width: 27, depth: 22, height: 6.5,
        region: "downtown", exteriorColor: "#757d78",
        interiorId: "interior-ammu-downtown", kind: "weapon-shop",
        category: "shopping", marker: "weapon-shop", interiorTheme: "gunshop"
      },
      {
        id: "ammu-nation-west", name: "Ammu-Nation — Westside",
        x: -495, z: 80, width: 28, depth: 23, height: 6.5,
        region: "suburbs", exteriorColor: "#767b72",
        interiorId: "interior-ammu-west", kind: "weapon-shop",
        category: "shopping", marker: "weapon-shop", interiorTheme: "gunshop"
      },
      {
        id: "ammu-nation-east", name: "Ammu-Nation — East Vice",
        x: 585, z: 65, width: 29, depth: 24, height: 6.5,
        region: "industrial", exteriorColor: "#737d79",
        interiorId: "interior-ammu-east", kind: "weapon-shop",
        category: "shopping", marker: "weapon-shop", interiorTheme: "gunshop"
      },
      {
        id: "vice-city-motors", name: "Vice City Motors",
        x: -30, z: -465, width: 58, depth: 43, height: 9,
        region: "coastal", exteriorColor: "#647e8a",
        interiorId: "interior-vice-city-motors", kind: "car-dealer",
        category: "shopping", marker: "car-dealer", interiorTheme: "car-dealer"
      },
      {
        id: "south-beach-auto-gallery", name: "South Beach Auto Gallery",
        x: 510, z: 395, width: 62, depth: 46, height: 10,
        region: "suburbs", exteriorColor: "#7e8f99",
        interiorId: "interior-south-beach-auto-gallery", kind: "car-dealer",
        category: "shopping", marker: "car-dealer", interiorTheme: "auto-gallery"
      },
      {
        id: "vice-city-bank", name: "Vice City Metropolitan Bank",
        x: 170, z: 150, width: 42, depth: 34, height: 18,
        region: "downtown", exteriorColor: "#a3acb1",
        interiorId: "interior-vice-city-bank", kind: "bank",
        category: "public-service", marker: "bank", interiorTheme: "bank"
      },
      {
        id: "coastal-community-bank", name: "Coastal Community Bank",
        x: -420, z: -355, width: 34, depth: 29, height: 12,
        region: "coastal", exteriorColor: "#b8b6aa",
        interiorId: "interior-coastal-community-bank", kind: "bank",
        category: "public-service", marker: "bank", interiorTheme: "bank"
      }
    ];

    function createShellWall(landmark, chunkKey, shellMeshes, name, size, position, material, extra = {}) {
      const wall = B.MeshBuilder.CreateBox(name, size, scene);
      wall.position.set(position.x, position.y, position.z);
      wall.material = material;
      wall.isPickable = true;
      wall.metadata = {
        ...(wall.metadata || {}),
        isBuilding: true,
        isLandmark: true,
        landmarkId: landmark.id,
        interiorExteriorId: landmark.interiorId ?? null,
        blocksPlayer: true,
        isWalkable: false,
        ...extra
      };
      wall.checkCollisions = wall.metadata.blocksPlayer === true;
      registerMesh(wall, chunkKey);
      shellMeshes.push(wall);
      return wall;
    }

  function buildLandmarkShell(landmark, chunkKey, material) {
      const shellMeshes = [];
      const t = 0.65;
      const baseY = WORLD_CONFIG.baseGroundY;
      const centerY = baseY + landmark.height / 2;
      const halfW = landmark.width / 2;
      const halfD = landmark.depth / 2;
      const doorWidth = Math.min(3.2, landmark.depth * 0.18);
      const segmentDepth = Math.max(0.5, (landmark.depth - doorWidth) / 2);

      createShellWall(landmark, chunkKey, shellMeshes, `landmark-${landmark.id}-north-wall`,
        { width: landmark.width, height: landmark.height, depth: t },
        { x: landmark.x, y: centerY, z: landmark.z - halfD }, material);
      createShellWall(landmark, chunkKey, shellMeshes, `landmark-${landmark.id}-south-wall`,
        { width: landmark.width, height: landmark.height, depth: t },
        { x: landmark.x, y: centerY, z: landmark.z + halfD }, material);
      createShellWall(landmark, chunkKey, shellMeshes, `landmark-${landmark.id}-west-wall`,
        { width: t, height: landmark.height, depth: landmark.depth },
        { x: landmark.x - halfW, y: centerY, z: landmark.z }, material);

      // The east wall contains a real doorway opening aligned with the approach point.
      for (const side of [-1, 1]) {
        createShellWall(landmark, chunkKey, shellMeshes,
          `landmark-${landmark.id}-east-wall-${side}`,
          { width: t, height: landmark.height, depth: segmentDepth },
          { x: landmark.x + halfW, y: centerY,
            z: landmark.z + side * (doorWidth / 2 + segmentDepth / 2) }, material);
      }
      createShellWall(landmark, chunkKey, shellMeshes, `landmark-${landmark.id}-entry-lintel`,
        { width: t, height: 0.85, depth: doorWidth },
        { x: landmark.x + halfW, y: baseY + landmark.height - 0.425, z: landmark.z }, material);

      const roof = createShellWall(landmark, chunkKey, shellMeshes,
        `landmark-${landmark.id}-roof`,
        { width: landmark.width + 1.2, height: 0.35, depth: landmark.depth + 1.2 },
        { x: landmark.x, y: baseY + landmark.height + 0.175, z: landmark.z },
        materials.sidewalk, { blocksPlayer: false, isRoof: true });

      // Exterior accent fascia gives shops and nightlife locations a readable silhouette.
      if (landmark.accentColor) {
        const signMaterial = graphics?.createPBRMaterial?.(
          `landmark-sign-${landmark.id}`, {
            albedo: landmark.accentColor, metallic: 0.2, roughness: 0.35,
            emissive: landmark.accentColor
          }
        ) ?? materials.yellowMarking;
        surfaceMaterials.add(signMaterial);
        const sign = B.MeshBuilder.CreateBox(`landmark-${landmark.id}-sign`, {
          width: Math.min(landmark.width * 0.78, 24), height: 0.55, depth: 0.16
        }, scene);
        sign.position.set(landmark.x, baseY + landmark.height * 0.78, landmark.z - halfD - 0.12);
        sign.material = signMaterial;
        sign.isPickable = false;
        sign.metadata = { ...(sign.metadata || {}), isNeonSign: true, landmarkId: landmark.id };
        registerMesh(sign, chunkKey);
        shellMeshes.push(sign);
      }

      return { shellMeshes, roof };
    }

    for (const landmark of specs) {
      const chunkKey = chunkKeyForPosition(landmark.x, landmark.z);
      const landmarkMaterial = graphics?.createPBRMaterial?.(
        `landmark-material-${landmark.id}`,
        { albedo: landmark.exteriorColor, metallic: 0.05, roughness: 0.83 }
      ) ?? materials.sidewalk;
      if (landmarkMaterial !== materials.sidewalk) surfaceMaterials.add(landmarkMaterial);

      const { shellMeshes, roof } = buildLandmarkShell(landmark, chunkKey, landmarkMaterial);
      const record = registerWorldEntity({
        id: landmark.id,
        name: landmark.name,
        type: landmark.kind,
        category: landmark.category,
        marker: landmark.marker,
        isMapLocation: true,
        searchable: true,
        region: landmark.region,
        position: new B.Vector3(landmark.x, 0, landmark.z),
        dimensions: { width: landmark.width, height: landmark.height, depth: landmark.depth },
        mesh: roof,
        shellMeshes,
        interiorId: landmark.interiorId,
        shopType: landmark.kind === "weapon-shop" ? "weapons" :
          landmark.kind === "car-dealer" ? "vehicles" : null,
        interactionRadiusM: 6.5,
        persistentState: {
          unlocked: landmark.id === "star-island-villa",
          owned: landmark.kind === "villa" ? landmark.id === "star-island-villa" : false,
          doorState: "closed",
          alarmState: "inactive"
        }
      });

      if (landmark.interiorId) {
        registerInterior({
          id: landmark.interiorId,
          name: landmark.name,
          buildingId: record.id,
          interiorTheme: landmark.interiorTheme ?? "generic",
          accentColor: landmark.accentColor ?? "#5fd4e5",
          secondaryColor: landmark.secondaryColor ?? "#f2bb70",
          region: landmark.region,
          kind: landmark.kind,
          width: Math.max(12, landmark.width - 2.0),
          depth: Math.max(12, landmark.depth - 2.0),
          height: Math.max(4.0, Math.min(landmark.height - 1.0, 8.5)),
          entryPosition: {
            x: landmark.x + landmark.width / 2 + 2.8,
            y: 0,
            z: landmark.z
          },
          spawnPosition: {
            x: landmark.x + landmark.width / 2 - 2.0,
            y: WORLD_CONFIG.baseGroundY + 0.9,
            z: landmark.z
          },
          interiorPosition: { x: landmark.x, y: 0, z: landmark.z },
          exitPosition: {
            x: landmark.x + landmark.width / 2 + 3.3,
            y: 0,
            z: landmark.z
          },
          shellMeshes,
          worldChunk: chunkKey,
          loaded: false,
          zones: [],
          locationId: record.id
        });
      }
    }
  }

  function registerInterior(definition) {
    if (!definition?.id) return null;
    if (interiors.has(definition.id)) return interiors.get(definition.id);

    const entryPosition = definition.entryPosition;
    if (!entryPosition || !Number.isFinite(entryPosition.x) || !Number.isFinite(entryPosition.z)) {
      throw new TypeError(`Interior "${definition.id}" requires a valid entry position.`);
    }

    const record = {
      ...definition,
      active: false,
      audioZone: {
        reverb: definition.interiorTheme?.includes("club") || definition.kind === "stripclub" ? 0.68 : 0.28,
        lowPass: 0
      },
      collisionMeshes: [],
      renderMeshes: [],
      nodes: [],
      lights: [],
      interactionPoints: [],
      shellMeshes: Array.isArray(definition.shellMeshes) ? definition.shellMeshes : [],
      worldChunk: definition.worldChunk ?? chunkKeyForPosition(entryPosition.x, entryPosition.z),
      loaded: false
    };

    interiors.set(definition.id, record);
    return record;
  }

  function getInterior(id) {
    return interiors.get(id) ?? null;
  }

  function createInteriorRoom(interior) {
    if (!interior || interior.loaded) {
      return { ok: false, message: "Interior is missing or already loaded." };
    }

    const center = interior.interiorPosition ?? interior.spawnPosition ?? interior.entryPosition;
    const chunkKey = interior.worldChunk ?? chunkKeyForPosition(center.x, center.z);
    const width = Math.max(10, finite(interior.width, 15));
    const depth = Math.max(10, finite(interior.depth, 13));
    const height = Math.max(3.5, finite(interior.height, 4.2));
    const halfW = width / 2;
    const halfD = depth / 2;
    const wallT = 0.24;
    const floorY = WORLD_CONFIG.baseGroundY + 0.04;
    const baseMaterial = B.Color3.FromHexString(interior.accentColor ?? "#5fd4e5");

    const wallMaterial = graphics?.createPBRMaterial?.(`interior-${interior.id}-wall`, {
      albedo: interior.kind === "stripclub" ? "#23212d" : "#aba59a",
      metallic: interior.kind === "stripclub" ? 0.12 : 0,
      roughness: interior.kind === "stripclub" ? 0.55 : 0.92
    }) ?? materials.sidewalk;
    const floorMaterial = graphics?.createPBRMaterial?.(`interior-${interior.id}-floor`, {
      albedo: interior.kind === "stripclub" ? "#28232e" : "#6f716d",
      metallic: interior.kind === "stripclub" ? 0.16 : 0.02,
      roughness: interior.kind === "stripclub" ? 0.34 : 0.82
    }) ?? materials.sidewalk;
    const accentMaterial = graphics?.createPBRMaterial?.(`interior-${interior.id}-accent`, {
      albedo: interior.accentColor ?? "#5fd4e5",
      metallic: 0.25,
      roughness: 0.3,
      emissive: interior.accentColor ?? "#5fd4e5"
    }) ?? materials.yellowMarking;
    const secondaryMaterial = graphics?.createPBRMaterial?.(`interior-${interior.id}-secondary`, {
      albedo: interior.secondaryColor ?? "#f2bb70",
      metallic: 0.18,
      roughness: 0.4,
      emissive: interior.kind === "stripclub" ? (interior.secondaryColor ?? "#f2bb70") : "#000000"
    }) ?? materials.curb;
    for (const material of [wallMaterial, floorMaterial, accentMaterial, secondaryMaterial]) {
      if (material !== materials.sidewalk && material !== materials.yellowMarking && material !== materials.curb) {
        surfaceMaterials.add(material);
      }
    }

    function addInteriorMesh(mesh, name, material, metadata = {}) {
      mesh.name = name;
      mesh.material = material;
      mesh.isPickable = metadata.isInteractable === true || metadata.isWalkable === true;
      mesh.checkCollisions = metadata.blocksPlayer === true;
      mesh.metadata = {
        ...(mesh.metadata || {}),
        interiorId: interior.id,
        isInteriorGeometry: true,
        isWalkable: false,
        ...metadata
      };
      registerMesh(mesh, chunkKey);
      interior.renderMeshes.push(mesh);
      if (metadata.blocksPlayer) interior.collisionMeshes.push(mesh);
      if (metadata.isInteractable === true && metadata.interactionType) {
        const pointId = `${interior.id}:${name}`;
        if (!interior.interactionPoints.some(point => point.id === pointId)) {
          interior.interactionPoints.push({
            id: pointId,
            type: metadata.interactionType,
            position: { x: mesh.position.x, y: mesh.position.y, z: mesh.position.z },
            restrictedArea: metadata.restrictedArea === true,
            isVIPArea: metadata.isVIPArea === true
          });
        }
      }
      return mesh;
    }

    function addBox(name, size, position, material = wallMaterial, metadata = {}) {
      const mesh = B.MeshBuilder.CreateBox(name, size, scene);
      mesh.position.set(position.x, position.y, position.z);
      return addInteriorMesh(mesh, name, material, metadata);
    }

    function addCylinder(name, options, position, material, metadata = {}) {
      const mesh = B.MeshBuilder.CreateCylinder(name, options, scene);
      mesh.position.set(position.x, position.y, position.z);
      return addInteriorMesh(mesh, name, material, metadata);
    }

    const floor = B.MeshBuilder.CreateGround(`${interior.id}-floor`, {
      width: width - 0.5,
      height: depth - 0.5,
      subdivisions: 1
    }, scene);
    floor.position.set(center.x, floorY, center.z);
    addInteriorMesh(floor, `${interior.id}-floor`, floorMaterial, {
      isWalkable: true,
      isGroundSurface: true,
      surfaceType: "interior-floor"
    });

    const wallY = floorY + height / 2;
    addBox(`${interior.id}-north-wall`, { width, height, depth: wallT },
      { x: center.x, y: wallY, z: center.z - halfD }, wallMaterial,
      { blocksPlayer: true, interiorBoundary: true });
    addBox(`${interior.id}-south-wall`, { width, height, depth: wallT },
      { x: center.x, y: wallY, z: center.z + halfD }, wallMaterial,
      { blocksPlayer: true, interiorBoundary: true });
    addBox(`${interior.id}-west-wall`, { width: wallT, height, depth },
      { x: center.x - halfW, y: wallY, z: center.z }, wallMaterial,
      { blocksPlayer: true, interiorBoundary: true });

    // East wall leaves a deliberate doorway that aligns with the exterior side-door.
    const doorWidth = 2.7;
    const segment = Math.max(0.5, (depth - doorWidth) / 2);
    for (const side of [-1, 1]) {
      addBox(`${interior.id}-east-wall-${side}`, { width: wallT, height, depth: segment },
        { x: center.x + halfW, y: wallY,
          z: center.z + side * (doorWidth / 2 + segment / 2) }, wallMaterial,
        { blocksPlayer: true, interiorBoundary: true });
    }
    addBox(`${interior.id}-east-lintel`, { width: wallT, height: 0.55, depth: doorWidth },
      { x: center.x + halfW, y: floorY + height - 0.275, z: center.z }, wallMaterial,
      { blocksPlayer: true, interiorBoundary: true });

    // Perimeter lighting strips and suspended fixtures provide a defined interior light setup.
    addBox(`${interior.id}-led-north`, { width: width * 0.72, height: 0.09, depth: 0.08 },
      { x: center.x, y: floorY + height - 0.35, z: center.z - halfD + 0.22 }, accentMaterial,
      { blocksPlayer: false, isEmissiveLighting: true });
    addBox(`${interior.id}-led-south`, { width: width * 0.72, height: 0.09, depth: 0.08 },
      { x: center.x, y: floorY + height - 0.35, z: center.z + halfD - 0.22 }, secondaryMaterial,
      { blocksPlayer: false, isEmissiveLighting: true });

    const lightPositions = interior.kind === "stripclub"
      ? [
          { x: center.x - width * 0.24, y: floorY + height - 0.7, z: center.z - depth * 0.18, color: baseMaterial },
          { x: center.x + width * 0.22, y: floorY + height - 0.7, z: center.z + depth * 0.12, color: B.Color3.FromHexString(interior.secondaryColor ?? "#f2bb70") }
        ]
      : [{ x: center.x, y: floorY + height - 0.6, z: center.z, color: new B.Color3(0.82, 0.87, 0.92) }];

    lightPositions.forEach((spec, index) => {
      const light = new B.PointLight(`${interior.id}-light-${index}`, new B.Vector3(spec.x, spec.y, spec.z), scene);
      light.diffuse = spec.color;
      light.intensity = interior.kind === "stripclub" ? 0.7 : 0.55;
      light.range = Math.max(10, Math.min(width, depth) * 0.95);
      light.setEnabled(false);
      light.metadata = { interiorId: interior.id, audioZoneId: interior.id };
      interior.lights.push(light);
    });

    // Build non-empty, theme-specific functional spaces from procedural primitives.
    const theme = interior.interiorTheme ?? "generic";

    if (theme === "neon-palms" || theme === "velvet-current") {
      const stageWidth = Math.min(11, width * 0.28);
      const stageDepth = Math.min(5.5, depth * 0.19);
      const stageZ = center.z - halfD + stageDepth / 2 + 2.0;
      addBox(`${interior.id}-dance-stage`, { width: stageWidth, height: 0.42, depth: stageDepth },
        { x: center.x, y: floorY + 0.22, z: stageZ }, secondaryMaterial,
        { blocksPlayer: false, isInteractable: true, interactionType: "dance-stage" });
      addCylinder(`${interior.id}-dance-pole`, {
        height: Math.max(2.2, height - 1.8), diameter: 0.11, tessellation: 12
      }, { x: center.x, y: floorY + Math.max(2.2, height - 1.8) / 2, z: stageZ }, accentMaterial,
      { blocksPlayer: false, isInteractable: true, interactionType: "dance-stage-prop" });

      // Bar counter and seating.
      addBox(`${interior.id}-bar-counter`, { width: width * 0.45, height: 1.1, depth: 1.3 },
        { x: center.x, y: floorY + 0.55, z: center.z + halfD - 3.0 }, wallMaterial,
        { blocksPlayer: true, isInteractable: true, interactionType: "bar" });
      for (let index = 0; index < 5; index++) {
        const x = center.x - width * 0.31 + index * width * 0.155;
        addCylinder(`${interior.id}-bar-stool-${index}`, {
          height: 0.75, diameter: 0.58, tessellation: 10
        }, { x, y: floorY + 0.38, z: center.z + halfD - 4.8 }, secondaryMaterial,
        { blocksPlayer: false, isInteractable: true, interactionType: "seat" });
      }
      for (let index = 0; index < 4; index++) {
        const x = center.x - width * 0.30 + (index % 2) * width * 0.28;
        const z = center.z + depth * 0.06 + Math.floor(index / 2) * depth * 0.19;
        addCylinder(`${interior.id}-lounge-table-${index}`, {
          height: 0.72, diameter: 1.0, tessellation: 12
        }, { x, y: floorY + 0.36, z }, accentMaterial,
        { blocksPlayer: false, isInteractable: true, interactionType: "lounge-table" });
      }

      // Two enclosed VIP suites. Each has rear/side partitions, a doorway gap,
      // an individual LED accent and an interaction point.
      for (let index = 0; index < 2; index++) {
        const vipX = center.x + (index === 0 ? -1 : 1) * width * 0.30;
        const vipZ = center.z + halfD * 0.18;
        const vipWidth = Math.min(width * 0.22, 10.5);
        const vipDepth = Math.min(depth * 0.22, 8.0);
        const vipHeight = Math.max(2.5, height * 0.66);
        const doorGap = 1.35;
        const vipFrontZ = vipZ + vipDepth / 2;

        addBox(`${interior.id}-vip-back-${index}`, { width: vipWidth, height: vipHeight, depth: 0.18 },
          { x: vipX, y: floorY + vipHeight / 2, z: vipZ - vipDepth / 2 }, wallMaterial,
          { blocksPlayer: true, isVIPArea: true, vipSuiteIndex: index });
        addBox(`${interior.id}-vip-left-${index}`, { width: 0.18, height: vipHeight, depth: vipDepth },
          { x: vipX - vipWidth / 2, y: floorY + vipHeight / 2, z: vipZ }, wallMaterial,
          { blocksPlayer: true, isVIPArea: true, vipSuiteIndex: index });
        addBox(`${interior.id}-vip-right-${index}`, { width: 0.18, height: vipHeight, depth: vipDepth },
          { x: vipX + vipWidth / 2, y: floorY + vipHeight / 2, z: vipZ }, wallMaterial,
          { blocksPlayer: true, isVIPArea: true, vipSuiteIndex: index });
        const frontSegment = Math.max(0.3, (vipWidth - doorGap) / 2);
        for (const side of [-1, 1]) {
          addBox(`${interior.id}-vip-front-${index}-${side}`, { width: frontSegment, height: vipHeight, depth: 0.18 },
            { x: vipX + side * (doorGap / 2 + frontSegment / 2), y: floorY + vipHeight / 2, z: vipFrontZ }, wallMaterial,
            { blocksPlayer: true, isVIPArea: true, vipSuiteIndex: index });
        }
        addBox(`${interior.id}-vip-led-${index}`, { width: vipWidth * 0.82, height: 0.08, depth: 0.08 },
          { x: vipX, y: floorY + vipHeight - 0.25, z: vipZ - vipDepth / 2 + 0.18 }, secondaryMaterial,
          { blocksPlayer: false, isVIPArea: true, isEmissiveLighting: true });
        addBox(`${interior.id}-vip-table-${index}`, { width: 2.2, height: 0.75, depth: 1.1 },
          { x: vipX, y: floorY + 0.38, z: vipZ + 0.5 }, accentMaterial,
          { blocksPlayer: false, isInteractable: true, interactionType: "vip-room", isVIPArea: true });
        interior.interactionPoints.push({ id: `${interior.id}-vip-${index}`, type: "vip-room", position: { x: vipX, y: floorY, z: vipZ }, isVIPArea: true });
      }
      interior.audioZone = { reverb: 0.72, lowPass: 0.06, musicProfile: theme };
      interior.interactionPoints.push({ id: `${interior.id}-stage`, type: "dance-stage", position: { x: center.x, y: floorY, z: stageZ } });
      interior.interactionPoints.push({ id: `${interior.id}-bar`, type: "bar", position: { x: center.x, y: floorY, z: center.z + halfD - 3.0 } });
    } else if (theme === "gunshop") {
      addBox(`${interior.id}-sales-counter`, { width: width * 0.55, height: 1.05, depth: 1.0 },
        { x: center.x, y: floorY + 0.525, z: center.z + halfD - 3.0 }, secondaryMaterial,
        { blocksPlayer: true, isInteractable: true, interactionType: "weapon-purchase-counter" });
      for (let side = -1; side <= 1; side += 2) {
        for (let shelf = 0; shelf < 3; shelf++) {
          addBox(`${interior.id}-wall-rack-${side}-${shelf}`, { width: 0.24, height: 2.3, depth: width * 0.24 },
            { x: center.x + side * (halfW - 0.7), y: floorY + 1.5, z: center.z - depth * 0.18 + shelf * depth * 0.18 }, wallMaterial,
            { blocksPlayer: true, isWeaponDisplayRack: true });
          addBox(`${interior.id}-weapon-display-${side}-${shelf}`, { width: 0.18, height: 0.11, depth: 1.5 },
            { x: center.x + side * (halfW - 0.53), y: floorY + 2.1, z: center.z - depth * 0.18 + shelf * depth * 0.18 }, accentMaterial,
            { blocksPlayer: false, isWeaponDisplay: true, itemCategory: "weapon", displayOnly: true });
        }
      }
      addBox(`${interior.id}-glass-counter-top`, { width: width * 0.56, height: 0.08, depth: 1.15 },
        { x: center.x, y: floorY + 1.12, z: center.z + halfD - 3.0 }, accentMaterial,
        { blocksPlayer: false, isWeaponDisplay: true });
      interior.audioZone = { reverb: 0.24, lowPass: 0.02, musicProfile: "retail" };
      interior.interactionPoints.push({ id: `${interior.id}-counter`, type: "weapon-purchase-counter", position: { x: center.x, y: floorY, z: center.z + halfD - 3.0 } });
    } else if (theme === "car-dealer" || theme === "auto-gallery") {
      const displayMaterial = theme === "auto-gallery" ? secondaryMaterial : accentMaterial;
      for (let index = 0; index < 3; index++) {
        const carX = center.x + (index - 1) * width * 0.27;
        const carZ = center.z - depth * 0.04;
        addBox(`${interior.id}-display-pad-${index}`, { width: width * 0.23, height: 0.16, depth: depth * 0.43 },
          { x: carX, y: floorY + 0.08, z: carZ }, displayMaterial,
          { blocksPlayer: false, isVehicleDisplayPad: true });

        // Procedural exhibition vehicles are visual scene objects, not owned/driveable vehicles.
        // The vehicle module must replace/catalogue them when real vehicle entities are registered.
        const carRoot = new B.TransformNode(`${interior.id}-display-vehicle-${index}`, scene);
        carRoot.position.set(carX, floorY + 0.24, carZ);
        interior.nodes.push(carRoot);
        const body = B.MeshBuilder.CreateBox(`${carRoot.name}-body`, {
          width: 3.7 + index * 0.18, height: 0.72, depth: 1.65
        }, scene);
        body.parent = carRoot;
        body.material = index === 1 ? secondaryMaterial : wallMaterial;
        body.metadata = { interiorId: interior.id, isInteriorGeometry: true, displayOnly: true, vehicleDisplayIndex: index };
        registerMesh(body, chunkKey);
        interior.renderMeshes.push(body);

        const cabin = B.MeshBuilder.CreateBox(`${carRoot.name}-cabin`, {
          width: 1.9, height: 0.72, depth: 1.25
        }, scene);
        cabin.parent = carRoot;
        cabin.position.set(-0.15, 0.66, 0);
        cabin.material = materials.window;
        cabin.metadata = { interiorId: interior.id, isInteriorGeometry: true, displayOnly: true, vehicleDisplayIndex: index };
        registerMesh(cabin, chunkKey);
        interior.renderMeshes.push(cabin);

        for (let wheel = 0; wheel < 4; wheel++) {
          const wheelMesh = B.MeshBuilder.CreateCylinder(`${carRoot.name}-wheel-${wheel}`, {
            height: 0.28, diameter: 0.62, tessellation: 12
          }, scene);
          wheelMesh.parent = carRoot;
          wheelMesh.rotation.z = Math.PI / 2;
          wheelMesh.position.set(wheel < 2 ? -1.15 : 1.15, -0.15, wheel % 2 === 0 ? -0.83 : 0.83);
          wheelMesh.material = materials.asphalt;
          wheelMesh.metadata = { interiorId: interior.id, isInteriorGeometry: true, displayOnly: true, vehicleDisplayIndex: index };
          registerMesh(wheelMesh, chunkKey);
          interior.renderMeshes.push(wheelMesh);
        }
        interior.interactionPoints.push({
          id: `${interior.id}-vehicle-${index}`,
          type: "vehicle-display",
          displayOnly: true,
          vehicleCatalogIndex: index,
          position: { x: carX, y: floorY, z: carZ }
        });
      }
      addBox(`${interior.id}-dealer-desk`, { width: 5.5, height: 1.1, depth: 1.2 },
        { x: center.x, y: floorY + 0.55, z: center.z + halfD - 2.5 }, secondaryMaterial,
        { blocksPlayer: true, isInteractable: true, interactionType: "vehicle-sales-desk" });
      interior.audioZone = { reverb: 0.28, lowPass: 0.01, musicProfile: "showroom" };
    } else if (theme === "bank") {
      addBox(`${interior.id}-bank-counter`, { width: width * 0.58, height: 1.12, depth: 1.0 },
        { x: center.x, y: floorY + 0.56, z: center.z - halfD * 0.2 }, secondaryMaterial,
        { blocksPlayer: true, isInteractable: true, interactionType: "bank-counter" });
      addBox(`${interior.id}-vault-door`, { width: 2.4, height: 2.6, depth: 0.26 },
        { x: center.x - halfW + 1.0, y: floorY + 1.3, z: center.z }, accentMaterial,
        { blocksPlayer: true, isInteractable: true, interactionType: "bank-security-door", restrictedArea: true });
      interior.audioZone = { reverb: 0.31, lowPass: 0.03, musicProfile: "public-interior" };
    } else if (theme === "hospital") {
      addBox(`${interior.id}-reception-desk`, { width: width * 0.42, height: 1.05, depth: 1.1 },
        { x: center.x, y: floorY + 0.525, z: center.z + halfD * 0.25 }, secondaryMaterial,
        { blocksPlayer: true, isInteractable: true, interactionType: "hospital-reception" });
      for (let index = 0; index < 3; index++) {
        const bedX = center.x - width * 0.28 + index * width * 0.28;
        addBox(`${interior.id}-bed-frame-${index}`, { width: 2.1, height: 0.4, depth: 3.2 },
          { x: bedX, y: floorY + 0.2, z: center.z - halfD * 0.3 }, wallMaterial,
          { blocksPlayer: false, isInteractable: true, interactionType: "hospital-bed" });
        addBox(`${interior.id}-bed-mattress-${index}`, { width: 2.0, height: 0.18, depth: 3.0 },
          { x: bedX, y: floorY + 0.48, z: center.z - halfD * 0.3 }, materials.window,
          { blocksPlayer: false });
      }
      interior.audioZone = { reverb: 0.32, lowPass: 0.02, musicProfile: "hospital" };
    } else if (theme === "villa") {
      addBox(`${interior.id}-living-sofa`, { width: 5.0, height: 0.8, depth: 1.4 },
        { x: center.x - width * 0.18, y: floorY + 0.4, z: center.z + depth * 0.12 }, secondaryMaterial,
        { blocksPlayer: false, isInteractable: true, interactionType: "seat" });
      addBox(`${interior.id}-safe`, { width: 1.2, height: 1.7, depth: 0.8 },
        { x: center.x + width * 0.28, y: floorY + 0.85, z: center.z - depth * 0.22 }, wallMaterial,
        { blocksPlayer: true, isInteractable: true, interactionType: "safe" });
      addBox(`${interior.id}-garage-bench`, { width: 4.5, height: 0.9, depth: 1.1 },
        { x: center.x + width * 0.23, y: floorY + 0.45, z: center.z + depth * 0.24 }, accentMaterial,
        { blocksPlayer: true, isInteractable: true, interactionType: "garage-storage" });
    } else if (theme === "prison") {
      addBox(`${interior.id}-security-desk`, { width: width * 0.42, height: 1.0, depth: 1.0 },
        { x: center.x, y: floorY + 0.5, z: center.z + halfD * 0.25 }, secondaryMaterial,
        { blocksPlayer: true, isInteractable: true, interactionType: "prison-checkpoint" });
      for (let index = 0; index < 4; index++) {
        const x = center.x - width * 0.28 + (index % 2) * width * 0.48;
        const z = center.z - depth * 0.22 + Math.floor(index / 2) * depth * 0.37;
        addBox(`${interior.id}-cell-${index}`, { width: width * 0.19, height: 2.5, depth: 0.18 },
          { x, y: floorY + 1.25, z }, wallMaterial,
          { blocksPlayer: true, isPrisonCell: true, restrictedArea: true });
      }
    } else {
      addBox(`${interior.id}-service-counter`, { width: width * 0.42, height: 1.0, depth: 1.0 },
        { x: center.x, y: floorY + 0.5, z: center.z + halfD * 0.3 }, secondaryMaterial,
        { blocksPlayer: true, isInteractable: true, interactionType: "service-counter" });
      addBox(`${interior.id}-seating`, { width: 4.2, height: 0.7, depth: 1.3 },
        { x: center.x - width * 0.22, y: floorY + 0.35, z: center.z - depth * 0.12 }, wallMaterial,
        { blocksPlayer: false, isInteractable: true, interactionType: "seat" });
    }

    interior.loaded = true;
    interior.createdAt = new Date().toISOString();
    interior.audioZone = { ...(interior.audioZone || {}), interiorId: interior.id };

    // Interiors remain disabled until the player actually enters.
    for (const mesh of interior.renderMeshes) {
      mesh.setEnabled(false);
    }
    for (const light of interior.lights) light.setEnabled(false);

    return { ok: true, interiorId: interior.id, meshCount: interior.renderMeshes.length };
  }

  function setInteriorActive(interior, active) {
    interior.active = Boolean(active);
    const chunk = chunks.get(interior.worldChunk);
    const chunkActive = Boolean(chunk?.active);

    for (const mesh of interior.shellMeshes) {
      if (!mesh || mesh.isDisposed()) continue;
      mesh.setEnabled(chunkActive && !interior.active);
    }
    for (const mesh of interior.renderMeshes) {
      if (!mesh || mesh.isDisposed()) continue;
      mesh.setEnabled(chunkActive && interior.active);
    }
    for (const light of interior.lights) {
      light.setEnabled(chunkActive && interior.active);
    }
  }

  function enterInterior(id, characterPosition) {
    const interior = getInterior(id);
    if (!interior) return { ok: false, message: "Unknown interior." };
    if (interior.active) return { ok: false, message: "Interior is already active." };
    if (!characterPosition || !Number.isFinite(characterPosition.x) || !Number.isFinite(characterPosition.z)) {
      return { ok: false, message: "Invalid character position." };
    }

    const distance = Math.hypot(
      characterPosition.x - interior.entryPosition.x,
      characterPosition.z - interior.entryPosition.z
    );
    if (distance > 5.5) {
      return { ok: false, message: "Entry point is too far away." };
    }

    if (!interior.loaded) {
      const loaded = createInteriorRoom(interior);
      if (!loaded.ok) return loaded;
    }

    setInteriorActive(interior, true);
    const position = interior.spawnPosition ?? {
      x: interior.interiorPosition.x,
      y: WORLD_CONFIG.baseGroundY + 0.9,
      z: interior.interiorPosition.z
    };

    runtime.events.emit("world:interiorEntered", {
      interiorId: interior.id,
      buildingId: interior.buildingId,
      locationId: interior.locationId,
      position: { ...position },
      audioZone: { ...interior.audioZone },
      interactionPoints: interior.interactionPoints.map(point => ({ ...point }))
    });

    return { ok: true, interiorId: interior.id, position: { ...position }, audioZone: { ...interior.audioZone } };
  }

  function exitInterior(id) {
    const interior = getInterior(id);
    if (!interior || !interior.active) {
      return { ok: false, message: "No active interior." };
    }

    setInteriorActive(interior, false);
    const position = { ...interior.exitPosition };

    runtime.events.emit("world:interiorExited", {
      interiorId: id,
      buildingId: interior.buildingId,
      locationId: interior.locationId,
      position,
      audioZone: { reverb: 0, lowPass: 0 }
    });

    return { ok: true, position };
  }

  function setChunkActive(key, active) {
    const chunk = chunks.get(key);
    if (!chunk || chunk.active === active) return;

    chunk.active = active;
    chunk.lastActivated = performance.now() / 1000;

    for (const mesh of chunk.meshes) {
      if (mesh.isDisposed()) continue;

      const metadata = mesh.metadata ?? {};
      const exteriorInteriorId = metadata.interiorExteriorId;
      const interiorGeometryId = metadata.interiorId;

      if (exteriorInteriorId) {
        const interior = interiors.get(exteriorInteriorId);
        mesh.setEnabled(active && !interior?.active);
      } else if (metadata.isInteriorGeometry && interiorGeometryId) {
        const interior = interiors.get(interiorGeometryId);
        mesh.setEnabled(active && Boolean(interior?.active));
      } else {
        mesh.setEnabled(active);
      }
    }

    for (const interior of interiors.values()) {
      if (interior.worldChunk !== key) continue;
      for (const light of interior.lights) {
        light.setEnabled(active && interior.active);
      }
    }

    runtime.events.emit(
      active ? "world:chunkLoaded" : "world:chunkUnloaded",
      { chunkId: key }
    );
  }

  function updateChunkStreaming() {
    const center = camera.globalPosition || camera.position;

    const gridX = Math.floor(
      (center.x - originX) / WORLD_CONFIG.gridSpacingM
    );

    const gridZ = Math.floor(
      (center.z - originZ) / WORLD_CONFIG.gridSpacingM
    );

    const currentCell = { x: gridX, z: gridZ };

    if (
      lastStreamCell &&
      lastStreamCell.x === currentCell.x &&
      lastStreamCell.z === currentCell.z
    ) {
      return;
    }

    lastStreamCell = currentCell;

    const nextKeys = new Set();
    const radius = WORLD_CONFIG.terrainChunkRadius;
    const maxX = WORLD_CONFIG.gridColumns - 2;
    const maxZ = WORLD_CONFIG.gridRows - 2;

    for (let x = gridX - radius; x <= gridX + radius; x++) {
      for (let z = gridZ - radius; z <= gridZ + radius; z++) {
        if (x < 0 || z < 0 || x > maxX || z > maxZ) continue;

        // Avoid rectangular streaming boundaries by using a circular
        // neighborhood for the outer ring.
        const dx = x - gridX;
        const dz = z - gridZ;
        if (dx * dx + dz * dz > radius * radius + 1) continue;

        nextKeys.add(`${x}:${z}`);
      }
    }

    for (const key of activeChunkKeys) {
      if (!nextKeys.has(key)) setChunkActive(key, false);
    }

    for (const key of nextKeys) {
      setChunkActive(key, true);
    }

    activeChunkKeys = nextKeys;
  }

  function getMapLocations() {
    return [...worldEntities.values()]
      .filter(entity => entity.isMapLocation === true)
      .map(entity => ({
        id: entity.id,
        name: entity.name,
        type: entity.type,
        category: entity.category ?? "location",
        marker: entity.marker ?? "location",
        region: entity.region,
        x: entity.position.x,
        y: entity.position.y,
        z: entity.position.z,
        interiorId: entity.interiorId ?? null,
        shopType: entity.shopType ?? null,
        interactionRadiusM: entity.interactionRadiusM ?? 6
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function getMapLocation(id) {
    const entity = worldEntities.get(id);
    if (!entity || entity.isMapLocation !== true) return null;
    return getMapLocations().find(location => location.id === id) ?? null;
  }

  function interactWithLocation(id, characterPosition) {
    const location = worldEntities.get(id);
    if (!location || location.isMapLocation !== true) {
      return { ok: false, message: `Unknown world location: ${id}` };
    }
    if (!characterPosition || !Number.isFinite(characterPosition.x) || !Number.isFinite(characterPosition.z)) {
      return { ok: false, message: "A valid character position is required." };
    }

    const distance = Math.hypot(
      characterPosition.x - location.position.x,
      characterPosition.z - location.position.z
    );
    if (distance > (location.interactionRadiusM ?? 6.5) + Math.max(location.dimensions?.width ?? 0, location.dimensions?.depth ?? 0) / 2) {
      return { ok: false, message: "Location is too far away." };
    }

    const payload = {
      locationId: location.id,
      name: location.name,
      kind: location.type,
      shopType: location.shopType ?? null,
      position: { x: location.position.x, y: location.position.y, z: location.position.z },
      interiorId: location.interiorId ?? null,
      requestedAt: new Date().toISOString()
    };

    runtime.events.emit("world:locationInteracted", payload);
    if (location.shopType) runtime.events.emit("world:shopInteractionRequested", payload);
    return { ok: true, location: payload };
  }

  function interactWithInteriorPoint(interiorId, pointId, characterPosition) {
    const interior = interiors.get(interiorId);
    if (!interior || !interior.active) {
      return { ok: false, message: "The requested interior is not active." };
    }
    const point = interior.interactionPoints.find(item => item.id === pointId);
    if (!point) return { ok: false, message: `Unknown interior interaction: ${pointId}` };
    if (!characterPosition || !Number.isFinite(characterPosition.x) || !Number.isFinite(characterPosition.z)) {
      return { ok: false, message: "A valid character position is required." };
    }
    const distance = Math.hypot(
      characterPosition.x - point.position.x,
      characterPosition.z - point.position.z
    );
    if (distance > 3.8) return { ok: false, message: "Interaction point is too far away." };

    const payload = {
      interiorId,
      locationId: interior.locationId ?? interior.buildingId,
      interactionId: point.id,
      interactionType: point.type,
      restrictedArea: point.restrictedArea === true,
      isVIPArea: point.isVIPArea === true,
      position: { ...point.position },
      requestedAt: new Date().toISOString()
    };
    runtime.events.emit("world:interiorInteractionRequested", payload);
    if (point.type === "weapon-purchase-counter") {
      runtime.events.emit("world:weaponShopInteractionRequested", payload);
    } else if (point.type === "vehicle-sales-desk" || point.type === "vehicle-display") {
      runtime.events.emit("world:vehicleDealerInteractionRequested", payload);
    }
    return { ok: true, interaction: payload };
  }

  function getRoadNetworkSnapshot() {
    return {
      nodeCount: nodes.size,
      edgeCount: edges.size,
      chunkCount: chunks.size,
      activeChunks: activeChunkKeys.size,
      buildings: buildings.size,
      entityCount: worldEntities.size,
      spatialEntities: grid.size
    };
  }

  function updateRoadSurfaceWetness(wetness) {
    const value = clamp(wetness, 0, 1);

    for (const material of surfaceMaterials) {
      graphics?.setMaterialWetness?.(material, value);
    }

    for (const edge of edges.values()) {
      edge.wetness = value;
    }
  }

  async function initialize() {
    if (initialized) return { ok: true };

    initialized = true;

    // World generation is deterministic for a given seed.
    createStreetNetwork();
    createTerrainAndBuildings();
    createVegetation();
    createNamedLandmarks();

    const worldService = {
      getNodes: () => [...nodes.values()],
      getEdges: () => [...edges.values()],
      getNode: id => nodes.get(id) ?? null,
      getEdge: getRoadEdge,

      findRoute,
      findRouteBetweenPositions,
      nearestRoadNode,
      closestPointOnRoad,
      sampleGroundHeight,

      setRoadBlocked,
      registerEntity: registerWorldEntity,
      unregisterEntity: unregisterWorldEntity,
      queryEntities: (position, radius) => {
        spatialQueryCount++;
        return grid.queryRadius(position, radius);
      },

      riverZ,
      distanceToRiver,
      regionAt,
      chunkKeyForPosition,

      getInterior,
      registerInterior,
      enterInterior,
      exitInterior,
      getMapLocations,
      getMapLocation,
      interactWithLocation,
      interactWithInteriorPoint,
      getShopLocations: () => getMapLocations().filter(location => location.shopType),
      getStripClubs: () => getMapLocations().filter(location => location.type === "stripclub"),
      getSnapshot: getRoadNetworkSnapshot
    };

    serviceDisposers.push(
      runtime.services.register("world", worldService)
    );

    serviceDisposers.push(
      runtime.services.register("roads", worldService)
    );

    serviceDisposers.push(
      runtime.services.register("worldLocations", worldService)
    );

    serviceDisposers.push(
      runtime.services.register("worldMapData", worldService)
    );

    eventDisposers.push(
      runtime.events.on("weather:environmentImpact", payload => {
        if (Number.isFinite(payload.wetness)) {
          updateRoadSurfaceWetness(payload.wetness);
        }
      })
    );

    eventDisposers.push(
      runtime.events.on("world:roadBlockChanged", () => {
        runtime.events.emit("navigation:invalidateRoutes", {
          reason: "road-network-changed"
        });
      })
    );

    updateChunkStreaming();

    runtime.events.emit("world:mapLocationsReady", {
      locations: getMapLocations(),
      source: "world-architecture"
    });

    logger.info("Procedural world architecture initialized.", {
      ...getRoadNetworkSnapshot(),
      mapLocations: getMapLocations().length,
      shops: getMapLocations().filter(location => location.shopType).length,
      stripClubs: getMapLocations().filter(location => location.type === "stripclub").length
    });

    return { ok: true };
  }

  function start() {
    running = true;
    updateChunkStreaming();
    return { ok: true };
  }

  function update(context) {
    if (!initialized || !running || disposed) return;

    // Visibility / activation streaming is based on the shared camera.
    // The static road graph remains stable while chunks change state.
    updateChunkStreaming();

    if (context.simulationTime % 8 < context.simulationDeltaSeconds) {
      runtime.events.emit("world:diagnostics", getRoadNetworkSnapshot());
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
      try { off(); } catch (error) {
        logger.warn("World event cleanup failed.", error);
      }
    }

    for (const off of serviceDisposers.splice(0)) {
      try { off(); } catch (error) {
        logger.warn("World service cleanup failed.", error);
      }
    }

    for (const interior of interiors.values()) {
      for (const light of interior.lights) {
        try { light.dispose(); } catch (error) {
          logger.warn("Interior light cleanup failed.", error);
        }
      }
      for (const node of interior.nodes ?? []) {
        try { node.dispose(false, false); } catch (error) {
          logger.warn("Interior transform cleanup failed.", error);
        }
      }
    }

    for (const mesh of meshes) {
      if (!mesh.isDisposed()) mesh.dispose(false, true);
    }

    for (const material of surfaceMaterials) {
      try { material.dispose(); } catch {}
    }

    for (const material of buildingPalette) {
      try { material.dispose(); } catch {}
    }

    grid.clear();

    nodes.clear();
    edges.clear();
    adjacency.clear();
    chunks.clear();
    worldEntities.clear();
    buildings.clear();
    interiors.clear();
    meshes.clear();
    surfaceMaterials.clear();
    activeChunkKeys.clear();
  }

  return Object.freeze({
    initialize,
    start,
    update,
    stop,
    dispose,

    getSnapshot: getRoadNetworkSnapshot,
    findRoute,
    findRouteBetweenPositions,
    nearestRoadNode,
    closestPointOnRoad,
    sampleGroundHeight,
    setRoadBlocked,
    riverZ,
    regionAt,
    getMapLocations,
    getMapLocation,
    interactWithLocation,
    interactWithInteriorPoint,
    getInterior,
    enterInterior,
    exitInterior
  });
}
  function registerInterior(definition) {
    if (!definition?.id) return null;
    if (interiors.has(definition.id)) return interiors.get(definition.id);

    const entryPosition = definition.entryPosition;
    if (!entryPosition || !Number.isFinite(entryPosition.x) || !Number.isFinite(entryPosition.z)) {
      throw new TypeError(`Interior "${definition.id}" requires a valid entry position.`);
    }

    const record = {
      ...definition,
      active: false,
      audioZone: {
        reverb: definition.interiorTheme?.includes("club") || definition.kind === "stripclub" ? 0.68 : 0.28,
        lowPass: 0
      },
      collisionMeshes: [],
      renderMeshes: [],
      nodes: [],
      lights: [],
      interactionPoints: [],
      shellMeshes: Array.isArray(definition.shellMeshes) ? definition.shellMeshes : [],
      worldChunk: definition.worldChunk ?? chunkKeyForPosition(entryPosition.x, entryPosition.z),
      loaded: false
    };

    interiors.set(definition.id, record);
    return record;
  }

  function getInterior(id) {
    return interiors.get(id) ?? null;
  }

  function createInteriorRoom(interior) {
    if (!interior || interior.loaded) {
      return { ok: false, message: "Interior is missing or already loaded." };
    }

    const center = interior.interiorPosition ?? interior.spawnPosition ?? interior.entryPosition;
    const chunkKey = interior.worldChunk ?? chunkKeyForPosition(center.x, center.z);
    const width = Math.max(10, finite(interior.width, 15));
    const depth = Math.max(10, finite(interior.depth, 13));
    const height = Math.max(3.5, finite(interior.height, 4.2));
    const halfW = width / 2;
    const halfD = depth / 2;
    const wallT = 0.24;
    const floorY = WORLD_CONFIG.baseGroundY + 0.04;
    const baseMaterial = B.Color3.FromHexString(interior.accentColor ?? "#5fd4e5");

    const wallMaterial = graphics?.createPBRMaterial?.(`interior-${interior.id}-wall`, {
      albedo: interior.kind === "stripclub" ? "#23212d" : "#aba59a",
      metallic: interior.kind === "stripclub" ? 0.12 : 0,
      roughness: interior.kind === "stripclub" ? 0.55 : 0.92
    }) ?? materials.sidewalk;

    const floorMaterial = graphics?.createPBRMaterial?.(`interior-${interior.id}-floor`, {
      albedo: interior.kind === "stripclub" ? "#28232e" : "#6f716d",
      metallic: interior.kind === "stripclub" ? 0.16 : 0.02,
      roughness: interior.kind === "stripclub" ? 0.34 : 0.82
    }) ?? materials.sidewalk;

    const accentMaterial = graphics?.createPBRMaterial?.(`interior-${interior.id}-accent`, {
      albedo: interior.accentColor ?? "#5fd4e5",
      metallic: 0.25,
      roughness: 0.3,
      emissive: interior.accentColor ?? "#5fd4e5"
    }) ?? materials.yellowMarking;

    const secondaryMaterial = graphics?.createPBRMaterial?.(`interior-${interior.id}-secondary`, {
      albedo: interior.secondaryColor ?? "#f2bb70",
      metallic: 0.18,
      roughness: 0.4,
      emissive: interior.kind === "stripclub" ? (interior.secondaryColor ?? "#f2bb70") : "#000000"
    }) ?? materials.curb;

    for (const material of [wallMaterial, floorMaterial, accentMaterial, secondaryMaterial]) {
      if (material !== materials.sidewalk && material !== materials.yellowMarking && material !== materials.curb) {
        surfaceMaterials.add(material);
      }
    }

    function addInteriorMesh(mesh, name, material, metadata = {}) {
      mesh.name = name;
      mesh.material = material;
      mesh.isPickable = metadata.isInteractable === true || metadata.isWalkable === true;
      mesh.checkCollisions = metadata.blocksPlayer === true;

      mesh.metadata = {
        ...(mesh.metadata || {}),
        interiorId: interior.id,
        isInteriorGeometry: true,
        isWalkable: false,
        ...metadata
      };

      registerMesh(mesh, chunkKey);
      interior.renderMeshes.push(mesh);

      if (metadata.blocksPlayer) {
        interior.collisionMeshes.push(mesh);
      }

      if (metadata.isInteractable === true && metadata.interactionType) {
        const pointId = `${interior.id}:${name}`;

        if (!interior.interactionPoints.some(point => point.id === pointId)) {
          interior.interactionPoints.push({
            id: pointId,
            type: metadata.interactionType,
            position: {
              x: mesh.position.x,
              y: mesh.position.y,
              z: mesh.position.z
            },
            restrictedArea: metadata.restrictedArea === true,
            isVIPArea: metadata.isVIPArea === true
          });
        }
      }

      return mesh;
    }

    function addBox(name, size, position, material = wallMaterial, metadata = {}) {
      const mesh = B.MeshBuilder.CreateBox(name, size, scene);
      mesh.position.set(position.x, position.y, position.z);
      return addInteriorMesh(mesh, name, material, metadata);
    }

    function addCylinder(name, options, position, material, metadata = {}) {
      const mesh = B.MeshBuilder.CreateCylinder(name, options, scene);
      mesh.position.set(position.x, position.y, position.z);
      return addInteriorMesh(mesh, name, material, metadata);
    }

    const floor = B.MeshBuilder.CreateGround(`${interior.id}-floor`, {
      width: width - 0.5,
      height: depth - 0.5,
      subdivisions: 1
    }, scene);

    floor.position.set(center.x, floorY, center.z);

    addInteriorMesh(floor, `${interior.id}-floor`, floorMaterial, {
      isWalkable: true,
      isGroundSurface: true,
      surfaceType: "interior-floor"
    });

    const wallY = floorY + height / 2;

    addBox(`${interior.id}-north-wall`, { width, height, depth: wallT },
      { x: center.x, y: wallY, z: center.z - halfD }, wallMaterial,
      { blocksPlayer: true, interiorBoundary: true });

    addBox(`${interior.id}-south-wall`, { width, height, depth: wallT },
      { x: center.x, y: wallY, z: center.z + halfD }, wallMaterial,
      { blocksPlayer: true, interiorBoundary: true });

    addBox(`${interior.id}-west-wall`, { width: wallT, height, depth },
      { x: center.x - halfW, y: wallY, z: center.z }, wallMaterial,
      { blocksPlayer: true, interiorBoundary: true });

    // East wall leaves a deliberate doorway that aligns with the exterior side-door.
    const doorWidth = 2.7;
    const segment = Math.max(0.5, (depth - doorWidth) / 2);

    for (const side of [-1, 1]) {
      addBox(`${interior.id}-east-wall-${side}`, { width: wallT, height, depth: segment },
        { x: center.x + halfW, y: wallY,
          z: center.z + side * (doorWidth / 2 + segment / 2) }, wallMaterial,
        { blocksPlayer: true, interiorBoundary: true });
    }

    addBox(`${interior.id}-east-lintel`, { width: wallT, height: 0.55, depth: doorWidth },
      { x: center.x + halfW, y: floorY + height - 0.275, z: center.z }, wallMaterial,
      { blocksPlayer: true, interiorBoundary: true });

    // Perimeter lighting strips and suspended fixtures provide a defined interior light setup.
    addBox(`${interior.id}-led-north`, { width: width * 0.72, height: 0.09, depth: 0.08 },
      { x: center.x, y: floorY + height - 0.35, z: center.z - halfD + 0.22 }, accentMaterial,
      { blocksPlayer: false, isEmissiveLighting: true });

    addBox(`${interior.id}-led-south`, { width: width * 0.72, height: 0.09, depth: 0.08 },
      { x: center.x, y: floorY + height - 0.35, z: center.z + halfD - 0.22 }, secondaryMaterial,
      { blocksPlayer: false, isEmissiveLighting: true });

    const lightPositions = interior.kind === "stripclub"
      ? [
          { x: center.x - width * 0.24, y: floorY + height - 0.7, z: center.z - depth * 0.18, color: baseMaterial },
          { x: center.x + width * 0.22, y: floorY + height - 0.7, z: center.z + depth * 0.12, color: B.Color3.FromHexString(interior.secondaryColor ?? "#f2bb70") }
        ]
      : [
          {
            x: center.x,
            y: floorY + height - 0.6,
            z: center.z,
            color: new B.Color3(0.82, 0.87, 0.92)
          }
        ];

    lightPositions.forEach((spec, index) => {
      const light = new B.PointLight(
        `${interior.id}-light-${index}`,
        new B.Vector3(spec.x, spec.y, spec.z),
        scene
      );

      light.diffuse = spec.color;
      light.intensity = interior.kind === "stripclub" ? 0.7 : 0.55;
      light.range = Math.max(10, Math.min(width, depth) * 0.95);
      light.setEnabled(false);
      light.metadata = { interiorId: interior.id, audioZoneId: interior.id };
      interior.lights.push(light);
    });

    // Build non-empty, theme-specific functional spaces from procedural primitives.
    const theme = interior.interiorTheme ?? "generic";

    if (theme === "neon-palms" || theme === "velvet-current") {
      const stageWidth = Math.min(11, width * 0.28);
      const stageDepth = Math.min(5.5, depth * 0.19);
      const stageZ = center.z - halfD + stageDepth / 2 + 2.0;

      addBox(`${interior.id}-dance-stage`, {
        width: stageWidth,
        height: 0.42,
        depth: stageDepth
      }, {
        x: center.x,
        y: floorY + 0.22,
        z: stageZ
      }, secondaryMaterial, {
        blocksPlayer: false,
        isInteractable: true,
        interactionType: "dance-stage"
      });

      addCylinder(`${interior.id}-dance-pole`, {
        height: Math.max(2.2, height - 1.8),
        diameter: 0.11,
        tessellation: 12
      }, {
        x: center.x,
        y: floorY + Math.max(2.2, height - 1.8) / 2,
        z: stageZ
      }, accentMaterial, {
        blocksPlayer: false,
        isInteractable: true,
        interactionType: "dance-stage-prop"
      });

      // Bar counter and seating.
      addBox(`${interior.id}-bar-counter`, {
        width: width * 0.45,
        height: 1.1,
        depth: 1.3
      }, {
        x: center.x,
        y: floorY + 0.55,
        z: center.z + halfD - 3.0
      }, wallMaterial, {
        blocksPlayer: true,
        isInteractable: true,
        interactionType: "bar"
      });

      for (let index = 0; index < 5; index++) {
        const x = center.x - width * 0.31 + index * width * 0.155;

        addCylinder(`${interior.id}-bar-stool-${index}`, {
          height: 0.75,
          diameter: 0.58,
          tessellation: 10
        }, {
          x,
          y: floorY + 0.38,
          z: center.z + halfD - 4.8
        }, secondaryMaterial, {
          blocksPlayer: false,
          isInteractable: true,
          interactionType: "seat"
        });
      }

      for (let index = 0; index < 4; index++) {
        const x = center.x - width * 0.30 + (index % 2) * width * 0.28;
        const z = center.z + depth * 0.06 + Math.floor(index / 2) * depth * 0.19;

        addCylinder(`${interior.id}-lounge-table-${index}`, {
          height: 0.72,
          diameter: 1.0,
          tessellation: 12
        }, {
          x,
          y: floorY + 0.36,
          z
        }, accentMaterial, {
          blocksPlayer: false,
          isInteractable: true,
          interactionType: "lounge-table"
        });
      }

      // Two enclosed VIP suites. Each has rear/side partitions, a doorway gap,
      // an individual LED accent and an interaction point.
      for (let index = 0; index < 2; index++) {
        const vipX = center.x + (index === 0 ? -1 : 1) * width * 0.30;
        const vipZ = center.z + halfD * 0.18;
        const vipWidth = Math.min(width * 0.22, 10.5);
        const vipDepth = Math.min(depth * 0.22, 8.0);
        const vipHeight = Math.max(2.5, height * 0.66);
        const doorGap = 1.35;
        const vipFrontZ = vipZ + vipDepth / 2;

        addBox(`${interior.id}-vip-back-${index}`, {
          width: vipWidth,
          height: vipHeight,
          depth: 0.18
        }, {
          x: vipX,
          y: floorY + vipHeight / 2,
          z: vipZ - vipDepth / 2
        }, wallMaterial, {
          blocksPlayer: true,
          isVIPArea: true,
          vipSuiteIndex: index
        });

        addBox(`${interior.id}-vip-left-${index}`, {
          width: 0.18,
          height: vipHeight,
          depth: vipDepth
        }, {
          x: vipX - vipWidth / 2,
          y: floorY + vipHeight / 2,
          z: vipZ
        }, wallMaterial, {
          blocksPlayer: true,
          isVIPArea: true,
          vipSuiteIndex: index
        });

        addBox(`${interior.id}-vip-right-${index}`, {
          width: 0.18,
          height: vipHeight,
          depth: vipDepth
        }, {
          x: vipX + vipWidth / 2,
          y: floorY + vipHeight / 2,
          z: vipZ
        }, wallMaterial, {
          blocksPlayer: true,
          isVIPArea: true,
          vipSuiteIndex: index
        });

        const frontSegment = Math.max(0.3, (vipWidth - doorGap) / 2);

        for (const side of [-1, 1]) {
          addBox(`${interior.id}-vip-front-${index}-${side}`, {
            width: frontSegment,
            height: vipHeight,
            depth: 0.18
          }, {
            x: vipX + side * (doorGap / 2 + frontSegment / 2),
            y: floorY + vipHeight / 2,
            z: vipFrontZ
          }, wallMaterial, {
            blocksPlayer: true,
            isVIPArea: true,
            vipSuiteIndex: index
          });
        }

        addBox(`${interior.id}-vip-led-${index}`, {
          width: vipWidth * 0.82,
          height: 0.08,
          depth: 0.08
        }, {
          x: vipX,
          y: floorY + vipHeight - 0.25,
          z: vipZ - vipDepth / 2 + 0.18
        }, secondaryMaterial, {
          blocksPlayer: false,
          isVIPArea: true,
          isEmissiveLighting: true
        });

        addBox(`${interior.id}-vip-table-${index}`, {
          width: 2.2,
          height: 0.75,
          depth: 1.1
        }, {
          x: vipX,
          y: floorY + 0.38,
          z: vipZ + 0.5
        }, accentMaterial, {
          blocksPlayer: false,
          isInteractable: true,
          interactionType: "vip-room",
          isVIPArea: true
        });

        interior.interactionPoints.push({
          id: `${interior.id}-vip-${index}`,
          type: "vip-room",
          position: { x: vipX, y: floorY, z: vipZ },
          isVIPArea: true
        });
      }

      interior.audioZone = {
        reverb: 0.72,
        lowPass: 0.06,
        musicProfile: theme
      };

      interior.interactionPoints.push({
        id: `${interior.id}-stage`,
        type: "dance-stage",
        position: { x: center.x, y: floorY, z: stageZ }
      });

      interior.interactionPoints.push({
        id: `${interior.id}-bar`,
        type: "bar",
        position: {
          x: center.x,
          y: floorY,
          z: center.z + halfD - 3.0
        }
      });
    } else if (theme === "gunshop") {
      addBox(`${interior.id}-sales-counter`, {
        width: width * 0.55,
        height: 1.05,
        depth: 1.0
      }, {
        x: center.x,
        y: floorY + 0.525,
        z: center.z + halfD - 3.0
      }, secondaryMaterial, {
        blocksPlayer: true,
        isInteractable: true,
        interactionType: "weapon-purchase-counter"
      });

      for (let side = -1; side <= 1; side += 2) {
        for (let shelf = 0; shelf < 3; shelf++) {
          addBox(`${interior.id}-wall-rack-${side}-${shelf}`, {
            width: 0.24,
            height: 2.3,
            depth: width * 0.24
          }, {
            x: center.x + side * (halfW - 0.7),
            y: floorY + 1.5,
            z: center.z - depth * 0.18 + shelf * depth * 0.18
          }, wallMaterial, {
            blocksPlayer: true,
            isWeaponDisplayRack: true
          });

          addBox(`${interior.id}-weapon-display-${side}-${shelf}`, {
            width: 0.18,
            height: 0.11,
            depth: 1.5
          }, {
            x: center.x + side * (halfW - 0.53),
            y: floorY + 2.1,
            z: center.z - depth * 0.18 + shelf * depth * 0.18
          }, accentMaterial, {
            blocksPlayer: false,
            isWeaponDisplay: true,
            itemCategory: "weapon",
            displayOnly: true
          });
        }
      }

      addBox(`${interior.id}-glass-counter-top`, {
        width: width * 0.56,
        height: 0.08,
        depth: 1.15
      }, {
        x: center.x,
        y: floorY + 1.12,
        z: center.z + halfD - 3.0
      }, accentMaterial, {
        blocksPlayer: false,
        isWeaponDisplay: true
      });

      interior.audioZone = {
        reverb: 0.24,
        lowPass: 0.02,
        musicProfile: "retail"
      };

      interior.interactionPoints.push({
        id: `${interior.id}-counter`,
        type: "weapon-purchase-counter",
        position: {
          x: center.x,
          y: floorY,
          z: center.z + halfD - 3.0
        }
      });
    } else if (theme === "car-dealer" || theme === "auto-gallery") {
      const displayMaterial = theme === "auto-gallery" ? secondaryMaterial : accentMaterial;

      for (let index = 0; index < 3; index++) {
        const carX = center.x + (index - 1) * width * 0.27;
        const carZ = center.z - depth * 0.04;

        addBox(`${interior.id}-display-pad-${index}`, {
          width: width * 0.23,
          height: 0.16,
          depth: depth * 0.43
        }, {
          x: carX,
          y: floorY + 0.08,
          z: carZ
        }, displayMaterial, {
          blocksPlayer: false,
          isVehicleDisplayPad: true
        });

        // Procedural exhibition vehicles are visual scene objects, not owned/driveable vehicles.
        // The vehicle module must replace/catalogue them when real vehicle entities are registered.
        const carRoot = new B.TransformNode(
          `${interior.id}-display-vehicle-${index}`,
          scene
        );

        carRoot.position.set(carX, floorY + 0.24, carZ);
        interior.nodes.push(carRoot);

        const body = B.MeshBuilder.CreateBox(`${carRoot.name}-body`, {
          width: 3.7 + index * 0.18,
          height: 0.72,
          depth: 1.65
        }, scene);

        body.parent = carRoot;
        body.material = index === 1 ? secondaryMaterial : wallMaterial;
        body.metadata = {
          interiorId: interior.id,
          isInteriorGeometry: true,
          displayOnly: true,
          vehicleDisplayIndex: index
        };

        registerMesh(body, chunkKey);
        interior.renderMeshes.push(body);

        const cabin = B.MeshBuilder.CreateBox(`${carRoot.name}-cabin`, {
          width: 1.9,
          height: 0.72,
          depth: 1.25
        }, scene);

        cabin.parent = carRoot;
        cabin.position.set(-0.15, 0.66, 0);
        cabin.material = materials.window;
        cabin.metadata = {
          interiorId: interior.id,
          isInteriorGeometry: true,
          displayOnly: true,
          vehicleDisplayIndex: index
        };

        registerMesh(cabin, chunkKey);
        interior.renderMeshes.push(cabin);

        for (let wheel = 0; wheel < 4; wheel++) {
          const wheelMesh = B.MeshBuilder.CreateCylinder(`${carRoot.name}-wheel-${wheel}`, {
            height: 0.28,
            diameter: 0.62,
            tessellation: 12
          }, scene);

          wheelMesh.parent = carRoot;
          wheelMesh.rotation.z = Math.PI / 2;
          wheelMesh.position.set(
            wheel < 2 ? -1.15 : 1.15,
            -0.15,
            wheel % 2 === 0 ? -0.83 : 0.83
          );

          wheelMesh.material = materials.asphalt;
          wheelMesh.metadata = {
            interiorId: interior.id,
            isInteriorGeometry: true,
            displayOnly: true,
            vehicleDisplayIndex: index
          };

          registerMesh(wheelMesh, chunkKey);
          interior.renderMeshes.push(wheelMesh);
        }

        interior.interactionPoints.push({
          id: `${interior.id}-vehicle-${index}`,
          type: "vehicle-display",
          displayOnly: true,
          vehicleCatalogIndex: index,
          position: { x: carX, y: floorY, z: carZ }
        });
      }

      addBox(`${interior.id}-dealer-desk`, {
        width: 5.5,
        height: 1.1,
        depth: 1.2
      }, {
        x: center.x,
        y: floorY + 0.55,
        z: center.z + halfD - 2.5
      }, secondaryMaterial, {
        blocksPlayer: true,
        isInteractable: true,
        interactionType: "vehicle-sales-desk"
      });

      interior.audioZone = {
        reverb: 0.28,
        lowPass: 0.01,
        musicProfile: "showroom"
      };
    } else if (theme === "bank") {
      addBox(`${interior.id}-bank-counter`, {
        width: width * 0.58,
        height: 1.12,
        depth: 1.0
      }, {
        x: center.x,
        y: floorY + 0.56,
        z: center.z - halfD * 0.2
      }, secondaryMaterial, {
        blocksPlayer: true,
        isInteractable: true,
        interactionType: "bank-counter"
      });

      addBox(`${interior.id}-vault-door`, {
        width: 2.4,
        height: 2.6,
        depth: 0.26
      }, {
        x: center.x - halfW + 1.0,
        y: floorY + 1.3,
        z: center.z
      }, accentMaterial, {
        blocksPlayer: true,
        isInteractable: true,
        interactionType: "bank-security-door",
        restrictedArea: true
      });

      interior.audioZone = {
        reverb: 0.31,
        lowPass: 0.03,
        musicProfile: "public-interior"
      };
    } else if (theme === "hospital") {
      addBox(`${interior.id}-reception-desk`, {
        width: width * 0.42,
        height: 1.05,
        depth: 1.1
      }, {
        x: center.x,
        y: floorY + 0.525,
        z: center.z + halfD * 0.25
      }, secondaryMaterial, {
        blocksPlayer: true,
        isInteractable: true,
        interactionType: "hospital-reception"
      });

      for (let index = 0; index < 3; index++) {
        const bedX = center.x - width * 0.28 + index * width * 0.28;

        addBox(`${interior.id}-bed-frame-${index}`, {
          width: 2.1,
          height: 0.4,
          depth: 3.2
        }, {
          x: bedX,
          y: floorY + 0.2,
          z: center.z - halfD * 0.3
        }, wallMaterial, {
          blocksPlayer: false,
          isInteractable: true,
          interactionType: "hospital-bed"
        });

        addBox(`${interior.id}-bed-mattress-${index}`, {
          width: 2.0,
          height: 0.18,
          depth: 3.0
        }, {
          x: bedX,
          y: floorY + 0.48,
          z: center.z - halfD * 0.3
        }, materials.window, {
          blocksPlayer: false
        });
      }

      interior.audioZone = {
        reverb: 0.32,
        lowPass: 0.02,
        musicProfile: "hospital"
      };
    } else if (theme === "villa") {
      addBox(`${interior.id}-living-sofa`, {
        width: 5.0,
        height: 0.8,
        depth: 1.4
      }, {
        x: center.x - width * 0.18,
        y: floorY + 0.4,
        z: center.z + depth * 0.12
      }, secondaryMaterial, {
        blocksPlayer: false,
        isInteractable: true,
        interactionType: "seat"
      });

      addBox(`${interior.id}-safe`, {
        width: 1.2,
        height: 1.7,
        depth: 0.8
      }, {
        x: center.x + width * 0.28,
        y: floorY + 0.85,
        z: center.z - depth * 0.22
      }, wallMaterial, {
        blocksPlayer: true,
        isInteractable: true,
        interactionType: "safe"
      });

      addBox(`${interior.id}-garage-bench`, {
        width: 4.5,
        height: 0.9,
        depth: 1.1
      }, {
        x: center.x + width * 0.23,
        y: floorY + 0.45,
        z: center.z + depth * 0.24
      }, accentMaterial, {
        blocksPlayer: true,
        isInteractable: true,
        interactionType: "garage-storage"
      });
    } else if (theme === "prison") {
      addBox(`${interior.id}-security-desk`, {
        width: width * 0.42,
        height: 1.0,
        depth: 1.0
      }, {
        x: center.x,
        y: floorY + 0.5,
        z: center.z + halfD * 0.25
      }, secondaryMaterial, {
        blocksPlayer: true,
        isInteractable: true,
        interactionType: "prison-checkpoint"
      });

      for (let index = 0; index < 4; index++) {
        const x = center.x - width * 0.28 + (index % 2) * width * 0.48;
        const z = center.z - depth * 0.22 + Math.floor(index / 2) * depth * 0.37;

        addBox(`${interior.id}-cell-${index}`, {
          width: width * 0.19,
          height: 2.5,
          depth: 0.18
        }, {
          x,
          y: floorY + 1.25,
          z
        }, wallMaterial, {
          blocksPlayer: true,
          isPrisonCell: true,
          restrictedArea: true
        });
      }
    } else {
      addBox(`${interior.id}-service-counter`, {
        width: width * 0.42,
        height: 1.0,
        depth: 1.0
      }, {
        x: center.x,
        y: floorY + 0.5,
        z: center.z + halfD * 0.3
      }, secondaryMaterial, {
        blocksPlayer: true,
        isInteractable: true,
        interactionType: "service-counter"
      });

      addBox(`${interior.id}-seating`, {
        width: 4.2,
        height: 0.7,
        depth: 1.3
      }, {
        x: center.x - width * 0.22,
        y: floorY + 0.35,
        z: center.z - depth * 0.12
      }, wallMaterial, {
        blocksPlayer: false,
        isInteractable: true,
        interactionType: "seat"
      });
    }

    interior.loaded = true;
    interior.createdAt = new Date().toISOString();
    interior.audioZone = { ...(interior.audioZone || {}), interiorId: interior.id };

    // Interiors remain disabled until the player actually enters.
    for (const mesh of interior.renderMeshes) {
      mesh.setEnabled(false);
    }

    for (const light of interior.lights) {
      light.setEnabled(false);
    }

    return {
      ok: true,
      interiorId: interior.id,
      meshCount: interior.renderMeshes.length
    };
  }

  function setInteriorActive(interior, active) {
    interior.active = Boolean(active);

    const chunk = chunks.get(interior.worldChunk);
    const chunkActive = Boolean(chunk?.active);

    for (const mesh of interior.shellMeshes) {
      if (!mesh || mesh.isDisposed()) continue;
      mesh.setEnabled(chunkActive && !interior.active);
    }

    for (const mesh of interior.renderMeshes) {
      if (!mesh || mesh.isDisposed()) continue;
      mesh.setEnabled(chunkActive && interior.active);
    }

    for (const light of interior.lights) {
      light.setEnabled(chunkActive && interior.active);
    }
  }

  function enterInterior(id, characterPosition) {
    const interior = getInterior(id);
    if (!interior) return { ok: false, message: "Unknown interior." };
    if (interior.active) return { ok: false, message: "Interior is already active." };

    if (!characterPosition ||
        !Number.isFinite(characterPosition.x) ||
        !Number.isFinite(characterPosition.z)) {
      return { ok: false, message: "Invalid character position." };
    }

    const distance = Math.hypot(
      characterPosition.x - interior.entryPosition.x,
      characterPosition.z - interior.entryPosition.z
    );

    if (distance > 5.5) {
      return { ok: false, message: "Entry point is too far away." };
    }

    if (!interior.loaded) {
      const loaded = createInteriorRoom(interior);
      if (!loaded.ok) return loaded;
    }

    setInteriorActive(interior, true);

    const position = interior.spawnPosition ?? {
      x: interior.interiorPosition.x,
      y: WORLD_CONFIG.baseGroundY + 0.9,
      z: interior.interiorPosition.z
    };

    runtime.events.emit("world:interiorEntered", {
      interiorId: interior.id,
      buildingId: interior.buildingId,
      locationId: interior.locationId,
      position: { ...position },
      audioZone: { ...interior.audioZone },
      interactionPoints: interior.interactionPoints.map(point => ({ ...point }))
    });

    return {
      ok: true,
      interiorId: interior.id,
      position: { ...position },
      audioZone: { ...interior.audioZone }
    };
  }

  function exitInterior(id) {
    const interior = getInterior(id);

    if (!interior || !interior.active) {
      return { ok: false, message: "No active interior." };
    }

    setInteriorActive(interior, false);

    const position = { ...interior.exitPosition };

    runtime.events.emit("world:interiorExited", {
      interiorId: id,
      buildingId: interior.buildingId,
      locationId: interior.locationId,
      position,
      audioZone: { reverb: 0, lowPass: 0 }
    });

    return { ok: true, position };
  }

  function setChunkActive(key, active) {
    const chunk = chunks.get(key);
    if (!chunk || chunk.active === active) return;

    chunk.active = active;
    chunk.lastActivated = performance.now() / 1000;

    for (const mesh of chunk.meshes) {
      if (mesh.isDisposed()) continue;

      const metadata = mesh.metadata ?? {};
      const exteriorInteriorId = metadata.interiorExteriorId;
      const interiorGeometryId = metadata.interiorId;

      if (exteriorInteriorId) {
        const interior = interiors.get(exteriorInteriorId);
        mesh.setEnabled(active && !interior?.active);
      } else if (metadata.isInteriorGeometry && interiorGeometryId) {
        const interior = interiors.get(interiorGeometryId);
        mesh.setEnabled(active && Boolean(interior?.active));
      } else {
        mesh.setEnabled(active);
      }
    }

    for (const interior of interiors.values()) {
      if (interior.worldChunk !== key) continue;
      for (const light of interior.lights) {
        light.setEnabled(active && interior.active);
      }
    }

    runtime.events.emit(
      active ? "world:chunkLoaded" : "world:chunkUnloaded",
      { chunkId: key }
    );
  }

  function updateChunkStreaming() {
    const center = camera.globalPosition || camera.position;

    const gridX = Math.floor(
      (center.x - originX) / WORLD_CONFIG.gridSpacingM
    );

    const gridZ = Math.floor(
      (center.z - originZ) / WORLD_CONFIG.gridSpacingM
    );

    const currentCell = { x: gridX, z: gridZ };

    if (
      lastStreamCell &&
      lastStreamCell.x === currentCell.x &&
      lastStreamCell.z === currentCell.z
    ) {
      return;
    }

    lastStreamCell = currentCell;

    const nextKeys = new Set();
    const radius = WORLD_CONFIG.terrainChunkRadius;
    const maxX = WORLD_CONFIG.gridColumns - 2;
    const maxZ = WORLD_CONFIG.gridRows - 2;

    for (let x = gridX - radius; x <= gridX + radius; x++) {
      for (let z = gridZ - radius; z <= gridZ + radius; z++) {
        if (x < 0 || z < 0 || x > maxX || z > maxZ) continue;

        // Avoid rectangular streaming boundaries by using a circular
        // neighborhood for the outer ring.
        const dx = x - gridX;
        const dz = z - gridZ;

        if (dx * dx + dz * dz > radius * radius + 1) continue;

        nextKeys.add(`${x}:${z}`);
      }
    }

    for (const key of activeChunkKeys) {
      if (!nextKeys.has(key)) setChunkActive(key, false);
    }

    for (const key of nextKeys) {
      setChunkActive(key, true);
    }

    activeChunkKeys = nextKeys;
  }

  function getMapLocations() {
    return [...worldEntities.values()]
      .filter(entity => entity.isMapLocation === true)
      .map(entity => ({
        id: entity.id,
        name: entity.name,
        type: entity.type,
        category: entity.category ?? "location",
        marker: entity.marker ?? "location",
        region: entity.region,
        x: entity.position.x,
        y: entity.position.y,
        z: entity.position.z,
        interiorId: entity.interiorId ?? null,
        shopType: entity.shopType ?? null,
        interactionRadiusM: entity.interactionRadiusM ?? 6
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function getMapLocation(id) {
    const entity = worldEntities.get(id);
    if (!entity || entity.isMapLocation !== true) return null;

    return getMapLocations().find(location => location.id === id) ?? null;
  }

  function interactWithLocation(id, characterPosition) {
    const location = worldEntities.get(id);

    if (!location || location.isMapLocation !== true) {
      return { ok: false, message: `Unknown world location: ${id}` };
    }

    if (!characterPosition ||
        !Number.isFinite(characterPosition.x) ||
        !Number.isFinite(characterPosition.z)) {
      return { ok: false, message: "A valid character position is required." };
    }

    const distance = Math.hypot(
      characterPosition.x - location.position.x,
      characterPosition.z - location.position.z
    );

    if (distance > (location.interactionRadiusM ?? 6.5) +
        Math.max(location.dimensions?.width ?? 0, location.dimensions?.depth ?? 0) / 2) {
      return { ok: false, message: "Location is too far away." };
    }

    const payload = {
      locationId: location.id,
      name: location.name,
      kind: location.type,
      shopType: location.shopType ?? null,
      position: {
        x: location.position.x,
        y: location.position.y,
        z: location.position.z
      },
      interiorId: location.interiorId ?? null,
      requestedAt: new Date().toISOString()
    };

    runtime.events.emit("world:locationInteracted", payload);

    if (location.shopType) {
      runtime.events.emit("world:shopInteractionRequested", payload);
    }

    return { ok: true, location: payload };
  }

  function interactWithInteriorPoint(interiorId, pointId, characterPosition) {
    const interior = interiors.get(interiorId);

    if (!interior || !interior.active) {
      return { ok: false, message: "The requested interior is not active." };
    }

    const point = interior.interactionPoints.find(item => item.id === pointId);

    if (!point) {
      return { ok: false, message: `Unknown interior interaction: ${pointId}` };
    }

    if (!characterPosition ||
        !Number.isFinite(characterPosition.x) ||
        !Number.isFinite(characterPosition.z)) {
      return { ok: false, message: "A valid character position is required." };
    }

    const distance = Math.hypot(
      characterPosition.x - point.position.x,
      characterPosition.z - point.position.z
    );

    if (distance > 3.8) {
      return { ok: false, message: "Interaction point is too far away." };
    }

    const payload = {
      interiorId,
      locationId: interior.locationId ?? interior.buildingId,
      interactionId: point.id,
      interactionType: point.type,
      restrictedArea: point.restrictedArea === true,
      isVIPArea: point.isVIPArea === true,
      position: { ...point.position },
      requestedAt: new Date().toISOString()
    };

    runtime.events.emit("world:interiorInteractionRequested", payload);

    if (point.type === "weapon-purchase-counter") {
      runtime.events.emit("world:weaponShopInteractionRequested", payload);
    } else if (point.type === "vehicle-sales-desk" || point.type === "vehicle-display") {
      runtime.events.emit("world:vehicleDealerInteractionRequested", payload);
    }

    return { ok: true, interaction: payload };
  }

  function getRoadNetworkSnapshot() {
    return {
      nodeCount: nodes.size,
      edgeCount: edges.size,
      chunkCount: chunks.size,
      activeChunks: activeChunkKeys.size,
      buildings: buildings.size,
      entityCount: worldEntities.size,
      spatialEntities: grid.size
    };
  }

  function updateRoadSurfaceWetness(wetness) {
    const value = clamp(wetness, 0, 1);

    for (const material of surfaceMaterials) {
      graphics?.setMaterialWetness?.(material, value);
    }

    for (const edge of edges.values()) {
      edge.wetness = value;
    }
  }

  async function initialize() {
    if (initialized) return { ok: true };

    initialized = true;

    // World generation is deterministic for a given seed.
    createStreetNetwork();
    createTerrainAndBuildings();
    createVegetation();
    createNamedLandmarks();

    const worldService = {
      getNodes: () => [...nodes.values()],
      getEdges: () => [...edges.values()],
      getNode: id => nodes.get(id) ?? null,
      getEdge: getRoadEdge,

      findRoute,
      findRouteBetweenPositions,
      nearestRoadNode,
      closestPointOnRoad,
      sampleGroundHeight,

      setRoadBlocked,
      registerEntity: registerWorldEntity,
      unregisterEntity: unregisterWorldEntity,
      queryEntities: (position, radius) => {
        spatialQueryCount++;
        return grid.queryRadius(position, radius);
      },

      riverZ,
      distanceToRiver,
      regionAt,
      chunkKeyForPosition,

      getInterior,
      registerInterior,
      enterInterior,
      exitInterior,
      getMapLocations,
      getMapLocation,
      interactWithLocation,
      interactWithInteriorPoint,

      getShopLocations: () => getMapLocations().filter(location => location.shopType),
      getStripClubs: () => getMapLocations().filter(location => location.type === "stripclub"),
      getSnapshot: getRoadNetworkSnapshot
    };

    serviceDisposers.push(
      runtime.services.register("world", worldService)
    );

    serviceDisposers.push(
      runtime.services.register("roads", worldService)
    );

    serviceDisposers.push(
      runtime.services.register("worldLocations", worldService)
    );

    serviceDisposers.push(
      runtime.services.register("worldMapData", worldService)
    );

    eventDisposers.push(
      runtime.events.on("weather:environmentImpact", payload => {
        if (Number.isFinite(payload.wetness)) {
          updateRoadSurfaceWetness(payload.wetness);
        }
      })
    );

    eventDisposers.push(
      runtime.events.on("world:roadBlockChanged", () => {
        runtime.events.emit("navigation:invalidateRoutes", {
          reason: "road-network-changed"
        });
      })
    );

    updateChunkStreaming();

    runtime.events.emit("world:mapLocationsReady", {
      locations: getMapLocations(),
      source: "world-architecture"
    });

    logger.info("Procedural world architecture initialized.", {
      ...getRoadNetworkSnapshot(),
      mapLocations: getMapLocations().length,
      shops: getMapLocations().filter(location => location.shopType).length,
      stripClubs: getMapLocations().filter(location => location.type === "stripclub").length
    });

    return { ok: true };
  }

  function start() {
    running = true;
    updateChunkStreaming();
    return { ok: true };
  }

  function update(context) {
    if (!initialized || !running || disposed) return;

    // Visibility / activation streaming is based on the shared camera.
    // The static road graph remains stable while chunks change state.
    updateChunkStreaming();

    if (context.simulationTime % 8 < context.simulationDeltaSeconds) {
      runtime.events.emit("world:diagnostics", getRoadNetworkSnapshot());
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
      try {
        off();
      } catch (error) {
        logger.warn("World event cleanup failed.", error);
      }
    }

    for (const off of serviceDisposers.splice(0)) {
      try {
        off();
      } catch (error) {
        logger.warn("World service cleanup failed.", error);
      }
    }

    for (const interior of interiors.values()) {
      for (const light of interior.lights) {
        try {
          light.dispose();
        } catch (error) {
          logger.warn("Interior light cleanup failed.", error);
        }
      }

      for (const node of interior.nodes ?? []) {
        try {
          node.dispose(false, false);
        } catch (error) {
          logger.warn("Interior transform cleanup failed.", error);
        }
      }
    }

    for (const mesh of meshes) {
      if (!mesh.isDisposed()) mesh.dispose(false, true);
    }

    for (const material of surfaceMaterials) {
      try {
        material.dispose();
      } catch {}
    }

    for (const material of buildingPalette) {
      try {
        material.dispose();
      } catch {}
    }

    grid.clear();

    nodes.clear();
    edges.clear();
    adjacency.clear();
    chunks.clear();
    worldEntities.clear();
    buildings.clear();
    interiors.clear();
    meshes.clear();
    surfaceMaterials.clear();
    activeChunkKeys.clear();
  }

  return Object.freeze({
    initialize,
    start,
    update,
    stop,
    dispose,

    getSnapshot: getRoadNetworkSnapshot,
    findRoute,
    findRouteBetweenPositions,
    nearestRoadNode,
    closestPointOnRoad,
    sampleGroundHeight,
    setRoadBlocked,
    riverZ,
    regionAt,
    getMapLocations,
    getMapLocation,
    interactWithLocation,
    interactWithInteriorPoint,
    getInterior,
    enterInterior,
    exitInterior
  });
}
