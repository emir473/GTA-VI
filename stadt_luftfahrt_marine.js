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
    wingAreaM2: 48,
    maxThrustN: 78000,
    stallSpeedMps: 40,
    rotationSpeedMps: 54,
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
    rotationSpeedMps: 72,
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

  const world = services.get("world");
  const water = services.get("water");
  const weather = services.get("weather");
  const vehicles = services.get("vehicles");

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

  const militaryZones = new Map();
  const eventDisposers = [];
  const serviceDisposers = [];

  const airportState = {
    airportId: "vice-city-international",
    name: "Vice City International Airport",
    operating: true,
    runwayReservation: new Map(),
    nextRunwayId: 1
  };

  /* --------------------------------------------------------------- */
  /* Shared materials and primitive models                           */
  /* --------------------------------------------------------------- */

  function makeMaterial(name, color, roughness = 0.65, metallic = 0.15) {
    const material = services.get("graphics")?.createPBRMaterial?.(
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
      logger.warn("Transport entity registry rejected entity.", {
        id,
        message: error.message
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

    const landingRunway = runways.get("runway-09-27");

    airportState.runwayReservation.set(
      landingRunway.id,
      null
    );

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

    runway.occupiedBy = aircraftId;
    runway.reservedUntil = elapsed +
      Math.max(1, durationSeconds);

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

      heading: transportFinite(options.heading),
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

      passengerCount: 0,
      passengerCapacity: classId === "airliner" ? 172 : 38,

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

  /* --------------------------------------------------------------- */
  /* Flight planning and dynamics                                     */
  /* --------------------------------------------------------------- */

  function assignFlightPlan(id, plan) {
    const record = aircraft.get(id);

    if (!record) return { ok: false, reason: "aircraft-not-found" };

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
      altitudeError * 0.0017,
      -0.45,
      0.45
    );

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
        0.25 +
        angleOfAttack * 4.9 +
        record.flaps * 0.55;

      liftCoefficient = transportClamp(
        liftCoefficient,
        -0.35,
        1.65
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
        liftN *= transportClamp(
          airSpeed / Math.max(1, profile.stallSpeedMps),
          0,
          1
        );
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

    record.rollRate = transportLerp(
      record.rollRate,
      (desiredRoll - record.roll) * 1.5,
      transportClamp(profile.rollRateRadS * dt, 0, 1)
    );

    record.pitchRate = transportLerp(
      record.pitchRate,
      (desiredPitch - record.pitch) * 1.8,
      transportClamp(profile.pitchRateRadS * 2 * dt, 0, 1)
    );

    record.yawRate = transportLerp(
      record.yawRate,
      record.rudder * profile.rollRateRadS * 0.55,
      transportClamp(dt * 1.5, 0, 1)
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

    if (record.pitch > Math.PI) record.pitch -= Math.PI * 2;
    if (record.pitch < -Math.PI) record.pitch += Math.PI * 2;
    if (record.heading > Math.PI) record.heading -= Math.PI * 2;
    if (record.heading < -Math.PI) record.heading += Math.PI * 2;

    record.root.position.copyFrom(record.position);
    record.root.rotation.set(record.pitch, record.heading, record.roll);

    if (record.rotor) {
      record.rotor.rotation.y += dt * (
        20 + record.throttle * 58
      );
    }
  }

  function setAircraftControls(id, controls) {
    const record = aircraft.get(id);

    if (!record || record.destroyed) {
      return { ok: false, reason: "aircraft-unavailable" };
    }

    record.autopilot = false;
    record.throttle = transportClamp(transportFinite(controls.throttle), 0, 1);
    record.elevator = transportClamp(transportFinite(controls.elevator), -1, 1);
    record.aileron = transportClamp(transportFinite(controls.aileron), -1, 1);
    record.rudder = transportClamp(transportFinite(controls.rudder), -1, 1);
    record.flaps = transportClamp(transportFinite(controls.flaps), 0, 1);

    return { ok: true };
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
    if (!isRunwayAvailable(runway)) {
      return { ok: false, reason: "runway-unavailable" };
    }

    const reservation = reserveRunway(
      runway.id,
      record.id,
      75
    );

    if (!reservation.ok) return reservation;

    record.runwayId = runway.id;
    record.position.copyFrom(runway.start);
    record.position.y += 1.6;
    record.heading = runway.heading;
    record.velocity.setAll(0);

    record.engineRunning = true;
    record.throttle = 1;

    record.flightPlan = {
      id: `departure-${record.id}`,
      waypointIndex: 0,
      waypoints: [
        runway.end.add(new B.Vector3(0, 95, 180)),
        runway.end.add(new B.Vector3(80, 420, 600)),
        runway.end.add(new B.Vector3(240, record.desiredAltitudeM, 1500))
      ],
      destination: runway.end.clone()
    };

    transitionFlightState(record, "takeoffRoll", "scheduled-departure");

    return { ok: true, runwayId: runway.id };
  }

  function startArrival(record, runway) {
    if (!isRunwayAvailable(runway)) {
      return { ok: false, reason: "runway-unavailable" };
    }

    const reservation = reserveRunway(
      runway.id,
      record.id,
      90
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

    const finalApproach = runway.start.clone();
    finalApproach.y += 45;

    record.flightPlan = {
      id: `arrival-${record.id}`,
      waypointIndex: 0,
      waypoints: [
        finalApproach.add(runway.direction.scale(-750)),
        finalApproach,
        runway.start.clone()
      ],
      destination: runway.start.clone()
    };

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

      case "taxi":
        record.throttle = 0.16;

        if (record.timeInCurrentState > 12) {
          if (runway && isRunwayAvailable(runway)) {
            startDeparture(record, runway);
          } else {
            transitionFlightState(record, "holding");
          }
        }
        break;

      case "takeoffRoll":
        record.throttle = 1;

        if (speed >= record.profile.rotationSpeedMps) {
          record.elevator = 0.7;
          record.autopilot = true;

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
          record.runwayId = null;
          record.engineRunning = false;

          transitionFlightState(record, "parking", "landing-roll-complete");
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

    const runway = [...runways.values()].find(isRunwayAvailable);

    if (!runway) {
      return { ok: false, reason: "no-runway-available" };
    }

    const classId = flightSequence % 3 === 0
      ? "airliner"
      : "commuter";

    const start = kind === "departure"
      ? runway.start
      : runway.start.add(new B.Vector3(-1200, 500, 900));

    const spawned = createAircraft({
      classId,
      position: start,
      heading: runway.heading,
      flightState: kind === "departure" ? "taxi" : "cruise",
      arrivalDeparture: kind,
      desiredAltitudeM: AVIATION_CONFIG.defaultCruiseAltitudeM,
      targetSpeedMps: AIRCRAFT_CLASSES[classId].cruiseSpeedMps,
      cargoFlight: flightSequence % 4 === 0
    });

    if (!spawned.ok) return spawned;

    const record = aircraft.get(spawned.aircraftId);
    record.runwayId = runway.id;

    if (kind === "arrival") {
      const result = startArrival(record, runway);

      if (!result.ok) {
        aircraft.delete(record.id);
        record.root.dispose(false, true);
        return result;
      }
    }

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

    const waterSample = water?.sampleWater?.(
      record.position,
      elapsed
    );

    const waterRegion = water?.getWaterRegionAt?.(
      record.position,
      { ignoreHeight: true }
    );

    const waveHeight = waterSample?.height ??
      record.position.y + profile.draftM;

    const localWind = weather?.getWindAt?.(record.position) ??
      B.Vector3.Zero();

    const windDrag = localWind
      .subtract(record.velocity)
      .scale(0.025 * profile.frontalAreaM2);

    const flow = waterSample?.flowVelocity ??
      B.Vector3.Zero();

    const relativeFlow = record.velocity.subtract(flow);

    const drag = relativeFlow.scale(
      -0.5 *
      1025 *
      profile.dragCoefficient *
      profile.beamM *
      Math.max(1, speed) /
      profile.massKg
    );

    const thrust = forward.scale(
      profile.maxThrustN *
      transportClamp(record.throttle, 0, 1) /
      profile.massKg
    );

    const buoyancyFraction = transportClamp(
      (waveHeight - record.position.y + profile.draftM * 0.25) /
      Math.max(0.1, profile.draftM),
      0,
      1.8
    );

    const verticalAcceleration =
      gravity * (buoyancyFraction - 1);

    const acceleration = thrust.add(drag).add(windDrag);
    record.velocity.addInPlace(acceleration.scale(dt));

    const maxSpeed = record.classId === "cargoShip"
      ? 11
      : record.classId === "yacht"
        ? 30
        : record.classId === "jetski"
          ? 27
          : 24;

    if (record.velocity.length() > maxSpeed) {
      record.velocity.normalize().scaleInPlace(maxSpeed);
    }

    record.position.addInPlace(record.velocity.scale(dt));

    const yawAcceleration =
      record.steering *
      profile.steeringRateRadS *
      transportClamp(speed / 5, 0.05, 1) -
      record.yawRate * 0.25;

    record.yawRate += yawAcceleration * dt;
    record.heading += record.yawRate * dt;

    const waveHeightRate = waterSample?.orbitalVelocity?.y ?? 0;

    record.pitch = transportClamp(
      waveHeightRate * 0.075 +
      Math.sin(elapsed * 0.35 + record.position.x * 0.01) *
        Math.min(0.055, speed * 0.002),
      -0.16,
      0.16
    );

    record.roll = transportClamp(
      record.yawRate * speed * 0.055 +
      Math.sin(elapsed * 0.28 + record.position.z * 0.013) *
        Math.min(0.09, speed * 0.003),
      -0.22,
      0.22
    );

    record.position.y = transportLerp(
      record.position.y,
      waveHeight - profile.draftM * 0.65,
      transportClamp(dt * 1.5, 0, 1)
    );

    record.root.position.copyFrom(record.position);
    record.root.rotation.set(
      record.pitch,
      record.heading,
      record.roll
    );

    if (record.throttle > 0.2 && record.engineRunning) {
      runtime.events.emit("audio:vehicleEngine", {
        entityId: record.id,
        category: "marine",
        speedMps: speed,
        throttle: record.throttle
      });
    }

    runtime.events.emit("marine:telemetry", {
      vesselId: record.id,
      speedMps: speed,
      heading: record.heading,
      waveHeightM: waveHeight,
      waterRegionId: waterRegion?.id ?? null,
      fuelLiters: record.fuelLiters
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
      state: "inService",
      passengerCount: 0,
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

    if (type === "metro") metroTrains.set(id, record);
    else buses.set(id, record);

    const registered = registerTransportEntity(id, {
      type: "public-transport",
      transportType: type,
      position: record.position,
      root,
      record
    });

    if (!registered.ok) {
      buses.delete(id);
      metroTrains.delete(id);
      root.dispose(false, true);

      return registered;
    }

    return { ok: true, id, record };
  }

  function updateTransitVehicle(record, dt) {
    if (!record.route?.length) return;

    if (record.dwellRemaining > 0) {
      record.dwellRemaining -= dt;
      record.doorState = "open";
      record.velocity.scaleInPlace(Math.exp(-dt * 5));
      return;
    }

    record.doorState = "closed";

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

      record.routeIndex =
        (record.routeIndex + 1) % record.route.length;

      return;
    }

    const desiredHeading = Math.atan2(dx, dz);
    let headingError = desiredHeading - record.yaw;

    while (headingError > Math.PI) headingError -= 2 * Math.PI;
    while (headingError < -Math.PI) headingError += 2 * Math.PI;

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

  function updateFlightScheduler() {
    if (elapsed < nextFlightScheduleAt) return;

    nextFlightScheduleAt +=
      AVIATION_CONFIG.gameSecondsBetweenFlights;

    // Schedule only one movement batch per interval. Delays do not spawn
    // an unbounded backlog if the game was paused or throttled.
    const departure = spawnScheduledFlight("departure");

    const arrival = [...runways.values()].some(isRunwayAvailable)
      ? spawnScheduledFlight("arrival")
      : { ok: false, reason: "no-runway-available" };

    runtime.events.emit("aviation:scheduleBatchProcessed", {
      at: elapsed,
      departure,
      arrival,
      nextScheduledAt: nextFlightScheduleAt
    });
  }

  function updateAircraft(record, dt) {
    if (record.destroyed) return;

    updateFlightStateMachine(record, dt);

    if (record.autopilot) {
      resolveFlightControls(record, dt);
    }

    const dynamics = calculateFlightForces(record, dt);
    updateFlightControlSurface(record, dt);

    if (
      record.position.y < 0 &&
      !["landingRoll", "parked", "taxi", "parking"].includes(
        record.flightState
      )
    ) {
      record.position.y = 0;
      record.velocity.y = Math.max(-10, record.velocity.y);
      record.health = Math.max(0, record.health - 1.5);

      transitionFlightState(record, "emergency", "ground-contact");
    }

    if (record.fuelKg > 0 && record.engineRunning) {
      record.fuelKg = Math.max(
        0,
        record.fuelKg -
        (0.015 + record.throttle * 0.1) * dt
      );
    }

    if (record.fuelKg <= 0) {
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
    if (initialized) return { ok: true };

    initialized = true;

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

    createTransitVehicle("bus", {
      id: "city-bus-route-01",
      route: [
        new B.Vector3(18, 0, -35),
        new B.Vector3(60, 0, 15),
        new B.Vector3(160, 0, 180),
        new B.Vector3(95, 0, 260),
        new B.Vector3(18, 0, -35)
      ]
    });

    createTransitVehicle("metro", {
      id: "metro-train-route-01",
      route: [
        new B.Vector3(10, -8, 0),
        new B.Vector3(75, -8, -90),
        new B.Vector3(175, -8, -150),
        new B.Vector3(280, -8, -225)
      ]
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

        reserveRunway,
        releaseRunway,
        closeRunway,

        getRunways: () => [...runways.values()],
        getAirportState: () => ({
          ...airportState,
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

    logger.info("Aviation, marine and public transit initialized.", {
      runways: runways.size,
      aircraft: aircraft.size,
      vessels: vessels.size,
      stations: stations.size
    });

    return { ok: true };
  }

  function start() {
    running = true;
    return { ok: true };
  }

  function update(context) {
    if (!initialized || !running || disposed) return;

    const dt = transportClamp(
      transportFinite(context.simulationDeltaSeconds ?? context.gameDeltaSeconds),
      0,
      0.04
    );

    elapsed += dt;

    updateRunwayClosures();
    updateFlightScheduler();

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
        elapsed - zone.lastAlertAt > 100
      ) {
        zone.alertLevel = Math.max(0, zone.alertLevel - 1);
      }
    }
  }

  function stop() {
    running = false;

    for (const runway of runways.values()) {
      if (runway.occupiedBy) {
        releaseRunway(runway.id, runway.occupiedBy);
      }
    }

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
      for (const part of record.visualParts) {
        if (!part.isDisposed()) part.dispose(false, true);
      }

      record.root.dispose(false, true);

      try { record.material.dispose(); } catch {}
    }

    for (const record of vessels.values()) {
      record.hull.dispose(false, true);
      record.cabin.dispose(false, true);
      record.root.dispose(false, true);
    }

    for (const record of buses.values()) {
      record.mesh.dispose(false, true);
      record.root.dispose(false, true);
    }

    for (const record of metroTrains.values()) {
      record.mesh.dispose(false, true);
      record.root.dispose(false, true);
    }

    for (const object of airportObjects.values()) {
      object.dispose(false, true);
    }

    for (const runway of runways.values()) {
      runway.mesh.dispose(false, true);
    }

    aircraft.clear();
    vessels.clear();
    buses.clear();
    metroTrains.clear();
    stations.clear();
    runways.clear();
    airportObjects.clear();
    flightPlans.clear();
    militaryZones.clear();
  }

  return Object.freeze({
    initialize,
    start,
    update,
    stop,
    dispose
  });
}
