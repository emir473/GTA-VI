/*
 * Module 11: stadt_luftfahrt_marine.js
 * Services: aviation, marine, publicTransport, militaryZones.
 *
 * Uses shared Babylon scene, world, water, weather and vehicle services.
 * Aircraft use a custom flight-dynamics approximation.
 * A certified full-scale flight simulator or airport ATC system is not
 * claimed; all flight scheduling and restricted-zone behavior is in-game.
 */

const AVIATION_CONFIG = Object.freeze({
  gameSecondsBetweenFlights: 600,

  gravityMps2: 9.81,
  seaLevelAirDensityKgM3: 1.225,

  runwayLengthM: 820,
  runwayWidthM: 42,

  departureStallBufferMps: 11,
  defaultCruiseAltitudeM: 2400,
  defaultApproachSpeedMps: 65,

  npcPassengerVisualBudget: 36
});

const AIRCRAFT_CLASSES = Object.freeze({
  commuter: {
    massKg: 22800,
    wingAreaM2: 84,
    maxThrustN: 78000,
    stallSpeedMps: 45,
    rotationSpeedMps: 56,
    cruiseSpeedMps: 125,
    landingSpeedMps: 48,
    maxFuelKg: 4600,
    maxBankRad: 0.67,
    maxPitchRad: 0.30,
    rollRateRadS: 0.48,
    pitchRateRadS: 0.25,
    dragCoefficient: 0.036,
    frontalAreaM2: 20,
    type: "fixed-wing"
  },

  airliner: {
    massKg: 66500,
    wingAreaM2: 124,
    maxThrustN: 235000,
    stallSpeedMps: 61,
    rotationSpeedMps: 76,
    cruiseSpeedMps: 235,
    landingSpeedMps: 66,
    maxFuelKg: 18500,
    maxBankRad: 0.55,
    maxPitchRad: 0.24,
    rollRateRadS: 0.23,
    pitchRateRadS: 0.12,
    dragCoefficient: 0.031,
    frontalAreaM2: 42,
    type: "fixed-wing"
  },

  helicopter: {
    massKg: 2800,
    wingAreaM2: 0,
    maxThrustN: 38000,
    stallSpeedMps: 0,
    rotationSpeedMps: 4,
    cruiseSpeedMps: 62,
    landingSpeedMps: 2,
    maxFuelKg: 680,
    maxBankRad: 0.75,
    maxPitchRad: 0.5,
    rollRateRadS: 0.8,
    pitchRateRadS: 0.65,
    dragCoefficient: 0.8,
    frontalAreaM2: 5.2,
    type: "rotorcraft"
  }
});

const MARINE_CLASSES = Object.freeze({
  yacht: {
    massKg: 13500,
    lengthM: 17,
    beamM: 4.4,
    draftM: 1.25,
    maxThrustN: 26000,
    dragCoefficient: 0.95,
    frontalAreaM2: 6.7,
    steeringRateRadS: 0.35,
    displacementM3: 14
  },

  cargoShip: {
    massKg: 1850000,
    lengthM: 115,
    beamM: 19,
    draftM: 6.3,
    maxThrustN: 315000,
    dragCoefficient: 1.1,
    frontalAreaM2: 145,
    steeringRateRadS: 0.08,
    displacementM3: 1850
  },

  policeBoat: {
    massKg: 1900,
    lengthM: 7.2,
    beamM: 2.3,
    draftM: 0.6,
    maxThrustN: 28000,
    dragCoefficient: 1.0,
    frontalAreaM2: 2.1,
    steeringRateRadS: 0.65,
    displacementM3: 1.95
  },

  jetski: {
    massKg: 360,
    lengthM: 3.2,
    beamM: 1.25,
    draftM: 0.28,
    maxThrustN: 6000,
    dragCoefficient: 0.8,
    frontalAreaM2: 0.7,
    steeringRateRadS: 1.0,
    displacementM3: 0.36
  }
});

function transportClamp(value, min, max) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}

function transportFinite(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function transportLerp(a, b, t) {
  return a + (b - a) * t;
}

export async function createCityAviationMarineSystem({
  runtime,
  scene,
  engine,
  camera,
  services,
  entities,
  logger
}) {
  if (!runtime || !scene) {
    throw new TypeError("Transport simulation requires the shared runtime and scene.");
  }

  const B = globalThis.BABYLON;
  if (!B) throw new Error("Babylon.js is unavailable.");

  let world = null;
  let water = null;
  let weather = null;
  let vehicles = null;
  let player = null;
  let graphics = null;

  function refreshDependencies() {
    world = services?.get?.("world") ??
      services?.get?.("worldArchitecture") ??
      services?.get?.("weltArchitektur") ?? world;
    water = services?.get?.("water") ?? water;
    weather = services?.get?.("weather") ?? weather;
    vehicles = services?.get?.("vehicles") ?? vehicles;
    player = services?.get?.("player") ?? player;
    graphics = services?.get?.("graphics") ?? graphics;
  }

  let initialized = false;
  let running = false;
  let disposed = false;

  let elapsed = 0;
  let nextFlightScheduleAt = AVIATION_CONFIG.gameSecondsBetweenFlights;
  let flightSequence = 1;
  let nextBoatId = 1;
  let nextTransportId = 1;

  const aircraft = new Map();
  const vessels = new Map();
  const buses = new Map();
  const metroTrains = new Map();

  const stations = new Map();
  const airportObjects = new Map();
  const runways = new Map();
  const flightPlans = new Map();
  const airportGates = new Map();
  const parkingStands = new Map();
  const passengerOperations = new Map();
  const passengerAgents = new Map();

  let nextPassengerOperationId = 1;
  let nextPassengerAgentId = 1;

  const militaryZones = new Map();
  const eventDisposers = [];
  const serviceDisposers = [];

  const airportState = {
    airportId: "vice-city-international",
    name: "Vice City International Airport",
    operating: true,
    runwayReservation: new Map(),
    nextRunwayId: 1,
    passengerTerminal: new B.Vector3(-485, 0, 805),
    cargoCenter: new B.Vector3(-635, 0, 710)
  };

  /* --------------------------------------------------------------- */
  /* Shared materials and primitive models                           */
  /* --------------------------------------------------------------- */

  function makeMaterial(name, color, roughness = 0.65, metallic = 0.15) {
    const material = graphics?.createPBRMaterial?.(
      name,
      { albedo: color, roughness, metallic }
    );

    if (material) return material;

    const fallback = new B.StandardMaterial(name, scene);
    fallback.diffuseColor = B.Color3.FromHexString(color);
    fallback.specularColor = new B.Color3(0.12, 0.12, 0.12);
    return fallback;
  }

  const materials = {
    fuselage: makeMaterial("aircraft-fuselage", "#b7c4ca", 0.42, 0.52),
    wing: makeMaterial("aircraft-wing", "#d2d7d7", 0.44, 0.4),
    cockpit: makeMaterial("aircraft-cockpit-glass", "#1b3c4d", 0.15, 0.3),
    trim: makeMaterial("aircraft-trim", "#4c555b", 0.62, 0.18),
    tire: makeMaterial("transport-tire", "#17191b", 0.96, 0),
    hull: makeMaterial("marine-hull", "#cbd0cd", 0.38, 0.27),
    hullDark: makeMaterial("marine-hull-lower", "#173c4d", 0.35, 0.16),
    bus: makeMaterial("city-bus-body", "#d2bd5c", 0.48, 0.16),
    metro: makeMaterial("metro-train-body", "#96a7b1", 0.42, 0.24),
    military: makeMaterial("military-vehicle-body", "#59634e", 0.86, 0.08)
  };

  function trackMesh(mesh, collection) {
    collection.add(mesh);
    return mesh;
  }

  function registerTransportEntity(id, data) {
    const record = {
      id,
      ...data
    };

    try {
      entities.register(id, record);
    } catch (error) {
      logger?.warn?.("Transport entity registry rejected entity.", {
        id,
        message: error?.message ?? String(error)
      });

      return {
        ok: false,
        reason: "entity-registry-rejected"
      };
    }

    return { ok: true, record };
  }

  /* --------------------------------------------------------------- */
  /* Airport, runways and taxi routes                                 */
  /* --------------------------------------------------------------- */

  function createRunway(id, start, end, widthM = AVIATION_CONFIG.runwayWidthM) {
    const startPoint = new B.Vector3(start.x, start.y ?? 0, start.z);
    const endPoint = new B.Vector3(end.x, end.y ?? 0, end.z);

    const delta = endPoint.subtract(startPoint);
    const lengthM = delta.length();
    const direction = delta.normalize();

    if (lengthM < 100) {
      throw new RangeError("Runway length is too short for aircraft operations.");
    }

    const center = B.Vector3.Lerp(startPoint, endPoint, 0.5);
    const heading = Math.atan2(direction.x, direction.z);

    const mesh = B.MeshBuilder.CreateGround(
      `runway-${id}`,
      {
        width: widthM,
        height: lengthM,
        subdivisions: 1
      },
      scene
    );

    mesh.position.copyFrom(center);
    mesh.rotation.y = heading;
    mesh.isPickable = true;
    mesh.checkCollisions = false;

    mesh.material = makeMaterial(
      `runway-material-${id}`,
      "#454b51",
      0.84,
      0.02
    );

    mesh.metadata = {
      ...(mesh.metadata || {}),
      airportId: airportState.airportId,
      runwayId: id,
      isRunway: true,
      isWalkable: true,
      isGroundSurface: true
    };

    const thresholdA = startPoint.clone();
    const thresholdB = endPoint.clone();

    const runway = {
      id,
      start: thresholdA,
      end: thresholdB,
      center,
      direction,
      heading,
      lengthM,
      widthM,
      mesh,
      occupiedBy: null,
      reservedUntil: -Infinity,
      closures: []
    };

    runways.set(id, runway);
    airportObjects.set(id, mesh);

    return runway;
  }

  function createAirport() {
    // This is a coherent airport prototype with separated runway,
    // apron, terminal and hangar areas. A real-world airport layout,
    // taxiway markings and navigation charts require dedicated assets.
    const airportCenter = new B.Vector3(-485, 0, 585);

    const apron = B.MeshBuilder.CreateGround(
      "vc-international-apron",
      {
        width: 170,
        height: 245,
        subdivisions: 1
      },
      scene
    );

    apron.position.copyFrom(
      airportCenter.add(new B.Vector3(0, 0.04, 120))
    );

    apron.material = makeMaterial(
      "vc-international-apron-material",
      "#737980",
      0.82,
      0.02
    );

    apron.metadata = {
      ...(apron.metadata || {}),
      isWalkable: true,
      airportId: airportState.airportId,
      airportApron: true
    };

    airportObjects.set("apron", apron);

    createRunway(
      "runway-09-27",
      {
        x: airportCenter.x - 430,
        y: 0.12,
        z: airportCenter.z - 70
      },
      {
        x: airportCenter.x + 430,
        y: 0.12,
        z: airportCenter.z - 70
      },
      44
    );

    // A second separated parallel runway gives the runway allocator a real
    // alternative when another aircraft has a reservation or a closure.
    createRunway(
      "runway-10-28",
      {
        x: airportCenter.x - 390,
        y: 0.12,
        z: airportCenter.z - 175
      },
      {
        x: airportCenter.x + 390,
        y: 0.12,
        z: airportCenter.z - 175
      },
      38
    );

    const terminal = B.MeshBuilder.CreateBox(
      "vc-airport-terminal",
      {
        width: 118,
        height: 15,
        depth: 34
      },
      scene
    );

    terminal.position.copyFrom(
      airportCenter.add(new B.Vector3(0, 7.5, 220))
    );

    terminal.material = makeMaterial(
      "vc-terminal-material",
      "#aab8bf",
      0.52,
      0.26
    );

    terminal.metadata = {
      ...(terminal.metadata || {}),
      buildingId: "vc-terminal",
      isBuilding: true,
      blocksPlayer: true,
      airportId: airportState.airportId
    };

    airportObjects.set("terminal", terminal);

    for (let index = 0; index < 3; index++) {
      const hangar = B.MeshBuilder.CreateBox(
        `vc-airport-hangar-${index}`,
        {
          width: 45,
          height: 14,
          depth: 34
        },
        scene
      );

      hangar.position.set(
        airportCenter.x - 95 + index * 95,
        7,
        airportCenter.z + 36
      );

      hangar.material = makeMaterial(
        `vc-hangar-material-${index}`,
        index === 1 ? "#7e8d94" : "#969f9f",
        0.75,
        0.18
      );

      hangar.metadata = {
        ...(hangar.metadata || {}),
        isBuilding: true,
        blocksPlayer: true,
        airportId: airportState.airportId
      };

      airportObjects.set(`hangar-${index}`, hangar);
    }

    // Taxiways connect the runway system to apron parking. These are separate
    // walkable/driveable surfaces with their own metadata, rather than one
    // runway-sized plane standing in for the entire airport.
    const taxiwayA = B.MeshBuilder.CreateGround(
      "vc-taxiway-apron-link",
      { width: 20, height: 185, subdivisions: 1 },
      scene
    );
    taxiwayA.position.set(airportCenter.x, 0.09, airportCenter.z + 58);
    taxiwayA.material = makeMaterial("vc-taxiway-material", "#62686e", 0.88, 0.02);
    taxiwayA.metadata = { isWalkable: true, isGroundSurface: true, isTaxiway: true, airportId: airportState.airportId };
    airportObjects.set("taxiway-apron-link", taxiwayA);

    const taxiwayB = B.MeshBuilder.CreateGround(
      "vc-taxiway-terminal-link",
      { width: 24, height: 92, subdivisions: 1 },
      scene
    );
    taxiwayB.position.set(airportCenter.x, 0.095, airportCenter.z + 164);
    taxiwayB.material = taxiwayA.material;
    taxiwayB.metadata = { isWalkable: true, isGroundSurface: true, isTaxiway: true, airportId: airportState.airportId };
    airportObjects.set("taxiway-terminal-link", taxiwayB);

    const cargoApron = B.MeshBuilder.CreateGround(
      "vc-cargo-apron",
      { width: 92, height: 88, subdivisions: 1 },
      scene
    );
    cargoApron.position.set(airportState.cargoCenter.x, 0.07, airportState.cargoCenter.z);
    cargoApron.material = makeMaterial("vc-cargo-apron-material", "#777d80", 0.86, 0.03);
    cargoApron.metadata = { isWalkable: true, isGroundSurface: true, airportId: airportState.airportId, cargoApron: true };
    airportObjects.set("cargo-apron", cargoApron);

    const cargoTerminal = B.MeshBuilder.CreateBox(
      "vc-cargo-terminal",
      { width: 42, height: 11, depth: 27 },
      scene
    );
    cargoTerminal.position.set(airportState.cargoCenter.x, 5.5, airportState.cargoCenter.z + 8);
    cargoTerminal.material = makeMaterial("vc-cargo-terminal-material", "#828d91", 0.72, 0.16);
    cargoTerminal.metadata = { isBuilding: true, blocksPlayer: true, airportId: airportState.airportId, cargoTerminal: true };
    airportObjects.set("cargo-terminal", cargoTerminal);

    for (let index = 0; index < 4; index++) {
      const gateId = `vc-gate-${String(index + 1).padStart(2, "0")}`;
      const standPosition = new B.Vector3(
        airportCenter.x - 54 + index * 36,
        1.7,
        airportCenter.z + 132
      );
      const stand = B.MeshBuilder.CreateGround(
        `vc-parking-stand-${index + 1}`,
        { width: 28, height: 38, subdivisions: 1 },
        scene
      );
      stand.position.set(standPosition.x, 0.08, standPosition.z);
      stand.material = makeMaterial(`vc-parking-stand-material-${index + 1}`, index % 2 ? "#676f73" : "#70787c", 0.85, 0.03);
      stand.metadata = { isWalkable: true, isGroundSurface: true, isAircraftStand: true, airportId: airportState.airportId, gateId };
      airportObjects.set(`parking-stand-${index + 1}`, stand);

      const gatePosition = new B.Vector3(standPosition.x, 0, airportCenter.z + 204);
      const gateMarker = B.MeshBuilder.CreateBox(
        `vc-gate-marker-${index + 1}`,
        { width: 4, height: 0.16, depth: 1.4 },
        scene
      );
      gateMarker.position.set(gatePosition.x, 0.18, gatePosition.z);
      gateMarker.material = makeMaterial(`vc-gate-marker-material-${index + 1}`, "#b5c2c6", 0.55, 0.08);
      gateMarker.metadata = { airportId: airportState.airportId, gateId, isGateMarker: true };
      airportObjects.set(`gate-marker-${index + 1}`, gateMarker);

      airportGates.set(gateId, {
        id: gateId,
        name: `Gate ${String(index + 1).padStart(2, "0")}`,
        position: gatePosition,
        standId: `stand-${index + 1}`,
        assignedAircraftId: null
      });
      parkingStands.set(`stand-${index + 1}`, {
        id: `stand-${index + 1}`,
        gateId,
        position: standPosition,
        assignedAircraftId: null
      });
    }

    for (const runway of runways.values()) {
      airportState.runwayReservation.set(runway.id, null);
    }

    return {
      ok: true,
      airportId: airportState.airportId,
      runwayCount: runways.size
    };
  }

  function isRunwayAvailable(runway, now = elapsed) {
    if (!runway || runway.closures.length) return false;

    if (runway.occupiedBy && now < runway.reservedUntil) {
      return false;
    }

    runway.occupiedBy = null;
    runway.reservedUntil = -Infinity;

    return true;
  }

  function reserveRunway(runwayId, aircraftId, durationSeconds) {
    const runway = runways.get(runwayId);

    if (!runway) return { ok: false, reason: "runway-not-found" };

    if (!isRunwayAvailable(runway)) {
      return { ok: false, reason: "runway-occupied-or-closed" };
    }

    const leaseSeconds = transportClamp(
      transportFinite(durationSeconds, 60),
      1,
      600
    );
    runway.occupiedBy = aircraftId;
    runway.reservedUntil = elapsed + leaseSeconds;

    airportState.runwayReservation.set(runwayId, aircraftId);

    runtime.events.emit("aviation:runwayReserved", {
      runwayId,
      aircraftId,
      reservedUntil: runway.reservedUntil
    });

    return { ok: true };
  }

  function releaseRunway(runwayId, aircraftId) {
    const runway = runways.get(runwayId);

    if (!runway || runway.occupiedBy !== aircraftId) return false;

    runway.occupiedBy = null;
    runway.reservedUntil = -Infinity;
    airportState.runwayReservation.set(runwayId, null);

    runtime.events.emit("aviation:runwayReleased", {
      runwayId,
      aircraftId
    });

    return true;
  }

  function closeRunway(runwayId, reason, durationSeconds = 300) {
    const runway = runways.get(runwayId);
    if (!runway) return { ok: false, reason: "runway-not-found" };

    runway.closures.push({
      reason,
      expiresAt: elapsed + Math.max(0, durationSeconds)
    });

    runtime.events.emit("aviation:runwayClosed", {
      runwayId,
      reason,
      expiresAt: elapsed + durationSeconds
    });

    return { ok: true };
  }

  function updateRunwayClosures() {
    for (const runway of runways.values()) {
      runway.closures = runway.closures.filter(
        closure => closure.expiresAt > elapsed
      );
    }
  }

  /* --------------------------------------------------------------- */
  /* Aircraft construction                                             */
  /* --------------------------------------------------------------- */

  function createAircraftModel(record) {
    const profile = record.profile;
    const root = record.root;

    function addPart(name, size, local, material) {
      const mesh = B.MeshBuilder.CreateBox(
        `${record.id}-${name}`,
        {
          width: size.x,
          height: size.y,
          depth: size.z
        },
        scene
      );

      mesh.parent = root;
      mesh.position.set(local.x, local.y, local.z);
      mesh.material = material;
      mesh.isPickable = true;

      mesh.metadata = {
        ...(mesh.metadata || {}),
        aircraftId: record.id,
        isAircraft: true,
        blocksPlayer: true
      };

      record.visualParts.add(mesh);

      return mesh;
    }

    const isAirliner = record.classId === "airliner";
    const length = isAirliner ? 36 : 17;
    const wingSpan = isAirliner ? 31 : 18;

    const fuselage = addPart(
      "fuselage",
      new B.Vector3(2.9, 2.65, length),
      { x: 0, y: 0, z: 0 },
      record.material
    );

    const cabin = addPart(
      "cockpit",
      new B.Vector3(2.7, 1.65, length * 0.25),
      { x: 0, y: 0.8, z: length * 0.30 },
      materials.cockpit
    );

    const wing = addPart(
      "wing",
      new B.Vector3(wingSpan, 0.45, isAirliner ? 5.5 : 3.7),
      { x: 0, y: -0.1, z: -0.45 },
      materials.wing
    );

    const horizontalTail = addPart(
      "horizontal-tail",
      new B.Vector3(wingSpan * 0.30, 0.24, 2.6),
      { x: 0, y: 0.9, z: -length * 0.40 },
      materials.wing
    );

    addPart(
      "vertical-tail",
      new B.Vector3(0.35, 3.8, 2.4),
      { x: 0, y: 2.1, z: -length * 0.4 },
      materials.wing
    );

    if (record.classId === "helicopter") {
      addPart(
        "rotor-mast",
        new B.Vector3(0.22, 2.1, 0.22),
        { x: 0, y: 1.6, z: 0 },
        materials.trim
      );

      const rotor = B.MeshBuilder.CreateBox(
        `${record.id}-main-rotor`,
        {
          width: 14,
          height: 0.06,
          depth: 0.25
        },
        scene
      );

      rotor.parent = root;
      rotor.position.y = 2.75;
      rotor.material = materials.trim;
      rotor.isPickable = false;

      record.rotor = rotor;
      record.visualParts.add(rotor);
    }

    if (isAirliner) {
      for (const side of [-1, 1]) {
        addPart(
          `engine-${side}`,
          new B.Vector3(2.3, 2.1, 5.2),
          {
            x: side * wingSpan * 0.25,
            y: -0.9,
            z: 1.2
          },
          materials.trim
        );
      }
    }

    record.fuselageMesh = fuselage;
    record.cabinMesh = cabin;
    record.wingMesh = wing;

    return { fuselage, cabin, wing, horizontalTail };
  }

  function createAircraft(options = {}) {
    const classId = options.classId ?? "commuter";
    const profile = AIRCRAFT_CLASSES[classId];

    if (!profile) {
      return { ok: false, reason: "unknown-aircraft-class" };
    }

    const id = options.id ??
      `aircraft-${flightSequence++}`;

    if (aircraft.has(id)) {
      return { ok: false, reason: "duplicate-aircraft-id" };
    }

    const root = new B.TransformNode(`aircraft-root-${id}`, scene);

    const position = new B.Vector3(
      transportFinite(options.position?.x),
      transportFinite(options.position?.y, 0),
      transportFinite(options.position?.z)
    );

    root.position.copyFrom(position);
    root.rotation.set(
      transportFinite(options.pitch),
      transportFinite(options.heading),
      transportFinite(options.roll)
    );

    const material = makeMaterial(
      `aircraft-paint-${id}`,
      options.paint ?? "#e8e9e3",
      0.39,
      0.26
    );

    const record = {
      id,
      classId,
      profile,
      root,
      material,
      visualParts: new Set(),

      position,
      velocity: new B.Vector3(0, 0, 0),

      pitch: transportFinite(options.pitch),
      roll: transportFinite(options.roll),

      pitchRate: 0,
      rollRate: 0,
      yawRate: 0,

      throttle: 0,
      elevator: 0,
      aileron: 0,
      rudder: 0,
      flaps: 0,
      gearDown: true,

      engineRunning: false,
      fuelKg: profile.maxFuelKg * 0.78,
      health: 100,

      flightState: options.flightState ?? "parked",
      flightPlan: null,
      autopilot: options.autopilot !== false,
      runwayId: null,
      runwayReservationUntil: null,

      desiredAltitudeM: transportFinite(
        options.desiredAltitudeM,
        AVIATION_CONFIG.defaultCruiseAltitudeM
      ),

      targetSpeedMps: transportFinite(
        options.targetSpeedMps,
        profile.cruiseSpeedMps
      ),

      passengerCount: transportClamp(transportFinite(options.passengerCount, 0), 0, classId === "airliner" ? 172 : 38),
      passengerCapacity: classId === "airliner" ? 172 : 38,
      passengerOperationId: null,
      gateId: options.gateId ?? null,
      manualPilotId: null,

      hasPilot: options.hasPilot !== false,
      assignedPilot: options.assignedPilot ?? "autopilot",

      timeInCurrentState: 0,
      flightDistanceM: 0,
      destroyed: false,

      metadata: {
        arrivalDeparture: options.arrivalDeparture ?? "unscheduled",
        routeName: options.routeName ?? "local",
        cargoFlight: options.cargoFlight === true
      }
    };

    createAircraftModel(record);

    const registered = registerTransportEntity(id, {
      type: "aircraft",
      classId,
      position: record.position,
      root,
      record
    });

    if (!registered.ok) {
      root.dispose(false, true);
      material.dispose();
      return registered;
    }

    aircraft.set(id, record);

    runtime.events.emit("aviation:aircraftRegistered", {
      aircraftId: id,
      classId,
      flightState: record.flightState,
      position: position.clone()
    });

    return {
      ok: true,
      aircraftId: id,
      aircraft: record
    };
  }

  function forwardForAircraft(record) {
    const cp = Math.cos(record.pitch);

    return new B.Vector3(
      Math.sin(record.heading) * cp,
      Math.sin(record.pitch),
      Math.cos(record.heading) * cp
    ).normalize();
  }

  function getPassengerVisualCount() {
    return passengerAgents.size;
  }

  function createPassengerAgent(operation, startPosition, targetPosition, index) {
    if (passengerAgents.size >= AVIATION_CONFIG.npcPassengerVisualBudget) return null;
    const id = `airport-passenger-${nextPassengerAgentId++}`;
    const root = new B.TransformNode(`${id}-root`, scene);
    root.position.copyFrom(startPosition);
    const body = B.MeshBuilder.CreateBox(`${id}-body`, { width: 0.34, height: 0.82, depth: 0.22 }, scene);
    body.parent = root;
    body.position.y = 0.58;
    body.material = index % 3 === 0 ? materials.military : materials.trim;
    body.isPickable = false;
    body.metadata = { isNPC: true, npcType: "airport-passenger", passengerId: id, operationId: operation.id };

    const head = B.MeshBuilder.CreateBox(`${id}-head`, { width: 0.22, height: 0.24, depth: 0.22 }, scene);
    head.parent = root;
    head.position.y = 1.12;
    head.material = materials.cockpit;
    head.isPickable = false;
    head.metadata = { isNPC: true, npcType: "airport-passenger", passengerId: id };

    const suitcase = B.MeshBuilder.CreateBox(`${id}-suitcase`, { width: 0.22, height: 0.3, depth: 0.14 }, scene);
    suitcase.parent = root;
    suitcase.position.set(0.28, 0.23, 0.05);
    suitcase.material = materials.hullDark;
    suitcase.isPickable = false;
    suitcase.metadata = { passengerLuggage: true, passengerId: id };

    const agent = {
      id,
      operationId: operation.id,
      root,
      position: root.position,
      targetPosition: targetPosition.clone(),
      speedMps: 1.05 + ((index * 17) % 6) * 0.12,
      state: "walking",
      walkPhase: index * 0.7,
      luggage: true
    };
    passengerAgents.set(id, agent);
    operation.visualAgentIds.push(id);
    return agent;
  }

  function disposePassengerOperation(operationId) {
    const operation = passengerOperations.get(operationId);
    if (!operation) return false;
    for (const agentId of operation.visualAgentIds) {
      const agent = passengerAgents.get(agentId);
      if (agent) {
        agent.root.dispose(false, true);
        passengerAgents.delete(agentId);
      }
    }
    passengerOperations.delete(operationId);
    return true;
  }

  function createAirportPassengerOperation(record, direction) {
    if (!record || !["departure", "arrival"].includes(direction)) {
      return { ok: false, reason: "invalid-passenger-operation" };
    }
    const existing = passengerOperations.get(record.passengerOperationId);
    if (existing) disposePassengerOperation(existing.id);

    let gate = record.gateId ? airportGates.get(record.gateId) : null;
    if (!gate) {
      const availableGate = [...airportGates.values()].find(candidate =>
        !candidate.assignedAircraftId || candidate.assignedAircraftId === record.id
      );
      gate = availableGate ?? [...airportGates.values()][0] ?? null;
    }
    if (!gate) return { ok: false, reason: "no-airport-gates" };

    gate.assignedAircraftId = record.id;
    record.gateId = gate.id;
    const passengerCount = direction === "departure"
      ? Math.max(1, Math.round(record.passengerCapacity * (0.32 + (record.id.length % 4) * 0.1)))
      : Math.max(0, record.passengerCount);
    const terminal = airportState.passengerTerminal.clone();
    const gatePosition = gate.position.clone();
    const operation = {
      id: `airport-passenger-operation-${nextPassengerOperationId++}`,
      aircraftId: record.id,
      gateId: gate.id,
      direction,
      passengerCount,
      state: direction === "departure" ? "walkingToGate" : "deboarding",
      position: (direction === "departure" ? terminal : gatePosition).clone(),
      targetPosition: (direction === "departure" ? gatePosition : terminal).clone(),
      elapsedInState: 0,
      travelSeconds: B.Vector3.Distance(terminal, gatePosition) / 1.25,
      visualAgentIds: [],
      createdAt: elapsed
    };
    passengerOperations.set(operation.id, operation);
    record.passengerOperationId = operation.id;

    const visualCount = Math.min(6, passengerCount, AVIATION_CONFIG.npcPassengerVisualBudget - passengerAgents.size);
    for (let index = 0; index < visualCount; index++) {
      const offset = new B.Vector3((index % 3) * 1.1 - 1.1, 0, Math.floor(index / 3) * 1.4 - 0.7);
      const start = operation.position.add(offset);
      const target = operation.targetPosition.add(offset);
      createPassengerAgent(operation, start, target, index + nextPassengerAgentId);
    }

    runtime.events.emit("aviation:passengerOperationStarted", {
      operationId: operation.id,
      aircraftId: record.id,
      gateId: gate.id,
      direction,
      passengerCount,
      visualizedPassengerCount: operation.visualAgentIds.length,
      groupedPassengerCount: Math.max(0, passengerCount - operation.visualAgentIds.length)
    });
    return { ok: true, operationId: operation.id, passengerCount, gateId: gate.id };
  }

  function updateAirportPassengerOperations(dt) {
    for (const agent of passengerAgents.values()) {
      if (agent.state !== "walking") continue;
      const delta = agent.targetPosition.subtract(agent.position);
      const distance = delta.length();
      if (distance <= 0.35) {
        agent.position.copyFrom(agent.targetPosition);
        agent.state = "arrived";
        continue;
      }
      const step = Math.min(distance, agent.speedMps * dt);
      if (distance > 0) agent.position.addInPlace(delta.scale(step / distance));
      agent.walkPhase += dt * 8;
      agent.root.rotation.y = Math.atan2(delta.x, delta.z);
    }

    for (const operation of [...passengerOperations.values()]) {
      operation.elapsedInState += dt;
      if (operation.state === "walkingToGate" && operation.elapsedInState >= operation.travelSeconds) {
        operation.state = "boarding";
        operation.elapsedInState = 0;
        operation.position.copyFrom(operation.targetPosition);
        runtime.events.emit("aviation:passengersAtGate", {
          operationId: operation.id,
          aircraftId: operation.aircraftId,
          gateId: operation.gateId,
          passengerCount: operation.passengerCount
        });
      } else if (operation.state === "boarding" && operation.elapsedInState >= 24) {
        operation.state = "boarded";
        const record = aircraft.get(operation.aircraftId);
        if (record) record.passengerCount = operation.passengerCount;
        runtime.events.emit("aviation:passengersBoarded", {
          operationId: operation.id,
          aircraftId: operation.aircraftId,
          gateId: operation.gateId,
          passengerCount: operation.passengerCount
        });
      } else if (operation.state === "deboarding" && operation.elapsedInState >= 18) {
        operation.state = "completed";
        const record = aircraft.get(operation.aircraftId);
        if (record) record.passengerCount = 0;
        runtime.events.emit("aviation:passengersAlighted", {
          operationId: operation.id,
          aircraftId: operation.aircraftId,
          gateId: operation.gateId,
          passengerCount: operation.passengerCount
        });
        disposePassengerOperation(operation.id);
      }
    }
  }

  /* --------------------------------------------------------------- */
  /* Flight planning and dynamics                                     */
  /* --------------------------------------------------------------- */

  function assignFlightPlan(id, plan) {
    const record = aircraft.get(id);

    if (!record) return { ok: false, reason: "aircraft-not-found" };
    if (!plan || typeof plan !== "object") {
      return { ok: false, reason: "invalid-flight-plan" };
    }

    if (!Array.isArray(plan.waypoints) || plan.waypoints.length === 0) {
      return { ok: false, reason: "empty-flight-plan" };
    }

    const waypoints = plan.waypoints.map(point => {
      if (
        !Number.isFinite(point.x) ||
        !Number.isFinite(point.y) ||
        !Number.isFinite(point.z)
      ) {
        throw new TypeError("Flight waypoints require finite XYZ positions.");
      }

      return new B.Vector3(point.x, point.y, point.z);
    });

    if (record.flightPlan?.id) flightPlans.delete(record.flightPlan.id);
    record.flightPlan = {
      id: plan.id ?? `flight-plan-${record.id}`,
      waypoints,
      waypointIndex: 0,
      destination: waypoints[waypoints.length - 1].clone(),
      assignedAt: elapsed,
      flightMode: plan.flightMode ?? "direct",
      completed: false
    };

    flightPlans.set(record.flightPlan.id, record.flightPlan);

    runtime.events.emit("aviation:flightPlanAssigned", {
      aircraftId: id,
      flightPlanId: record.flightPlan.id,
      waypointCount: waypoints.length
    });

    return {
      ok: true,
      flightPlanId: record.flightPlan.id
    };
  }

  function resolveFlightControls(record, dt) {
    if (!record.autopilot || !record.flightPlan) return;

    const profile = record.profile;
    const relativeWind = weather?.getWindAt?.(record.position) ?? B.Vector3.Zero();
    const plan = record.flightPlan;
    const target = plan.waypoints[plan.waypointIndex];

    if (!target) {
      plan.completed = true;
      record.throttle = 0.18;
      return;
    }

    const delta = target.subtract(record.position);
    const horizontalDistance = Math.hypot(delta.x, delta.z);

    if (delta.length() < 90 && plan.waypointIndex < plan.waypoints.length - 1) {
      plan.waypointIndex++;
    }

    const desiredHeading = Math.atan2(delta.x, delta.z);

    let headingError = desiredHeading - record.heading;

    while (headingError > Math.PI) headingError -= Math.PI * 2;
    while (headingError < -Math.PI) headingError += Math.PI * 2;

    const desiredAltitude = target.y;
    const altitudeError = desiredAltitude - record.position.y;

    record.aileron = transportClamp(
      headingError * 0.9,
      -1,
      1
    );

    record.rudder = transportClamp(
      headingError * 0.45,
      -1,
      1
    );

    record.elevator = transportClamp(
      altitudeError * 0.0024 - record.velocity.y * 0.025,
      -0.7,
      0.7
    );

    if (record.flightState === "climb" && profile.type === "fixed-wing" &&
        profile.wingAreaM2 > 0) {
      // During initial climb, the altitude-only controller can demand a shallow
      // pitch before the aircraft has gained enough energy. Maintain the angle
      // of attack required by the current mass, density and airspeed, while the
      // altitude controller still chooses the overall climb direction.
      const density = AVIATION_CONFIG.seaLevelAirDensityKgM3 *
        Math.exp(-Math.max(0, record.position.y) / 8500);
      const airSpeed = record.velocity.subtract(relativeWind).length();
      const liftDenominator = Math.max(
        1,
        0.5 * density * airSpeed * airSpeed * profile.wingAreaM2
      );
      const requiredLiftCoefficient =
        profile.massKg * AVIATION_CONFIG.gravityMps2 * 1.06 /
        liftDenominator;
      const requiredAngleOfAttack = transportClamp(
        (requiredLiftCoefficient - 0.35 - record.flaps * 0.70) / 7.1,
        0.02,
        profile.maxPitchRad * 0.90
      );
      const flightPathAngle = Math.atan2(
        record.velocity.y,
        Math.max(1, Math.hypot(record.velocity.x, record.velocity.z))
      );
      const minimumPitch = transportClamp(
        flightPathAngle + requiredAngleOfAttack,
        0,
        profile.maxPitchRad * 0.92
      );
      record.elevator = Math.max(
        record.elevator,
        transportClamp(minimumPitch / profile.maxPitchRad, 0, 1)
      );
    }

    const desiredSpeed = record.targetSpeedMps;

    record.throttle = transportClamp(
      0.48 +
      (desiredSpeed - record.velocity.length()) * 0.025,
      0,
      1
    );

    if (
      record.flightState === "approach" ||
      record.flightState === "descent"
    ) {
      record.throttle = transportClamp(
        0.45 + altitudeError * 0.0004,
        0.15,
        0.65
      );

      record.flaps = 0.65;
      record.gearDown = record.position.y < 220;
    }

    if (horizontalDistance < 35 && Math.abs(altitudeError) < 10) {
      plan.waypointIndex = Math.min(
        plan.waypointIndex + 1,
        plan.waypoints.length
      );
    }

    void dt;
  }

  function calculateFlightForces(record, dt) {
    const profile = record.profile;
    const gravity = AVIATION_CONFIG.gravityMps2;

    const speed = record.velocity.length();
    const forward = forwardForAircraft(record);

    const relativeWind =
      weather?.getWindAt?.(record.position) ??
      B.Vector3.Zero();

    const airVelocity = record.velocity.subtract(relativeWind);
    const airSpeed = airVelocity.length();

    const airDensity = AVIATION_CONFIG.seaLevelAirDensityKgM3 *
      Math.exp(-Math.max(0, record.position.y) / 8500);

    let liftN = 0;
    let thrustN = profile.maxThrustN *
      transportClamp(record.throttle, 0, 1);

    if (profile.type === "fixed-wing") {
      const horizontalSpeed = Math.hypot(
        record.velocity.x,
        record.velocity.z
      );

      const flightPathAngle = Math.atan2(
        record.velocity.y,
        Math.max(1, horizontalSpeed)
      );

      const angleOfAttack = record.pitch - flightPathAngle;

      let liftCoefficient =
        0.35 +
        angleOfAttack * 7.1 +
        record.flaps * 0.70;

      liftCoefficient = transportClamp(
        liftCoefficient,
        -0.55,
        2.35
      );

      liftN = 0.5 *
        airDensity *
        airSpeed *
        airSpeed *
        profile.wingAreaM2 *
        liftCoefficient;

      // Beyond stall, lift collapses progressively instead of remaining
      // constant regardless of airspeed.
      if (airSpeed < profile.stallSpeedMps) {
        const stallRatio = airSpeed / Math.max(1, profile.stallSpeedMps);
        liftN *= stallRatio * stallRatio;
      }
    } else {
      // The rotorcraft model can sustain lift at near-zero forward speed.
      const collective = transportClamp(
        0.65 + record.elevator * 0.35,
        0.2,
        1.1
      );

      liftN = profile.massKg * gravity * collective;
    }

    const dragN =
      0.5 *
      airDensity *
      profile.dragCoefficient *
      profile.frontalAreaM2 *
      airSpeed *
      airSpeed;

    const liftDirection = new B.Vector3(0, 1, 0);

    if (airSpeed > 1) {
      const velocityDirection = airVelocity.normalize();

      liftDirection.subtractInPlace(
        velocityDirection.scale(
          B.Vector3.Dot(liftDirection, velocityDirection)
        )
      );

      if (liftDirection.lengthSquared() > 1e-5) {
        liftDirection.normalize();
      } else {
        liftDirection.set(0, 1, 0);
      }
    }

    const liftForce = liftDirection.scale(liftN);
    const thrust = forward.scale(thrustN);
    const drag = airSpeed > 1e-3
      ? airVelocity.normalize().scale(-dragN)
      : B.Vector3.Zero();

    const weight = new B.Vector3(
      0,
      -profile.massKg * gravity,
      0
    );

    const force = liftForce
      .add(thrust)
      .add(drag)
      .add(weight);

    const acceleration = force.scale(1 / profile.massKg);

    record.velocity.addInPlace(acceleration.scale(dt));

    // A bounded numerical guard protects damaged or invalid states.
    if (record.velocity.length() > 360) {
      record.velocity.normalize().scaleInPlace(360);
    }

    record.position.addInPlace(record.velocity.scale(dt));
    record.flightDistanceM += speed * dt;

    return {
      airSpeedMps: airSpeed,
      liftN,
      thrustN,
      dragN,
      accelerationMps2: acceleration.length(),
      angleOfAttackRad: record.pitch -
        Math.atan2(record.velocity.y, Math.max(1, speed))
    };
  }

  function updateFlightControlSurface(record, dt) {
    const profile = record.profile;
    const desiredRoll = transportClamp(
      -record.aileron * profile.maxBankRad,
      -profile.maxBankRad,
      profile.maxBankRad
    );
    const desiredPitch = transportClamp(
      record.elevator * profile.maxPitchRad,
      -profile.maxPitchRad,
      profile.maxPitchRad
    );

    record.rollRate = transportClamp(
      (desiredRoll - record.roll) * 2.4,
      -profile.rollRateRadS,
      profile.rollRateRadS
    );
    record.pitchRate = transportClamp(
      (desiredPitch - record.pitch) * 2.6,
      -profile.pitchRateRadS,
      profile.pitchRateRadS
    );
    record.yawRate = transportLerp(
      record.yawRate,
      record.rudder * profile.rollRateRadS * 0.55,
      transportClamp(1 - Math.exp(-1.8 * dt), 0, 1)
    );

    record.roll = transportClamp(
      record.roll + record.rollRate * dt,
      -profile.maxBankRad,
      profile.maxBankRad
    );
    record.pitch = transportClamp(
      record.pitch + record.pitchRate * dt,
      -profile.maxPitchRad,
      profile.maxPitchRad
    );
    record.heading += record.yawRate * dt;
    while (record.heading > Math.PI) record.heading -= Math.PI * 2;
    while (record.heading < -Math.PI) record.heading += Math.PI * 2;

    record.root.position.copyFrom(record.position);
    record.root.rotation.set(record.pitch, record.heading, record.roll);

    if (record.rotor) {
      const rotorTarget = 20 + record.throttle * 58;
      record.rotor.rotation.y += dt * rotorTarget;
    }
  }

  function setAircraftControls(id, controls = {}) {
    const record = aircraft.get(id);

    if (!record || record.destroyed) {
      return { ok: false, reason: "aircraft-unavailable" };
    }
    if (record.manualPilotId && controls.pilotId !== record.manualPilotId) {
      return { ok: false, reason: "active-pilot-mismatch" };
    }

    record.autopilot = false;
    record.throttle = transportClamp(transportFinite(controls.throttle), 0, 1);
    record.elevator = transportClamp(transportFinite(controls.elevator), -1, 1);
    record.aileron = transportClamp(transportFinite(controls.aileron), -1, 1);
    record.rudder = transportClamp(transportFinite(controls.rudder), -1, 1);
    record.flaps = transportClamp(transportFinite(controls.flaps), 0, 1);

    return { ok: true };
  }

  function hijackAircraft(aircraftId, characterId, options = {}) {
    const record = aircraft.get(aircraftId);
    if (!record || record.destroyed) return { ok: false, reason: "aircraft-unavailable" };
    if (!["parked", "taxi", "parking", "holding"].includes(record.flightState)) {
      return { ok: false, reason: "aircraft-not-accessible-on-ground" };
    }
    const character = characterId != null
      ? player?.getCharacter?.(characterId)
      : player?.getActiveCharacter?.();
    if (!character?.position) return { ok: false, reason: "character-or-position-unavailable" };
    const actualCharacterId = characterId ?? character.id ?? null;
    if (actualCharacterId == null) return { ok: false, reason: "character-id-unavailable" };
    const distanceM = B.Vector3.Distance(character.position, record.position);
    if (distanceM > transportClamp(transportFinite(options.maxDistanceM, 4.5), 1, 8)) {
      return { ok: false, reason: "out-of-range", distanceM };
    }
    if (record.manualPilotId) return { ok: false, reason: "already-hijacked" };

    if (record.flightPlan?.id) flightPlans.delete(record.flightPlan.id);
    record.flightPlan = null;
    record.autopilot = false;
    const previousPilot = record.assignedPilot ?? "autopilot";
    record.manualPilotId = actualCharacterId;
    record.assignedPilot = actualCharacterId;
    record.hasPilot = true;
    record.engineRunning = record.fuelKg > 0;
    record.throttle = 0;
    record.elevator = 0;
    record.aileron = 0;
    record.rudder = 0;
    record.flaps = 0.22;
    record.gearDown = true;
    record.timeInCurrentState = 0;
    if (record.runwayId) releaseRunway(record.runwayId, record.id);
    transitionFlightState(record, "manualTaxi", "unauthorized-pilot-takeover");

    if (record.passengerOperationId) {
      disposePassengerOperation(record.passengerOperationId);
      record.passengerOperationId = null;
    }
    if (record.parkingStandId) {
      const stand = parkingStands.get(record.parkingStandId);
      if (stand?.assignedAircraftId === record.id) stand.assignedAircraftId = null;
      const gate = airportGates.get(record.gateId);
      if (gate?.assignedAircraftId === record.id) gate.assignedAircraftId = null;
      record.parkingStandId = null;
      record.gateId = null;
    }
    runtime.events.emit("aviation:alarmTriggered", {
      aircraftId,
      characterId: actualCharacterId,
      position: record.position.clone(),
      reason: "unauthorized-takeover"
    });
    runtime.events.emit("aviation:aircraftHijacked", {
      aircraftId,
      characterId: actualCharacterId,
      fromPilot: previousPilot,
      position: record.position.clone()
    });
    runtime.events.emit("crime:aircraftHijacking", {
      actorId: actualCharacterId,
      aircraftId,
      position: record.position.clone()
    });
    runtime.events.emit("police:crimeReported", {
      actorId: actualCharacterId,
      crimeType: "aircraft-hijacking",
      severity: 5,
      source: "airport-security",
      position: record.position.clone()
    });
    return { ok: true, aircraftId, flightState: record.flightState, pilotId: actualCharacterId };
  }

  function transitionFlightState(record, nextState, reason = "normal") {
    if (record.flightState === nextState) return;

    const previous = record.flightState;

    record.flightState = nextState;
    record.timeInCurrentState = 0;

    runtime.events.emit("aviation:flightStateChanged", {
      aircraftId: record.id,
      from: previous,
      to: nextState,
      reason
    });
  }

  function startDeparture(record, runway) {
    if (!record || record.destroyed) {
      return { ok: false, reason: "aircraft-unavailable" };
    }
    if (record.manualPilotId) {
      return { ok: false, reason: "manual-pilot-control-active" };
    }
    if (!airportState.operating) {
      return { ok: false, reason: "airport-not-operating" };
    }
    if (record.fuelKg <= 0) {
      return { ok: false, reason: "aircraft-out-of-fuel" };
    }
    if (record.passengerOperationId) {
      const operation = passengerOperations.get(record.passengerOperationId);
      if (operation && operation.kind === "departure" && operation.state !== "boarded") {
        return { ok: false, reason: "passengers-not-boarded" };
      }
    }
    if (!isRunwayAvailable(runway)) {
      return { ok: false, reason: "runway-unavailable" };
    }

    const reservation = reserveRunway(
      runway.id,
      record.id,
      120
    );

    if (!reservation.ok) return reservation;

    record.runwayId = runway.id;
    const runwayCenter = B.Vector3.Lerp(runway.start, runway.end, 0.5);
    const dx = record.position.x - runwayCenter.x;
    const dz = record.position.z - runwayCenter.z;
    const lateralOffset = Math.abs(
      dx * -Math.sin(runway.heading) + dz * Math.cos(runway.heading)
    );
    const alongOffset = Math.abs(
      dx * Math.sin(runway.heading) + dz * Math.cos(runway.heading)
    );
    if (lateralOffset > runway.widthM * 0.5 || alongOffset > runway.lengthM * 0.5) {
      record.position.copyFrom(runway.start);
      record.velocity.setAll(0);
    }
    record.position.y = runway.start.y + 1.6;
    record.heading = runway.heading;

    record.engineRunning = true;
    record.throttle = 1;
    record.flaps = 0.22;
    record.gearDown = true;

    record.flightPlan = {
      id: `departure-${record.id}`,
      waypointIndex: 0,
      waypoints: [
        runway.end.add(new B.Vector3(0, 95, 180)),
        runway.end.add(new B.Vector3(80, 420, 600)),
        runway.end.add(new B.Vector3(240, record.desiredAltitudeM, 1500))
      ],
      destination: runway.end.clone(),
      completed: false
    };
    flightPlans.set(record.flightPlan.id, record.flightPlan);

    transitionFlightState(record, "takeoffRoll", "scheduled-departure");

    return { ok: true, runwayId: runway.id };
  }

  function startArrival(record, runway) {
    if (!record || record.destroyed) {
      return { ok: false, reason: "aircraft-unavailable" };
    }
    if (record.manualPilotId) {
      return { ok: false, reason: "manual-pilot-control-active" };
    }
    if (!isRunwayAvailable(runway)) {
      return { ok: false, reason: "runway-unavailable" };
    }

    const reservation = reserveRunway(
      runway.id,
      record.id,
      180
    );

    if (!reservation.ok) return reservation;

    const approachStart = runway.start.add(
      runway.direction.scale(-1500)
    );

    record.position.copyFrom(approachStart);
    record.position.y = 500;
    record.heading = runway.heading;
    record.velocity = runway.direction.scale(
      record.profile.landingSpeedMps + 18
    );

    record.runwayId = runway.id;
    record.engineRunning = true;
    record.gearDown = false;
    record.flaps = 0.25;

    const runwayCenterHeight = runway.start.y + 1.6;
    const finalApproach = runway.start.clone();
    finalApproach.y = runwayCenterHeight + 43;

    record.flightPlan = {
      id: `arrival-${record.id}`,
      waypointIndex: 0,
      waypoints: [
        finalApproach.add(runway.direction.scale(-750)),
        finalApproach,
        new B.Vector3(runway.start.x, runwayCenterHeight, runway.start.z)
      ],
      destination: new B.Vector3(runway.start.x, runwayCenterHeight, runway.start.z),
      completed: false
    };
    flightPlans.set(record.flightPlan.id, record.flightPlan);

    record.autopilot = true;
    record.targetSpeedMps = record.profile.landingSpeedMps;

    transitionFlightState(record, "approach", "scheduled-arrival");

    return { ok: true, runwayId: runway.id };
  }

  function updateFlightStateMachine(record, dt) {
    record.timeInCurrentState += dt;

    const speed = record.velocity.length();
    const runway = runways.get(record.runwayId);

    switch (record.flightState) {
      case "parked":
        record.throttle = 0;
        record.velocity.scaleInPlace(Math.exp(-dt * 2.5));
        break;

      case "taxi": {
        record.engineRunning = record.fuelKg > 0;
        const operation = passengerOperations.get(record.passengerOperationId);
        if (operation && operation.direction === "departure" && operation.state !== "boarded") {
          record.throttle = 0.04;
          if (record.timeInCurrentState > 12) record.timeInCurrentState = 12;
          break;
        }
        record.throttle = 0.16;
        if (record.timeInCurrentState > 12) {
          if (runway && isRunwayAvailable(runway)) {
            startDeparture(record, runway);
          } else {
            transitionFlightState(record, "holding", "runway-unavailable");
          }
        }
        break;
      }

      case "manualTaxi":
        if (!record.engineRunning || record.fuelKg <= 0) record.throttle = 0;
        if (record.velocity.length() >= record.profile.rotationSpeedMps) {
          transitionFlightState(record, "manualFlight", "manual-rotation-speed");
          runtime.events.emit("aviation:aircraftLiftedOff", {
            aircraftId: record.id,
            runwayId: record.runwayId,
            speedMps: record.velocity.length(),
            manualPilotId: record.manualPilotId
          });
        }
        break;

      case "manualFlight":
        // Inputs continue to drive the actual flight dynamics; no autopilot overrides them.
        break;

      case "taxiToGate": {
        const target = record.groundTaxiTarget;
        if (!target) {
          transitionFlightState(record, "parking", "no-parking-route");
          break;
        }
        const dx = target.x - record.position.x;
        const dz = target.z - record.position.z;
        const distance = Math.hypot(dx, dz);
        if (distance < 4.5 && record.velocity.length() < 2.4) {
          record.velocity.setAll(0);
          record.position.copyFrom(target);
          record.root.position.copyFrom(record.position);
          record.throttle = 0;
          record.groundTaxiTarget = null;
          transitionFlightState(record, "parking", "parking-stand-reached");
          createAirportPassengerOperation(record, "arrival");
          runtime.events.emit("aviation:aircraftAtGate", {
            aircraftId: record.id,
            gateId: record.gateId,
            parkingStandId: record.parkingStandId
          });
          break;
        }
        const desiredHeading = Math.atan2(dx, dz);
        let error = desiredHeading - record.heading;
        while (error > Math.PI) error -= Math.PI * 2;
        while (error < -Math.PI) error += Math.PI * 2;
        record.heading += transportClamp(error, -dt * 0.22, dt * 0.22);
        record.throttle = distance > 10 ? 0.12 : 0;
        record.brake = distance < 10 ? 0.85 : 0;
        if (distance < 10) {
          // The flight force model is optimized for aircraft in flight and
          // does not model hydraulic wheel brakes. Apply a bounded ground-only
          // deceleration so taxi-to-gate cannot coast indefinitely past a stand.
          const braking = Math.exp(-Math.min(8, dt * 1.8));
          record.velocity.x *= braking;
          record.velocity.z *= braking;
          if (record.velocity.length() < 2.4) record.velocity.setAll(0);
        }
        break;
      }

      case "takeoffRoll":
        record.throttle = 1;

        if (speed >= record.profile.rotationSpeedMps) {
          // Rotate to an angle that produces approximately the required lift
          // at the actual rotation speed. Setting elevator alone would delay
          // pitch response until after the dynamics step and can cause a
          // false ground-contact emergency immediately after liftoff.
          if (record.profile.type === "fixed-wing" && record.profile.wingAreaM2 > 0) {
            const density = AVIATION_CONFIG.seaLevelAirDensityKgM3 *
              Math.exp(-Math.max(0, record.position.y) / 8500);
            const liftDenominator = Math.max(
              1,
              0.5 * density * speed * speed * record.profile.wingAreaM2
            );
            const requiredLiftCoefficient =
              record.profile.massKg * AVIATION_CONFIG.gravityMps2 * 1.06 /
              liftDenominator;
            const requiredRotationPitch =
              (requiredLiftCoefficient - 0.35 - record.flaps * 0.70) / 7.1;
            record.pitch = transportClamp(
              Math.max(record.pitch, requiredRotationPitch),
              record.profile.maxPitchRad * 0.58,
              record.profile.maxPitchRad * 0.92
            );
          }
          record.elevator = 0.7;
          record.autopilot = true;
          if (record.runwayId) releaseRunway(record.runwayId, record.id);
          if (record.passengerOperationId) {
            disposePassengerOperation(record.passengerOperationId);
            record.passengerOperationId = null;
          }

          transitionFlightState(record, "climb", "rotation-speed-reached");

          runtime.events.emit("aviation:aircraftLiftedOff", {
            aircraftId: record.id,
            runwayId: record.runwayId,
            speedMps: speed
          });
        }
        break;

      case "climb":
        record.targetSpeedMps = Math.max(
          record.profile.cruiseSpeedMps * 0.8,
          record.profile.stallSpeedMps + 15
        );

        if (record.position.y >= record.desiredAltitudeM * 0.90) {
          transitionFlightState(record, "cruise", "cruise-altitude-reached");
        }
        break;

      case "cruise":
        record.targetSpeedMps = record.profile.cruiseSpeedMps;

        if (record.timeInCurrentState > 55) {
          const landingRunway = runways.get(record.runwayId);
          if (landingRunway) {
            const approachStart = landingRunway.start.add(
              landingRunway.direction.scale(-1500)
            );
            approachStart.y = 520;
            const finalApproach = landingRunway.start.add(
              landingRunway.direction.scale(-750)
            );
            finalApproach.y = landingRunway.start.y + 45;
            const runwayEndPoint = new B.Vector3(
              landingRunway.start.x,
              landingRunway.start.y + 1.6,
              landingRunway.start.z
            );
            if (record.flightPlan?.id) flightPlans.delete(record.flightPlan.id);
            record.flightPlan = {
              id: `return-${record.id}-${Math.floor(elapsed)}`,
              waypoints: [approachStart, finalApproach, runwayEndPoint],
              waypointIndex: 0,
              destination: runwayEndPoint.clone(),
              completed: false
            };
            flightPlans.set(record.flightPlan.id, record.flightPlan);
            record.autopilot = true;
            record.targetSpeedMps = Math.max(
              record.profile.landingSpeedMps + 12,
              record.profile.stallSpeedMps + 12
            );
          } else {
            transitionFlightState(record, "emergency", "no-return-runway");
            break;
          }
          transitionFlightState(record, "descent", "route-time-elapsed");
        }
        break;

      case "descent":
        record.desiredAltitudeM = Math.max(
          150,
          record.desiredAltitudeM - dt * 28
        );

        if (record.position.y < 260) {
          transitionFlightState(record, "approach");
        }
        break;

      case "approach":
        record.targetSpeedMps = record.profile.landingSpeedMps;
        record.gearDown = record.position.y < 220;
        record.flaps = transportClamp(
          (220 - record.position.y) / 190,
          0.2,
          1
        );

        if (
          record.position.y < 12 &&
          runway &&
          B.Vector3.Distance(record.position, runway.start) < 130
        ) {
          transitionFlightState(record, "landingRoll", "runway-contact-proximity");
        }
        break;

      case "landingRoll":
        record.throttle = 0;
        record.flaps = 1;
        record.gearDown = true;

        record.velocity.scaleInPlace(
          Math.exp(-dt * 0.42)
        );

        if (speed < 4 || record.timeInCurrentState > 45) {
          releaseRunway(record.runwayId, record.id);
          const landingRunway = runways.get(record.runwayId);
          record.runwayId = null;
          record.engineRunning = true;
          const availableStand = [...parkingStands.values()].find(stand =>
            !stand.assignedAircraftId || stand.assignedAircraftId === record.id
          );
          if (availableStand) {
            availableStand.assignedAircraftId = record.id;
            record.parkingStandId = availableStand.id;
            record.gateId = availableStand.gateId;
            const gate = airportGates.get(availableStand.gateId);
            if (gate) gate.assignedAircraftId = record.id;
            const taxiStart = landingRunway
              ? new B.Vector3(landingRunway.end.x, landingRunway.end.y + 1.6, landingRunway.end.z)
              : record.position.clone();
            record.groundTaxiTarget = availableStand.position.clone();
            record.position.x = taxiStart.x;
            record.position.z = taxiStart.z;
            record.position.y = taxiStart.y;
            record.velocity.scaleInPlace(0.18);
            transitionFlightState(record, "taxiToGate", "landing-roll-complete");
          } else {
            record.engineRunning = false;
            transitionFlightState(record, "parking", "no-parking-stand-available");
          }
        }
        break;

      case "parking":
        if (record.timeInCurrentState > 7) {
          transitionFlightState(record, "parked");
          runtime.events.emit("aviation:aircraftParked", {
            aircraftId: record.id
          });
        }
        break;

      case "holding":
        record.throttle = 0.2;

        if (record.timeInCurrentState > 15 && runway &&
            isRunwayAvailable(runway)) {
          startDeparture(record, runway);
        }
        break;

      case "emergency":
        record.throttle = Math.min(record.throttle, 0.35);
        record.targetSpeedMps = Math.max(
          record.profile.stallSpeedMps + 8,
          45
        );
        break;
    }
  }

  function spawnScheduledFlight(kind) {
    if (!airportState.operating) {
      return { ok: false, reason: "airport-not-operating" };
    }

    const availableRunways = [...runways.values()].filter(runway => isRunwayAvailable(runway));
    if (!availableRunways.length) {
      return { ok: false, reason: "no-runway-available" };
    }
    const runway = availableRunways[(flightSequence - 1) % availableRunways.length];

    const classId = flightSequence % 3 === 0
      ? "airliner"
      : "commuter";

    const start = kind === "departure"
      ? new B.Vector3(runway.start.x, runway.start.y + 1.6, runway.start.z)
      : runway.start.add(new B.Vector3(-1200, 500, 900));

    const spawned = createAircraft({
      classId,
      position: start,
      heading: runway.heading,
      flightState: kind === "departure" ? "taxi" : "cruise",
      arrivalDeparture: kind,
      desiredAltitudeM: AVIATION_CONFIG.defaultCruiseAltitudeM,
      targetSpeedMps: AIRCRAFT_CLASSES[classId].cruiseSpeedMps,
      engineRunning: kind === "departure",
      cargoFlight: flightSequence % 4 === 0
    });

    if (!spawned.ok) return spawned;

    const record = aircraft.get(spawned.aircraftId);
    record.runwayId = runway.id;

    if (kind === "arrival") {
      record.passengerCount = Math.round(record.passengerCapacity * 0.58);
      const result = startArrival(record, runway);

      if (!result.ok) {
        aircraft.delete(record.id);
        try { entities?.unregister?.(record.id); } catch {}
        if (record.flightPlan?.id) flightPlans.delete(record.flightPlan.id);
        record.root.dispose(false, true);
        try { record.material.dispose(); } catch {}
        return result;
      }
    }

    if (kind === "departure") createAirportPassengerOperation(record, "departure");

    runtime.events.emit("aviation:scheduledFlightCreated", {
      aircraftId: record.id,
      kind,
      runwayId: runway.id
    });

    return {
      ok: true,
      aircraftId: record.id,
      kind,
      runwayId: runway.id
    };
  }

  /* --------------------------------------------------------------- */
  /* Marine entities and buoyancy                                     */
  /* --------------------------------------------------------------- */

  function createVessel(options = {}) {
    const classId = options.classId ?? "yacht";
    const profile = MARINE_CLASSES[classId];

    if (!profile) {
      return { ok: false, reason: "unknown-vessel-class" };
    }

    const id = options.id ?? `vessel-${nextBoatId++}`;

    if (vessels.has(id)) {
      return { ok: false, reason: "duplicate-vessel-id" };
    }

    const root = new B.TransformNode(`vessel-root-${id}`, scene);

    const position = new B.Vector3(
      transportFinite(options.position?.x),
      transportFinite(options.position?.y, -1),
      transportFinite(options.position?.z)
    );

    root.position.copyFrom(position);

    const hullMaterial = classId === "cargoShip"
      ? materials.hullDark
      : materials.hull;

    const hull = B.MeshBuilder.CreateBox(
      `vessel-${id}-hull`,
      {
        width: profile.beamM,
        height: profile.draftM * 0.9,
        depth: profile.lengthM
      },
      scene
    );

    hull.parent = root;
    hull.position.y = -profile.draftM * 0.22;
    hull.material = hullMaterial;
    hull.isPickable = true;

    hull.metadata = {
      ...(hull.metadata || {}),
      vesselId: id,
      isVessel: true,
      blocksPlayer: true
    };

    const cabin = B.MeshBuilder.CreateBox(
      `vessel-${id}-deck-house`,
      {
        width: profile.beamM * 0.60,
        height: profile.draftM + 0.9,
        depth: profile.lengthM * 0.25
      },
      scene
    );

    cabin.parent = root;
    cabin.position.set(
      0,
      profile.draftM * 0.4,
      -profile.lengthM * 0.08
    );

    cabin.material = materials.trim;
    cabin.isPickable = true;

    cabin.metadata = {
      ...(cabin.metadata || {}),
      vesselId: id,
      blocksPlayer: true
    };

    const record = {
      id,
      classId,
      profile,
      root,
      hull,
      cabin,

      position,
      velocity: new B.Vector3(0, 0, 0),
      heading: transportFinite(options.heading),
      yawRate: 0,
      pitch: 0,
      roll: 0,

      throttle: 0,
      steering: 0,
      engineRunning: options.engineRunning ?? true,

      fuelLiters: transportFinite(
        options.fuelLiters,
        classId === "cargoShip" ? 42000 : 600
      ),

      health: 100,
      ownerId: options.ownerId ?? null,
      driverId: null,
      autopilot: null,

      metadata: {
        route: options.route ?? null,
        publicService: options.publicService ?? false
      }
    };

    vessels.set(id, record);

    const registered = registerTransportEntity(id, {
      type: "vessel",
      position,
      root,
      record
    });

    if (!registered.ok) {
      vessels.delete(id);
      root.dispose(false, true);

      return registered;
    }

    runtime.events.emit("marine:vesselRegistered", {
      vesselId: id,
      classId,
      position: position.clone()
    });

    return { ok: true, vesselId: id, vessel: record };
  }

  function updateVessel(record, dt) {
    const profile = record.profile;
    const speed = record.velocity.length();
    const forward = new B.Vector3(
      Math.sin(record.heading),
      0,
      Math.cos(record.heading)
    );

    const waterSample = water?.sampleWater?.(record.position, elapsed) ?? null;
    const waterRegion = water?.getWaterRegionAt?.(
      record.position,
      { ignoreHeight: true }
    ) ?? null;
    const hasWaterSurface = Number.isFinite(waterSample?.height);
    const localWind = weather?.getWindAt?.(record.position) ?? B.Vector3.Zero();
    const flow = waterSample?.flowVelocity ?? B.Vector3.Zero();
    const relativeFlow = record.velocity.subtract(flow);
    const relativeSpeed = relativeFlow.length();

    const windRelative = localWind.subtract(record.velocity);
    const windDrag = windRelative.scale(
      0.018 * profile.frontalAreaM2 / Math.max(1, profile.massKg / 1000)
    );
    const dragAcceleration = relativeSpeed > 1e-4
      ? relativeFlow.normalize().scale(
          -0.5 * 1025 * profile.dragCoefficient * profile.beamM *
          relativeSpeed * relativeSpeed / profile.massKg
        )
      : B.Vector3.Zero();

    const engineAvailable = record.engineRunning && record.fuelLiters > 0 &&
      record.health > 0;
    const throttle = engineAvailable
      ? transportClamp(record.throttle, 0, 1)
      : 0;
    const thrustAcceleration = forward.scale(
      profile.maxThrustN * throttle / profile.massKg
    );
    const acceleration = thrustAcceleration
      .add(dragAcceleration)
      .add(windDrag);

    record.velocity.addInPlace(acceleration.scale(dt));

    const maxSpeed = record.classId === "cargoShip" ? 11 :
      record.classId === "yacht" ? 30 :
      record.classId === "jetski" ? 27 : 24;
    if (record.velocity.length() > maxSpeed) {
      record.velocity.normalize().scaleInPlace(maxSpeed);
    }

    record.position.x += record.velocity.x * dt;
    record.position.z += record.velocity.z * dt;

    const yawAcceleration =
      record.steering * profile.steeringRateRadS *
        transportClamp(speed / 5, 0, 1) - record.yawRate * 0.65;
    record.yawRate += yawAcceleration * dt;
    record.heading += record.yawRate * dt;
    if (record.heading > Math.PI) record.heading -= Math.PI * 2;
    if (record.heading < -Math.PI) record.heading += Math.PI * 2;

    const targetWaterline = hasWaterSurface
      ? waterSample.height - profile.draftM * 0.62
      : record.position.y;
    const heaveError = targetWaterline - record.position.y;
    const waveVelocity = transportFinite(waterSample?.orbitalVelocity?.y, 0);
    const verticalAcceleration = hasWaterSurface
      ? transportClamp(heaveError * 2.6 + (waveVelocity - record.velocity.y) * 1.7, -3.5, 3.5)
      : -record.velocity.y * 1.8;
    record.velocity.y = transportClamp(
      record.velocity.y + verticalAcceleration * dt,
      -2.4,
      2.4
    );
    record.position.y += record.velocity.y * dt;

    const surfaceSlopeX = transportFinite(waterSample?.normal?.x, 0);
    const surfaceSlopeZ = transportFinite(waterSample?.normal?.z, 0);
    record.pitch = transportClamp(
      -surfaceSlopeZ * 0.16 +
        Math.sin(elapsed * 0.35 + record.position.x * 0.01) * Math.min(0.055, speed * 0.002),
      -0.16,
      0.16
    );
    record.roll = transportClamp(
      record.yawRate * speed * 0.055 + surfaceSlopeX * 0.12 +
        Math.sin(elapsed * 0.28 + record.position.z * 0.013) * Math.min(0.09, speed * 0.003),
      -0.22,
      0.22
    );

    const fuelRate = (record.classId === "cargoShip" ? 0.48 :
      record.classId === "yacht" ? 0.055 :
      record.classId === "jetski" ? 0.018 : 0.04) * throttle;
    if (record.fuelLiters > 0 && engineAvailable) {
      const previousFuel = record.fuelLiters;
      record.fuelLiters = Math.max(0, record.fuelLiters - fuelRate * dt);
      if (previousFuel > 0 && record.fuelLiters <= 0) {
        record.throttle = 0;
        record.engineRunning = false;
        runtime.events.emit("marine:fuelDepleted", {
          vesselId: record.id,
          position: record.position.clone()
        });
      }
    }

    record.root.position.copyFrom(record.position);
    record.root.rotation.set(record.pitch, record.heading, record.roll);

    if (throttle > 0.2) {
      runtime.events.emit("audio:vehicleEngine", {
        entityId: record.id,
        category: "marine",
        speedMps: speed,
        throttle
      });
    }

    runtime.events.emit("marine:telemetry", {
      vesselId: record.id,
      speedMps: speed,
      heading: record.heading,
      waveHeightM: waterSample?.height ?? null,
      waterRegionId: waterRegion?.id ?? null,
      fuelLiters: record.fuelLiters,
      engineRunning: record.engineRunning,
      throttle,
      verticalAccelerationMps2: verticalAcceleration
    });

    checkRestrictedZone({
      id: record.id,
      type: "vessel",
      position: record.position
    });
  }

  /* --------------------------------------------------------------- */
  /* Scheduled buses and metro trains                                 */
  /* --------------------------------------------------------------- */

  function createStation(options) {
    if (!options?.id || !options.position) {
      throw new TypeError("Transit station requires an ID and position.");
    }

    if (stations.has(options.id)) {
      return { ok: false, reason: "duplicate-station-id" };
    }

    const station = {
      id: options.id,
      name: options.name ?? options.id,
      type: options.type ?? "bus",
      position: new B.Vector3(
        options.position.x,
        options.position.y ?? 0,
        options.position.z
      ),
      routeIds: [...(options.routeIds ?? [])],
      dwellSeconds: transportClamp(options.dwellSeconds ?? 14, 2, 120),
      lastArrivalAt: -Infinity
    };

    stations.set(station.id, station);

    runtime.events.emit("transport:stationRegistered", {
      stationId: station.id,
      stationType: station.type,
      position: station.position.clone()
    });

    return { ok: true, stationId: station.id };
  }

  function createTransitVehicle(type, options = {}) {
    const id = options.id ?? `transit-${nextTransportId++}`;

    const profile = {
      type,
      route: [...(options.route ?? [])],
      routeIndex: 0,
      speedMps: type === "metro" ? 18 : 10,
      dwellRemaining: 0,
      serviceIntervalSeconds: transportClamp(
        transportFinite(options.serviceIntervalSeconds, type === "metro" ? 240 : 180),
        60,
        1800
      ),
      nextDepartureAt: elapsed + transportClamp(
        transportFinite(options.startDelaySeconds, 0),
        0,
        3600
      ),
      state: transportFinite(options.startDelaySeconds, 0) > 0 ? "scheduled" : "inService",
      passengerCount: 0,
      passengerIds: new Set(),
      capacity: type === "metro" ? 220 : 54,
      doorState: "closed",
      lastStopId: null
    };

    const root = new B.TransformNode(`transit-root-${id}`, scene);

    root.position.copyFrom(
      profile.route[0] ??
      B.Vector3.Zero()
    );

    const mesh = B.MeshBuilder.CreateBox(
      `transit-body-${id}`,
      {
        width: type === "metro" ? 2.85 : 2.4,
        height: type === "metro" ? 3.4 : 3.0,
        depth: type === "metro" ? 18 : 10.2
      },
      scene
    );

    mesh.parent = root;
    mesh.position.y = 1.65;
    mesh.material = type === "metro" ? materials.metro : materials.bus;
    mesh.isPickable = true;

    mesh.metadata = {
      ...(mesh.metadata || {}),
      transportId: id,
      isPublicTransport: true,
      blocksPlayer: true
    };

    const record = {
      ...profile,
      id,
      root,
      mesh,
      position: root.position,
      velocity: new B.Vector3(0, 0, 0),
      yaw: 0
    };

    if (buses.has(id) || metroTrains.has(id)) {
      root.dispose(false, true);
      return { ok: false, reason: "duplicate-transport-id" };
    }

    const registered = registerTransportEntity(id, {
      type: "public-transport",
      transportType: type,
      position: record.position,
      root,
      record
    });

    if (!registered.ok) {
      root.dispose(false, true);
      return registered;
    }

    if (type === "metro") metroTrains.set(id, record);
    else buses.set(id, record);

    return { ok: true, id, record };
  }

  function updateTransitVehicle(record, dt) {
    if (!record.route?.length) return;

    if (record.state === "scheduled") {
      if (elapsed + 1e-6 < record.nextDepartureAt) {
        record.velocity.scaleInPlace(Math.exp(-dt * 4));
        record.doorState = "open";
        return;
      }
      record.state = "inService";
      record.routeIndex = Math.min(1, record.route.length - 1);
      record.doorState = "closed";
      runtime.events.emit("transport:serviceDispatched", {
        transportId: record.id,
        transportType: record.type,
        scheduledAt: record.nextDepartureAt,
        dispatchedAt: elapsed
      });
    }

    if (record.dwellRemaining > 0) {
      record.dwellRemaining -= dt;
      record.doorState = "open";
      record.velocity.scaleInPlace(Math.exp(-dt * 5));
      return;
    }

    record.doorState = "closed";
    if (record.state === "delayed") record.state = "inService";

    let target = record.route[record.routeIndex];

    if (!target) {
      record.routeIndex = 0;
      target = record.route[0];
    }

    const dx = target.x - record.position.x;
    const dz = target.z - record.position.z;
    const distance = Math.hypot(dx, dz);

    if (distance < 4.5) {
      record.lastStopId = [...stations.values()].find(station =>
        B.Vector3.Distance(station.position, record.position) < 9 &&
        station.type === (record.type === "metro" ? "metro" : "bus")
      )?.id ?? null;

      if (record.lastStopId) {
        const station = stations.get(record.lastStopId);

        record.dwellRemaining = station.dwellSeconds;
        station.lastArrivalAt = elapsed;

        runtime.events.emit("transport:stationArrival", {
          transportId: record.id,
          stationId: station.id,
          passengerCount: record.passengerCount
        });
      }

      const completedLoop = record.routeIndex >= record.route.length - 1 &&
        B.Vector3.Distance(record.route[record.route.length - 1], record.route[0]) < 4.5;
      if (completedLoop) {
        record.routeIndex = 0;
        record.state = "scheduled";
        record.dwellRemaining = 0;
        record.nextDepartureAt = elapsed + Math.max(
          record.serviceIntervalSeconds,
          stations.get(record.lastStopId)?.dwellSeconds ?? 0
        );
        runtime.events.emit("transport:serviceScheduled", {
          transportId: record.id,
          nextDepartureAt: record.nextDepartureAt,
          intervalSeconds: record.serviceIntervalSeconds
        });
      } else {
        record.routeIndex = (record.routeIndex + 1) % record.route.length;
      }
      return;
    }

    const desiredHeading = Math.atan2(dx, dz);
    let headingError = desiredHeading - record.yaw;

    while (headingError > Math.PI) headingError -= Math.PI * 2;
    while (headingError < -Math.PI) headingError += Math.PI * 2;

    record.yaw += transportClamp(headingError, -dt * 0.55, dt * 0.55);

    const direction = new B.Vector3(
      Math.sin(record.yaw),
      0,
      Math.cos(record.yaw)
    );

    const desiredSpeed = Math.min(
      record.speedMps,
      Math.sqrt(Math.max(0, distance) * 1.4)
    );

    const currentSpeed = record.velocity.length();

    record.velocity = B.Vector3.Lerp(
      record.velocity,
      direction.scale(desiredSpeed),
      transportClamp(dt * 1.5, 0, 1)
    );

    const nextPosition = record.position.add(
      record.velocity.scale(dt)
    );

    if (record.type !== "metro") {
      const blocked = world?.closestPointOnRoad?.(
        nextPosition,
        25
      );

      if (blocked?.blocked) {
        record.velocity.scaleInPlace(0.2);
        record.state = "delayed";

        runtime.events.emit("transport:routeBlocked", {
          transportId: record.id,
          position: nextPosition.clone()
        });

        return;
      }
    }

    record.position.copyFrom(nextPosition);
    record.root.position.copyFrom(nextPosition);
    record.root.rotation.y = record.yaw;

    runtime.events.emit("transport:telemetry", {
      transportId: record.id,
      speedMps: currentSpeed,
      state: record.state,
      doorState: record.doorState,
      passengerCount: record.passengerCount
    });
  }

  function getTransitRecord(id) {
    return buses.get(id) ?? metroTrains.get(id) ?? null;
  }

  function boardPassenger(transportId, passengerId, options = {}) {
    const record = getTransitRecord(transportId);
    if (!record) return { ok: false, reason: "transport-not-found" };
    if (passengerId == null || String(passengerId).trim() === "") {
      return { ok: false, reason: "passenger-id-required" };
    }
    const id = String(passengerId);
    if (record.passengerIds.has(id)) return { ok: false, reason: "passenger-already-aboard" };
    if (record.passengerIds.size >= record.capacity) return { ok: false, reason: "transport-full" };
    if (record.doorState !== "open" || record.dwellRemaining <= 0 || !record.lastStopId) {
      return { ok: false, reason: "doors-closed-or-not-at-station" };
    }
    const station = stations.get(record.lastStopId);
    if (!station) return { ok: false, reason: "station-not-found" };
    if (options.position && B.Vector3.Distance(
      new B.Vector3(options.position.x, options.position.y ?? 0, options.position.z),
      station.position
    ) > 12) return { ok: false, reason: "passenger-not-near-station" };

    record.passengerIds.add(id);
    record.passengerCount = record.passengerIds.size;
    runtime.events.emit("transport:passengerBoarded", {
      transportId,
      passengerId: id,
      stationId: station.id,
      passengerCount: record.passengerCount
    });
    return { ok: true, passengerCount: record.passengerCount };
  }

  function alightPassenger(transportId, passengerId, options = {}) {
    const record = getTransitRecord(transportId);
    if (!record) return { ok: false, reason: "transport-not-found" };
    if (record.doorState !== "open" || record.dwellRemaining <= 0 || !record.lastStopId) {
      return { ok: false, reason: "doors-closed-or-not-at-station" };
    }
    const id = String(passengerId ?? "");
    if (!record.passengerIds.has(id)) return { ok: false, reason: "passenger-not-aboard" };
    const station = stations.get(record.lastStopId);
    if (!station) return { ok: false, reason: "station-not-found" };

    record.passengerIds.delete(id);
    record.passengerCount = record.passengerIds.size;
    runtime.events.emit("transport:passengerAlighted", {
      transportId,
      passengerId: id,
      stationId: station.id,
      position: station.position.clone(),
      passengerCount: record.passengerCount
    });
    return { ok: true, passengerCount: record.passengerCount };
  }

  /* --------------------------------------------------------------- */
  /* Military restricted zones                                        */
  /* --------------------------------------------------------------- */

  function registerMilitaryZone(options) {
    if (!options?.id || !options.center ||
        !Number.isFinite(options.radiusM) ||
        options.radiusM <= 0) {
      throw new TypeError("Military zone requires ID, center and radius.");
    }

    if (militaryZones.has(options.id)) {
      return { ok: false, reason: "duplicate-zone" };
    }

    const zone = {
      id: options.id,
      name: options.name ?? options.id,
      center: new B.Vector3(
        options.center.x,
        options.center.y ?? 0,
        options.center.z
      ),

      radiusM: options.radiusM,
      verticalCeilingM: options.verticalCeilingM ?? 800,
      restrictedTypes: options.restrictedTypes ??
        ["player", "civilian", "aircraft", "vessel"],

      alertLevel: 0,
      lastIntruderId: null,
      lastAlertAt: -Infinity,
      lastDecayAt: elapsed,
      escalationCooldown: 0,
      enabled: true
    };

    militaryZones.set(zone.id, zone);

    runtime.events.emit("military:zoneRegistered", {
      zoneId: zone.id,
      center: zone.center.clone(),
      radiusM: zone.radiusM
    });

    return {
      ok: true,
      zoneId: zone.id,
      dispose: () => militaryZones.delete(zone.id)
    };
  }

  function checkRestrictedZone(entity) {
    if (!entity?.position || !entity.id) return [];

    const breaches = [];

    for (const zone of militaryZones.values()) {
      if (!zone.enabled) continue;

      if (!zone.restrictedTypes.includes(entity.type)) continue;

      const horizontalDistance = Math.hypot(
        entity.position.x - zone.center.x,
        entity.position.z - zone.center.z
      );

      const verticalDistance = Math.abs(
        entity.position.y - zone.center.y
      );

      if (
        horizontalDistance > zone.radiusM ||
        verticalDistance > zone.verticalCeilingM
      ) {
        continue;
      }

      const repeated = zone.lastIntruderId === entity.id &&
        elapsed - zone.lastAlertAt < 4;

      if (repeated) continue;

      zone.lastIntruderId = entity.id;
      zone.lastAlertAt = elapsed;

      zone.alertLevel = transportClamp(
        zone.alertLevel + 1,
        0,
        5
      );

      const breach = {
        zoneId: zone.id,
        entityId: entity.id,
        alertLevel: zone.alertLevel,
        distanceM: horizontalDistance
      };

      breaches.push(breach);

      runtime.events.emit("military:restrictedZoneBreach", {
        ...breach,
        position: entity.position.clone()
      });

      if (zone.alertLevel >= 2) {
        runtime.events.emit("military:interceptionRequested", {
          zoneId: zone.id,
          entityId: entity.id,
          alertLevel: zone.alertLevel,
          position: entity.position.clone(),
          interceptClass:
            entity.type === "aircraft" ? "fighter" : "patrol"
        });
      }
    }

    return breaches;
  }

  function setMilitaryZoneAlert(id, level) {
    const zone = militaryZones.get(id);
    if (!zone) return { ok: false, reason: "zone-not-found" };

    const previous = zone.alertLevel;
    zone.alertLevel = transportClamp(Math.floor(level), 0, 5);
    zone.lastAlertAt = elapsed;
    zone.lastDecayAt = elapsed;

    runtime.events.emit("military:alertChanged", {
      zoneId: id,
      from: previous,
      to: zone.alertLevel
    });

    return { ok: true, alertLevel: zone.alertLevel };
  }

  /* --------------------------------------------------------------- */
  /* Timed flight scheduler                                            */
  /* --------------------------------------------------------------- */

  let nextScheduledFlightKind = "departure";

  function updateFlightScheduler() {
    // Tolerate accumulated floating-point error at exact ten-minute boundaries.
    if (elapsed + 1e-6 < nextFlightScheduleAt) return;

    // At most one aircraft movement is scheduled per 10 game minutes.
    // If the runway is busy, skip this slot instead of creating a backlog.
    const scheduledAt = nextFlightScheduleAt;
    nextFlightScheduleAt = elapsed +
      AVIATION_CONFIG.gameSecondsBetweenFlights;

    const kind = nextScheduledFlightKind;
    const result = spawnScheduledFlight(kind);
    if (result.ok) {
      nextScheduledFlightKind = kind === "departure" ? "arrival" : "departure";
    }

    runtime.events.emit("aviation:scheduleBatchProcessed", {
      at: elapsed,
      scheduledAt,
      kind,
      result,
      nextScheduledFlightKind,
      nextScheduledAt: nextFlightScheduleAt
    });
  }

  function updateAircraft(record, dt) {
    if (record.destroyed) return;

    const stateBeforeUpdate = record.flightState;
    updateFlightStateMachine(record, dt);

    const groundControlStates = new Set([
      "parked", "taxi", "holding", "takeoffRoll", "landingRoll", "parking", "taxiToGate", "manualTaxi"
    ]);
    const justRotated = stateBeforeUpdate === "takeoffRoll" &&
      record.flightState === "climb";
    if (record.autopilot && !groundControlStates.has(record.flightState) && !justRotated) {
      resolveFlightControls(record, dt);
    }

    const dynamics = calculateFlightForces(record, dt);
    updateFlightControlSurface(record, dt);

    const groundStates = new Set([
      "parked", "taxi", "holding", "takeoffRoll", "landingRoll", "parking", "taxiToGate", "manualTaxi"
    ]);
    if (groundStates.has(record.flightState)) {
      const runway = runways.get(record.runwayId);
      const groundCenterY = runway
        ? runway.start.y + 1.6
        : 1.6;
      record.position.y = groundCenterY;
      record.velocity.y = 0;
    }

    if (
      record.position.y < 0 &&
      !groundStates.has(record.flightState)
    ) {
      record.position.y = 0;
      record.velocity.y = Math.max(-10, record.velocity.y);
      record.health = Math.max(0, record.health - 1.5);

      transitionFlightState(record, "emergency", "ground-contact");
    }

    if (record.fuelKg > 0 && record.engineRunning) {
      const burnKgPerSecond = record.classId === "airliner"
        ? 0.85 + record.throttle * 1.6
        : record.classId === "helicopter"
          ? 0.045 + record.throttle * 0.12
          : 0.18 + record.throttle * 0.48;
      record.fuelKg = Math.max(0, record.fuelKg - burnKgPerSecond * dt);
    }

    if (record.fuelKg <= 0 && record.engineRunning) {
      record.throttle = 0;
      record.engineRunning = false;

      transitionFlightState(record, "emergency", "fuel-depleted");

      runtime.events.emit("aviation:engineOut", {
        aircraftId: record.id,
        position: record.position.clone()
      });
    }

    runtime.events.emit("aviation:telemetry", {
      aircraftId: record.id,
      classId: record.classId,
      flightState: record.flightState,
      position: record.position.clone(),
      velocity: record.velocity.clone(),
      airspeedMps: dynamics.airSpeedMps,
      altitudeM: record.position.y,
      pitchRad: record.pitch,
      rollRad: record.roll,
      headingRad: record.heading,
      angleOfAttackRad: dynamics.angleOfAttackRad,
      liftN: dynamics.liftN,
      thrustN: dynamics.thrustN
    });

    checkRestrictedZone({
      id: record.id,
      type: "aircraft",
      position: record.position
    });
  }

  /* --------------------------------------------------------------- */
  /* Lifecycle and service registration                               */
  /* --------------------------------------------------------------- */

  async function initialize() {
    if (disposed) return { ok: false, reason: "transport-system-disposed" };
    if (initialized) return { ok: true };
    refreshDependencies();

    createAirport();

    createStation({
      id: "vice-city-central-bus",
      name: "Vice City Central Bus Terminal",
      type: "bus",
      position: { x: 18, y: 0, z: -35 },
      dwellSeconds: 16
    });

    createStation({
      id: "downtown-bus-stop",
      name: "Downtown Exchange",
      type: "bus",
      position: { x: 160, y: 0, z: 180 },
      dwellSeconds: 11
    });

    createStation({
      id: "central-metro",
      name: "Central Metro Station",
      type: "metro",
      position: { x: 10, y: -8, z: 0 },
      dwellSeconds: 19
    });

    createStation({
      id: "coastal-metro",
      name: "Coastal Metro Station",
      type: "metro",
      position: { x: 280, y: -8, z: -225 },
      dwellSeconds: 19
    });

    const busRoute = [
      new B.Vector3(18, 0, -35),
      new B.Vector3(60, 0, 15),
      new B.Vector3(160, 0, 180),
      new B.Vector3(95, 0, 260),
      new B.Vector3(18, 0, -35)
    ];
    createTransitVehicle("bus", {
      id: "city-bus-route-01",
      route: busRoute,
      serviceIntervalSeconds: 180
    });
    createTransitVehicle("bus", {
      id: "city-bus-route-02",
      route: busRoute.map(point => point.clone()),
      startDelaySeconds: 90,
      serviceIntervalSeconds: 180
    });

    const metroRoute = [
      new B.Vector3(10, -8, 0),
      new B.Vector3(75, -8, -90),
      new B.Vector3(175, -8, -150),
      new B.Vector3(280, -8, -225),
      new B.Vector3(175, -8, -150),
      new B.Vector3(75, -8, -90),
      new B.Vector3(10, -8, 0)
    ];
    createTransitVehicle("metro", {
      id: "metro-train-route-01",
      route: metroRoute,
      serviceIntervalSeconds: 240
    });
    createTransitVehicle("metro", {
      id: "metro-train-route-02",
      route: metroRoute.map(point => point.clone()),
      startDelaySeconds: 120,
      serviceIntervalSeconds: 240
    });

    createVessel({
      id: "world-police-boat-01",
      classId: "policeBoat",
      position: { x: 1020, y: -1.0, z: 220 },
      publicService: true
    });

    createVessel({
      id: "world-yacht-01",
      classId: "yacht",
      position: { x: 1130, y: -1.3, z: -130 }
    });

    registerMilitaryZone({
      id: "fort-zancudo-restricted",
      name: "Fort Zancudo Restricted Airspace",
      center: { x: -760, y: 0, z: 680 },
      radiusM: 190,
      verticalCeilingM: 1500
    });

    registerMilitaryZone({
      id: "port-gellhorn-security",
      name: "Port Gellhorn Security Perimeter",
      center: { x: 580, y: 0, z: -480 },
      radiusM: 130,
      verticalCeilingM: 250
    });

    serviceDisposers.push(
      runtime.services.register("aviation", {
        createAircraft,
        getAircraft: id => aircraft.get(id) ?? null,
        getAllAircraft: () => [...aircraft.values()],

        assignFlightPlan,
        setAircraftControls,
        startDeparture,
        startArrival,
        spawnScheduledFlight,
        hijackAircraft,
        getPassengerOperations: () => [...passengerOperations.values()].map(operation => ({
          id: operation.id,
          aircraftId: operation.aircraftId,
          gateId: operation.gateId,
          direction: operation.direction,
          passengerCount: operation.passengerCount,
          state: operation.state
        })),

        reserveRunway,
        releaseRunway,
        closeRunway,

        getRunways: () => [...runways.values()],
        getGates: () => [...airportGates.values()].map(gate => ({
          id: gate.id,
          name: gate.name,
          position: gate.position.clone(),
          assignedAircraftId: gate.assignedAircraftId
        })),
        getParkingStands: () => [...parkingStands.values()].map(stand => ({
          id: stand.id,
          gateId: stand.gateId,
          position: stand.position.clone(),
          assignedAircraftId: stand.assignedAircraftId
        })),
        getAirportState: () => ({
          ...airportState,
          gateCount: airportGates.size,
          parkingStandCount: parkingStands.size,
          runways: [...runways.values()].map(runway => ({
            id: runway.id,
            occupiedBy: runway.occupiedBy,
            reservedUntil: runway.reservedUntil,
            closures: [...runway.closures]
          }))
        }),

        getSnapshot: () => ({
          aircraft: aircraft.size,
          activeAircraft: [...aircraft.values()].filter(
            a => !a.destroyed
          ).length,
          runways: runways.size,
          flightPlans: flightPlans.size,
          nextScheduledFlight: nextFlightScheduleAt
        })
      })
    );

    serviceDisposers.push(
      runtime.services.register("marine", {
        createVessel,
        getVessel: id => vessels.get(id) ?? null,
        getAllVessels: () => [...vessels.values()],
        setVesselControls(id, controls) {
          const vessel = vessels.get(id);

          if (!vessel) {
            return { ok: false, reason: "vessel-not-found" };
          }

          vessel.throttle = transportClamp(
            transportFinite(controls.throttle),
            0,
            1
          );

          vessel.steering = transportClamp(
            transportFinite(controls.steering),
            -1,
            1
          );

          return { ok: true };
        },
        getSnapshot: () => ({
          vessels: vessels.size,
          yachts: [...vessels.values()].filter(
            v => v.classId === "yacht"
          ).length
        })
      })
    );

    serviceDisposers.push(
      runtime.services.register("publicTransport", {
        createStation,
        createTransitVehicle,

        getStation: id => stations.get(id) ?? null,
        getBus: id => buses.get(id) ?? null,
        getTrain: id => metroTrains.get(id) ?? null,
        boardPassenger,
        alightPassenger,

        getSnapshot: () => ({
          stations: stations.size,
          buses: buses.size,
          metroTrains: metroTrains.size
        })
      })
    );

    serviceDisposers.push(
      runtime.services.register("militaryZones", {
        registerMilitaryZone,
        checkRestrictedZone,
        checkPlayerRestrictedZone: (characterId, position) =>
          checkRestrictedZone({ id: characterId, type: "player", position }),
        setMilitaryZoneAlert,
        getZone: id => militaryZones.get(id) ?? null,
        getSnapshot: () => ({
          zones: militaryZones.size,
          alertLevels: [...militaryZones.values()].map(zone => ({
            id: zone.id,
            alertLevel: zone.alertLevel
          }))
        })
      })
    );

    eventDisposers.push(
      runtime.events.on("military:interceptionRequested", payload => {
        runtime.events.emit("police:airInterceptionRequested", payload);
      })
    );

    eventDisposers.push(
      runtime.events.on("vehicle:collision", payload => {
        if (!payload?.vehicleId) return;

        runtime.events.emit("transport:trafficIncident", {
          entityId: payload.vehicleId,
          type: "road-collision",
          speedMps: payload.speedMps
        });
      })
    );

    eventDisposers.push(
      runtime.events.on("transport:boardRequested", payload => {
        if (!payload) return;
        const result = boardPassenger(payload.transportId, payload.passengerId, {
          position: payload.position
        });
        runtime.events.emit("transport:boardRequestResolved", {
          ...payload,
          result
        });
      })
    );

    eventDisposers.push(
      runtime.events.on("transport:alightRequested", payload => {
        if (!payload) return;
        const result = alightPassenger(payload.transportId, payload.passengerId, {
          position: payload.position
        });
        runtime.events.emit("transport:alightRequestResolved", {
          ...payload,
          result
        });
      })
    );

    initialized = true;
    logger?.info?.("Aviation, marine and public transit initialized.", {
      runways: runways.size,
      aircraft: aircraft.size,
      vessels: vessels.size,
      stations: stations.size
    });

    return { ok: true };
  }

  function start() {
    if (disposed) return { ok: false, reason: "transport-system-disposed" };
    if (!initialized) return { ok: false, reason: "transport-system-not-initialized" };
    running = true;
    return { ok: true };
  }

  function update(context = {}) {
    if (!initialized || !running || disposed) return;

    const dt = transportClamp(
      transportFinite(context?.simulationDeltaSeconds ?? context?.gameDeltaSeconds),
      0,
      0.04
    );

    elapsed += dt;

    updateRunwayClosures();
    updateFlightScheduler();
    updateAirportPassengerOperations(dt);

    for (const record of aircraft.values()) {
      updateAircraft(record, dt);
    }

    for (const record of vessels.values()) {
      updateVessel(record, dt);
    }

    for (const record of buses.values()) {
      updateTransitVehicle(record, dt);
    }

    for (const record of metroTrains.values()) {
      updateTransitVehicle(record, dt);
    }

    for (const zone of militaryZones.values()) {
      if (
        zone.alertLevel > 0 &&
        elapsed - zone.lastAlertAt >= 100 &&
        elapsed - zone.lastDecayAt >= 30
      ) {
        const previous = zone.alertLevel;
        zone.alertLevel = Math.max(0, zone.alertLevel - 1);
        zone.lastDecayAt = elapsed;
        runtime.events.emit("military:alertChanged", {
          zoneId: zone.id,
          from: previous,
          to: zone.alertLevel,
          reason: "alert-decay"
        });
      }
    }
  }

  function stop() {
    // Stopping updates is a pause, not a simulated landing or cancellation.
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

    for (const record of aircraft.values()) {
      record.root.dispose(false, true);
      try { record.material.dispose(); } catch {}
    }

    for (const record of vessels.values()) {
      record.root.dispose(false, true);
    }

    for (const record of buses.values()) {
      record.root.dispose(false, true);
    }

    for (const record of metroTrains.values()) {
      record.root.dispose(false, true);
    }

    for (const agent of passengerAgents.values()) {
      try { agent.root.dispose(false, true); } catch {}
    }
    passengerAgents.clear();
    passengerOperations.clear();

    for (const object of airportObjects.values()) {
      object.dispose(false, true);
    }

    // Runway meshes are also held in airportObjects; dispose them once there.

    for (const material of Object.values(materials)) {
      try { material.dispose(); } catch {}
    }

    for (const record of aircraft.values()) {
      try { entities?.unregister?.(record.id); } catch {}
    }
    for (const record of vessels.values()) {
      try { entities?.unregister?.(record.id); } catch {}
    }
    for (const record of buses.values()) {
      try { entities?.unregister?.(record.id); } catch {}
    }
    for (const record of metroTrains.values()) {
      try { entities?.unregister?.(record.id); } catch {}
    }

    aircraft.clear();
    vessels.clear();
    buses.clear();
    metroTrains.clear();
    stations.clear();
    runways.clear();
    airportObjects.clear();
    airportGates.clear();
    parkingStands.clear();
    flightPlans.clear();
    militaryZones.clear();
  }

  return Object.freeze({
    initialize,
    start,
    update,
    stop,
    dispose,
    hijackAircraft,
    createAirportPassengerOperation
  });
}
