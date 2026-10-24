/*
 * Module 10: fahrzeug_physik.js
 * Public services: vehicles, vehiclePhysics.
 *
 * Four-wheel suspension raycasts, torque curves, gearbox, traction,
 * slip, damage, fuel, theft, trailers and vehicle delivery.
 * No independent Babylon engine or Scene is created.
 */

const VEHICLE_CLASSES = Object.freeze({
  sedan: {
    massKg: 1560,
    wheelbaseM: 2.72,
    trackWidthM: 1.58,
    lengthM: 4.72,
    widthM: 1.82,
    heightM: 1.45,
    wheelRadiusM: 0.335,
    suspensionTravelM: 0.34,
    springRateNpm: 31000,
    damperNspm: 3400,
    steeringMaxRad: 0.53,
    maxSteeringSpeedMps: 18,
    dragCoefficient: 0.29,
    frontalAreaM2: 2.15,
    maxRpm: 6500,
    idleRpm: 780,
    peakTorqueNm: 260,
    maxPowerW: 125000,
    gears: [3.7, 2.1, 1.4, 1.0, 0.82, 0.68],
    finalDrive: 3.55,
    drive: "fwd",
    tireGrip: 1.0,
    brakeTorqueNm: 4800,
    fuelCapacityL: 58,
    maxSpeedMps: 57,
    color: "#526a7a"
  },

  coupe: {
    massKg: 1470,
    wheelbaseM: 2.64,
    trackWidthM: 1.55,
    lengthM: 4.52,
    widthM: 1.86,
    heightM: 1.31,
    wheelRadiusM: 0.34,
    suspensionTravelM: 0.29,
    springRateNpm: 37000,
    damperNspm: 4100,
    steeringMaxRad: 0.49,
    maxSteeringSpeedMps: 21,
    dragCoefficient: 0.27,
    frontalAreaM2: 2.04,
    maxRpm: 7200,
    idleRpm: 850,
    peakTorqueNm: 315,
    maxPowerW: 205000,
    gears: [3.1, 2.05, 1.52, 1.19, 0.95, 0.78],
    finalDrive: 3.7,
    drive: "rwd",
    tireGrip: 1.14,
    brakeTorqueNm: 5700,
    fuelCapacityL: 62,
    maxSpeedMps: 82,
    color: "#a54b40"
  },

  sports: {
    massKg: 1380,
    wheelbaseM: 2.61,
    trackWidthM: 1.62,
    lengthM: 4.45,
    widthM: 1.94,
    heightM: 1.23,
    wheelRadiusM: 0.35,
    suspensionTravelM: 0.22,
    springRateNpm: 48000,
    damperNspm: 5200,
    steeringMaxRad: 0.47,
    maxSteeringSpeedMps: 24,
    dragCoefficient: 0.25,
    frontalAreaM2: 1.98,
    maxRpm: 7900,
    idleRpm: 900,
    peakTorqueNm: 395,
    maxPowerW: 335000,
    gears: [3.0, 2.15, 1.56, 1.22, 0.97, 0.81, 0.69],
    finalDrive: 3.45,
    drive: "rwd",
    tireGrip: 1.26,
    brakeTorqueNm: 7100,
    fuelCapacityL: 64,
    maxSpeedMps: 96,
    color: "#24685b"
  },

  taxi: {
    massKg: 1740,
    wheelbaseM: 2.92,
    trackWidthM: 1.62,
    lengthM: 5.02,
    widthM: 1.91,
    heightM: 1.53,
    wheelRadiusM: 0.34,
    suspensionTravelM: 0.40,
    springRateNpm: 34000,
    damperNspm: 3800,
    steeringMaxRad: 0.50,
    maxSteeringSpeedMps: 16,
    dragCoefficient: 0.32,
    frontalAreaM2: 2.35,
    maxRpm: 6000,
    idleRpm: 750,
    peakTorqueNm: 285,
    maxPowerW: 148000,
    gears: [3.6, 2.15, 1.43, 1.0, 0.75],
    finalDrive: 3.3,
    drive: "rwd",
    tireGrip: 0.94,
    brakeTorqueNm: 5100,
    fuelCapacityL: 68,
    maxSpeedMps: 54,
    color: "#dfc247"
  },

  truck: {
    massKg: 4200,
    wheelbaseM: 3.72,
    trackWidthM: 1.84,
    lengthM: 6.2,
    widthM: 2.2,
    heightM: 2.3,
    wheelRadiusM: 0.44,
    suspensionTravelM: 0.46,
    springRateNpm: 78000,
    damperNspm: 7600,
    steeringMaxRad: 0.48,
    maxSteeringSpeedMps: 13,
    dragCoefficient: 0.48,
    frontalAreaM2: 4.9,
    maxRpm: 4800,
    idleRpm: 650,
    peakTorqueNm: 650,
    maxPowerW: 240000,
    gears: [4.7, 3.1, 2.1, 1.5, 1.0, 0.75],
    finalDrive: 4.2,
    drive: "rwd",
    tireGrip: 0.91,
    brakeTorqueNm: 9500,
    fuelCapacityL: 110,
    maxSpeedMps: 38,
    color: "#77786c"
  }
});

const VEHICLE_SURFACES = Object.freeze({
  asphalt: { grip: 1.00, rollingResistance: 0.014 },
  "asphalt-highway": { grip: 1.02, rollingResistance: 0.012 },
  sidewalk: { grip: 0.72, rollingResistance: 0.035 },
  gravel: { grip: 0.70, rollingResistance: 0.045 },
  mud: { grip: 0.45, rollingResistance: 0.095 },
  sand: { grip: 0.58, rollingResistance: 0.075 },
  terrain: { grip: 0.68, rollingResistance: 0.055 },
  ice: { grip: 0.16, rollingResistance: 0.012 }
});

function vehicleClamp(value, min, max) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}

function vehicleFinite(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function vehicleLerp(a, b, t) {
  return a + (b - a) * t;
}

function vehicleSmoothstep(t) {
  const v = vehicleClamp(t, 0, 1);
  return v * v * (3 - 2 * v);
}

export async function createVehiclePhysicsSystem({
  runtime,
  scene,
  engine,
  camera,
  services,
  entities,
  logger
}) {
  if (!runtime || !scene) {
    throw new TypeError("Vehicle physics requires the shared scene and runtime.");
  }

  const B = globalThis.BABYLON;
  if (!B) throw new Error("Babylon.js is unavailable.");

  const graphics = services.get("graphics");
  const world = services.get("world");
  const weather = services.get("weather");
  const player = services.get("player");

  let elapsed = 0;
  let initialized = false;
  let running = false;
  let disposed = false;

  let nextVehicleId = 1;
  let nextDamageId = 1;

  const vehicles = new Map();
  const eventDisposers = [];
  const serviceDisposers = [];
  const activeTrailers = new Map();
  const detachedParts = new Set();

  const gravity = 9.81;
  const airDensity = 1.225;

  function makeMaterial(name, color, roughness = 0.65, metallic = 0.12) {
    const material = graphics?.createPBRMaterial?.(name, {
      albedo: color,
      roughness,
      metallic
    });

    if (material) return material;

    const fallback = new B.StandardMaterial(name, scene);
    fallback.diffuseColor = B.Color3.FromHexString(color);
    fallback.specularColor = new B.Color3(0.17, 0.17, 0.17);
    return fallback;
  }

  const materials = {
    glass: makeMaterial("vehicle-glass", "#293f4a", 0.17, 0.32),
    tire: makeMaterial("vehicle-tire", "#17191c", 0.95, 0),
    alloy: makeMaterial("vehicle-alloy", "#8c969e", 0.29, 0.8),
    interior: makeMaterial("vehicle-interior", "#24272b", 0.82, 0.04),
    trim: makeMaterial("vehicle-trim", "#30353a", 0.52, 0.35),
    lamp: makeMaterial("vehicle-lamp", "#e5dfbc", 0.28, 0.05),
    redLamp: makeMaterial("vehicle-red-lamp", "#bc3434", 0.3, 0.04)
  };

  function engineTorqueFraction(rpm, profile) {
    const normalized = vehicleClamp(
      rpm / profile.maxRpm,
      0,
      1.15
    );

    // A tunable curve with low-speed torque, midrange peak and high-RPM
    // taper; it is not a flat torque multiplier.
    const lowEnd = vehicleSmoothstep(normalized / 0.28);
    const midPeak = Math.exp(-Math.pow((normalized - 0.56) / 0.29, 2));
    const highEndTaper = 1 - 0.36 * vehicleSmoothstep(
      (normalized - 0.79) / 0.19
    );

    return vehicleClamp(
      (0.42 + 0.32 * lowEnd + 0.26 * midPeak) *
        highEndTaper,
      0.18,
      1.02
    );
  }

  function createVehicleBodyVisuals(record) {
    const { id, profile, root } = record;

    const body = B.MeshBuilder.CreateBox(
      `vehicle-${id}-body`,
      {
        width: profile.widthM,
        height: profile.heightM * 0.46,
        depth: profile.lengthM * 0.78
      },
      scene
    );

    body.parent = root;
    body.position.y = profile.wheelRadiusM + profile.heightM * 0.27;
    body.material = record.material;
    body.isPickable = true;

    body.metadata = {
      ...(body.metadata || {}),
      vehicleId: id,
      isVehicle: true,
      blocksPlayer: false
    };

    const cabin = B.MeshBuilder.CreateBox(
      `vehicle-${id}-cabin`,
      {
        width: profile.widthM * 0.78,
        height: profile.heightM * 0.38,
        depth: profile.lengthM * 0.42
      },
      scene
    );

    cabin.parent = root;
    cabin.position.set(
      0,
      profile.wheelRadiusM + profile.heightM * 0.62,
      -profile.lengthM * 0.025
    );

    cabin.material = materials.glass;
    cabin.isPickable = true;

    cabin.metadata = {
      ...(cabin.metadata || {}),
      vehicleId: id,
      isVehicle: true,
      materialClass: "glass",
      materialThicknessM: 0.006,
      penetrationResistanceJPerM: 1200,
      blocksPlayer: false
    };

    const lower = B.MeshBuilder.CreateBox(
      `vehicle-${id}-lower-trim`,
      {
        width: profile.widthM * 0.95,
        height: profile.heightM * 0.08,
        depth: profile.lengthM * 0.81
      },
      scene
    );

    lower.parent = root;
    lower.position.y = profile.wheelRadiusM + profile.heightM * 0.045;
    lower.material = materials.trim;
    lower.isPickable = true;

    lower.metadata = {
      ...(lower.metadata || {}),
      vehicleId: id,
      isVehicle: true,
      blocksPlayer: false
    };

    const wheels = [];

    for (const axle of [-1, 1]) {
      for (const side of [-1, 1]) {
        const front = axle === 1;

        const pivot = new B.TransformNode(
          `vehicle-${id}-wheel-pivot-${axle}-${side}`,
          scene
        );

        pivot.parent = root;

        pivot.position.set(
          side * profile.trackWidthM * 0.5,
          profile.wheelRadiusM,
          axle * profile.wheelbaseM * 0.5
        );

        const tire = B.MeshBuilder.CreateCylinder(
          `vehicle-${id}-tire-${axle}-${side}`,
          {
            height: 0.22,
            diameter: profile.wheelRadiusM * 2,
            tessellation: 20
          },
          scene
        );

        tire.parent = pivot;
        tire.rotation.z = Math.PI / 2;
        tire.material = materials.tire;
        tire.isPickable = false;

        const alloy = B.MeshBuilder.CreateCylinder(
          `vehicle-${id}-alloy-${axle}-${side}`,
          {
            height: 0.225,
            diameter: profile.wheelRadiusM * 1.14,
            tessellation: 12
          },
          scene
        );

        alloy.parent = pivot;
        alloy.rotation.z = Math.PI / 2;
        alloy.material = materials.alloy;
        alloy.isPickable = false;

        wheels.push({
          axle,
          side,
          front,
          pivot,
          tire,
          alloy,
          spinAngle: 0,
          suspensionLengthM: profile.suspensionTravelM,
          compressionM: 0,
          grounded: false,
          normalForceN: 0,
          slipRatio: 0,
          slipAngleRad: 0,
          surface: "asphalt"
        });
      }
    }

    const headlights = [];

    for (const side of [-1, 1]) {
      const lamp = B.MeshBuilder.CreateBox(
        `vehicle-${id}-headlamp-${side}`,
        {
          width: 0.19,
          height: 0.12,
          depth: 0.05
        },
        scene
      );

      lamp.parent = root;
      lamp.position.set(
        side * profile.widthM * 0.31,
        profile.wheelRadiusM + profile.heightM * 0.33,
        profile.lengthM * 0.41
      );

      lamp.material = materials.lamp;
      lamp.isPickable = false;
      headlights.push(lamp);

      const tail = B.MeshBuilder.CreateBox(
        `vehicle-${id}-tail-lamp-${side}`,
        {
          width: 0.2,
          height: 0.14,
          depth: 0.05
        },
        scene
      );

      tail.parent = root;
      tail.position.set(
        side * profile.widthM * 0.33,
        profile.wheelRadiusM + profile.heightM * 0.30,
        -profile.lengthM * 0.41
      );

      tail.material = materials.redLamp;
      tail.isPickable = false;

      record.visualParts.add(tail);
    }

    record.visualParts.add(body, cabin, lower);

    for (const wheel of wheels) {
      record.visualParts.add(
        wheel.pivot,
        wheel.tire,
        wheel.alloy
      );
    }

    for (const lamp of headlights) record.visualParts.add(lamp);

    return { body, cabin, lower, wheels, headlights };
  }

  function createVehicle(options = {}) {
    const classId = options.classId ?? "sedan";
    const sourceProfile = VEHICLE_CLASSES[classId];

    if (!sourceProfile) {
      return { ok: false, reason: "unknown-vehicle-class" };
    }

    const id = options.id ?? `vehicle-${nextVehicleId++}`;

    if (vehicles.has(id)) {
      return { ok: false, reason: "duplicate-vehicle-id" };
    }

    const profile = {
      ...sourceProfile,
      ...(options.profile ?? {})
    };

    const root = new B.TransformNode(`vehicle-root-${id}`, scene);

    root.position.copyFrom(
      options.position
        ? new B.Vector3(
            options.position.x,
            options.position.y ?? 0,
            options.position.z
          )
        : B.Vector3.Zero()
    );

    root.rotation.y = vehicleFinite(options.heading, 0);

    const color = options.color ?? profile.color;

    const material = makeMaterial(
      `vehicle-body-material-${id}`,
      color,
      0.32,
      0.36
    );

    const record = {
      id,
      classId,
      profile,
      root,
      material,
      visualParts: new Set(),

      position: root.position,
      velocity: new B.Vector3(0, 0, 0),
      yaw: root.rotation.y,
      yawRateRadS: 0,
      pitchRad: 0,
      rollRad: 0,

      engineRPM: profile.idleRpm,
      gearIndex: 0,
      driveDirection: 1,
      throttle: 0,
      brake: 0,
      steering: 0,
      handbrake: false,

      health: 100,
      damage: {
        engine: 0,
        cooling: 0,
        transmission: 0,
        suspension: [0, 0, 0, 0],
        tireWear: [0, 0, 0, 0],
        bodyIntegrity: 1
      },

      fuelLiters: profile.fuelCapacityL * 0.72,
      fuelLeakLitersPerSecond: 0,
      fuelLeakActive: false,
      engineRunning: true,

      ownerId: options.ownerId ?? null,
      owned: options.owned === true,
      stolen: false,
      alarmArmed: options.alarmArmed === true,
      alarmTriggered: false,
      lockState: options.lockState ?? "unlocked",

      driverId: null,
      passengerIds: [],
      depot: [],
      tuning: {
        engineFactor: 1,
        brakeFactor: 1,
        suspensionFactor: 1,
        tireGripFactor: 1,
        paintColor: color,
        spoiler: false,
        wheelStyle: "standard"
      },

      autopilot: null,
      trailerId: null,

      wheelStates: [],
      groundContacts: 0,
      averageSuspensionCompression: 0,

      lastImpactTime: -Infinity,
      lastSafePosition: root.position.clone(),
      delivered: false,
      destroyed: false,

      metadata: {
        taxiService: classId === "taxi",
        source: options.source ?? "world"
      }
    };

    const visuals = createVehicleBodyVisuals(record);
    record.bodyMesh = visuals.body;
    record.cabinMesh = visuals.cabin;
    record.wheels = visuals.wheels;
    record.headlights = visuals.headlights;

    record.wheelStates = record.wheels.map(() => ({
      compressionM: 0,
      grounded: false,
      normalForceN: 0,
      slipRatio: 0,
      slipAngleRad: 0,
      surface: "asphalt"
    }));

    record.wheels.forEach((wheel, index) => {
      wheel.state = record.wheelStates[index];
    });

    vehicles.set(id, record);

    try {
      entities.register(id, {
        id,
        type: "vehicle",
        classId,
        position: root.position,
        root,
        record
      });
    } catch (error) {
      vehicles.delete(id);
      root.dispose(false, true);
      material.dispose();

      return {
        ok: false,
        reason: "entity-registry-rejected",
        message: error.message
      };
    }

    runtime.events.emit("vehicle:created", {
      vehicleId: id,
      classId,
      position: record.position.clone()
    });

    return { ok: true, vehicleId: id, vehicle: record };
  }

  function getVehicle(id) {
    return vehicles.get(id) ?? null;
  }

  function getOwnedVehicles(characterId = null) {
    return [...vehicles.values()]
      .filter(vehicle =>
        vehicle.owned &&
        (!characterId || vehicle.ownerId === characterId)
      )
      .map(vehicle => ({
        id: vehicle.id,
        name: vehicle.classId,
        description: `${vehicle.classId} · ${Math.round(
          vehicle.fuelLiters
        )} L fuel`,
        fuelLiters: vehicle.fuelLiters,
        health: vehicle.health,
        status: vehicle.destroyed
          ? "destroyed"
          : vehicle.driverId ? "in use" : "available"
      }));
  }

  function getVehicleForward(vehicle) {
    return new B.Vector3(
      Math.sin(vehicle.yaw),
      0,
      Math.cos(vehicle.yaw)
    );
  }

  function getVehicleRight(vehicle) {
    return new B.Vector3(
      Math.cos(vehicle.yaw),
      0,
      -Math.sin(vehicle.yaw)
    );
  }

  function transformLocal(vehicle, localPosition) {
    vehicle.root.computeWorldMatrix(true);

    return B.Vector3.TransformCoordinates(
      localPosition,
      vehicle.root.getWorldMatrix()
    );
  }

  function raycastGround(origin, maximumDistance) {
    const ray = new B.Ray(
      origin,
      new B.Vector3(0, -1, 0),
      maximumDistance
    );

    return scene.pickWithRay(
      ray,
      mesh =>
        mesh.isEnabled() &&
        mesh.isVisible &&
        mesh.metadata?.isWalkable === true &&
        mesh.metadata?.isWaterSurface !== true,
      false
    );
  }

  function sampleSurface(position) {
    const road = world?.closestPointOnRoad?.(position, 80);
    const weatherEffects = weather?.getSurfaceEffectsAt?.(position);

    let surface = road && road.distance < 12
      ? road.type === "highway"
        ? "asphalt-highway"
        : "asphalt"
      : "terrain";

    if (world?.regionAt?.(position.x, position.z) === "wetlands") {
      surface = "mud";
    }

    if (world?.regionAt?.(position.x, position.z) === "coastal") {
      surface = "sand";
    }

    const profile = VEHICLE_SURFACES[surface] ??
      VEHICLE_SURFACES.terrain;

    const wetness = vehicleClamp(
      vehicleFinite(weatherEffects?.wetness),
      0,
      1
    );

    return {
      surface,
      dryGrip: profile.grip,
      grip: profile.grip * (1 - wetness * 0.34),
      rollingResistance: profile.rollingResistance *
        (1 + wetness * 0.14),
      wetness,
      weatherEffects,
      road
    };
  }

  function updateSuspension(vehicle, dt) {
    let contacts = 0;
    let totalCompression = 0;

    for (let i = 0; i < vehicle.wheels.length; i++) {
      const wheel = vehicle.wheels[i];
      const profile = vehicle.profile;

      const mountLocal = new B.Vector3(
        wheel.side * profile.trackWidthM * 0.5,
        profile.wheelRadiusM + profile.suspensionTravelM + 0.12,
        wheel.axle * profile.wheelbaseM * 0.5
      );

      const origin = transformLocal(vehicle, mountLocal);

      const rayLength =
        profile.suspensionTravelM +
        profile.wheelRadiusM +
        0.35;

      const hit = raycastGround(origin, rayLength);
      const wheelState = vehicle.wheelStates[i];

      if (hit?.hit && hit.pickedPoint) {
        const contactDistance = hit.distance;
        const suspensionLength = Math.max(
          0,
          contactDistance - profile.wheelRadiusM
        );

        const compression = vehicleClamp(
          profile.suspensionTravelM - suspensionLength,
          0,
          profile.suspensionTravelM
        );

        const compressionVelocity =
          (compression - wheelState.compressionM) /
          Math.max(0.001, dt);

        const springRate =
          profile.springRateNpm *
          vehicle.tuning.suspensionFactor;

        const springForce = springRate * compression;
        const damperForce =
          profile.damperNspm * compressionVelocity;

        const normalForce = vehicleClamp(
          springForce + damperForce,
          0,
          vehicle.profile.massKg * gravity * 2.4
        );

        wheelState.compressionM = compression;
        wheelState.grounded = true;
        wheelState.normalForceN = normalForce;
        wheelState.surface = sampleSurface(hit.pickedPoint).surface;

        contacts++;
        totalCompression += compression;
      } else {
        wheelState.compressionM = vehicleLerp(
          wheelState.compressionM,
          0,
          vehicleClamp(dt * 4, 0, 1)
        );

        wheelState.grounded = false;
        wheelState.normalForceN = 0;
        wheelState.surface = "air";
      }

      wheel.state = wheelState;

      wheel.pivot.position.y =
        profile.wheelRadiusM + wheelState.compressionM;

      if (wheel.front) {
        wheel.pivot.rotation.y =
          vehicle.steering *
          vehicleClamp(1 - Math.abs(vehicle.velocity.length()) /
            70, 0.18, 1);
      }

      wheel.spinAngle += (
        B.Vector3.Dot(vehicle.velocity, getVehicleForward(vehicle)) /
        Math.max(0.01, profile.wheelRadiusM)
      ) * dt;

      wheel.tire.rotation.x = wheel.spinAngle;
      wheel.alloy.rotation.x = wheel.spinAngle;
    }

    vehicle.groundContacts = contacts;

    vehicle.averageSuspensionCompression =
      contacts > 0 ? totalCompression / contacts : 0;

    const compressionBySide = (side) => {
      const selected = vehicle.wheelStates.filter(
        (_, i) => vehicle.wheels[i].side === side
      );

      return selected.reduce(
        (sum, wheel) => sum + wheel.compressionM,
        0
      ) / Math.max(1, selected.length);
    };

    const leftCompression = compressionBySide(-1);
    const rightCompression = compressionBySide(1);

    const rollTarget = vehicleClamp(
      (rightCompression - leftCompression) * 0.55,
      -0.22,
      0.22
    );

    vehicle.rollRad = vehicleLerp(
      vehicle.rollRad,
      rollTarget,
      vehicleClamp(dt * 5, 0, 1)
    );
  }

  function updateAutomaticGear(vehicle, forwardSpeed) {
    const profile = vehicle.profile;
    const gearCount = profile.gears.length;

    if (vehicle.driveDirection < 0) {
      vehicle.gearIndex = 0;
      return;
    }

    const gearRatio = profile.gears[vehicle.gearIndex];
    const wheelRpm =
      Math.abs(forwardSpeed) /
      (2 * Math.PI * profile.wheelRadiusM) * 60;

    const targetRpm = Math.max(
      profile.idleRpm,
      wheelRpm * gearRatio * profile.finalDrive
    );

    vehicle.engineRPM = vehicleLerp(
      vehicle.engineRPM,
      Math.min(profile.maxRpm, targetRpm),
      vehicleClamp(4.5 * 0.016, 0, 1)
    );

    if (
      vehicle.engineRPM > profile.maxRpm * 0.90 &&
      vehicle.gearIndex < gearCount - 1
    ) {
      vehicle.gearIndex++;
    } else if (
      vehicle.engineRPM < profile.maxRpm * 0.34 &&
      vehicle.gearIndex > 0
    ) {
      vehicle.gearIndex--;
    }
  }

  function updateVehicleHandling(vehicle, input, dt) {
    const profile = vehicle.profile;
    const forward = getVehicleForward(vehicle);
    const right = getVehicleRight(vehicle);

    const velocity = vehicle.velocity;

    const forwardSpeed = B.Vector3.Dot(velocity, forward);
    const lateralSpeed = B.Vector3.Dot(velocity, right);
    const totalSpeed = velocity.length();

    const currentSurface = sampleSurface(vehicle.position);
    const weatherEffects = currentSurface.weatherEffects;

    const waterDepth = weather?.getSurfaceEffectsAt?.(
      vehicle.position
    )?.waterDepthM ?? 0;

    const hydroplaning = currentSurface.wetness > 0.5 &&
      totalSpeed > 23 &&
      waterDepth > 0.008;

    const hydroplaningFactor = hydroplaning
      ? vehicleClamp(
          1 - (totalSpeed - 23) / 35,
          0.22,
          0.60
        )
      : 1;

    const tireGrip = currentSurface.grip *
      profile.tireGrip *
      vehicle.tuning.tireGripFactor *
      hydroplaningFactor;

    vehicle.throttle = vehicleClamp(
      vehicleFinite(input.throttle),
      0,
      1
    );

    vehicle.brake = vehicleClamp(
      vehicleFinite(input.brake),
      0,
      1
    );

    vehicle.steering = vehicleClamp(
      vehicleFinite(input.steering),
      -1,
      1
    );

    vehicle.handbrake = input.handbrake === true;

    if (!vehicle.engineRunning || vehicle.fuelLiters <= 0) {
      vehicle.throttle = 0;
    }

    const wheelOmega =
      Math.abs(forwardSpeed) / Math.max(0.01, profile.wheelRadiusM);

    const currentGear =
      profile.gears[vehicle.gearIndex] ?? 1;

    const rpmFraction = engineTorqueFraction(
      vehicle.engineRPM,
      profile
    );

    const engineTorque =
      profile.peakTorqueNm *
      rpmFraction *
      vehicle.tuning.engineFactor;

    const wheelTorque =
      engineTorque *
      currentGear *
      profile.finalDrive *
      (profile.drive === "awd" ? 0.90 : 0.88);

    const engineForceN =
      wheelTorque / Math.max(0.01, profile.wheelRadiusM);

    const drivenFraction = profile.drive === "fwd"
      ? 0.48
      : profile.drive === "awd"
        ? 0.85
        : 0.55;

    const maxTractionForce =
      profile.massKg * gravity * tireGrip * drivenFraction;

    const driveForce = vehicleClamp(
      engineForceN * vehicle.throttle,
      0,
      maxTractionForce
    );

    const longitudinalBrakeForce =
      (profile.brakeTorqueNm *
        vehicle.tuning.brakeFactor /
        Math.max(0.01, profile.wheelRadiusM)) *
      vehicle.brake;

    const handbrakeForce = vehicle.handbrake
      ? profile.massKg * gravity * tireGrip * 0.72
      : 0;

    let longitudinalAcceleration =
      (driveForce -
        Math.sign(forwardSpeed) *
          (longitudinalBrakeForce + handbrakeForce)) /
      profile.massKg;

    if (Math.abs(forwardSpeed) < 0.5 && vehicle.brake > 0.7) {
      longitudinalAcceleration = 0;
    }

    const rollingForce =
      Math.sign(forwardSpeed) *
      profile.massKg *
      gravity *
      currentSurface.rollingResistance;

    const aerodynamicForce =
      0.5 *
      airDensity *
      profile.dragCoefficient *
      profile.frontalAreaM2 *
      totalSpeed *
      totalSpeed;

    longitudinalAcceleration -= (
      rollingForce +
      Math.sign(forwardSpeed) * aerodynamicForce
    ) / profile.massKg;

    if (vehicle.groundContacts === 0) {
      longitudinalAcceleration *= 0.35;
    }

    const speedRatio = vehicleClamp(
      totalSpeed / profile.maxSpeedMps,
      0,
      1.4
    );

    if (forwardSpeed > profile.maxSpeedMps && longitudinalAcceleration > 0) {
      longitudinalAcceleration = 0;
    }

    const yawSpeedFactor = vehicleClamp(
      totalSpeed / profile.maxSteeringSpeedMps,
      0.08,
      1
    );

    const steeringAngle =
      vehicle.steering *
      profile.steeringMaxRad *
      (1 - speedRatio * 0.24);

    const yawRate =
      (forwardSpeed / Math.max(0.2, profile.wheelbaseM)) *
      Math.tan(steeringAngle) *
      yawSpeedFactor *
      (1 - vehicle.damage.suspension[0] * 0.25);

    vehicle.yawRateRadS = vehicleLerp(
      vehicle.yawRateRadS,
      yawRate,
      vehicleClamp(dt * 5.5, 0, 1)
    );

    vehicle.yaw += vehicle.yawRateRadS * dt;

    const maxLateralForce =
      profile.massKg * gravity * tireGrip;

    let lateralForce =
      -lateralSpeed *
      profile.massKg *
      vehicleClamp(tireGrip * 3.1, 0.25, 5.2);

    lateralForce = vehicleClamp(
      lateralForce,
      -maxLateralForce,
      maxLateralForce
    );

    if (vehicle.handbrake) {
      lateralForce *= 0.28;
    }

    const longitudinalDelta = forward.scale(
      longitudinalAcceleration * dt
    );

    const lateralDelta = right.scale(
      lateralForce / profile.massKg * dt
    );

    velocity.addInPlace(longitudinalDelta);
    velocity.addInPlace(lateralDelta);

    // A stationary vehicle cannot retain an impossible small residual drift.
    if (
      vehicle.brake > 0.9 &&
      Math.abs(forwardSpeed) < 0.15 &&
      Math.abs(lateralSpeed) < 0.15
    ) {
      velocity.x = 0;
      velocity.z = 0;
    }

    const travelDistance = velocity.length() * dt;

    const collision = resolveVehicleCollision(vehicle, travelDistance);

    if (!collision) {
      vehicle.position.x += velocity.x * dt;
      vehicle.position.z += velocity.z * dt;
    }

    vehicle.position.y = getGroundReferenceY(vehicle);

    updateSuspension(vehicle, dt);

    vehicle.pitchRad = vehicleLerp(
      vehicle.pitchRad,
      vehicle.throttle > vehicle.brake
        ? -vehicle.throttle * 0.045
        : vehicle.brake > 0
          ? vehicle.brake * 0.065
          : 0,
      vehicleClamp(dt * 3.4, 0, 1)
    );

    vehicle.root.position.copyFrom(vehicle.position);
    vehicle.root.rotation.set(
      vehicle.pitchRad,
      vehicle.yaw,
      vehicle.rollRad
    );

    updateFuel(vehicle, totalSpeed, dt);

    if (vehicle.damage.engine > 0.88) {
      vehicle.engineRunning = false;
      vehicle.throttle = 0;
    }

    runtime.events.emit("vehicle:telemetry", {
      vehicleId: vehicle.id,
      speedMps: vehicle.velocity.length(),
      forwardSpeedMps: forwardSpeed,
      lateralSpeedMps: lateralSpeed,
      engineRPM: vehicle.engineRPM,
      gear: vehicle.gearIndex + 1,
      steering: vehicle.steering,
      throttle: vehicle.throttle,
      brake: vehicle.brake,
      fuelLiters: vehicle.fuelLiters,
      surface: currentSurface.surface,
      wetness: currentSurface.wetness,
      hydroplaning,
      tireGrip
    });

    return {
      longitudinalAcceleration,
      forwardSpeed,
      lateralSpeed,
      totalSpeed,
      surface: currentSurface.surface,
      wetness: currentSurface.wetness,
      hydroplaning,
      tireGrip
    };
  }

  function getGroundReferenceY(vehicle) {
    const ground = world?.sampleGroundHeight?.(
      vehicle.position.x,
      vehicle.position.z
    );

    if (Number.isFinite(ground)) return ground;

    const hit = raycastGround(
      vehicle.position.add(new B.Vector3(0, 3, 0)),
      30
    );

    if (hit?.hit && hit.pickedPoint) return hit.pickedPoint.y;

    return vehicle.position.y;
  }

  function resolveVehicleCollision(vehicle, travelDistance) {
    const velocity = vehicle.velocity;
    const speed = velocity.length();

    if (speed < 0.15) return false;

    const direction = velocity.normalize();
    const start = vehicle.position.add(new B.Vector3(0, 0.75, 0));

    const ray = new B.Ray(
      start,
      direction,
      Math.max(
        vehicle.profile.lengthM * 0.42,
        travelDistance + 0.5
      )
    );

    const hit = scene.pickWithRay(
      ray,
      mesh => {
        if (!mesh || mesh.isDisposed()) return false;
        if (!mesh.isEnabled() || !mesh.isVisible) return false;
        if (mesh.metadata?.vehicleId === vehicle.id) return false;

        return mesh.metadata?.blocksPlayer === true ||
          mesh.metadata?.isVehicle === true;
      },
      false
    );

    if (!hit?.hit || hit.distance > travelDistance + 0.4) {
      return false;
    }

    const relativeSpeed = speed;
    const impactEnergyJ =
      0.5 * vehicle.profile.massKg *
      relativeSpeed * relativeSpeed;

    const damage = vehicleClamp(
      impactEnergyJ / 125000,
      0,
      55
    );

    vehicle.health = Math.max(0, vehicle.health - damage);
    vehicle.damage.bodyIntegrity = vehicleClamp(
      vehicle.damage.bodyIntegrity - damage / 100,
      0,
      1
    );

    vehicle.lastImpactTime = elapsed;

    // Restitution produces a bounded impulse; the vehicle is not
    // teleported through the obstacle or given an unbounded velocity.
    const restitution = vehicleClamp(
      vehicle.damage.bodyIntegrity * 0.23,
      0,
      0.23
    );

    velocity.scaleInPlace(-restitution);

    if (vehicle.health <= 0) {
      vehicle.destroyed = true;
      vehicle.engineRunning = false;
    }

    runtime.events.emit("vehicle:damaged", {
      vehicleId: vehicle.id,
      damage,
      impactEnergyJ,
      targetEntityId: hit.pickedMesh?.metadata?.vehicleId ?? null,
      position: hit.pickedPoint?.clone?.() ?? vehicle.position.clone(),
      normal: hit.getNormal?.(true, true) ?? null,
      destroyed: vehicle.destroyed
    });

    runtime.events.emit("vehicle:collision", {
      vehicleId: vehicle.id,
      speedMps: relativeSpeed,
      impactEnergyJ
    });

    return true;
  }

  function updateFuel(vehicle, speedMps, dt) {
    if (vehicle.fuelLiters <= 0) {
      vehicle.fuelLiters = 0;
      vehicle.engineRunning = false;
      return;
    }

    const rpmFactor = vehicle.engineRunning
      ? vehicleClamp(vehicle.engineRPM / vehicle.profile.maxRpm, 0.1, 1)
      : 0;

    const loadFactor = 0.25 + vehicle.throttle * 1.45;
    const leakRate = vehicle.fuelLeakActive
      ? vehicle.fuelLeakLitersPerSecond
      : 0;

    const litersPerSecond =
      0.00023 *
      vehicle.profile.massKg / 1500 *
      rpmFactor *
      loadFactor;

    vehicle.fuelLiters = Math.max(
      0,
      vehicle.fuelLiters - (litersPerSecond + leakRate) * dt
    );

    if (vehicle.fuelLiters <= 0) {
      vehicle.engineRunning = false;

      runtime.events.emit("vehicle:fuelEmpty", {
        vehicleId: vehicle.id
      });
    }
  }

  function setControls(id, controls) {
    const vehicle = vehicles.get(id);

    if (!vehicle) {
      return { ok: false, reason: "unknown-vehicle" };
    }

    if (vehicle.destroyed) {
      return { ok: false, reason: "vehicle-destroyed" };
    }

    if (vehicle.lockState === "locked" && !vehicle.driverId) {
      return { ok: false, reason: "vehicle-locked" };
    }

    vehicle.controlInput = {
      throttle: vehicleClamp(vehicleFinite(controls.throttle), 0, 1),
      brake: vehicleClamp(vehicleFinite(controls.brake), 0, 1),
      steering: vehicleClamp(vehicleFinite(controls.steering), -1, 1),
      handbrake: controls.handbrake === true,
      gearDirection: controls.gearDirection === -1 ? -1 : 1
    };

    return { ok: true };
  }

  function startEngine(id) {
    const vehicle = vehicles.get(id);
    if (!vehicle) return { ok: false, reason: "unknown-vehicle" };

    if (vehicle.destroyed || vehicle.fuelLiters <= 0 ||
        vehicle.damage.engine > 0.88) {
      return { ok: false, reason: "engine-unavailable" };
    }

    if (vehicle.lockState === "locked" && !vehicle.driverId) {
      return { ok: false, reason: "vehicle-locked" };
    }

    vehicle.engineRunning = true;

    runtime.events.emit("vehicle:engineStarted", {
      vehicleId: id
    });

    return { ok: true };
  }

  function stopEngine(id) {
    const vehicle = vehicles.get(id);
    if (!vehicle) return { ok: false, reason: "unknown-vehicle" };

    vehicle.engineRunning = false;
    vehicle.throttle = 0;

    runtime.events.emit("vehicle:engineStopped", {
      vehicleId: id
    });

    return { ok: true };
  }

  function enterVehicle(vehicleId, characterId) {
    const vehicle = vehicles.get(vehicleId);
    const character = player?.getCharacter?.(characterId);

    if (!vehicle || !character) {
      return { ok: false, reason: "vehicle-or-character-not-found" };
    }

    if (vehicle.destroyed) {
      return { ok: false, reason: "vehicle-destroyed" };
    }

    if (vehicle.driverId && vehicle.driverId !== characterId) {
      return { ok: false, reason: "driver-seat-occupied" };
    }

    if (vehicle.lockState === "locked") {
      return { ok: false, reason: "vehicle-locked" };
    }

    if (character.vehicleId) {
      return { ok: false, reason: "character-already-in-vehicle" };
    }

    if (
      B.Vector3.Distance(
        character.position,
        vehicle.position
      ) > 4.8
    ) {
      return { ok: false, reason: "out-of-range" };
    }

    vehicle.driverId = characterId;
    character.vehicleId = vehicleId;

    runtime.events.emit("vehicle:entered", {
      vehicleId,
      characterId,
      seat: "driver"
    });

    return { ok: true };
  }

  function exitVehicle(vehicleId, characterId) {
    const vehicle = vehicles.get(vehicleId);
    const character = player?.getCharacter?.(characterId);

    if (!vehicle || !character || vehicle.driverId !== characterId) {
      return { ok: false, reason: "not-driver" };
    }

    if (vehicle.velocity.length() > 3.3) {
      return { ok: false, reason: "vehicle-moving-too-fast" };
    }

    const side = getVehicleRight(vehicle);
    const position = vehicle.position.add(
      side.scale(vehicle.profile.widthM * 0.5 + 0.9)
    );

    character.position.copyFrom(position);
    character.vehicleId = null;
    vehicle.driverId = null;

    runtime.events.emit("vehicle:exited", {
      vehicleId,
      characterId,
      position
    });

    return { ok: true, position };
  }

  function stealVehicle(vehicleId, characterId, options = {}) {
    const vehicle = vehicles.get(vehicleId);
    if (!vehicle) return { ok: false, reason: "unknown-vehicle" };

    if (vehicle.owned && vehicle.ownerId !== characterId) {
      vehicle.stolen = true;
    } else {
      vehicle.stolen = true;
    }

    if (vehicle.alarmArmed) {
      vehicle.alarmTriggered = true;

      runtime.events.emit("vehicle:alarmTriggered", {
        vehicleId,
        characterId,
        position: vehicle.position.clone()
      });
    }

    vehicle.lockState = "unlocked";

    runtime.events.emit("vehicle:stolen", {
      vehicleId,
      characterId,
      method: options.method ?? "forced-entry",
      position: vehicle.position.clone()
    });

    runtime.events.emit("crime:vehicleTheft", {
      actorId: characterId,
      vehicleId,
      position: vehicle.position.clone()
    });

    return { ok: true, stolen: true };
  }

  function damageVehicle(vehicleId, damage, options = {}) {
    const vehicle = vehicles.get(vehicleId);

    if (!vehicle) return { ok: false, reason: "unknown-vehicle" };

    const amount = vehicleClamp(vehicleFinite(damage), 0, 100);

    vehicle.health = Math.max(0, vehicle.health - amount);
    vehicle.damage.bodyIntegrity = vehicleClamp(
      vehicle.damage.bodyIntegrity - amount / 100,
      0,
      1
    );

    if (options.engineDamage) {
      vehicle.damage.engine = vehicleClamp(
        vehicle.damage.engine + amount / 100,
        0,
        1
      );
    }

    if (options.fuelLeak) {
      vehicle.fuelLeakActive = true;
      vehicle.fuelLeakLitersPerSecond = vehicleClamp(
        vehicleFinite(options.leakRate, 0.012),
        0,
        0.1
      );
    }

    if (vehicle.health <= 0) {
      vehicle.destroyed = true;
      vehicle.engineRunning = false;
    }

    const damageId = `vehicle-damage-${nextDamageId++}`;

    runtime.events.emit("vehicle:damaged", {
      damageId,
      vehicleId,
      damage: amount,
      health: vehicle.health,
      engineDamage: vehicle.damage.engine,
      fuelLeak: vehicle.fuelLeakActive,
      destroyed: vehicle.destroyed
    });

    return { ok: true, damageId };
  }

  function tuneVehicle(vehicleId, modifications) {
    const vehicle = vehicles.get(vehicleId);
    if (!vehicle) return { ok: false, reason: "unknown-vehicle" };

    const tuning = vehicle.tuning;

    if (modifications.engineFactor !== undefined) {
      tuning.engineFactor = vehicleClamp(
        modifications.engineFactor, 0.8, 1.65
      );
    }

    if (modifications.brakeFactor !== undefined) {
      tuning.brakeFactor = vehicleClamp(
        modifications.brakeFactor, 0.75, 1.55
      );
    }

    if (modifications.suspensionFactor !== undefined) {
      tuning.suspensionFactor = vehicleClamp(
        modifications.suspensionFactor, 0.65, 1.75
      );
    }

    if (modifications.tireGripFactor !== undefined) {
      tuning.tireGripFactor = vehicleClamp(
        modifications.tireGripFactor, 0.65, 1.35
      );
    }

    if (modifications.paintColor) {
      tuning.paintColor = modifications.paintColor;

      const material = makeMaterial(
        `vehicle-paint-${vehicle.id}-${elapsed}`,
        modifications.paintColor,
        0.32,
        0.36
      );

      vehicle.material = material;
      vehicle.bodyMesh.material = material;
    }

    if (modifications.spoiler !== undefined) {
      tuning.spoiler = Boolean(modifications.spoiler);
    }

    runtime.events.emit("vehicle:tuned", {
      vehicleId,
      tuning: { ...tuning }
    });

    return { ok: true, tuning: { ...tuning } };
  }

  function attachTrailer(vehicleId, trailerId, options = {}) {
    const vehicle = vehicles.get(vehicleId);
    const trailer = vehicles.get(trailerId);

    if (!vehicle || !trailer) {
      return { ok: false, reason: "vehicle-or-trailer-not-found" };
    }

    if (vehicleId === trailerId || vehicle.trailerId || trailer.trailerId) {
      return { ok: false, reason: "invalid-trailer-connection" };
    }

    const hitchDistance = B.Vector3.Distance(
      vehicle.position,
      trailer.position
    );

    if (hitchDistance > (options.maxDistanceM ?? 3.4)) {
      return { ok: false, reason: "hitch-out-of-range" };
    }

    vehicle.trailerId = trailerId;
    trailer.towedBy = vehicleId;

    activeTrailers.set(trailerId, {
      towingVehicleId: vehicleId,
      trailerVehicleId: trailerId,
      maxArticulationRad: 0.72,
      restLengthM: hitchDistance
    });

    runtime.events.emit("vehicle:trailerAttached", {
      vehicleId,
      trailerId
    });

    return { ok: true };
  }

  function updateTrailerPhysics(dt) {
    for (const connection of activeTrailers.values()) {
      const vehicle = vehicles.get(connection.towingVehicleId);
      const trailer = vehicles.get(connection.trailerVehicleId);

      if (!vehicle || !trailer) continue;

      const hitchOffset = getVehicleForward(vehicle).scale(
        -vehicle.profile.lengthM * 0.43
      );

      const desiredHitch = vehicle.position.add(hitchOffset);

      const trailerForward = getVehicleForward(trailer);
      const trailerHitch = trailer.position.add(
        trailerForward.scale(trailer.profile.lengthM * 0.43)
      );

      const error = desiredHitch.subtract(trailerHitch);
      const distance = error.length();

      const direction = distance > 0.0001
        ? error.scale(1 / distance)
        : B.Vector3.Zero();

      const correctingForce = direction.scale(
        Math.min(
          15000,
          distance * trailer.profile.massKg * 7.5
        )
      );

      trailer.velocity.addInPlace(
        correctingForce.scale(dt / trailer.profile.massKg)
      );

      const relativeHeading = vehicle.yaw - trailer.yaw;

      const angle = Math.atan2(
        Math.sin(relativeHeading),
        Math.cos(relativeHeading)
      );

      const allowed = connection.maxArticulationRad;

      if (Math.abs(angle) > allowed) {
        trailer.yaw = vehicle.yaw -
          Math.sign(angle) * allowed;
      }

      trailer.velocity.scaleInPlace(
        vehicleClamp(1 - dt * 0.035, 0.9, 1)
      );

      trailer.position.addInPlace(trailer.velocity.scale(dt));
      trailer.root.position.copyFrom(trailer.position);
      trailer.root.rotation.y = trailer.yaw;
    }
  }

  function requestDelivery(payload) {
    const vehicleId = payload?.vehicleId;
    const existing = vehicles.get(vehicleId);

    if (!existing || !existing.owned) {
      return Promise.resolve({
        ok: false,
        message: "Vehicle is not owned or is unavailable."
      });
    }

    if (existing.driverId || existing.destroyed) {
      return Promise.resolve({
        ok: false,
        message: "Vehicle cannot be delivered in its current state."
      });
    }

    const active = player?.getActiveCharacter?.();
    if (!active) {
      return Promise.resolve({
        ok: false,
        message: "No active character is available."
      });
    }

    const nearest = world?.closestPointOnRoad?.(
      active.position,
      120
    );

    if (!nearest || nearest.blocked) {
      return Promise.resolve({
        ok: false,
        message: "No suitable accessible road was found."
      });
    }

    existing.position.set(
      nearest.x,
      nearest.y ?? 0,
      nearest.z
    );

    existing.velocity.setAll(0);
    existing.root.position.copyFrom(existing.position);
    existing.delivered = true;

    runtime.events.emit("vehicle:delivered", {
      vehicleId,
      position: existing.position.clone()
    });

    return Promise.resolve({
      ok: true,
      vehicleId,
      position: existing.position.clone(),
      message: "Vehicle delivered to an accessible roadside point."
    });
  }

  function requestPickup(payload) {
    const active = player?.getActiveCharacter?.();

    if (!active) {
      return Promise.resolve({
        ok: false,
        message: "Active player unavailable."
      });
    }

    const nearest = world?.closestPointOnRoad?.(
      payload?.position ?? active.position,
      120
    );

    if (!nearest || nearest.blocked) {
      return Promise.resolve({
        ok: false,
        message: "No reachable road-side pickup point."
      });
    }

    const candidates = [...vehicles.values()].filter(vehicle =>
      vehicle.classId === "taxi" &&
      !vehicle.driverId &&
      !vehicle.destroyed &&
      vehicle.velocity.length() < 0.3
    );

    if (!candidates.length) {
      return Promise.resolve({
        ok: false,
        message: "No available taxi is registered."
      });
    }

    const taxi = candidates.sort((a, b) =>
      B.Vector3.Distance(a.position, nearest) -
      B.Vector3.Distance(b.position, nearest)
    )[0];

    taxi.autopilot = {
      mode: "taxiPickup",
      target: new B.Vector3(nearest.x, nearest.y ?? 0, nearest.z),
      destination: null,
      requestedBy: active.id,
      requestedAt: elapsed
    };

    runtime.events.emit("taxi:requested", {
      vehicleId: taxi.id,
      pickup: taxi.autopilot.target.clone(),
      characterId: active.id
    });

    return Promise.resolve({
      ok: true,
      vehicleId: taxi.id,
      message: "A registered taxi has accepted the pickup request."
    });
  }

  function getStatus() {
    return {
      ok: true,
      activeVehicles: [...vehicles.values()].filter(v => !v.destroyed).length,
      taxisAvailable: [...vehicles.values()].filter(v =>
        v.classId === "taxi" && !v.driverId && !v.destroyed
      ).length
    };
  }

  async function initialize() {
    if (initialized) return { ok: true };
    initialized = true;

    serviceDisposers.push(
      runtime.services.register("vehicles", {
        createVehicle,
        getVehicle,
        getOwnedVehicles,
        getStatus,
        requestDelivery,
        requestPickup,

        setControls,
        startEngine,
        stopEngine,
        enterVehicle,
        exitVehicle,
        stealVehicle,
        damageVehicle,
        tuneVehicle,

        attachTrailer,
        getSnapshot: () => ({
          count: vehicles.size,
          active: [...vehicles.values()].filter(v => !v.destroyed).length,
          moving: [...vehicles.values()].filter(v => v.velocity.length() > 2).length,
          trailers: activeTrailers.size,
          detachedParts: detachedParts.size
        })
      })
    );

    serviceDisposers.push(
      runtime.services.register("vehiclePhysics", {
        createVehicle,
        getVehicle,
        setControls,
        damageVehicle,
        tuneVehicle,
        attachTrailer,
        sampleSurface,
        engineTorqueFraction
      })
    );

    eventDisposers.push(
      runtime.events.on("vehicle:controlInput", payload => {
        if (payload?.vehicleId) {
          setControls(payload.vehicleId, payload.controls ?? {});
        }
      })
    );

    eventDisposers.push(
      runtime.events.on("player:characterChanged", () => {
        // Character switching does not implicitly transfer a vehicle driver.
      })
    );

    createVehicle({
      id: "world-taxi-001",
      classId: "taxi",
      position: { x: 15, y: 0, z: 22 },
      owned: false,
      source: "initial-world-fleet"
    });

    createVehicle({
      id: "world-sedan-001",
      classId: "sedan",
      position: { x: 23, y: 0, z: 30 },
      owned: false,
      source: "initial-world-fleet"
    });

    createVehicle({
      id: "player-sedan-001",
      classId: "sedan",
      position: { x: -248, y: 0, z: 308 },
      ownerId: "lucia",
      owned: true,
      source: "player-garage"
    });

    logger.info("Vehicle dynamics initialized.", {
      vehicleCount: vehicles.size,
      vehicleClasses: Object.keys(VEHICLE_CLASSES)
    });

    return { ok: true };
  }

  function start() {
    running = true;
    return { ok: true };
  }

  function update(context) {
    if (!initialized || !running || disposed) return;

    const dt = vehicleClamp(
      vehicleFinite(context.simulationDeltaSeconds ?? context.gameDeltaSeconds),
      0,
      0.05
    );

    elapsed += dt;

    for (const vehicle of vehicles.values()) {
      if (vehicle.destroyed) continue;

      if (!vehicle.controlInput) {
        vehicle.controlInput = {
          throttle: 0,
          brake: 0,
          steering: 0,
          handbrake: false,
          gearDirection: 1
        };
      }

      if (vehicle.autopilot) {
        const target = vehicle.autopilot.target;
        const delta = target.subtract(vehicle.position);
        const distance = Math.hypot(delta.x, delta.z);

        if (distance < 3.5) {
          vehicle.controlInput.throttle = 0;
          vehicle.controlInput.brake = 0.8;
          vehicle.autopilot = null;

          runtime.events.emit(
            vehicle.metadata.taxiService
              ? "taxi:arrived"
              : "vehicle:deliveryArrived",
            {
              vehicleId: vehicle.id,
              position: vehicle.position.clone()
            }
          );
        } else {
          const desiredHeading = Math.atan2(delta.x, delta.z);

          let headingError = desiredHeading - vehicle.yaw;

          while (headingError > Math.PI) headingError -= 2 * Math.PI;
          while (headingError < -Math.PI) headingError += 2 * Math.PI;

          vehicle.controlInput.steering =
            vehicleClamp(headingError * 1.65, -1, 1);

          const desiredSpeed = Math.min(
            vehicle.profile.maxSpeedMps * 0.28,
            Math.sqrt(Math.max(0, distance) * 1.9)
          );

          const forwardSpeed = B.Vector3.Dot(
            vehicle.velocity,
            getVehicleForward(vehicle)
          );

          vehicle.controlInput.throttle =
            forwardSpeed < desiredSpeed ? 0.42 : 0.04;

          vehicle.controlInput.brake =
            forwardSpeed > desiredSpeed + 3 ? 0.25 : 0;
        }
      }

      const metrics = updateVehicleHandling(
        vehicle,
        vehicle.controlInput,
        dt
      );

      updateAutomaticGear(vehicle, metrics.forwardSpeed);

      // Fuel leakage and engine failure are persistent vehicle state.
      if (vehicle.fuelLiters <= 0) vehicle.engineRunning = false;
    }

    updateTrailerPhysics(dt);
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

    for (const vehicle of vehicles.values()) {
      for (const part of vehicle.visualParts) {
        if (!part.isDisposed()) part.dispose(false, true);
      }

      vehicle.root.dispose(false, true);

      try { vehicle.material.dispose(); } catch {}
    }

    for (const part of detachedParts) {
      try { part.dispose(); } catch {}
    }

    vehicles.clear();
    activeTrailers.clear();
    detachedParts.clear();
  }

  return Object.freeze({
    initialize,
    start,
    update,
    stop,
    dispose,

    createVehicle,
    getVehicle,
    getOwnedVehicles,
    setControls,
    enterVehicle,
    exitVehicle
  });
}
