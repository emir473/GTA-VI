/*
 * Module 9: waffen_inventar.js
 * Dependencies: Babylon.js scene, combat service, weather service.
 * Public service: weapons.
 *
 * Ballistics are gameplay approximations with SI-like units.
 * No real-world weapon or external targeting integrations are used.
 */

const WEAPON_CATALOG = Object.freeze({
  pistol: {
    id: "pistol",
    name: "Service Pistol",
    category: "handgun",
    damage: 24,
    muzzleVelocityMps: 360,
    projectileMassKg: 0.008,
    dragCoefficient: 0.31,
    referenceAreaM2: 0.00006,
    magazineSize: 12,
    reloadSeconds: 1.45,
    fireIntervalSeconds: 0.24,
    spreadRadians: 0.012,
    rangeM: 220,
    ammoClass: "9mm",
    visibleCarry: "holster",
    massKg: 0.95
  },

  heavyPistol: {
    id: "heavyPistol",
    name: "Heavy Pistol",
    category: "handgun",
    damage: 42,
    muzzleVelocityMps: 300,
    projectileMassKg: 0.013,
    dragCoefficient: 0.34,
    referenceAreaM2: 0.00009,
    magazineSize: 8,
    reloadSeconds: 1.8,
    fireIntervalSeconds: 0.34,
    spreadRadians: 0.015,
    rangeM: 250,
    ammoClass: "heavy-pistol",
    visibleCarry: "holster",
    massKg: 1.25
  },

  smg: {
    id: "smg",
    name: "Compact SMG",
    category: "smg",
    damage: 19,
    muzzleVelocityMps: 390,
    projectileMassKg: 0.008,
    dragCoefficient: 0.30,
    referenceAreaM2: 0.00006,
    magazineSize: 30,
    reloadSeconds: 1.9,
    fireIntervalSeconds: 0.085,
    spreadRadians: 0.024,
    rangeM: 260,
    ammoClass: "9mm",
    visibleCarry: "back",
    massKg: 2.6
  },

  rifle: {
    id: "rifle",
    name: "Assault Rifle",
    category: "rifle",
    damage: 27,
    muzzleVelocityMps: 760,
    projectileMassKg: 0.004,
    dragCoefficient: 0.31,
    referenceAreaM2: 0.000036,
    magazineSize: 30,
    reloadSeconds: 2.1,
    fireIntervalSeconds: 0.095,
    spreadRadians: 0.013,
    rangeM: 500,
    ammoClass: "rifle",
    visibleCarry: "back",
    massKg: 3.8
  },

  shotgun: {
    id: "shotgun",
    name: "Pump Shotgun",
    category: "shotgun",
    damage: 13,
    pellets: 9,
    muzzleVelocityMps: 380,
    projectileMassKg: 0.003,
    dragCoefficient: 0.45,
    referenceAreaM2: 0.000012,
    magazineSize: 6,
    reloadSeconds: 2.4,
    fireIntervalSeconds: 0.75,
    spreadRadians: 0.075,
    rangeM: 70,
    ammoClass: "12g",
    visibleCarry: "back",
    massKg: 3.4
  }
});

const INVENTORY_LIMITS = Object.freeze({
  maxProjectiles: 280,
  maxHistoryEntries: 200,
  maxAmmoPerClass: 2400,
  maxWeaponsOwned: 24,
  maxCarryMassKg: 35
});

function weaponClamp(value, min, max) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}

function weaponFinite(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function createEmptyLoadout(characterId) {
  return {
    characterId,
    weapons: new Map(),
    ammoByClass: new Map(),
    selectedWeaponId: null,
    lastShotTime: -Infinity,
    reloadingWeaponId: null,
    reloadTimeRemaining: 0,
    reloadReservedAmmo: 0,
    carryingWeightKg: 0,
    inventoryRevision: 0
  };
}

export async function createWeaponInventorySystem({
  runtime,
  scene,
  camera,
  services,
  entities,
  logger
}) {
  if (!runtime || !scene || !camera) {
    throw new TypeError("Weapon system requires runtime, scene and camera.");
  }

  const B = globalThis.BABYLON;
  if (!B) throw new Error("Babylon.js is unavailable.");

  const eventDisposers = [];
  const serviceDisposers = [];

  const loadouts = new Map();
  const projectiles = [];
  const tracerMeshes = new Set();
  const impactMeshes = new Set();
  const pickupRecords = new Map();

  const weaponWheel = {
    open: false,
    selectedIndex: 0,
    previousSelection: null,
    timeScaleLease: null,
    overlay: null
  };

  let initialized = false;
  let running = false;
  let disposed = false;
  let elapsed = 0;
  let nextProjectileId = 1;
  let nextPickupId = 1;
  let nextImpactId = 1;

  let combat = services.get("combat");
  let weather = services.get("weather");
  let player = services.get("player");

  function getLoadout(characterId) {
    if (!loadouts.has(characterId)) {
      loadouts.set(characterId, createEmptyLoadout(characterId));
    }

    return loadouts.get(characterId);
  }

  function getSelectedLoadout() {
    const characterId =
      player?.getActiveCharacterId?.() ??
      runtime.state.get("activeCharacterId") ??
      "lucia";

    return getLoadout(characterId);
  }

  function publicWeaponState(loadout) {
    return {
      characterId: loadout.characterId,
      selectedWeaponId: loadout.selectedWeaponId,
      carryingWeightKg: loadout.carryingWeightKg,

      weapons: [...loadout.weapons.values()].map(weapon => ({
        id: weapon.id,
        magazine: weapon.magazine,
        magazineSize: weapon.definition.magazineSize,
        reserveAmmo: loadout.ammoByClass.get(
          weapon.definition.ammoClass
        ) ?? 0,
        weightKg: weapon.weightKg,
        durability: weapon.durability,
        visible: weapon.visible,
        isReloading: loadout.reloadingWeaponId === weapon.id
      })),

      ammoByClass: Object.fromEntries(loadout.ammoByClass),
      reloadTimeRemaining: loadout.reloadTimeRemaining
    };
  }

  function addWeapon(characterId, weaponId, options = {}) {
    const definition = WEAPON_CATALOG[weaponId];

    if (!definition) {
      return { ok: false, reason: "unknown-weapon" };
    }

    const loadout = getLoadout(characterId);

    if (loadout.weapons.has(weaponId)) {
      return { ok: false, reason: "already-owned" };
    }

    if (loadout.weapons.size >= INVENTORY_LIMITS.maxWeaponsOwned) {
      return { ok: false, reason: "weapon-capacity-reached" };
    }

    const initialAmmo = weaponClamp(
      Math.floor(weaponFinite(
        options.initialReserveAmmo,
        3 * definition.magazineSize
      )),
      0,
      INVENTORY_LIMITS.maxAmmoPerClass
    );

    const existingWeight = loadout.carryingWeightKg;
    const weaponWeight = weaponClamp(
      weaponFinite(options.massKg, definition.massKg ?? 2.1),
      0.1,
      15
    );

    if (existingWeight + weaponWeight > INVENTORY_LIMITS.maxCarryMassKg) {
      return { ok: false, reason: "carry-weight-limit" };
    }

    const weapon = {
      id: weaponId,
      definition,
      magazine: weaponClamp(
        Math.floor(weaponFinite(
          options.magazine,
          definition.magazineSize
        )),
        0,
        definition.magazineSize
      ),
      equippedAt: elapsed,
      weightKg: weaponWeight,
      durability: weaponClamp(weaponFinite(options.durability, 1), 0, 1),
      visible: options.visible !== false
    };

    loadout.weapons.set(weaponId, weapon);

    loadout.ammoByClass.set(
      definition.ammoClass,
      Math.min(
        INVENTORY_LIMITS.maxAmmoPerClass,
        (loadout.ammoByClass.get(definition.ammoClass) ?? 0) + initialAmmo
      )
    );

    loadout.carryingWeightKg += weaponWeight;
    loadout.inventoryRevision++;

    if (!loadout.selectedWeaponId) {
      loadout.selectedWeaponId = weaponId;
    }

    runtime.events.emit("inventory:changed", {
      characterId,
      reason: "weapon-added",
      weaponId,
      inventory: publicWeaponState(loadout)
    });

    return { ok: true, weaponId };
  }

  function removeWeapon(characterId, weaponId, options = {}) {
    const loadout = getLoadout(characterId);
    const weapon = loadout.weapons.get(weaponId);

    if (!weapon) {
      return { ok: false, reason: "weapon-not-owned" };
    }

    if (loadout.reloadingWeaponId === weaponId) {
      const ammoClass = weapon.definition.ammoClass;
      const reserve = loadout.ammoByClass.get(ammoClass) ?? 0;
      const reserved = Math.max(
        0,
        Math.floor(loadout.reloadReservedAmmo ?? 0)
      );

      loadout.ammoByClass.set(
        ammoClass,
        Math.min(INVENTORY_LIMITS.maxAmmoPerClass, reserve + reserved)
      );

      loadout.reloadingWeaponId = null;
      loadout.reloadTimeRemaining = 0;
      loadout.reloadReservedAmmo = 0;

      runtime.events.emit("weapon:reloadCancelled", {
        characterId,
        weaponId,
        roundsReturned: reserved,
        reason: "weapon-removed"
      });
    }

    loadout.weapons.delete(weaponId);
    loadout.carryingWeightKg = Math.max(
      0,
      loadout.carryingWeightKg - weapon.weightKg
    );
    loadout.inventoryRevision++;

    if (loadout.selectedWeaponId === weaponId) {
      loadout.selectedWeaponId =
        loadout.weapons.keys().next().value ?? null;
    }

    if (options.returnAmmo === true) {
      const ammoClass = weapon.definition.ammoClass;
      const reserve = loadout.ammoByClass.get(ammoClass) ?? 0;

      loadout.ammoByClass.set(
        ammoClass,
        Math.min(
          INVENTORY_LIMITS.maxAmmoPerClass,
          reserve + weapon.magazine
        )
      );
    }

    runtime.events.emit("inventory:changed", {
      characterId,
      reason: "weapon-removed",
      weaponId,
      inventory: publicWeaponState(loadout)
    });

    return { ok: true };
  }

  function selectWeapon(characterId, weaponId) {
    const loadout = getLoadout(characterId);

    if (!loadout.weapons.has(weaponId)) {
      return { ok: false, reason: "weapon-not-owned" };
    }

    if (loadout.reloadingWeaponId) {
      return { ok: false, reason: "weapon-reloading" };
    }

    const previous = loadout.selectedWeaponId;
    loadout.selectedWeaponId = weaponId;
    loadout.inventoryRevision++;

    runtime.events.emit("inventory:weaponSelected", {
      characterId,
      weaponId,
      previousWeaponId: previous
    });

    return { ok: true, weaponId };
  }

  function addAmmo(characterId, ammoClass, amount) {
    if (!Number.isFinite(amount) || amount <= 0) {
      return { ok: false, reason: "invalid-amount" };
    }

    const knownAmmoClasses = new Set(
      Object.values(WEAPON_CATALOG).map(definition => definition.ammoClass)
    );

    if (typeof ammoClass !== "string" || !knownAmmoClasses.has(ammoClass)) {
      return { ok: false, reason: "unknown-ammo-class" };
    }

    const integerAmount = Math.floor(amount);
    if (integerAmount <= 0) {
      return { ok: false, reason: "invalid-amount" };
    }

    const loadout = getLoadout(characterId);
    const current = loadout.ammoByClass.get(ammoClass) ?? 0;

    const next = Math.min(
      INVENTORY_LIMITS.maxAmmoPerClass,
      current + integerAmount
    );

    loadout.ammoByClass.set(ammoClass, next);
    loadout.inventoryRevision++;

    runtime.events.emit("inventory:changed", {
      characterId,
      reason: "ammo-added",
      ammoClass,
      amount: next - current,
      inventory: publicWeaponState(loadout)
    });

    return { ok: true, amount: next - current };
  }

  function reload(characterId) {
    const loadout = getLoadout(characterId);
    const weapon = loadout.weapons.get(loadout.selectedWeaponId);

    if (!weapon) return { ok: false, reason: "no-selected-weapon" };
    if (loadout.reloadingWeaponId) {
      return { ok: false, reason: "already-reloading" };
    }

    const needed = weapon.definition.magazineSize - weapon.magazine;
    const available = loadout.ammoByClass.get(
      weapon.definition.ammoClass
    ) ?? 0;

    if (needed <= 0) return { ok: false, reason: "magazine-full" };
    if (available <= 0) return { ok: false, reason: "no-reserve-ammo" };

    // Reserve ammunition once when reloading starts.
    const reserved = Math.min(needed, available);

    loadout.ammoByClass.set(
      weapon.definition.ammoClass,
      available - reserved
    );

    loadout.reloadingWeaponId = weapon.id;
    loadout.reloadTimeRemaining = weapon.definition.reloadSeconds;
    loadout.reloadReservedAmmo = reserved;
    loadout.inventoryRevision++;

    runtime.events.emit("weapon:reloadStarted", {
      characterId,
      weaponId: weapon.id,
      durationSeconds: loadout.reloadTimeRemaining,
      roundsReserved: reserved
    });

    return { ok: true, roundsReserved: reserved };
  }

  function applySpread(direction, spread, seed) {
    const random = (() => {
      let x = seed >>> 0;

      return () => {
        x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
        return x / 4294967296;
      };
    })();

    const right = B.Vector3.Cross(
      direction,
      Math.abs(direction.y) > 0.9 ? B.Axis.Z : B.Axis.Y
    ).normalize();

    const up = B.Vector3.Cross(right, direction).normalize();

    const angle = random() * Math.PI * 2;
    const radius = Math.sqrt(random()) * spread;

    return direction.clone()
      .add(right.scale(Math.cos(angle) * radius))
      .add(up.scale(Math.sin(angle) * radius))
      .normalize();
  }

  function resolveShooter(characterId) {
    const character = player?.getCharacter?.(characterId);
    if (!character) return null;

    const root = scene.getTransformNodeByName(
      `character-root-${characterId}`
    );

    const position = root?.getAbsolutePosition?.() ?? character.position;
    const heading = weaponFinite(character.heading);

    const cameraRay = camera.getForwardRay?.(1);
    const cameraDirection = cameraRay?.direction;

    const direction = cameraDirection && cameraDirection.lengthSquared() > 1e-5
      ? cameraDirection.clone().normalize()
      : new B.Vector3(
          Math.sin(heading),
          0.025,
          Math.cos(heading)
        ).normalize();

    return {
      character,
      root,
      position: new B.Vector3(position.x, position.y, position.z),
      direction
    };
  }

  function createTracer(start, end, lifetime = 0.09) {
    if (tracerMeshes.size >= 80) return null;

    const mesh = B.MeshBuilder.CreateLines(
      `projectile-tracer-${nextProjectileId}`,
      {
        points: [start, end],
        updatable: true
      },
      scene
    );

    mesh.isPickable = false;
    mesh.color = new B.Color3(1, 0.78, 0.42);

    const record = {
      mesh,
      expiresAt: elapsed + lifetime
    };

    tracerMeshes.add(record);
    return record;
  }

  function fire(characterId, options = {}) {
    const loadout = getLoadout(characterId);
    const weapon = loadout.weapons.get(loadout.selectedWeaponId);
    const shooter = resolveShooter(characterId);

    if (disposed || !initialized) {
      return { ok: false, reason: "weapon-system-unavailable" };
    }

    if (!weapon || !shooter) {
      return { ok: false, reason: "weapon-or-shooter-unavailable" };
    }

    if (loadout.reloadingWeaponId) {
      return { ok: false, reason: "reloading" };
    }

    if (
      elapsed - loadout.lastShotTime <
      weapon.definition.fireIntervalSeconds
    ) {
      return { ok: false, reason: "fire-rate-limit" };
    }

    if (weapon.magazine <= 0) {
      return { ok: false, reason: "empty-magazine" };
    }

    const weaponDefinition = weapon.definition;
    const requestedDirection = options.direction
      ? new B.Vector3(
          weaponFinite(options.direction.x),
          weaponFinite(options.direction.y),
          weaponFinite(options.direction.z)
        )
      : shooter.direction.clone();

    if (
      !Number.isFinite(requestedDirection.x) ||
      !Number.isFinite(requestedDirection.y) ||
      !Number.isFinite(requestedDirection.z) ||
      requestedDirection.lengthSquared() < 1e-6
    ) {
      return { ok: false, reason: "invalid-aim-direction" };
    }

    const aimDirection = requestedDirection.normalize();
    const pellets = Math.max(
      1,
      Math.floor(weaponFinite(weaponDefinition.pellets, 1))
    );

    if (projectiles.length + pellets > INVENTORY_LIMITS.maxProjectiles) {
      return { ok: false, reason: "projectile-capacity-reached" };
    }

    weapon.magazine--;
    loadout.lastShotTime = elapsed;
    loadout.inventoryRevision++;

    const heading = weaponFinite(shooter.character.heading);
    const muzzleOffset = new B.Vector3(
      Math.sin(heading) * 0.18,
      1.23,
      Math.cos(heading) * 0.18
    );

    const start = shooter.position.add(muzzleOffset);
    const seedBase = nextProjectileId++;

    for (let pellet = 0; pellet < pellets; pellet++) {
      const direction = applySpread(
        aimDirection,
        weaponDefinition.spreadRadians,
        seedBase * 41 + pellet
      );

      const projectile = {
        id: `projectile-${seedBase}-${pellet}`,
        ownerId: characterId,
        weaponId: weapon.id,
        position: start.clone(),
        velocity: direction.scale(weaponDefinition.muzzleVelocityMps),

        massKg: weaponDefinition.projectileMassKg,
        dragCoefficient: weaponDefinition.dragCoefficient,
        areaM2: weaponDefinition.referenceAreaM2,

        energyJ: 0.5 *
          weaponDefinition.projectileMassKg *
          weaponDefinition.muzzleVelocityMps ** 2,

        damage: weaponDefinition.damage,
        timeAlive: 0,
        distanceTravelledM: 0,
        maxRangeM: weaponDefinition.rangeM,
        maxLifetimeSeconds:
          weaponDefinition.rangeM /
          Math.max(1, weaponDefinition.muzzleVelocityMps) + 0.7,

        remainingPenetrations: 2,
        hitEntityIds: new Set(),

        tracer: pellet === 0
          ? createTracer(start, start.add(direction.scale(12)))
          : null,

        dead: false
      };

      projectiles.push(projectile);
    }

    runtime.events.emit("weapon:fired", {
      shooterId: characterId,
      weaponId: weapon.id,
      projectileCount: pellets,
      muzzlePosition: start.clone(),
      direction: aimDirection.clone(),
      magazineRemaining: weapon.magazine
    });

    runtime.events.emit("weapon:recoilRequested", {
      characterId,
      weaponId: weapon.id,
      category: weaponDefinition.category,
      impulse: weaponDefinition.category === "shotgun" ? 1.35
        : weaponDefinition.category === "rifle" ? 0.62
          : weaponDefinition.category === "smg" ? 0.28 : 0.42,
      direction: aimDirection.clone()
    });

    runtime.events.emit("world:gunshotEmitted", {
      actorId: characterId,
      position: start.clone(),
      weaponId: weapon.id,
      acousticRadiusM: weaponDefinition.category === "shotgun" ? 1200 : 900,
      publicWeapon: true,
      observedCrimeConfirmed: false
    });

    runtime.events.emit("audio:gunshotRequested", {
      actorId: characterId,
      position: start.clone(),
      weaponId: weapon.id,
      category: weaponDefinition.category
    });

    runtime.events.emit("inventory:changed", {
      characterId,
      reason: "shot",
      inventory: publicWeaponState(loadout)
    });

    return {
      ok: true,
      weaponId: weapon.id,
      magazineRemaining: weapon.magazine,
      projectilesSpawned: pellets
    };
  }

  function spawnImpactEffect(position, normal, materialClass = "unknown") {
    if (!position || impactMeshes.size >= 96) return null;

    const mesh = B.MeshBuilder.CreateSphere(
      `projectile-impact-${nextImpactId++}`,
      { diameter: 0.075, segments: 6 },
      scene
    );

    const n = normal?.clone?.() ?? new B.Vector3(0, 1, 0);
    if (n.lengthSquared() > 1e-5) n.normalize();
    else n.set(0, 1, 0);

    mesh.position.copyFrom(position.add(n.scale(0.025)));
    mesh.isPickable = false;
    mesh.checkCollisions = false;
    mesh.metadata = {
      ...(mesh.metadata || {}),
      projectilePassThrough: true,
      temporaryImpactEffect: true
    };

    const material = new B.StandardMaterial(
      `${mesh.name}-material`,
      scene
    );

    const metal = /metal|steel|vehicle|armor/i.test(materialClass);
    material.diffuseColor = metal
      ? new B.Color3(0.95, 0.53, 0.16)
      : new B.Color3(0.22, 0.19, 0.15);
    material.emissiveColor = metal
      ? new B.Color3(0.8, 0.22, 0.04)
      : new B.Color3(0.04, 0.035, 0.025);
    material.alpha = metal ? 0.9 : 0.72;
    mesh.material = material;

    const record = {
      mesh,
      material,
      createdAt: elapsed,
      lifetimeSeconds: metal ? 0.24 : 1.8
    };

    impactMeshes.add(record);
    return record;
  }

  function applyProjectileImpact(projectile, hit) {
    const mesh = hit.pickedMesh;
    const metadata = mesh?.metadata ?? {};

    const materialName = String(
      metadata.materialClass ?? mesh?.material?.name ?? ""
    ).toLowerCase();

    const defaultResistance = /glass|window/.test(materialName) ? 900
      : /drywall|plaster|gypsum/.test(materialName) ? 700
        : /flesh|body|meat/.test(materialName) ? 3000
          : /wood|timber|plywood/.test(materialName) ? 2400
            : /concrete|brick|stone/.test(materialName) ? 18000
              : /steel|armor|armour/.test(materialName) ? 30000
                : /metal|vehicle/.test(materialName) ? 12000
                  : 5000;

    const materialResistance = weaponClamp(
      weaponFinite(metadata.penetrationResistanceJPerM, defaultResistance),
      0,
      200000
    );

    const defaultThickness = /glass|window/.test(materialName) ? 0.012
      : /drywall|plaster|gypsum/.test(materialName) ? 0.035
        : /flesh|body|meat/.test(materialName) ? 0.15
          : /wood|timber|plywood/.test(materialName) ? 0.045
            : /concrete|brick|stone/.test(materialName) ? 0.22
              : /steel|armor|armour/.test(materialName) ? 0.08
                : /metal|vehicle/.test(materialName) ? 0.04
                  : 0.12;

    const thicknessM = weaponClamp(
      weaponFinite(metadata.materialThicknessM, defaultThickness),
      0.01,
      4
    );

    const requiredEnergy = materialResistance * thicknessM;
    const targetId =
      metadata.combatantId ??
      metadata.characterId ??
      metadata.npcId ??
      null;

    // Apply damage before penetration so a high-energy projectile cannot pass
    // through a registered character hitbox without applying a hit.
    if (targetId && !projectile.hitEntityIds.has(targetId)) {
      const combatService = services.get("combat") ?? combat;

      if (combatService?.applyDamage) {
        const result = combatService.applyDamage({
          targetId,
          attackerId: projectile.ownerId,
          damage: projectile.damage,
          hitZone: metadata.hitZone ?? "torso",
          source: "ballistic-projectile"
        });

        if (result?.ok) projectile.hitEntityIds.add(targetId);
      }
    }

    const surfaceNormal = hit.getNormal?.(true, true);

    if (surfaceNormal && metadata.ricochetAllowed === true) {
      const incomingDirection = projectile.velocity.clone().normalize();
      const incidence = Math.abs(
        B.Vector3.Dot(incomingDirection, surfaceNormal.normalize())
      );

      if (
        incidence < weaponClamp(
          weaponFinite(metadata.ricochetIncidenceThreshold, 0.28),
          0.05,
          0.8
        ) &&
        projectile.energyJ > requiredEnergy * 0.25
      ) {
        const n = surfaceNormal.normalize();
        projectile.energyJ *= 0.42;
        projectile.velocity = incomingDirection
          .subtract(n.scale(2 * B.Vector3.Dot(incomingDirection, n)))
          .scale(Math.sqrt(2 * projectile.energyJ / projectile.massKg));
        projectile.damage *= 0.45;
        projectile.remainingPenetrations = Math.max(
          0,
          projectile.remainingPenetrations - 1
        );
        projectile.position.copyFrom(hit.pickedPoint.add(n.scale(0.045)));
        spawnImpactEffect(
          hit.pickedPoint,
          n,
          metadata.materialClass ?? "metal"
        );

        runtime.events.emit("weapon:ricochet", {
          projectileId: projectile.id,
          position: hit.pickedPoint.clone(),
          materialClass: metadata.materialClass ?? "unknown",
          energyRemainingJ: projectile.energyJ
        });

        return { penetrated: true, ricocheted: true };
      }
    }

    if (
      projectile.remainingPenetrations > 0 &&
      projectile.energyJ > requiredEnergy * 1.8 &&
      metadata.penetrable !== false
    ) {
      projectile.remainingPenetrations--;

      const energyBefore = Math.max(1, projectile.energyJ);
      projectile.energyJ = Math.max(
        0,
        projectile.energyJ - requiredEnergy
      );

      const postPenetrationSpeed = Math.sqrt(
        2 * projectile.energyJ / projectile.massKg
      );

      projectile.velocity = projectile.velocity.normalize()
        .scale(postPenetrationSpeed);

      projectile.damage *= weaponClamp(
        projectile.energyJ / energyBefore,
        0.12,
        0.85
      );

      const continuation = projectile.velocity.normalize().scale(0.09);

      projectile.position.copyFrom(
        hit.pickedPoint.add(continuation)
      );

      spawnImpactEffect(
        hit.pickedPoint,
        hit.getNormal?.(true, true),
        metadata.materialClass ?? "unknown"
      );

      runtime.events.emit("weapon:materialPenetrated", {
        projectileId: projectile.id,
        meshId: mesh?.uniqueId ?? null,
        materialId: metadata.materialClass ?? "unknown",
        energyRemainingJ: projectile.energyJ
      });

      return { penetrated: true };
    }

    if (hit.pickedPoint) {
      spawnImpactEffect(
        hit.pickedPoint,
        hit.getNormal?.(true, true),
        metadata.materialClass ?? "unknown"
      );

      runtime.events.emit("weapon:impact", {
        projectileId: projectile.id,
        ownerId: projectile.ownerId,
        weaponId: projectile.weaponId,
        position: hit.pickedPoint.clone(),
        normal: hit.getNormal?.(true, true) ?? null,
        targetId,
        stoppedBy: metadata.materialClass ?? "world-geometry",
        energyJ: projectile.energyJ
      });
    }

    projectile.dead = true;
    return { penetrated: false };
  }

  function updateProjectile(projectile, dt) {
    if (projectile.dead) return;

    projectile.timeAlive += dt;

    if (projectile.timeAlive >= projectile.maxLifetimeSeconds) {
      projectile.dead = true;
      return;
    }

    const windSample = weather?.getWindAt?.(projectile.position);
    const wind = windSample?.subtract
      ? windSample.clone()
      : new B.Vector3(
          weaponFinite(windSample?.x),
          weaponFinite(windSample?.y),
          weaponFinite(windSample?.z)
        );

    const relativeWind = wind.subtract(projectile.velocity);
    const relativeSpeed = relativeWind.length();

    const density = 1.225;
    const drag = relativeSpeed > 1e-4
      ? relativeWind.scale(
          0.5 *
          density *
          projectile.dragCoefficient *
          projectile.areaM2 *
          relativeSpeed /
          projectile.massKg
        )
      : B.Vector3.Zero();

    const acceleration = new B.Vector3(
      drag.x,
      -9.81 + drag.y,
      drag.z
    );

    projectile.velocity.addInPlace(acceleration.scale(dt));
    const currentSpeed = projectile.velocity.length();
    projectile.energyJ = 0.5 * projectile.massKg * currentSpeed * currentSpeed;

    if (currentSpeed < 8 || projectile.energyJ < 0.05) {
      projectile.dead = true;
      return;
    }

    const nextPosition = projectile.position.add(
      projectile.velocity.scale(dt)
    );

    const delta = nextPosition.subtract(projectile.position);
    const fullStepDistance = delta.length();
    const remainingRange = Math.max(
      0,
      projectile.maxRangeM - projectile.distanceTravelledM
    );

    const distance = Math.min(fullStepDistance, remainingRange);

    if (fullStepDistance > 1e-6 && distance < fullStepDistance) {
      nextPosition.copyFrom(
        projectile.position.add(delta.normalize().scale(distance))
      );
    }

    if (distance <= 0) {
      projectile.dead = true;
      return;
    }

    projectile.distanceTravelledM += distance;

    if (distance > 0.001) {
      const ray = new B.Ray(
        projectile.position,
        delta.normalize(),
        distance
      );

      const hit = scene.pickWithRay(
        ray,
        mesh => {
          if (!mesh || !mesh.isEnabled() || !mesh.isVisible) return false;
          if (mesh.metadata?.isWaterSurface) return false;
          if (mesh.metadata?.projectilePassThrough === true) return false;

          const entityId = mesh.metadata?.combatantId ??
            mesh.metadata?.characterId ??
            mesh.metadata?.npcId;

          // Once an entity has been hit, ignore its other overlapping hit zones
          // for this projectile. This prevents one shot applying damage several times.
          if (entityId && projectile.hitEntityIds.has(entityId)) return false;

          if (
            entityId === projectile.ownerId &&
            projectile.timeAlive < 0.08
          ) {
            return false;
          }

          return mesh.isPickable !== false;
        },
        false
      );

      if (hit?.hit && hit.pickedPoint) {
        const impact = applyProjectileImpact(projectile, hit);
        if (!impact.penetrated) return;
      } else {
        projectile.position.copyFrom(nextPosition);
      }

      if (projectile.distanceTravelledM >= projectile.maxRangeM) {
        projectile.dead = true;
        return;
      }
    }

    if (projectile.tracer && !projectile.tracer.mesh.isDisposed()) {
      const mesh = projectile.tracer.mesh;

      B.MeshBuilder.CreateLines(
        mesh.name,
        {
          points: [
            projectile.position,
            projectile.position.subtract(
              projectile.velocity.normalize().scale(5)
            )
          ],
          instance: mesh
        },
        scene
      );
    }
  }

  /* --------------------------------------------------------------- */
  /* Weapon wheel and time-scale ownership                             */
  /* --------------------------------------------------------------- */

  function acquireSlowMotion() {
    const timeService = services.get("timeScale") ??
      services.get("simulationTime");

    if (typeof timeService?.acquire === "function") {
      try {
        return {
          adapter: "timeScale",
          handle: timeService.acquire({
            owner: "weapon-wheel",
            scale: 0.1
          }),
          service: timeService,
          active: true
        };
      } catch (firstError) {
        try {
          return {
            adapter: "timeScale",
            handle: timeService.acquire(0.1, "weapon-wheel"),
            service: timeService,
            active: true
          };
        } catch (secondError) {
          logger.warn(
            "The registered time-scale service rejected both supported acquire signatures.",
            secondError
          );
        }
      }
    }

    if (typeof runtime.timeScale?.acquire === "function") {
      try {
        return {
          adapter: "runtime",
          handle: runtime.timeScale.acquire(0.1, "weapon-wheel"),
          service: runtime.timeScale,
          active: true
        };
      } catch (error) {
        logger.warn("Runtime time-scale acquisition failed.", error);
      }
    }

    runtime.events.emit("simulation:timeScaleRequested", {
      owner: "weapon-wheel",
      scale: 0.1
    });

    return {
      adapter: "event-request",
      handle: null,
      service: null,
      active: false
    };
  }

  function releaseSlowMotion(lease) {
    if (!lease) return;

    try {
      if (lease.adapter === "event-request") {
        runtime.events.emit("simulation:timeScaleReleased", {
          owner: "weapon-wheel"
        });
      } else if (typeof lease.handle?.release === "function") {
        lease.handle.release();
      } else if (typeof lease.service?.release === "function") {
        lease.service.release(lease.handle);
      } else if (typeof lease.service?.setScale === "function") {
        lease.service.setScale(1, "weapon-wheel");
      }
    } catch (error) {
      logger.warn("Weapon-wheel time-scale cleanup failed.", error);
    }
  }

  function createWeaponWheelUI() {
    const overlay = document.createElement("div");

    overlay.id = "weapon-wheel-overlay";
    overlay.hidden = true;
    overlay.style.position = "fixed";
    overlay.style.inset = "0";
    overlay.style.zIndex = "9000";
    overlay.style.display = "grid";
    overlay.style.placeItems = "center";
    overlay.style.background = "rgba(3,8,14,.63)";
    overlay.style.backdropFilter = "blur(4px)";
    overlay.style.color = "#fff";
    overlay.style.fontFamily = "system-ui, sans-serif";

    const panel = document.createElement("div");

    panel.style.position = "relative";
    panel.style.width = "min(520px, 92vw, 76vh)";
    panel.style.height = "min(520px, 92vw, 76vh)";
    panel.style.padding = "0";
    panel.style.borderRadius = "50%";
    panel.style.border = "1px solid rgba(255,255,255,.2)";
    panel.style.background = "radial-gradient(circle, rgba(29,43,54,.98) 0 25%, rgba(13,23,32,.97) 66%, rgba(8,14,20,.97) 100%)";
    panel.style.boxShadow = "0 24px 80px rgba(0,0,0,.6)";
    panel.style.overflow = "hidden";

    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    weaponWheel.overlay = overlay;
    weaponWheel.panel = panel;

    overlay.addEventListener("click", event => {
      if (event.target === overlay) closeWeaponWheel(true);
    });

    return overlay;
  }

  function renderWeaponWheel() {
    const loadout = getSelectedLoadout();
    const weapons = [...loadout.weapons.values()];
    const panel = weaponWheel.panel;
    if (!panel) return;

    panel.replaceChildren();

    const rect = panel.getBoundingClientRect();
    const radius = Math.max(58, Math.min(rect.width, rect.height) * 0.28);

    const center = document.createElement("div");
    center.style.position = "absolute";
    center.style.left = "50%";
    center.style.top = "50%";
    center.style.transform = "translate(-50%, -50%)";
    center.style.width = "36%";
    center.style.textAlign = "center";
    center.style.pointerEvents = "none";

    const selectedWeapon = weapons[weaponWheel.selectedIndex] ?? null;
    const reserve = selectedWeapon
      ? (loadout.ammoByClass.get(selectedWeapon.definition.ammoClass) ?? 0)
      : 0;

    center.innerHTML = `<div style="font-size:clamp(11px,2.4vw,16px);font-weight:900;letter-spacing:.12em">WEAPONS</div>
      <div style="font-size:clamp(9px,1.9vw,12px);color:#9fb2c0;margin-top:5px">${loadout.characterId.toUpperCase()}</div>
      <div style="font-size:clamp(12px,2.8vw,18px);font-weight:800;margin-top:14px">${selectedWeapon ? selectedWeapon.definition.name : "EMPTY"}</div>
      <div style="font-size:clamp(11px,2.2vw,14px);color:#aee4dc;margin-top:5px">${selectedWeapon ? `${selectedWeapon.magazine} / ${reserve}` : "No weapon"}</div>`;

    panel.appendChild(center);

    weapons.forEach((weapon, index) => {
      const angle = -Math.PI / 2 +
        (Math.PI * 2 * index / Math.max(1, weapons.length));
      const x = Math.cos(angle) * radius;
      const y = Math.sin(angle) * radius;
      const selected = index === weaponWheel.selectedIndex;

      const button = document.createElement("button");
      button.type = "button";
      button.dataset.index = String(index);
      button.setAttribute(
        "aria-label",
        `${weapon.definition.name}, ${weapon.magazine} in magazine`
      );
      button.style.position = "absolute";
      button.style.left = "50%";
      button.style.top = "50%";
      button.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`;
      button.style.width = "clamp(82px, 20vw, 116px)";
      button.style.minHeight = "64px";
      button.style.padding = "8px 6px";
      button.style.borderRadius = "16px";
      button.style.border = selected
        ? "2px solid #7ee3d3"
        : "1px solid rgba(255,255,255,.16)";
      button.style.background = selected
        ? "rgba(75,189,174,.26)"
        : "rgba(255,255,255,.075)";
      button.style.color = "#fff";
      button.style.font = "inherit";
      button.style.fontSize = "clamp(9px,1.8vw,12px)";
      button.style.fontWeight = "800";
      button.style.boxShadow = selected
        ? "0 0 22px rgba(126,227,211,.23)"
        : "none";

      button.innerHTML = `<div>${weapon.definition.category.toUpperCase()}</div><div style="margin-top:4px">${weapon.definition.name}</div><div style="color:#aee4dc;margin-top:4px">${weapon.magazine} / ${loadout.ammoByClass.get(weapon.definition.ammoClass) ?? 0}</div>`;

      button.addEventListener("click", () => {
        weaponWheel.selectedIndex = index;
        renderWeaponWheel();
      });

      panel.appendChild(button);
    });

    const actions = document.createElement("div");
    actions.style.position = "absolute";
    actions.style.left = "50%";
    actions.style.bottom = "7%";
    actions.style.transform = "translateX(-50%)";
    actions.style.display = "flex";
    actions.style.flexWrap = "wrap";
    actions.style.justifyContent = "center";
    actions.style.gap = "6px";
    actions.style.width = "82%";

    const addAction = (label, handler) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.style.borderRadius = "8px";
      button.style.border = "1px solid rgba(255,255,255,.16)";
      button.style.padding = "7px 10px";
      button.style.color = "#fff";
      button.style.background = "rgba(255,255,255,.08)";
      button.style.fontSize = "10px";
      button.style.fontWeight = "800";
      button.addEventListener("click", handler);
      actions.appendChild(button);
    };

    addAction("EQUIP", () => {
      const selected = weapons[weaponWheel.selectedIndex];
      if (!selected) return;
      const result = selectWeapon(loadout.characterId, selected.id);
      if (result.ok) closeWeaponWheel(true);
    });

    addAction("RELOAD", () => {
      reload(loadout.characterId);
      renderWeaponWheel();
    });

    addAction("CLOSE", () => closeWeaponWheel(true));
    addAction("CANCEL", () => closeWeaponWheel(false));
    panel.appendChild(actions);
  }

  function openWeaponWheel() {
    if (weaponWheel.open || disposed) return { ok: false };

    const loadout = getSelectedLoadout();

    weaponWheel.open = true;
    weaponWheel.previousSelection = loadout.selectedWeaponId;

    const selectedIndex = [...loadout.weapons.keys()].findIndex(
      id => id === loadout.selectedWeaponId
    );

    weaponWheel.selectedIndex = selectedIndex >= 0 ? selectedIndex : 0;
    weaponWheel.timeScaleLease = acquireSlowMotion();

    if (typeof document === "undefined" || !document.body) {
      weaponWheel.open = false;
      releaseSlowMotion(weaponWheel.timeScaleLease);
      weaponWheel.timeScaleLease = null;
      return { ok: false, reason: "weapon-wheel-dom-unavailable" };
    }

    if (!weaponWheel.overlay) createWeaponWheelUI();

    weaponWheel.overlay.hidden = false;
    renderWeaponWheel();

    runtime.state.patch({ weaponWheelOpen: true }, "weapon-wheel");

    runtime.events.emit("weapon:wheelOpened", {
      characterId: loadout.characterId,
      slowMotionLeaseAcquired: weaponWheel.timeScaleLease?.active === true,
      slowMotionIntegrationRequired: weaponWheel.timeScaleLease?.active !== true
    });

    return { ok: true };
  }

  function closeWeaponWheel(confirm = true) {
    if (!weaponWheel.open) return false;

    const loadout = getSelectedLoadout();

    if (!confirm && weaponWheel.previousSelection) {
      const currentSelection = loadout.selectedWeaponId;
      loadout.selectedWeaponId = weaponWheel.previousSelection;
      loadout.inventoryRevision++;

      runtime.events.emit("inventory:weaponSelected", {
        characterId: loadout.characterId,
        weaponId: loadout.selectedWeaponId,
        previousWeaponId: currentSelection,
        reverted: true
      });
    }

    weaponWheel.open = false;

    if (weaponWheel.overlay) {
      weaponWheel.overlay.hidden = true;
    }

    releaseSlowMotion(weaponWheel.timeScaleLease);
    weaponWheel.timeScaleLease = null;

    runtime.state.patch({ weaponWheelOpen: false }, "weapon-wheel");

    runtime.events.emit("weapon:wheelClosed", {
      characterId: loadout.characterId,
      confirmed: confirm
    });

    return true;
  }

  /* --------------------------------------------------------------- */
  /* Vehicle weapon depot and dropped pickups                         */
  /* --------------------------------------------------------------- */

  function storeWeaponInVehicle(characterId, weaponId, vehicleId) {
    const loadout = getLoadout(characterId);
    const weapon = loadout.weapons.get(weaponId);

    const vehicleService = services.get("vehicles");
    const vehicle = vehicleService?.getVehicle?.(vehicleId);

    if (!weapon || !vehicle) {
      return { ok: false, reason: "weapon-or-vehicle-not-found" };
    }

    const vehicleType = String(
      vehicle.vehicleClass ??
      vehicle.class ??
      vehicle.type ??
      vehicle.category ??
      ""
    ).toLowerCase();

    const inferredCapacity = /motorcycle|motorbike|bicycle|jetski|scooter/.test(vehicleType)
      ? 0
      : /truck|van|utility|military|suv|offroad/.test(vehicleType)
        ? 12
        : /sports|supercar|coupe|sedan|hatchback/.test(vehicleType)
          ? 5
          : 6;

    const capacity = weaponClamp(
      Math.floor(weaponFinite(
        vehicle.weaponDepotCapacity ?? vehicle.config?.weaponDepotCapacity,
        inferredCapacity
      )),
      0,
      30
    );

    const depot = vehicle.depot ??= [];

    if (capacity <= 0) {
      return { ok: false, reason: "vehicle-has-no-weapon-depot" };
    }

    if (depot.length >= capacity) {
      return { ok: false, reason: "vehicle-depot-full" };
    }

    const serialized = {
      weaponId,
      magazine: weapon.magazine,
      durability: weapon.durability,
      weightKg: weapon.weightKg,
      visible: weapon.visible,
      ammoClass: weapon.definition.ammoClass
    };

    depot.push(serialized);

    const result = removeWeapon(characterId, weaponId);

    if (!result.ok) {
      depot.pop();
      return result;
    }

    runtime.events.emit("weapon:storedInVehicle", {
      characterId,
      vehicleId,
      weaponId
    });

    return { ok: true };
  }

  function retrieveWeaponFromVehicle(characterId, weaponId, vehicleId) {
    const vehicleService = services.get("vehicles");
    const vehicle = vehicleService?.getVehicle?.(vehicleId);
    const depot = vehicle?.depot;

    if (!vehicle || !Array.isArray(depot)) {
      return { ok: false, reason: "vehicle-depot-unavailable" };
    }

    const index = depot.findIndex(item => item.weaponId === weaponId);
    if (index < 0) {
      return { ok: false, reason: "weapon-not-in-depot" };
    }

    const stored = depot[index];

    const result = addWeapon(characterId, stored.weaponId, {
      initialReserveAmmo: 0,
      magazine: stored.magazine,
      durability: stored.durability,
      massKg: stored.weightKg,
      visible: stored.visible
    });

    if (!result.ok) return result;

    depot.splice(index, 1);

    runtime.events.emit("weapon:retrievedFromVehicle", {
      characterId,
      vehicleId,
      weaponId
    });

    return { ok: true, weaponId };
  }

  function createWeaponPickup(options) {
    if (!options || typeof options !== "object") {
      return { ok: false, reason: "invalid-pickup-definition" };
    }

    const definition = WEAPON_CATALOG[options.weaponId];

    if (
      !definition ||
      !options.position ||
      !Number.isFinite(options.position.x) ||
      !Number.isFinite(options.position.y) ||
      !Number.isFinite(options.position.z)
    ) {
      return { ok: false, reason: "invalid-pickup-definition" };
    }

    const id = options.id ?? `weapon-pickup-${nextPickupId++}`;

    if (pickupRecords.has(id)) {
      return { ok: false, reason: "duplicate-pickup-id" };
    }

    const mesh = B.MeshBuilder.CreateBox(
      `weapon-pickup-mesh-${id}`,
      { width: 0.32, height: 0.14, depth: 0.68 },
      scene
    );

    mesh.position.set(
      options.position.x,
      options.position.y,
      options.position.z
    );
    mesh.rotation.y = weaponFinite(options.rotationY, 0);
    mesh.isPickable = true;
    mesh.checkCollisions = false;

    const material = new B.StandardMaterial(
      `weapon-pickup-material-${id}`,
      scene
    );

    material.diffuseColor = new B.Color3(0.21, 0.25, 0.27);
    material.specularColor = new B.Color3(0.35, 0.35, 0.35);
    mesh.material = material;

    mesh.metadata = {
      ...(mesh.metadata || {}),
      weaponPickupId: id,
      projectilePassThrough: true
    };

    const record = {
      id,
      weaponId: options.weaponId,
      ammoClass: definition.ammoClass,
      ammoAmount: Math.max(0, Math.floor(options.ammoAmount ?? 0)),
      position: mesh.position.clone(),
      mesh,
      material,
      collected: false,
      expiresAt: elapsed + weaponFinite(options.lifetimeSeconds, 300)
    };

    pickupRecords.set(id, record);

    return {
      ok: true,
      id,
      dispose: () => {
        record.mesh.dispose();
        record.material?.dispose();
        pickupRecords.delete(id);
      }
    };
  }

  function collectPickup(id, characterId) {
    const record = pickupRecords.get(id);

    if (!record || record.collected) {
      return { ok: false, reason: "pickup-unavailable" };
    }

    const character = player?.getCharacter?.(characterId);

    if (!character) {
      return { ok: false, reason: "character-unavailable" };
    }

    if (B.Vector3.Distance(character.position, record.position) > 2.0) {
      return { ok: false, reason: "out-of-range" };
    }

    const loadout = getLoadout(characterId);
    let result;

    if (loadout.weapons.has(record.weaponId)) {
      result = addAmmo(characterId, record.ammoClass, record.ammoAmount);
    } else {
      result = addWeapon(characterId, record.weaponId, {
        initialReserveAmmo: record.ammoAmount
      });
    }

    if (!result.ok) return result;

    record.collected = true;
    record.mesh.dispose();
    record.material?.dispose();
    pickupRecords.delete(id);

    runtime.events.emit("inventory:pickupCollected", {
      characterId,
      pickupId: id,
      weaponId: record.weaponId
    });

    return { ok: true };
  }

  function installWeaponInput() {
    const canvas = document.getElementById("render-canvas") ?? null;

    const keyDown = event => {
      if (
        event.repeat ||
        event.target?.isContentEditable ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(event.target?.tagName)
      ) {
        return;
      }

      if (event.key.toLowerCase() === "r") {
        const characterId =
          player?.getActiveCharacterId?.() ??
          runtime.state.get("activeCharacterId") ??
          "lucia";
        reload(characterId);
      } else if (event.key.toLowerCase() === "q") {
        if (weaponWheel.open) closeWeaponWheel(true);
        else openWeaponWheel();
      }
    };

    const pointerDown = event => {
      if (!canvas || event.pointerType !== "mouse" || event.button !== 0) return;

      if (
        event.target?.closest?.(
          "#touch-controls, #weapon-wheel-overlay, button, input, textarea"
        )
      ) {
        return;
      }

      const characterId =
        player?.getActiveCharacterId?.() ??
        runtime.state.get("activeCharacterId") ??
        "lucia";

      fire(characterId);
    };

    document.addEventListener("keydown", keyDown);
    canvas?.addEventListener("pointerdown", pointerDown);

    eventDisposers.push(() => {
      document.removeEventListener("keydown", keyDown);
      canvas?.removeEventListener("pointerdown", pointerDown);
    });

    const root = document.getElementById("touch-controls");

    if (root) {
      const buttons = [
        { id: "touch-fire", label: "FIRE", right: "27px", bottom: "104px" },
        { id: "touch-weapon-wheel", label: "WEAPON", right: "27px", bottom: "25px" }
      ];

      const created = [];

      for (const spec of buttons) {
        if (document.getElementById(spec.id)) continue;

        const button = document.createElement("button");
        button.id = spec.id;
        button.type = "button";
        button.className = "touch-control";
        button.textContent = spec.label;
        button.setAttribute("aria-label", spec.label);
        button.style.position = "absolute";
        button.style.right = spec.right;
        button.style.bottom =
          `calc(${spec.bottom} + env(safe-area-inset-bottom, 0px))`;
        button.style.width = "60px";
        button.style.height = "60px";
        button.style.fontSize = "10px";
        button.style.fontWeight = "800";

        root.appendChild(button);
        created.push(button);
      }

      const fireButton = document.getElementById("touch-fire");
      const wheelButton = document.getElementById("touch-weapon-wheel");

      const fireHandler = event => {
        event.preventDefault();

        const characterId =
          player?.getActiveCharacterId?.() ??
          runtime.state.get("activeCharacterId") ??
          "lucia";

        fire(characterId);
      };

      const wheelHandler = event => {
        event.preventDefault();

        if (weaponWheel.open) closeWeaponWheel(true);
        else openWeaponWheel();
      };

      fireButton?.addEventListener("pointerdown", fireHandler);
      wheelButton?.addEventListener("click", wheelHandler);

      eventDisposers.push(() => {
        fireButton?.removeEventListener("pointerdown", fireHandler);
        wheelButton?.removeEventListener("click", wheelHandler);
        for (const button of created) button.remove();
      });
    }
  }

  function serializeLoadout(characterId) {
    const loadout = getLoadout(characterId);

    return {
      schemaVersion: 1,
      characterId,
      selectedWeaponId: loadout.selectedWeaponId,
      ammoByClass: Object.fromEntries(loadout.ammoByClass),
      weapons: [...loadout.weapons.values()].map(weapon => ({
        id: weapon.id,
        magazine: weapon.magazine,
        durability: weapon.durability,
        weightKg: weapon.weightKg,
        visible: weapon.visible
      }))
    };
  }

  function restoreLoadout(characterId, snapshot) {
    if (
      !snapshot ||
      snapshot.schemaVersion !== 1 ||
      !Array.isArray(snapshot.weapons) ||
      !snapshot.ammoByClass ||
      typeof snapshot.ammoByClass !== "object"
    ) {
      return { ok: false, reason: "invalid-loadout-snapshot" };
    }

    const staged = createEmptyLoadout(characterId);

    for (const [ammoClass, amount] of Object.entries(snapshot.ammoByClass)) {
      const known = Object.values(WEAPON_CATALOG).some(
        definition => definition.ammoClass === ammoClass
      );

      if (!known || !Number.isFinite(amount) || amount < 0) {
        return { ok: false, reason: "invalid-ammo-snapshot" };
      }

      staged.ammoByClass.set(
        ammoClass,
        weaponClamp(Math.floor(amount), 0, INVENTORY_LIMITS.maxAmmoPerClass)
      );
    }

    for (const item of snapshot.weapons) {
      const definition = WEAPON_CATALOG[item?.id];

      if (
        !definition ||
        staged.weapons.has(item.id) ||
        staged.weapons.size >= INVENTORY_LIMITS.maxWeaponsOwned
      ) {
        return { ok: false, reason: "invalid-weapon-snapshot" };
      }

      const weightKg = weaponClamp(
        weaponFinite(item.weightKg, definition.massKg ?? 2.1),
        0.1,
        15
      );

      if (
        staged.carryingWeightKg + weightKg >
        INVENTORY_LIMITS.maxCarryMassKg
      ) {
        return { ok: false, reason: "carry-weight-limit" };
      }

      staged.weapons.set(item.id, {
        id: item.id,
        definition,
        magazine: weaponClamp(
          Math.floor(weaponFinite(item.magazine, 0)),
          0,
          definition.magazineSize
        ),
        equippedAt: elapsed,
        weightKg,
        durability: weaponClamp(weaponFinite(item.durability, 1), 0, 1),
        visible: item.visible !== false
      });

      staged.carryingWeightKg += weightKg;
    }

    staged.selectedWeaponId = staged.weapons.has(snapshot.selectedWeaponId)
      ? snapshot.selectedWeaponId
      : (staged.weapons.keys().next().value ?? null);

    const existing = loadouts.get(characterId);
    staged.inventoryRevision = (existing?.inventoryRevision ?? 0) + 1;
    loadouts.set(characterId, staged);

    runtime.events.emit("inventory:changed", {
      characterId,
      reason: "loadout-restored",
      inventory: publicWeaponState(staged)
    });

    return { ok: true, inventory: publicWeaponState(staged) };
  }

  /* --------------------------------------------------------------- */
  /* Lifecycle                                                         */
  /* --------------------------------------------------------------- */

  async function initialize() {
    if (initialized) return { ok: true };

    combat = services.get("combat") ?? combat;
    weather = services.get("weather") ?? weather;
    player = services.get("player") ?? player;

    if (!combat) {
      logger.warn(
        "Combat service is not registered yet; projectile damage will be retried only after this service is available at fire time."
      );
    }

    installWeaponInput();

    for (const characterId of ["lucia", "jason"]) {
      addWeapon(characterId, "pistol", {
        initialReserveAmmo: 48
      });

      addWeapon(characterId, "smg", {
        initialReserveAmmo: 120
      });
    }

    serviceDisposers.push(runtime.services.register("weapons", {
      catalog: WEAPON_CATALOG,
      addWeapon,
      removeWeapon,
      addAmmo,
      selectWeapon,
      reload,
      fire,

      openWeaponWheel,
      closeWeaponWheel,

      storeWeaponInVehicle,
      retrieveWeaponFromVehicle,

      createPickup: createWeaponPickup,
      collectPickup,

      getLoadout: characterId =>
        publicWeaponState(getLoadout(characterId)),

      serializeLoadout,
      restoreLoadout,

      applyProjectileImpact,

      getSnapshot: () => ({
        projectiles: projectiles.length,
        pickups: pickupRecords.size,
        weaponWheelOpen: weaponWheel.open
      })
    }));

    eventDisposers.push(
      runtime.events.on("player:characterChanged", () => {
        if (weaponWheel.open) renderWeaponWheel();
      })
    );

    eventDisposers.push(
      runtime.events.on("weapon:fireRequested", payload => {
        const characterId =
          payload?.characterId ??
          player?.getActiveCharacterId?.() ??
          "lucia";

        fire(characterId, { direction: payload?.direction });
      })
    );

    eventDisposers.push(
      runtime.events.on("input:weaponFireRequested", payload => {
        const characterId =
          payload?.characterId ??
          player?.getActiveCharacterId?.() ??
          "lucia";

        fire(characterId, { direction: payload?.direction });
      })
    );

    eventDisposers.push(
      runtime.events.on("weapon:reloadRequested", payload => {
        reload(
          payload?.characterId ??
          player?.getActiveCharacterId?.() ??
          "lucia"
        );
      })
    );

    eventDisposers.push(
      runtime.events.on("weapon:wheelToggleRequested", () => {
        if (weaponWheel.open) closeWeaponWheel(true);
        else openWeaponWheel();
      })
    );

    eventDisposers.push(
      runtime.events.on("weapon:pickupCollectRequested", payload => {
        if (payload?.pickupId) {
          collectPickup(
            payload.pickupId,
            payload.characterId ??
              player?.getActiveCharacterId?.() ??
              "lucia"
          );
        }
      })
    );

    initialized = true;
    logger.info("Weapon inventory and ballistics initialized.");

    return { ok: true };
  }

  function start() {
    running = true;
    return { ok: true };
  }

  function update(context) {
    if (!initialized || !running || disposed) return;

    const dt = weaponClamp(
      weaponFinite(
        context.simulationDeltaSeconds ?? context.gameDeltaSeconds
      ),
      0,
      0.05
    );

    elapsed += dt;

    for (const [characterId, loadout] of loadouts) {
      if (loadout.reloadingWeaponId) {
        loadout.reloadTimeRemaining -= dt;

        if (loadout.reloadTimeRemaining <= 0) {
          const weapon = loadout.weapons.get(loadout.reloadingWeaponId);

          let roundsLoaded = 0;
          let roundsReturned = 0;

          if (weapon) {
            roundsLoaded = Math.min(
              Math.max(0, weapon.definition.magazineSize - weapon.magazine),
              Math.max(0, Math.floor(loadout.reloadReservedAmmo ?? 0))
            );

            weapon.magazine += roundsLoaded;

            roundsReturned = Math.max(
              0,
              Math.floor(loadout.reloadReservedAmmo ?? 0)
            ) - roundsLoaded;

            if (roundsReturned > 0) {
              const ammoClass = weapon.definition.ammoClass;
              loadout.ammoByClass.set(
                ammoClass,
                Math.min(
                  INVENTORY_LIMITS.maxAmmoPerClass,
                  (loadout.ammoByClass.get(ammoClass) ?? 0) + roundsReturned
                )
              );
            }
          }

          runtime.events.emit("weapon:reloadCompleted", {
            characterId,
            weaponId: loadout.reloadingWeaponId,
            magazine: weapon?.magazine ?? 0,
            roundsLoaded,
            roundsReturned
          });

          loadout.reloadingWeaponId = null;
          loadout.reloadTimeRemaining = 0;
          loadout.reloadReservedAmmo = 0;
          loadout.inventoryRevision++;

          runtime.events.emit("inventory:changed", {
            characterId,
            reason: "reload-completed",
            inventory: publicWeaponState(loadout)
          });
        }
      }
    }

    // Semi-fixed projectile integration prevents large frame spikes from
    // skipping collisions at high projectile speed.
    const fixedStep = 1 / 240;
    const steps = Math.max(1, Math.ceil(dt / fixedStep));
    const substep = dt / Math.min(steps, 12);

    for (let step = 0; step < Math.min(steps, 12); step++) {
      for (const projectile of projectiles) {
        updateProjectile(projectile, substep);
      }
    }

    for (let i = projectiles.length - 1; i >= 0; i--) {
      if (projectiles[i].dead) projectiles.splice(i, 1);
    }

    for (const tracer of [...tracerMeshes]) {
      if (
        tracer.expiresAt <= elapsed ||
        tracer.mesh.isDisposed()
      ) {
        if (!tracer.mesh.isDisposed()) tracer.mesh.dispose();
        tracerMeshes.delete(tracer);
      }
    }

    for (const impact of [...impactMeshes]) {
      const age = elapsed - impact.createdAt;

      if (age >= impact.lifetimeSeconds || impact.mesh.isDisposed()) {
        if (!impact.mesh.isDisposed()) impact.mesh.dispose(false, false);
        impact.material?.dispose();
        impactMeshes.delete(impact);
      } else if (impact.material) {
        impact.material.alpha = Math.max(
          0,
          0.8 * (1 - age / impact.lifetimeSeconds)
        );
      }
    }

    for (const [id, pickup] of pickupRecords) {
      if (pickup.expiresAt <= elapsed) {
        pickup.mesh.dispose();
        pickup.material?.dispose();
        pickupRecords.delete(id);
      }
    }
  }

  function stop() {
    running = false;
    closeWeaponWheel(false);
    return { ok: true };
  }

  function dispose() {
    if (disposed) return;

    closeWeaponWheel(false);
    disposed = true;
    running = false;

    for (const off of eventDisposers.splice(0)) {
      try { off(); } catch {}
    }

    for (const off of serviceDisposers.splice(0)) {
      try { off(); } catch {}
    }

    for (const projectile of projectiles) {
      projectile.dead = true;
    }

    for (const tracer of tracerMeshes) {
      tracer.mesh.dispose();
    }

    for (const impact of impactMeshes) {
      impact.mesh.dispose(false, false);
      impact.material?.dispose();
    }

    for (const record of pickupRecords.values()) {
      record.mesh.dispose();
      record.material?.dispose();
    }

    weaponWheel.overlay?.remove();

    loadouts.clear();
    projectiles.length = 0;
    tracerMeshes.clear();
    impactMeshes.clear();
    pickupRecords.clear();
  }

  return Object.freeze({
    initialize,
    start,
    update,
    stop,
    dispose
  });
}
