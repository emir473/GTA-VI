/*
 * Module 7: spieler_steuerung.js
 * Factory: createPlayerControlSystem()
 *
 * Responsibilities:
 * - Character state machine and fixed-step movement.
 * - Responsive keyboard / pointer / touch input abstraction.
 * - Walking, jogging, sprinting, jumping, crouching and crawling.
 * - Ground probes, collision checks and safe-position recovery.
 * - Third-person follow camera with touch-look controls.
 * - Lucia / Jason switching with persistent individual state.
 * - Partner-follow behavior and navigation integration.
 * - Swimming / diving integration.
 * - Fitness, stamina, lung capacity and environment cleanliness.
 *
 * Coordinates: X/Z horizontal, Y vertical, meters and seconds.
 */

const PLAYER_CONFIG = Object.freeze({
  gravityMps2: 22,
  walkSpeedMps: 2.1,
  jogSpeedMps: 3.8,
  sprintSpeedMps: 6.2,
  crouchSpeedMps: 1.25,
  crawlSpeedMps: 0.65,

  accelerationMps2: 13.5,
  decelerationMps2: 17,
  airAccelerationMps2: 3.8,

  jumpSpeedMps: 6.1,
  stepHeightM: 0.38,
  groundProbeDistanceM: 7,
  playerRadiusM: 0.36,

  cameraDistanceM: 7.5,
  cameraHeightM: 3.5,
  cameraLookHeightM: 1.35,
  cameraSensitivity: 0.005,
  cameraSmoothing: 7.5,

  maximumSlopeDeg: 52,
  coyoteTimeSeconds: 0.10,
  jumpBufferSeconds: 0.12,

  staminaMaximum: 100,
  staminaDrainPerSecond: 14,
  staminaRecoveryPerSecond: 8.5,

  companionFollowDistanceM: 5,
  companionRepathSeconds: 2.4
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

function expSmoothing(rate, dt) {
  return 1 - Math.exp(-Math.max(0, rate) * Math.max(0, dt));
}

function normalized2D(x, z) {
  const length = Math.hypot(x, z);

  return length > 1e-5
    ? { x: x / length, z: z / length, magnitude: Math.min(1, length) }
    : { x: 0, z: 0, magnitude: 0 };
}

function createCharacterProfile(id, overrides = {}) {
  const isLucia = id === "lucia";

  return {
    id,
    name: isLucia ? "Lucia" : "Jason",

    position: new globalThis.BABYLON.Vector3(
      isLucia ? 0 : 6,
      0,
      isLucia ? 0 : 4
    ),

    heading: 0,
    velocity: new globalThis.BABYLON.Vector3(0, 0, 0),
    verticalVelocity: 0,

    grounded: false,
    crouching: false,
    crawling: false,
    jumping: false,
    sprinting: false,

    moveMode: "idle",
    previousMoveMode: "idle",

    health: 100,
    stamina: PLAYER_CONFIG.staminaMaximum,
    lungVolume: 1,

    attributes: {
      shooting: isLucia ? 0.58 : 0.66,
      endurance: isLucia ? 0.62 : 0.68,
      driving: isLucia ? 0.67 : 0.72,
      lungCapacity: isLucia ? 0.75 : 0.8
    },

    fitness: {
      muscleMass: isLucia ? 0.55 : 0.63,
      bodyFat: 0.22,
      trainingLoad: 0,
      recovery: 1,
      caloriesConsumed: 0,
      lastExerciseGameTime: 0
    },

    cleanliness: {
      dust: 0,
      mud: 0,
      sand: 0,
      bloodState: 0,
      clothingWetness: 0
    },

    inventory: {
      currentWeaponId: null,
      equippedItems: []
    },

    interiorId: null,
    vehicleId: null,

    appearanceRevision: 0,
    lastSafePosition: new globalThis.BABYLON.Vector3(
      isLucia ? 0 : 6,
      0,
      isLucia ? 0 : 4
    ),

    relationship: {
      trust: 0.6,
      cooperation: 0.7,
      coverSupport: 0.65,
      chaseSupport: 0.65,
      heistCoordination: 0.65,
      reactionQuality: 0.65
    },

    ...overrides
  };
}

/* ------------------------------------------------------------------ */
/* Procedural rig proxy                                                 */
/* ------------------------------------------------------------------ */

function createAvatarRig(B, scene, graphics, profile) {
  const root = new B.TransformNode(
    `character-root-${profile.id}`,
    scene
  );

  root.position.copyFrom(profile.position);
  root.rotation.y = profile.heading;

  const clothingColor = profile.id === "lucia"
    ? "#783e4c"
    : "#384a58";

  const accentColor = profile.id === "lucia"
    ? "#c9a87e"
    : "#a78e69";

  const skinColor = profile.id === "lucia"
    ? "#c58d6d"
    : "#bc8b6a";

  const hairColor = profile.id === "lucia"
    ? "#241911"
    : "#34261c";

  function makeMaterial(name, albedo, roughness = 0.82, metallic = 0) {
    const material = graphics?.createPBRMaterial?.(name, {
      albedo,
      roughness,
      metallic
    });

    if (material) return material;

    const fallback = new B.StandardMaterial(name, scene);
    fallback.diffuseColor = B.Color3.FromHexString(albedo);
    fallback.specularColor = new B.Color3(0.1, 0.1, 0.1);
    return fallback;
  }

  const materials = {
    clothing: makeMaterial(`character-${profile.id}-clothing`, clothingColor),
    accent: makeMaterial(`character-${profile.id}-accent`, accentColor, 0.55),
    skin: makeMaterial(`character-${profile.id}-skin`, skinColor, 0.84),
    hair: makeMaterial(`character-${profile.id}-hair`, hairColor, 0.88),
    footwear: makeMaterial(
      `character-${profile.id}-footwear`,
      "#25272a",
      0.72,
      0.04
    ),
    eye: makeMaterial(
      `character-${profile.id}-eye`,
      "#242426",
      0.25
    ),
    detail: makeMaterial(
      `character-${profile.id}-detail`,
      "#8c7962",
      0.65,
      0.16
    )
  };

  const parts = new Set();

  function registerPart(mesh, material, name) {
    mesh.parent = root;
    mesh.material = material;

    mesh.isPickable = false;
    mesh.checkCollisions = false;

    mesh.metadata = {
      ...(mesh.metadata || {}),
      characterId: profile.id,
      characterPart: name,
      isCharacterProxy: true
    };

    parts.add(mesh);
    return mesh;
  }

  function createBox(name, size, position, material, parent = root) {
    const mesh = B.MeshBuilder.CreateBox(
      `character-${profile.id}-${name}`,
      {
        width: size.x,
        height: size.y,
        depth: size.z
      },
      scene
    );

    mesh.parent = parent;
    mesh.position.set(position.x, position.y, position.z);

    mesh.material = material;
    mesh.isPickable = false;
    mesh.checkCollisions = false;

    mesh.metadata = {
      ...(mesh.metadata || {}),
      characterId: profile.id,
      characterPart: name,
      isCharacterProxy: true
    };

    parts.add(mesh);
    return mesh;
  }

  function createSphere(name, diameter, position, material, scale = null) {
    const mesh = B.MeshBuilder.CreateSphere(
      `character-${profile.id}-${name}`,
      {
        diameter,
        segments: 10
      },
      scene
    );

    mesh.parent = root;
    mesh.position.set(position.x, position.y, position.z);

    if (scale) mesh.scaling.copyFrom(scale);

    mesh.material = material;
    mesh.isPickable = false;
    mesh.checkCollisions = false;

    mesh.metadata = {
      ...(mesh.metadata || {}),
      characterId: profile.id,
      characterPart: name,
      isCharacterProxy: true
    };

    parts.add(mesh);
    return mesh;
  }

  function createCylinder(name, height, diameter, position, material, parent = root) {
    const mesh = B.MeshBuilder.CreateCylinder(
      `character-${profile.id}-${name}`,
      {
        height,
        diameter,
        tessellation: 10
      },
      scene
    );

    mesh.parent = parent;
    mesh.position.set(position.x, position.y, position.z);

    mesh.material = material;
    mesh.isPickable = false;
    mesh.checkCollisions = false;

    mesh.metadata = {
      ...(mesh.metadata || {}),
      characterId: profile.id,
      characterPart: name,
      isCharacterProxy: true
    };

    parts.add(mesh);
    return mesh;
  }

  const pelvis = createBox(
    "pelvis",
    new B.Vector3(0.34, 0.25, 0.24),
    new B.Vector3(0, 0.84, 0),
    materials.accent
  );

  const torso = createCylinder(
    "torso",
    0.68,
    0.39,
    new B.Vector3(0, 1.20, 0),
    materials.clothing
  );

  torso.scaling.x = 0.85;
  torso.scaling.z = 0.72;

  createBox(
    "shirt-panel",
    new B.Vector3(0.22, 0.51, 0.04),
    new B.Vector3(0, 1.19, 0.19),
    materials.accent
  );

  createCylinder(
    "neck",
    0.16,
    0.15,
    new B.Vector3(0, 1.60, 0),
    materials.skin
  );

  createSphere(
    "head",
    0.39,
    new B.Vector3(0, 1.80, 0),
    materials.skin,
    new B.Vector3(0.88, 1.12, 0.85)
  );

  createSphere(
    "hair",
    0.405,
    new B.Vector3(0, 1.92, -0.015),
    materials.hair,
    new B.Vector3(0.91, 0.65, 0.89)
  );

  // Brow, eye, nose and jaw details establish a usable facial proxy.
  createBox(
    "nose",
    new B.Vector3(0.05, 0.105, 0.09),
    new B.Vector3(0, 1.79, 0.20),
    materials.skin
  );

  for (const side of [-1, 1]) {
    createSphere(
      `eye-${side}`,
      0.045,
      new B.Vector3(side * 0.075, 1.83, 0.176),
      materials.eye
    );

    createSphere(
      `ear-${side}`,
      0.075,
      new B.Vector3(side * 0.185, 1.79, 0),
      materials.skin,
      new B.Vector3(0.65, 1.0, 0.7)
    );
  }

  const arms = [];
  const legs = [];

  function createLimbPivot(name, x, y, z) {
    const pivot = new B.TransformNode(
      `character-${profile.id}-${name}-pivot`,
      scene
    );

    pivot.parent = root;
    pivot.position.set(x, y, z);

    return pivot;
  }

  for (const side of [-1, 1]) {
    const upperArmPivot = createLimbPivot(
      `upper-arm-${side}`,
      side * 0.255,
      1.43,
      0
    );

    const upperArm = B.MeshBuilder.CreateCylinder(
      `character-${profile.id}-upper-arm-${side}`,
      {
        height: 0.48,
        diameter: 0.15,
        tessellation: 10
      },
      scene
    );

    upperArm.parent = upperArmPivot;
    upperArm.position.y = -0.22;
    upperArm.material = materials.clothing;
    parts.add(upperArm);

    const elbowPivot = new B.TransformNode(
      `character-${profile.id}-elbow-${side}`,
      scene
    );

    elbowPivot.parent = upperArmPivot;
    elbowPivot.position.y = -0.43;

    const forearm = B.MeshBuilder.CreateCylinder(
      `character-${profile.id}-forearm-${side}`,
      {
        height: 0.39,
        diameter: 0.12,
        tessellation: 10
      },
      scene
    );

    forearm.parent = elbowPivot;
    forearm.position.y = -0.19;
    forearm.material = materials.skin;
    parts.add(forearm);

    const hand = B.MeshBuilder.CreateSphere(
      `character-${profile.id}-hand-${side}`,
      {
        diameter: 0.12,
        segments: 8
      },
      scene
    );

    hand.parent = elbowPivot;
    hand.position.y = -0.41;
    hand.material = materials.skin;
    parts.add(hand);

    arms.push({
      side,
      upperArmPivot,
      elbowPivot
    });

    const hipPivot = createLimbPivot(
      `leg-${side}`,
      side * 0.12,
      0.76,
      0
    );

    const thigh = B.MeshBuilder.CreateCylinder(
      `character-${profile.id}-thigh-${side}`,
      {
        height: 0.49,
        diameter: 0.17,
        tessellation: 10
      },
      scene
    );

    thigh.parent = hipPivot;
    thigh.position.y = -0.23;
    thigh.material = materials.clothing;
    parts.add(thigh);

    const kneePivot = new B.TransformNode(
      `character-${profile.id}-knee-${side}`,
      scene
    );

    kneePivot.parent = hipPivot;
    kneePivot.position.y = -0.46;

    const calf = B.MeshBuilder.CreateCylinder(
      `character-${profile.id}-calf-${side}`,
      {
        height: 0.43,
        diameterTop: 0.12,
        diameterBottom: 0.10,
        tessellation: 10
      },
      scene
    );

    calf.parent = kneePivot;
    calf.position.y = -0.205;
    calf.material = materials.clothing;
    parts.add(calf);

    const shoe = B.MeshBuilder.CreateBox(
      `character-${profile.id}-shoe-${side}`,
      {
        width: 0.15,
        height: 0.12,
        depth: 0.28
      },
      scene
    );

    shoe.parent = kneePivot;
    shoe.position.set(0, -0.42, 0.065);
    shoe.material = materials.footwear;
    parts.add(shoe);

    legs.push({
      side,
      hipPivot,
      kneePivot
    });
  }

  // Subtle equipment / belt geometry is retained as an articulated part.
  createBox(
    "utility-belt",
    new B.Vector3(0.39, 0.07, 0.25),
    new B.Vector3(0, 0.91, 0),
    materials.detail
  );

  createBox(
    "rear-equipment-panel",
    new B.Vector3(0.24, 0.30, 0.075),
    new B.Vector3(0, 1.13, -0.19),
    materials.accent
  );

  return {
    id: profile.id,
    root,
    parts,
    materials,
    arms,
    legs,
    torso,
    pelvis,

    animTime: 0,
    animationBlend: 0,
    stridePhase: 0,

    externalModelRoot: null,
    externalAnimations: null,

    dispose() {
      for (const mesh of [...parts]) {
        if (!mesh.isDisposed()) mesh.dispose(false, false);
      }

      this.externalModelRoot?.dispose(false, false);
      root.dispose(false, false);

      for (const material of Object.values(materials)) {
        try { material.dispose(); } catch {}
      }

      parts.clear();
    }
  };
}

/* ------------------------------------------------------------------ */
/* Factory                                                              */
/* ------------------------------------------------------------------ */

export async function createPlayerControlSystem({
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
      "Player controller requires the shared runtime, scene and camera."
    );
  }

  const B = globalThis.BABYLON;
  if (!B) throw new Error("Babylon.js is unavailable.");

  const graphics = services.get("graphics");
  const world = services.get("world");
  const water = services.get("water");

  let initialized = false;
  let running = false;
  let disposed = false;

  let activeCharacterId = "lucia";
  let switchTransition = null;

  let elapsed = 0;
  let lastInteractionTime = -Infinity;
  let lastFootstepTime = 0;
  let companionRepathElapsed = 0;

  let cameraYaw = 0;
  let cameraPitch = 0.28;
  let cameraReady = false;

  const eventDisposers = [];
  const serviceDisposers = [];
  const inputKeys = new Set();
  const pointerStates = new Map();

  const input = {
    moveX: 0,
    moveY: 0,
    lookX: 0,
    lookY: 0,

    sprint: false,
    crouch: false,
    crawl: false,
    jumpPressed: false,
    jumpHeld: false,
    dive: false,
    interactPressed: false,

    characterSwitchPressed: false
  };

  const characters = new Map();
  const rigs = new Map();
  const swimControllers = new Map();

  const companionNavigation = {
    route: null,
    waypointIndex: 0,
    targetPosition: null,
    repathPending: false
  };

  const previousSafePositions = new Map();

  let mobileButtons = [];

  const canvas = engine.getRenderingCanvas?.() ??
    document.getElementById("render-canvas");

  function getActiveCharacter() {
    return characters.get(activeCharacterId) ?? null;
  }

  function getActiveRig() {
    return rigs.get(activeCharacterId) ?? null;
  }

  function getCompanionId() {
    return activeCharacterId === "lucia" ? "jason" : "lucia";
  }

  function getCompanion() {
    return characters.get(getCompanionId()) ?? null;
  }

  function getCompanionRig() {
    return rigs.get(getCompanionId()) ?? null;
  }

  function createCharacter(id) {
    const profile = createCharacterProfile(id);

    const nearestRoad = world?.nearestRoadNode?.(
      profile.position,
      100
    );

    if (nearestRoad) {
      profile.position.x = nearestRoad.node.position.x +
        (id === "lucia" ? 3 : -3);

      profile.position.z = nearestRoad.node.position.z +
        (id === "lucia" ? 4 : -4);
    }

    const sampledGround = world?.sampleGroundHeight?.(
      profile.position.x,
      profile.position.z
    );

    if (Number.isFinite(sampledGround)) {
      profile.position.y = sampledGround;
    }

    profile.lastSafePosition.copyFrom(profile.position);

    const avatar = createAvatarRig(
      B,
      scene,
      graphics,
      profile
    );

    avatar.root.position.copyFrom(profile.position);
    avatar.root.rotation.y = profile.heading;

    characters.set(id, profile);
    rigs.set(id, avatar);
    previousSafePositions.set(id, profile.position.clone());

    if (water?.createSwimController) {
      swimControllers.set(
        id,
        water.createSwimController(id, {
          lungCapacitySeconds:
            WATER_CONFIG_LUNG_CAPACITY(profile),
          scuba: false
        })
      );
    }

    try {
      entities.register(id, {
        id,
        type: "player-character",
        profile,
        root: avatar.root,
        position: profile.position
      });
    } catch (error) {
      logger.warn(
        `Character ${id} could not be added to the central entity registry.`,
        error
      );
    }

    return profile;
  }

  function WATER_CONFIG_LUNG_CAPACITY(profile) {
    const attribute = clamp(
      finite(profile.attributes.lungCapacity, 0.5),
      0,
      1
    );

    return lerp(24, 45, attribute);
  }

  /* ---------------------------------------------------------------- */
  /* Input abstraction                                                  */
  /* ---------------------------------------------------------------- */

  function isTextInput(target) {
    return target instanceof HTMLElement &&
      (target.isContentEditable ||
       ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
  }

  function keyToInput(key, pressed) {
    const lower = key.toLowerCase();

    if (["w", "arrowup"].includes(lower)) {
      if (pressed) inputKeys.add("forward");
      else inputKeys.delete("forward");
    }

    if (["s", "arrowdown"].includes(lower)) {
      if (pressed) inputKeys.add("backward");
      else inputKeys.delete("backward");
    }

    if (["a", "arrowleft"].includes(lower)) {
      if (pressed) inputKeys.add("left");
      else inputKeys.delete("left");
    }

    if (["d", "arrowright"].includes(lower)) {
      if (pressed) inputKeys.add("right");
      else inputKeys.delete("right");
    }

    if (lower === "shift") {
      input.sprint = pressed;
    }

    if (lower === "c" || lower === "control") {
      input.crouch = pressed;
    }

    if (lower === "x") {
      input.crawl = pressed;
    }

    if (lower === " " && pressed && !input.jumpHeld) {
      input.jumpPressed = true;
      input.jumpHeld = true;
    } else if (lower === " " && !pressed) {
      input.jumpHeld = false;
    }

    if (lower === "tab" && pressed) {
      input.characterSwitchPressed = true;
    }

    if (lower === "e" && pressed) {
      input.interactPressed = true;
    }
  }

  function calculateKeyboardVector() {
    const x =
      (inputKeys.has("right") ? 1 : 0) -
      (inputKeys.has("left") ? 1 : 0);

    const y =
      (inputKeys.has("forward") ? 1 : 0) -
      (inputKeys.has("backward") ? 1 : 0);

    return normalized2D(x, y);
  }

  function clearInput() {
    inputKeys.clear();
    pointerStates.clear();

    input.moveX = 0;
    input.moveY = 0;

    input.sprint = false;
    input.crouch = false;
    input.crawl = false;
    input.jumpPressed = false;
    input.jumpHeld = false;
    input.dive = false;
  }

  function installInputHandlers() {
    const down = event => {
      if (isTextInput(event.target)) return;

      if (
        event.repeat &&
        [" ", "tab", "e"].includes(event.key.toLowerCase())
      ) {
        return;
      }

      keyToInput(event.key, true);
    };

    const up = event => {
      keyToInput(event.key, false);
    };

    const blur = () => clearInput();

    document.addEventListener("keydown", down);
    document.addEventListener("keyup", up);
    window.addEventListener("blur", blur);

    eventDisposers.push(() => {
      document.removeEventListener("keydown", down);
      document.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    });

    const touchMoveOff = runtime.events.on(
      "input:touchMove",
      payload => {
        if (payload.phase === "end") {
          input.moveX = 0;
          input.moveY = 0;
          return;
        }

        input.moveX = clamp(finite(payload.x), -1, 1);
        // The UI stick's Y coordinate increases downward.
        input.moveY = -clamp(finite(payload.y), -1, 1);
      }
    );

    const interactOff = runtime.events.on(
      "input:interactRequested",
      () => {
        input.interactPressed = true;
      }
    );

    eventDisposers.push(touchMoveOff, interactOff);

    if (canvas) {
      const pointerDown = event => {
        if (event.pointerType === "mouse" && event.button !== 0) return;

        const rightSide = event.clientX > window.innerWidth * 0.42;

        if (!rightSide && event.pointerType !== "mouse") return;

        pointerStates.set(event.pointerId, {
          x: event.clientX,
          y: event.clientY,
          pointerType: event.pointerType
        });

        try { canvas.setPointerCapture(event.pointerId); } catch {}
      };

      const pointerMove = event => {
        const previous = pointerStates.get(event.pointerId);
        if (!previous) return;

        const dx = event.clientX - previous.x;
        const dy = event.clientY - previous.y;

        previous.x = event.clientX;
        previous.y = event.clientY;

        cameraYaw -= dx * PLAYER_CONFIG.cameraSensitivity;
        cameraPitch = clamp(
          cameraPitch - dy * PLAYER_CONFIG.cameraSensitivity,
          -0.05,
          0.95
        );
      };

      const pointerUp = event => {
        pointerStates.delete(event.pointerId);
      };

      canvas.addEventListener("pointerdown", pointerDown);
      canvas.addEventListener("pointermove", pointerMove);
      canvas.addEventListener("pointerup", pointerUp);
      canvas.addEventListener("pointercancel", pointerUp);
      canvas.addEventListener("lostpointercapture", pointerUp);

      eventDisposers.push(() => {
        canvas.removeEventListener("pointerdown", pointerDown);
        canvas.removeEventListener("pointermove", pointerMove);
        canvas.removeEventListener("pointerup", pointerUp);
        canvas.removeEventListener("pointercancel", pointerUp);
        canvas.removeEventListener("lostpointercapture", pointerUp);
      });
    }
  }

  function installTouchButtons() {
    const root = document.getElementById("touch-controls");
    if (!root) return;

    const definitions = [
      { id: "touch-jump", label: "JUMP", right: "27px", bottom: "184px" },
      { id: "touch-sprint", label: "RUN", right: "104px", bottom: "184px" },
      { id: "touch-switch", label: "SWAP", right: "104px", bottom: "104px" },
      { id: "touch-dive", label: "DIVE", right: "104px", bottom: "25px" }
    ];

    for (const definition of definitions) {
      const button = document.createElement("button");

      button.id = definition.id;
      button.type = "button";
      button.className = "touch-control";
      button.textContent = definition.label;
      button.setAttribute("aria-label", definition.label);

      button.style.right = definition.right;
      button.style.bottom =
        `calc(${definition.bottom} + env(safe-area-inset-bottom, 0px))`;

      button.style.width = "60px";
      button.style.height = "60px";
      button.style.fontSize = "10px";
      button.style.fontWeight = "800";

      root.appendChild(button);
      mobileButtons.push(button);
    }

    const byId = id => document.getElementById(id);

    const jump = byId("touch-jump");
    const sprint = byId("touch-sprint");
    const swap = byId("touch-switch");
    const dive = byId("touch-dive");

    const jumpDown = event => {
      event.preventDefault();
      input.jumpPressed = true;
      input.jumpHeld = true;
    };

    const jumpUp = event => {
      event.preventDefault();
      input.jumpHeld = false;
    };

    jump.addEventListener("pointerdown", jumpDown);
    jump.addEventListener("pointerup", jumpUp);
    jump.addEventListener("pointercancel", jumpUp);

    const sprintDown = event => {
      event.preventDefault();
      input.sprint = true;
    };

    const sprintUp = event => {
      event.preventDefault();
      input.sprint = false;
    };

    sprint.addEventListener("pointerdown", sprintDown);
    sprint.addEventListener("pointerup", sprintUp);
    sprint.addEventListener("pointercancel", sprintUp);
    sprint.addEventListener("lostpointercapture", sprintUp);

    swap.addEventListener("click", event => {
      event.preventDefault();
      input.characterSwitchPressed = true;
    });

    const diveDown = event => {
      event.preventDefault();
      input.dive = true;
      input.crouch = true;
    };

    const diveUp = event => {
      event.preventDefault();
      input.dive = false;
      input.crouch = false;
    };

    dive.addEventListener("pointerdown", diveDown);
    dive.addEventListener("pointerup", diveUp);
    dive.addEventListener("pointercancel", diveUp);

    eventDisposers.push(() => {
      jump.removeEventListener("pointerdown", jumpDown);
      jump.removeEventListener("pointerup", jumpUp);
      jump.removeEventListener("pointercancel", jumpUp);

      sprint.removeEventListener("pointerdown", sprintDown);
      sprint.removeEventListener("pointerup", sprintUp);
      sprint.removeEventListener("pointercancel", sprintUp);
      sprint.removeEventListener("lostpointercapture", sprintUp);

      dive.removeEventListener("pointerdown", diveDown);
      dive.removeEventListener("pointerup", diveUp);
      dive.removeEventListener("pointercancel", diveUp);

      for (const button of mobileButtons) button.remove();
      mobileButtons = [];
    });
  }

  /* ---------------------------------------------------------------- */
  /* Ground probes, collision and recovery                             */
  /* ---------------------------------------------------------------- */

  function probeGround(position) {
    if (world?.sampleGroundHeight) {
      const y = world.sampleGroundHeight(position.x, position.z);

      if (Number.isFinite(y)) {
        const delta = position.y - y;

        return {
          hit: delta >= -0.1 && delta < 5,
          height: y,
          normal: new B.Vector3(0, 1, 0),
          distance: Math.max(0, delta),
          surface: "world"
        };
      }
    }

    const origin = position.add(new B.Vector3(0, 1.4, 0));

    const ray = new B.Ray(
      origin,
      new B.Vector3(0, -1, 0),
      PLAYER_CONFIG.groundProbeDistanceM
    );

    const pick = scene.pickWithRay(
      ray,
      mesh =>
        mesh.isEnabled() &&
        mesh.isVisible &&
        mesh.metadata?.isWalkable === true
    );

    if (!pick?.hit || !pick.pickedPoint) {
      return { hit: false, height: null };
    }

    return {
      hit: true,
      height: pick.pickedPoint.y,
      normal: pick.getNormal(true, true) ??
        new B.Vector3(0, 1, 0),
      distance: origin.y - pick.pickedPoint.y,
      surface: pick.pickedMesh?.metadata?.surfaceType ?? "unknown"
    };
  }

  function isSlopeWalkable(normal) {
    if (!normal || !Number.isFinite(normal.y)) return false;

    const minimumY = Math.cos(
      PLAYER_CONFIG.maximumSlopeDeg * Math.PI / 180
    );

    return normal.y >= minimumY;
  }

  function collidesHorizontally(position, direction, distance) {
    if (direction.lengthSquared() < 1e-6 || distance <= 0) {
      return false;
    }

    const origin = position.add(
      new B.Vector3(0, 0.85, 0)
    );

    const ray = new B.Ray(
      origin,
      direction.normalize(),
      distance
    );

    const pick = scene.pickWithRay(
      ray,
      mesh =>
        mesh.isEnabled() &&
        mesh.isVisible &&
        mesh.metadata?.blocksPlayer === true
    );

    return Boolean(pick?.hit && pick.distance < distance);
  }

  function safePositionFor(character) {
    const worldState = {
      ...character.lastSafePosition
    };

    const known = previousSafePositions.get(character.id);

    if (known) return known.clone();

    return new B.Vector3(
      finite(worldState.x),
      finite(worldState.y),
      finite(worldState.z)
    );
  }

  function recoverCharacter(character, reason) {
    const target = safePositionFor(character);
    const rig = rigs.get(character.id);

    character.position.copyFrom(target);
    character.velocity.setAll(0);
    character.verticalVelocity = 0;
    character.grounded = false;

    if (rig) {
      rig.root.position.copyFrom(target);
    }

    runtime.events.emit("player:positionRecovered", {
      characterId: character.id,
      reason,
      position: target.clone()
    });
  }

  /* ---------------------------------------------------------------- */
  /* Procedural animation                                               */
  /* ---------------------------------------------------------------- */

  function updateProceduralAnimation(character, rig, dt, speed) {
    rig.animTime += dt;

    const movementBlend = expSmoothing(
      speed > 0.1 ? 8 : 4,
      dt
    );

    rig.animationBlend = lerp(
      rig.animationBlend,
      clamp(speed / PLAYER_CONFIG.sprintSpeedMps, 0, 1),
      movementBlend
    );

    if (speed > 0.2) {
      rig.stridePhase += dt *
        lerp(4, 11, rig.animationBlend);
    }

    const phase = rig.stridePhase;
    const blend = rig.animationBlend;

    let strideScale = character.sprinting ? 1.0 : 0.72;

    if (character.crouching) strideScale = 0.32;
    if (character.crawling) strideScale = 0.18;

    for (const leg of rig.legs) {
      const swing = Math.sin(phase + (leg.side === 1 ? Math.PI : 0));

      leg.hipPivot.rotation.x =
        swing * 0.62 * blend * strideScale;

      leg.kneePivot.rotation.x =
        Math.max(0, -swing) * 0.85 * blend * strideScale;

      if (character.crouching) {
        leg.hipPivot.rotation.x -= 0.4;
      }

      if (character.crawling) {
        leg.hipPivot.rotation.x -= 0.9;
        leg.kneePivot.rotation.x += 0.9;
      }
    }

    for (const arm of rig.arms) {
      const swing = Math.sin(
        phase + (arm.side === 1 ? 0 : Math.PI)
      );

      arm.upperArmPivot.rotation.x =
        -swing * 0.48 * blend * strideScale;

      arm.upperArmPivot.rotation.z =
        arm.side * 0.08;

      arm.elbowPivot.rotation.x =
        Math.max(0, swing) * 0.6 * blend;

      if (character.crouching) {
        arm.upperArmPivot.rotation.x -= 0.2;
      }
    }

    const breathing = Math.sin(rig.animTime * 1.7);

    rig.torso.scaling.x = 0.85 + breathing * 0.007;
    rig.torso.scaling.z = 0.72 + breathing * 0.005;

    rig.pelvis.position.y = character.crouching
      ? 0.63
      : 0.84;
  }

  /* ---------------------------------------------------------------- */
  /* Camera                                                             */
  /* ---------------------------------------------------------------- */

  function calculateCameraPosition(character) {
    const forward = new B.Vector3(
      Math.sin(cameraYaw),
      0,
      Math.cos(cameraYaw)
    );

    const horizontalDistance =
      PLAYER_CONFIG.cameraDistanceM * Math.cos(cameraPitch);

    return new B.Vector3(
      character.position.x - forward.x * horizontalDistance,
      character.position.y +
        PLAYER_CONFIG.cameraHeightM +
        Math.sin(cameraPitch) * 2.4,
      character.position.z - forward.z * horizontalDistance
    );
  }

  function updateCamera(character, dt) {
    const targetCamera = calculateCameraPosition(character);

    const focus = new B.Vector3(
      character.position.x,
      character.position.y +
        (character.crouching ? 1.0 : PLAYER_CONFIG.cameraLookHeightM),
      character.position.z
    );

    if (!cameraReady) {
      camera.position.copyFrom(targetCamera);
      cameraReady = true;
    } else {
      const t = expSmoothing(
        PLAYER_CONFIG.cameraSmoothing,
        dt
      );

      camera.position = B.Vector3.Lerp(
        camera.position,
        targetCamera,
        t
      );
    }

    camera.setTarget(focus);
  }

  function performCharacterSwitch() {
    const nextId = getCompanionId();
    const oldCharacter = getActiveCharacter();
    const nextCharacter = characters.get(nextId);

    if (!nextCharacter) {
      runtime.notify("Target character is unavailable.", "error");
      return { ok: false, message: "Target character not found." };
    }

    const waterController = swimControllers.get(nextId);

    if (
      nextCharacter.vehicleId ||
      waterController?.state === "drowning"
    ) {
      runtime.notify(
        "Character switch is temporarily unavailable in this state.",
        "error"
      );

      return {
        ok: false,
        message: "Target character is in a restricted state."
      };
    }

    const currentCameraPosition = camera.position.clone();
    const nextCameraPosition = calculateCameraPosition(nextCharacter);

    activeCharacterId = nextId;

    runtime.state.patch({
      activeCharacterId: nextId,
      playerPosition: nextCharacter.position.clone(),
      playerHeading: nextCharacter.heading
    }, "character-switch");

    switchTransition = {
      elapsed: 0,
      duration: 0.8,
      from: currentCameraPosition,
      to: nextCameraPosition
    };

    runtime.events.emit("player:characterChanged", {
      from: oldCharacter?.id ?? null,
      to: nextId,
      position: nextCharacter.position.clone()
    });

    runtime.notify(`Active character: ${nextCharacter.name}`, "success");

    return { ok: true, characterId: nextId };
  }

  function updateCameraSwitchTransition(dt) {
    if (!switchTransition) return false;

    switchTransition.elapsed += dt;

    const t = clamp(
      switchTransition.elapsed / switchTransition.duration,
      0,
      1
    );

    const eased = t * t * (3 - 2 * t);

    camera.position = B.Vector3.Lerp(
      switchTransition.from,
      switchTransition.to,
      eased
    );

    if (t >= 1) switchTransition = null;

    return true;
  }

  /* ---------------------------------------------------------------- */
  /* Core character motion                                              */
  /* ---------------------------------------------------------------- */

  function chooseMovementMode(character, speed, inWater) {
    if (character.health <= 0) return "dead";
    if (character.vehicleId) return "inVehicle";
    if (inWater) return "swimming";
    if (character.crawling) return "crawling";
    if (character.crouching) return "crouching";
    if (character.jumping) return "airborne";
    if (character.sprinting && speed > 0.2) return "sprinting";
    if (speed > 0.2) return "moving";
    return "idle";
  }

  function getMovementDirection(character, moveX, moveY) {
    const magnitude = Math.hypot(moveX, moveY);

    if (magnitude < 1e-4) return B.Vector3.Zero();

    const normalized = normalized2D(moveX, moveY);

    const forward = new B.Vector3(
      Math.sin(cameraYaw),
      0,
      Math.cos(cameraYaw)
    );

    const right = new B.Vector3(
      Math.cos(cameraYaw),
      0,
      -Math.sin(cameraYaw)
    );

    const direction = forward.scale(normalized.z ?? normalized.y);
    direction.addInPlace(right.scale(normalized.x));

    if (direction.lengthSquared() > 1) direction.normalize();

    return direction;
  }

  function updateGroundedMotion(character, dt, direction, waterResult) {
    const position = character.position;
    const velocity = character.velocity;

    const inWater = waterResult?.inWater === true;

    character.previousMoveMode = character.moveMode;
    character.sprinting =
      input.sprint &&
      !character.crouching &&
      !character.crawling &&
      character.stamina > 0 &&
      !inWater;

    character.crouching = input.crouch && !inWater;
    character.crawling = input.crawl && !inWater;

    const requestedSpeed =
      character.crawling
        ? PLAYER_CONFIG.crawlSpeedMps
        : character.crouching
          ? PLAYER_CONFIG.crouchSpeedMps
          : character.sprinting
            ? PLAYER_CONFIG.sprintSpeedMps *
              (0.85 + character.attributes.endurance * 0.15)
            : inputKeys.has("shift")
              ? PLAYER_CONFIG.jogSpeedMps
              : PLAYER_CONFIG.walkSpeedMps;

    let desiredVelocity;

    if (inWater) {
      desiredVelocity = direction.scale(
        requestedSpeed * 0.65
      );
    } else {
      desiredVelocity = direction.scale(
        requestedSpeed
      );
    }

    const horizontalVelocity = new B.Vector3(
      velocity.x,
      0,
      velocity.z
    );

    const acceleration =
      direction.lengthSquared() > 1e-6
        ? character.grounded
          ? PLAYER_CONFIG.accelerationMps2
          : PLAYER_CONFIG.airAccelerationMps2
        : PLAYER_CONFIG.decelerationMps2;

    const velocityChange = desiredVelocity.subtract(horizontalVelocity);
    const maximumChange = acceleration * dt;

    if (velocityChange.length() > maximumChange) {
      velocityChange.normalize().scaleInPlace(maximumChange);
    }

    horizontalVelocity.addInPlace(velocityChange);

    const maxSpeed = requestedSpeed *
      (inWater ? 1.0 : 1.12);

    const speed = horizontalVelocity.length();

    if (speed > maxSpeed) {
      horizontalVelocity.normalize().scaleInPlace(maxSpeed);
    }

    velocity.x = horizontalVelocity.x;
    velocity.z = horizontalVelocity.z;

    if (direction.lengthSquared() > 1e-5 && !inWater) {
      const targetHeading = Math.atan2(direction.x, direction.z);

      let deltaHeading = targetHeading - character.heading;

      while (deltaHeading > Math.PI) deltaHeading -= Math.PI * 2;
      while (deltaHeading < -Math.PI) deltaHeading += Math.PI * 2;

      const turnRate = character.sprinting ? 5.5 : 8.5;

      character.heading += deltaHeading *
        expSmoothing(turnRate, dt);
    }

    if (character.sprinting && speed > 1) {
      character.stamina = Math.max(
        0,
        character.stamina -
        PLAYER_CONFIG.staminaDrainPerSecond * dt *
        (1.2 - character.attributes.endurance * 0.4)
      );
    } else {
      character.stamina = Math.min(
        PLAYER_CONFIG.staminaMaximum,
        character.stamina +
        PLAYER_CONFIG.staminaRecoveryPerSecond * dt
      );
    }

    if (character.stamina < 1) character.sprinting = false;

    if (!inWater) {
      if (character.grounded && input.jumpPressed) {
        character.verticalVelocity = PLAYER_CONFIG.jumpSpeedMps;
        character.grounded = false;
        character.jumping = true;

        runtime.events.emit("player:jumped", {
          characterId: character.id,
          position: position.clone()
        });
      }

      character.verticalVelocity -= PLAYER_CONFIG.gravityMps2 * dt;

      const nextX = position.x + velocity.x * dt;
      const nextZ = position.z + velocity.z * dt;

      const moveX = nextX - position.x;
      const moveZ = nextZ - position.z;

      const horizontalDistance = Math.hypot(moveX, moveZ);

      if (horizontalDistance > 1e-4) {
        const directionVector = new B.Vector3(
          moveX, 0, moveZ
        ).normalize();

        const collision = collidesHorizontally(
          position,
          directionVector,
          horizontalDistance + PLAYER_CONFIG.playerRadiusM
        );

        if (!collision) {
          position.x = nextX;
          position.z = nextZ;
        } else {
          // Slide along the non-blocked tangent instead of freezing
          // both axes when only one direction intersects a wall.
          const tryX = collidesHorizontally(
            position,
            new B.Vector3(Math.sign(moveX), 0, 0),
            Math.abs(moveX) + PLAYER_CONFIG.playerRadiusM
          );

          const tryZ = collidesHorizontally(
            position,
            new B.Vector3(0, 0, Math.sign(moveZ)),
            Math.abs(moveZ) + PLAYER_CONFIG.playerRadiusM
          );

          if (!tryX) position.x = nextX;
          else velocity.x = 0;

          if (!tryZ) position.z = nextZ;
          else velocity.z = 0;
        }
      }

      position.y += character.verticalVelocity * dt;

      const ground = probeGround(position);

      if (
        ground.hit &&
        isSlopeWalkable(ground.normal) &&
        character.verticalVelocity <= 0 &&
        position.y <= ground.height + 0.12
      ) {
        position.y = ground.height;
        character.verticalVelocity = 0;
        character.grounded = true;
        character.jumping = false;

        character.lastSafePosition.copyFrom(position);
        previousSafePositions.set(character.id, position.clone());
      } else {
        character.grounded = false;
        character.jumping = position.y > (ground.height ?? position.y);
      }

      if (position.y < -24) {
        recoverCharacter(character, "fell-below-world");
      }
    } else {
      const swim = waterResult;

      if (swim && Number.isFinite(swim.surfaceHeight)) {
        const swimmingState = swim.state;

        const desiredY =
          swimmingState === "underwater" ||
          swimmingState === "diving"
            ? swim.surfaceHeight - 1.1
            : swimmingState === "surfacing"
              ? swim.surfaceHeight - 0.12
              : swim.surfaceHeight - 0.12;

        const verticalBlend = expSmoothing(3.4, dt);

        position.y = lerp(
          position.y,
          desiredY,
          verticalBlend
        );

        character.verticalVelocity = 0;
        character.grounded = false;
        character.jumping = false;

        if (swim.waterVelocity) {
          position.x += swim.waterVelocity.x * dt * 0.35;
          position.z += swim.waterVelocity.z * dt * 0.35;
        }

        if (swim.damagePerSecond > 0) {
          character.health = Math.max(
            0,
            character.health - swim.damagePerSecond * dt
          );

          if (character.health === 0) {
            runtime.events.emit("player:died", {
              characterId: character.id,
              cause: "drowning"
            });
          }
        }
      }
    }

    character.moveMode = chooseMovementMode(
      character,
      Math.hypot(velocity.x, velocity.z),
      inWater
    );

    return {
      speedMps: Math.hypot(velocity.x, velocity.z),
      direction,
      inWater
    };
  }

  /* ---------------------------------------------------------------- */
  /* Partner navigation                                                 */
  /* ---------------------------------------------------------------- */

  function getDesiredCompanionPosition(character) {
    const active = getActiveCharacter();
    if (!active) return character.position.clone();

    const back = new B.Vector3(
      Math.sin(active.heading),
      0,
      Math.cos(active.heading)
    ).scale(-PLAYER_CONFIG.companionFollowDistanceM);

    const lateral = new B.Vector3(
      Math.cos(active.heading),
      0,
      -Math.sin(active.heading)
    ).scale(character.id === "jason" ? 2.1 : -2.1);

    return active.position.add(back).add(lateral);
  }

  function recalculateCompanionRoute(character) {
    const desired = getDesiredCompanionPosition(character);

    if (world?.findRouteBetweenPositions) {
      const route = world.findRouteBetweenPositions(
        character.position,
        desired,
        {
          maxSnapDistance: 450,
          avoidHighways: true,
          speedPreference: 1
        }
      );

      companionNavigation.route = route.ok ? route : null;
      companionNavigation.waypointIndex = 0;
    } else {
      companionNavigation.route = null;
    }

    companionNavigation.targetPosition = desired.clone();
    companionNavigation.repathPending = false;
  }

  function updateCompanion(character, dt) {
    if (!character) return;

    const rig = rigs.get(character.id);
    if (!rig) return;

    if (character.vehicleId) return;

    companionRepathElapsed += dt;

    const active = getActiveCharacter();
    const distance = active
      ? Math.hypot(
          character.position.x - active.position.x,
          character.position.z - active.position.z
        )
      : 0;

    if (distance < 3.5) {
      character.velocity.x *= Math.exp(-dt * 3);
      character.velocity.z *= Math.exp(-dt * 3);

      updateProceduralAnimation(
        character,
        rig,
        dt,
        Math.hypot(character.velocity.x, character.velocity.z)
      );

      return;
    }

    if (
      companionRepathElapsed >= PLAYER_CONFIG.companionRepathSeconds ||
      distance > 24 ||
      !companionNavigation.route
    ) {
      companionRepathElapsed = 0;
      recalculateCompanionRoute(character);
    }

    let target = companionNavigation.targetPosition;

    const route = companionNavigation.route;

    if (route?.ok && route.path?.length) {
      target = route.path[
        Math.min(
          companionNavigation.waypointIndex,
          route.path.length - 1
        )
      ];

      const waypointDistance = Math.hypot(
        target.x - character.position.x,
        target.z - character.position.z
      );

      if (
        waypointDistance < 5 &&
        companionNavigation.waypointIndex < route.path.length - 1
      ) {
        companionNavigation.waypointIndex++;
        target = route.path[companionNavigation.waypointIndex];
      }
    }

    if (!target) return;

    const direction2D = normalized2D(
      target.x - character.position.x,
      target.z - character.position.z
    );

    const direction = new B.Vector3(
      direction2D.x,
      0,
      direction2D.z
    );

    const desiredSpeed = distance > 12 ? 4.2 : 3.1;

    const desiredVelocity = direction.scale(desiredSpeed);
    const current = character.velocity;

    current.x = lerp(
      current.x,
      desiredVelocity.x,
      expSmoothing(2.8, dt)
    );

    current.z = lerp(
      current.z,
      desiredVelocity.z,
      expSmoothing(2.8, dt)
    );

    const next = character.position.add(
      new B.Vector3(current.x * dt, 0, current.z * dt)
    );

    if (
      !collidesHorizontally(
        character.position,
        direction,
        Math.hypot(current.x * dt, current.z * dt) + 0.3
      )
    ) {
      character.position.x = next.x;
      character.position.z = next.z;

      const ground = probeGround(character.position);

      if (ground.hit && isSlopeWalkable(ground.normal)) {
        character.position.y = ground.height;
      }
    } else {
      companionNavigation.repathPending = true;
    }

    character.heading = Math.atan2(direction.x, direction.z);

    rig.root.position.copyFrom(character.position);
    rig.root.rotation.y = character.heading;

    updateProceduralAnimation(
      character,
      rig,
      dt,
      Math.hypot(character.velocity.x, character.velocity.z)
    );
  }

  /* ---------------------------------------------------------------- */
  /* Interaction and surface effects                                   */
  /* ---------------------------------------------------------------- */

  function getCurrentSurfaceType(character) {
    const nearestRoad = world?.closestPointOnRoad?.(
      character.position,
      18
    );

    if (nearestRoad && nearestRoad.distance < 11) {
      return nearestRoad.type === "highway"
        ? "asphalt-highway"
        : "asphalt";
    }

    const region = world?.regionAt?.(
      character.position.x,
      character.position.z
    );

    if (region === "wetlands") return "mud";
    if (region === "coastal") return "sand";

    return "terrain";
  }

  function updateCleanliness(character, dt, inWater) {
    const surfaceType = getCurrentSurfaceType(character);
    const speed = Math.hypot(
      character.velocity.x,
      character.velocity.z
    );

    const next = { ...character.cleanliness };
    const previous = { ...next };

    if (surfaceType === "mud" && speed > 0.5) {
      next.mud = clamp(next.mud + dt * speed * 0.014, 0, 1);
    } else if (surfaceType === "sand" && speed > 0.7) {
      next.sand = clamp(next.sand + dt * speed * 0.009, 0, 1);
    } else if (surfaceType === "terrain" && speed > 1.5) {
      next.dust = clamp(next.dust + dt * speed * 0.005, 0, 1);
    }

    if (inWater) {
      next.mud = Math.max(0, next.mud - dt * 0.18);
      next.dust = Math.max(0, next.dust - dt * 0.25);
      next.sand = Math.max(0, next.sand - dt * 0.21);
      next.clothingWetness = Math.min(
        1,
        next.clothingWetness + dt * 0.3
      );
    } else {
      next.clothingWetness = Math.max(
        0,
        next.clothingWetness - dt * 0.012
      );
    }

    character.cleanliness = next;

    const changed =
      Math.abs(next.mud - previous.mud) > 0.015 ||
      Math.abs(next.dust - previous.dust) > 0.015 ||
      Math.abs(next.sand - previous.sand) > 0.015 ||
      Math.abs(next.clothingWetness - previous.clothingWetness) > 0.04;

    if (changed) {
      character.appearanceRevision++;

      runtime.events.emit("player:appearanceChanged", {
        characterId: character.id,
        revision: character.appearanceRevision,
        cleanliness: { ...next },
        surfaceType
      });
    }
  }

  function attemptInteraction(character) {
    if (elapsed - lastInteractionTime < 0.25) return;
    lastInteractionTime = elapsed;

    const nearest = world?.queryEntities?.(
      character.position,
      2.3
    ) ?? [];

    const candidate = nearest.find(entry =>
      ["building", "landmark", "item", "interaction"].includes(
        entry.object.type
      )
    );

    if (candidate) {
      runtime.events.emit("player:interactionRequested", {
        characterId: character.id,
        targetId: candidate.id,
        distanceM: candidate.distance,
        position: character.position.clone()
      });

      return;
    }

    const sites = water?.findNearbyDiveSites?.(
      character.position,
      2.5
    ) ?? [];

    if (sites.length) {
      const controller = swimControllers.get(character.id);

      const result = water.collectDiveSite(
        sites[0].id,
        character.position,
        controller
      );

      runtime.notify(
        result.ok ? `Collected: ${sites[0].name}` : result.message,
        result.ok ? "success" : "info"
      );

      return;
    }

    runtime.events.emit("player:interactionEmpty", {
      characterId: character.id,
      position: character.position.clone()
    });
  }

  /* ---------------------------------------------------------------- */
  /* UI state and world events                                         */
  /* ---------------------------------------------------------------- */

  function publishCharacterState(character, rig, movement) {
    runtime.state.patch({
      activeCharacterId: character.id,
      playerPosition: character.position.clone(),
      playerHeading: character.heading
    }, "character-transform");

    runtime.state.patch({
      isUnderwater: water?.getWaterRegionAt?.(
        character.position
      )?.type
        ? swimControllers.get(character.id)?.state === "underwater"
        : false
    }, "character-water-state");

    runtime.events.emit("player:stateUpdated", {
      characterId: character.id,
      position: character.position.clone(),
      velocity: character.velocity.clone(),
      heading: character.heading,
      health: character.health,
      stamina: character.stamina,
      movementMode: character.moveMode,
      grounded: character.grounded,
      speedMps: movement.speedMps
    });

    rig.root.position.copyFrom(character.position);
    rig.root.rotation.y = character.heading;
  }

  function updateFootsteps(character, movement) {
    if (!character.grounded) return;
    if (movement.speedMps < 0.55) return;

    const now = elapsed;

    const interval = character.sprinting
      ? 0.30
      : character.crouching
        ? 0.72
        : 0.46;

    if (now - lastFootstepTime < interval) return;

    lastFootstepTime = now;

    runtime.events.emit("audio:footstep", {
      characterId: character.id,
      position: character.position.clone(),
      speedMps: movement.speedMps,
      surfaceType: getCurrentSurfaceType(character),
      running: character.sprinting,
      crouching: character.crouching
    });
  }

  async function initialize() {
    if (initialized) return { ok: true };

    initialized = true;

    createCharacter("lucia");
    createCharacter("jason");

    installInputHandlers();
    installTouchButtons();

    runtime.state.patch({
      activeCharacterId,
      playerPosition: characters.get(activeCharacterId).position.clone(),
      playerHeading: characters.get(activeCharacterId).heading
    }, "player-initialization");

    eventDisposers.push(
      runtime.events.on("player:teleportRequested", payload => {
        const character = characters.get(
          payload.characterId ?? activeCharacterId
        );

        if (!character || !payload.position) return;

        const target = new B.Vector3(
          finite(payload.position.x),
          finite(payload.position.y),
          finite(payload.position.z)
        );

        character.position.copyFrom(target);
        character.lastSafePosition.copyFrom(target);

        const rig = rigs.get(character.id);
        if (rig) rig.root.position.copyFrom(target);

        runtime.events.emit("player:teleported", {
          characterId: character.id,
          position: target.clone()
        });
      })
    );

    eventDisposers.push(
      runtime.events.on("player:respawnRequested", payload => {
        const character = characters.get(
          payload.characterId ?? activeCharacterId
        );

        if (!character) return;

        const target = payload.position
          ? new B.Vector3(
              finite(payload.position.x),
              finite(payload.position.y),
              finite(payload.position.z)
            )
          : safePositionFor(character);

        character.position.copyFrom(target);
        character.lastSafePosition.copyFrom(target);
        character.health = 100;
        character.stamina = PLAYER_CONFIG.staminaMaximum;

        recoverCharacter(character, "respawn");
      })
    );

    const service = {
      getActiveCharacter: () => characters.get(activeCharacterId) ?? null,
      getCharacter: id => characters.get(id) ?? null,
      getAllCharacters: () => [...characters.values()],

      switchCharacter: performCharacterSwitch,
      getActiveCharacterId: () => activeCharacterId,

      registerCharacterModel(id, rootNode, animationGroups = []) {
        if (!characters.has(id)) {
          return { ok: false, message: `Unknown character: ${id}` };
        }

        if (!rootNode || typeof rootNode !== "object") {
          return { ok: false, message: "A valid model root is required." };
        }

        const rig = rigs.get(id);

        if (rig.externalModelRoot) {
          rig.externalModelRoot.dispose(false, false);
        }

        rootNode.parent = null;
        rootNode.position.copyFrom(characters.get(id).position);
        rootNode.rotation.y = characters.get(id).heading;

        rig.externalModelRoot = rootNode;
        rig.externalAnimations = [...animationGroups];

        // Hide the proxy after an external high-detail rig is registered.
        for (const mesh of rig.parts) mesh.setEnabled(false);

        runtime.events.emit("player:modelRegistered", {
          characterId: id,
          animationGroupCount: rig.externalAnimations.length
        });

        return { ok: true };
      },

      createCharacterModelProxy(id) {
        const rig = rigs.get(id);

        if (!rig) return null;

        for (const mesh of rig.parts) mesh.setEnabled(true);

        rig.externalModelRoot?.dispose(false, false);
        rig.externalModelRoot = null;
        rig.externalAnimations = null;

        return rig;
      },

      getSwimController: id => swimControllers.get(id) ?? null,

      setMovementMode(mode) {
        const modes = ["walk", "jog", "sprint", "crouch", "crawl"];

        if (!modes.includes(mode)) {
          return { ok: false, message: `Unknown movement mode: ${mode}` };
        }

        input.sprint = mode === "sprint";
        input.crouch = mode === "crouch";
        input.crawl = mode === "crawl";

        return { ok: true, mode };
      },

      getDiagnostics: () => ({
        activeCharacterId,
        characters: [...characters.values()].map(character => ({
          id: character.id,
          position: {
            x: character.position.x,
            y: character.position.y,
            z: character.position.z
          },
          health: character.health,
          stamina: character.stamina,
          movementMode: character.moveMode,
          grounded: character.grounded
        })),
        cameraYaw,
        cameraPitch,
        activePointers: pointerStates.size
      })
    };

    serviceDisposers.push(
      runtime.services.register("player", service)
    );

    serviceDisposers.push(
      runtime.services.register("characters", service)
    );

    logger.info("Player-control system initialized.", {
      characters: [...characters.keys()]
    });

    return { ok: true };
  }

  function start() {
    running = true;
    cameraReady = false;

    return { ok: true };
  }

  function update(context) {
    if (!initialized || !running || disposed) return;

    const dt = clamp(finite(context.gameDeltaSeconds), 0, 0.1);
    elapsed += dt;

    const activeCharacter = getActiveCharacter();
    const activeRig = getActiveRig();

    if (!activeCharacter || !activeRig) return;

    if (input.characterSwitchPressed) {
      input.characterSwitchPressed = false;
      performCharacterSwitch();
    }

    if (input.interactPressed) {
      input.interactPressed = false;
      attemptInteraction(activeCharacter);
    }

    const keyboard = calculateKeyboardVector();

    const moveX =
      Math.abs(input.moveX) > 0.02 ? input.moveX : keyboard.x;

    const moveY =
      Math.abs(input.moveY) > 0.02 ? input.moveY : keyboard.z;

    const direction = getMovementDirection(
      activeCharacter,
      moveX,
      moveY
    );

    const existingWaterController =
      swimControllers.get(activeCharacter.id);

    const waterRegion = water?.getWaterRegionAt?.(
      activeCharacter.position
    ) ?? null;

    let swimResult = null;

    if (waterRegion && existingWaterController) {
      const forward = new B.Vector3(
        Math.sin(cameraYaw),
        0,
        Math.cos(cameraYaw)
      );

      const right = new B.Vector3(
        Math.cos(cameraYaw),
        0,
        -Math.sin(cameraYaw)
      );

      const swimDirection = forward.scale(moveY).add(
        right.scale(moveX)
      );

      if (swimDirection.lengthSquared() > 1) {
        swimDirection.normalize();
      }

      swimResult = water.updateSwimmer(
        existingWaterController,
        {
          position: activeCharacter.position,
          velocity: activeCharacter.velocity,
          massKg: 75,
          volumeM3: 0.075,
          halfHeightM: 0.85
        },
        {
          moveX,
          moveY,
          directionX: swimDirection.x,
          directionZ: swimDirection.z,
          sprint: input.sprint,
          dive: input.dive,
          surface: input.jumpHeld,
          jump: input.jumpPressed,
          lungVolumeBonus:
            activeCharacter.attributes.lungCapacity * 0.5
        },
        dt
      );

      if (swimResult?.ok) {
        swimResult.characterId = activeCharacter.id;

        water.updateUnderwaterPresentation?.(swimResult);

        runtime.events.emit("player:swimmingUpdated", {
          characterId: activeCharacter.id,
          state: swimResult.state,
          depthBelowSurface: swimResult.depthBelowSurface,
          oxygenSeconds: swimResult.oxygenSeconds
        });
      }
    } else if (existingWaterController) {
      // Ensure an exited swimmer transitions to land and recovers oxygen.
      swimResult = water.updateSwimmer(
        existingWaterController,
        {
          position: activeCharacter.position,
          velocity: activeCharacter.velocity
        },
        {
          moveX,
          moveY
        },
        dt
      );

      water.updateUnderwaterPresentation?.(swimResult);
    }

    const movement = updateGroundedMotion(
      activeCharacter,
      dt,
      direction,
      swimResult
    );

    updateCleanliness(
      activeCharacter,
      dt,
      movement.inWater
    );

    updateProceduralAnimation(
      activeCharacter,
      activeRig,
      dt,
      movement.speedMps
    );

    activeRig.root.position.copyFrom(activeCharacter.position);
    activeRig.root.rotation.y = activeCharacter.heading;

    if (activeRig.externalModelRoot) {
      activeRig.externalModelRoot.position.copyFrom(
        activeCharacter.position
      );

      activeRig.externalModelRoot.rotation.y = activeCharacter.heading;

      // Animation groups can be selected by their semantic names.
      const groups = activeRig.externalAnimations ?? [];
      const desired = activeCharacter.moveMode;

      for (const group of groups) {
        if (!group?.name) continue;

        const name = group.name.toLowerCase();
        const matches =
          name.includes(desired) ||
          (desired === "moving" && name.includes("walk"));

        if (matches && !group.isPlaying) {
          group.start(true);
        } else if (!matches && group.isPlaying && name !== "idle") {
          group.stop();
        }
      }
    }

    updateFootsteps(activeCharacter, movement);
    updateCamera(activeCharacter, dt);

    publishCharacterState(
      activeCharacter,
      activeRig,
      movement
    );

    updateCompanion(getCompanion(), dt);

    if (
      activeCharacter.health <= 0 &&
      activeCharacter.moveMode !== "dead"
    ) {
      activeCharacter.moveMode = "dead";

      runtime.events.emit("player:died", {
        characterId: activeCharacter.id,
        position: activeCharacter.position.clone()
      });
    }

    input.jumpPressed = false;
    input.interactPressed = false;
    input.characterSwitchPressed = false;

    runtime.events.emit("player:movementTelemetry", {
      characterId: activeCharacter.id,
      speedMps: movement.speedMps,
      horizontalVelocity: {
        x: activeCharacter.velocity.x,
        z: activeCharacter.velocity.z
      },
      stamina: activeCharacter.stamina,
      surfaceType: getCurrentSurfaceType(activeCharacter)
    });
  }

  function stop() {
    running = false;
    clearInput();
    return { ok: true };
  }

  function dispose() {
    if (disposed) return;

    disposed = true;
    running = false;

    clearInput();

    for (const off of eventDisposers.splice(0)) {
      try { off(); } catch {}
    }

    for (const off of serviceDisposers.splice(0)) {
      try { off(); } catch {}
    }

    for (const [id, rig] of rigs) {
      try {
        rig.dispose();
      } catch (error) {
        logger.warn(`Character rig cleanup failed: ${id}`, error);
      }

      try { entities.unregister(id); } catch {}
    }

    rigs.clear();
    characters.clear();
    swimControllers.clear();
    previousSafePositions.clear();
  }

  return Object.freeze({
    initialize,
    start,
    update,
    stop,
    dispose,

    getActiveCharacter,
    performCharacterSwitch,

    getDiagnostics: () => ({
      activeCharacterId,
      running,
      characters: characters.size,
      rigs: rigs.size,
      elapsed
    })
  });
}
