
/*
 * Module: loader.js
 * Responsibility: shared runtime, state, events, services, persistence,
 * module lifecycle, fixed-step simulation and user-facing diagnostics.
 * Dependencies: Babylon.js global bundle, engine_grafik.js,
 * ui_smartphone.js.
 */

import { createGraphicsRuntime } from "./engine_grafik.js";
import { createSmartphoneSystem } from "./ui_smartphone.js";

const GAME_VERSION = "0.1.0";
const FIXED_STEP = 1 / 60;
const MAX_STEPS_PER_FRAME = 5;

const REQUIRED_SYSTEMS = [
  "weather",
  "world",
  "water",
  "player",
  "combat",
  "weapons",
  "vehicles",
  "aviation",
  "ai-economy"
];

/*
 * Stable contract for the subsequent modules.
 * Each module exports the named factory and may provide:
 * initialize(), start(), update(context), stop(), dispose(), snapshot().
 */
const MODULE_MANIFEST = [
  {
    id: "weather",
    file: "./welt_und_wetter.js",
    exportName: "createWorldWeatherSystem"
  },
  {
    id: "world",
    file: "./welt_architektur.js",
    exportName: "createWorldArchitectureSystem"
  },
  {
    id: "water",
    file: "./physik_wasser_tauchen.js",
    exportName: "createWaterSimulationSystem"
  },
  {
    id: "player",
    file: "./spieler_steuerung.js",
    exportName: "createPlayerControlSystem"
  },
  {
    id: "combat",
    file: "./kampf_animation.js",
    exportName: "createCombatAnimationSystem"
  },
  {
    id: "weapons",
    file: "./waffen_inventar.js",
    exportName: "createWeaponsInventorySystem"
  },
  {
    id: "vehicles",
    file: "./fahrzeug_physik.js",
    exportName: "createVehiclePhysicsSystem"
  },
  {
    id: "aviation",
    file: "./stadt_luftfahrt_marine.js",
    exportName: "createCityAviationMarineSystem"
  },
  {
    id: "ai-economy",
    file: "./ki_polizei_wirtschaft.js",
    exportName: "createAIPoliceEconomySystem"
  }
];

const INITIAL_STATE = {
  phase: "boot",
  isPaused: false,
  isPhoneOpen: false,
  isDebugOpen: false,

  locale: "en",
  distanceUnit: "km",
  speedUnit: "km/h",
  qualityProfile: "auto",

  activeCharacterId: null,
  playerPosition: null,
  playerHeading: 0,

  vehicleId: null,
  vehicleSpeedMps: 0,
  vehicleEngineRunning: false,
  vehicleDamage: 0,

  altitudeM: 0,
  bankAngleRad: 0,

  moneyCents: 0,
  wantedLevel: 0,

  timeOfDayMinutes: 9 * 60,
  weatherId: "clear",
  activeRoute: null,
  lastRecordedEvent: null,

  worldReady: false,
  saveSlot: "autosave"
};

function nowSeconds() {
  return performance.now() / 1000;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function isPlainObject(value) {
  return value !== null &&
    typeof value === "object" &&
    (Object.getPrototypeOf(value) === Object.prototype ||
     Object.getPrototypeOf(value) === null);
}

/* ------------------------------------------------------------------ */
/* Logging                                                            */
/* ------------------------------------------------------------------ */

function createLogger() {
  const history = [];
  const subscribers = new Set();
  const limit = 300;

  function write(level, message, details = null) {
    const entry = {
      time: new Date().toISOString(),
      level,
      message: String(message),
      details: details instanceof Error
        ? { name: details.name, message: details.message }
        : details
    };

    history.push(entry);
    if (history.length > limit) history.shift();

    const consoleMethod =
      level === "error" ? "error" :
      level === "warn" ? "warn" :
      level === "debug" ? "debug" : "info";

    console[consoleMethod]("[LEONIDA]", message, details ?? "");

    for (const listener of subscribers) {
      try {
        listener(entry);
      } catch (error) {
        console.error("Logger subscriber failed:", error);
      }
    }

    return entry;
  }

  return Object.freeze({
    debug: (message, details) => write("debug", message, details),
    info: (message, details) => write("info", message, details),
    warn: (message, details) => write("warn", message, details),
    error: (message, details) => write("error", message, details),

    getHistory() {
      return history.slice();
    },

    subscribe(listener) {
      if (typeof listener !== "function") {
        throw new TypeError("Logger subscriber must be a function.");
      }

      subscribers.add(listener);
      return () => subscribers.delete(listener);
    }
  });
}

/* ------------------------------------------------------------------ */
/* Event bus                                                          */
/* ------------------------------------------------------------------ */

function createEventBus(logger) {
  const subscriptions = new Map();
  const MAX_DEPTH = 24;
  let emissionDepth = 0;

  function on(eventName, handler) {
    if (typeof eventName !== "string" || !eventName.trim()) {
      throw new TypeError("Event name must be a non-empty string.");
    }
    if (typeof handler !== "function") {
      throw new TypeError("Event handler must be a function.");
    }

    if (!subscriptions.has(eventName)) {
      subscriptions.set(eventName, new Set());
    }

    const handlers = subscriptions.get(eventName);
    handlers.add(handler);

    let active = true;

    return () => {
      if (!active) return;
      active = false;

      handlers.delete(handler);
      if (handlers.size === 0) subscriptions.delete(eventName);
    };
  }

  function emit(eventName, payload = {}) {
    if (!isPlainObject(payload)) {
      throw new TypeError(
        `Event "${eventName}" requires a plain-object payload.`
      );
    }

    const handlers = subscriptions.get(eventName);
    if (!handlers || handlers.size === 0) return 0;

    if (emissionDepth >= MAX_DEPTH) {
      logger.error("Event recursion limit reached.", { eventName });
      return 0;
    }

    emissionDepth++;
    let successfulCalls = 0;

    try {
      for (const handler of [...handlers]) {
        try {
          handler(payload);
          successfulCalls++;
        } catch (error) {
          logger.error(`Event handler failed: ${eventName}`, error);
        }
      }
    } finally {
      emissionDepth--;
    }

    return successfulCalls;
  }

  return Object.freeze({
    on,
    emit,

    listenerCount(eventName) {
      return subscriptions.get(eventName)?.size ?? 0;
    },

    clear() {
      subscriptions.clear();
    }
  });
}

/* ------------------------------------------------------------------ */
/* Observable state                                                   */
/* ------------------------------------------------------------------ */

function createStateStore(initialState, events) {
  let state = { ...initialState };
  let version = 0;
  const watchers = new Set();

  function get(key) {
    return key === undefined ? { ...state } : state[key];
  }

  function patch(updates, reason = "unspecified") {
    if (!isPlainObject(updates)) {
      throw new TypeError("State updates must be a plain object.");
    }

    const changed = {};

    for (const [key, value] of Object.entries(updates)) {
      if (Object.is(state[key], value)) continue;
      changed[key] = { previous: state[key], value };
    }

    if (Object.keys(changed).length === 0) return false;

    const previousState = state;
    state = { ...state, ...updates };
    version++;

    const change = {
      version,
      reason,
      changes: changed,
      state: { ...state }
    };

    events.emit("state:changed", {
      version,
      reason,
      changes: Object.keys(changed)
    });

    for (const watcher of watchers) {
      try {
        watcher(change, previousState);
      } catch (error) {
        console.error("State watcher failed:", error);
      }
    }

    return true;
  }

  return Object.freeze({
    get,
    patch,
    getVersion: () => version,

    subscribe(watcher) {
      watchers.add(watcher);
      return () => watchers.delete(watcher);
    },

    snapshot() {
      return { ...state };
    },

    restore(snapshot) {
      if (!isPlainObject(snapshot)) {
        throw new TypeError("Invalid state snapshot.");
      }

      const allowedKeys = new Set(Object.keys(INITIAL_STATE));
      const clean = {};

      for (const [key, value] of Object.entries(snapshot)) {
        if (allowedKeys.has(key)) clean[key] = value;
      }

      return patch(clean, "restore");
    }
  });
}

/* ------------------------------------------------------------------ */
/* Localization                                                       */
/* ------------------------------------------------------------------ */

function createLocalizationManager(state, events) {
  const dictionaries = {
    en: {
      ready: "Core runtime ready",
      missingSystems: "Required systems are not registered.",
      worldReady: "Required gameplay systems are registered.",
      saveSuccess: "Game state saved.",
      saveError: "Save operation failed.",
      phone: "Phone",
      settings: "Settings",
      unavailable: "This service is not currently available."
    },

    de: {
      ready: "Grundsystem bereit",
      missingSystems: "Erforderliche Spielsysteme fehlen.",
      worldReady: "Erforderliche Spielsysteme sind registriert.",
      saveSuccess: "Spielstand gespeichert.",
      saveError: "Speichervorgang fehlgeschlagen.",
      phone: "Smartphone",
      settings: "Einstellungen",
      unavailable: "Dieser Dienst ist momentan nicht verfügbar."
    },

    es: {
      ready: "Sistema principal listo",
      missingSystems: "Faltan sistemas de juego necesarios.",
      worldReady: "Los sistemas necesarios están registrados.",
      saveSuccess: "Partida guardada.",
      saveError: "No se pudo guardar la partida.",
      phone: "Teléfono",
      settings: "Configuración",
      unavailable: "Este servicio no está disponible."
    },

    fr: {
      ready: "Système principal prêt",
      missingSystems: "Des systèmes de jeu sont manquants.",
      worldReady: "Les systèmes de jeu requis sont enregistrés.",
      saveSuccess: "Partie sauvegardée.",
      saveError: "La sauvegarde a échoué.",
      phone: "Téléphone",
      settings: "Paramètres",
      unavailable: "Ce service n'est pas disponible."
    }
  };

  function setLocale(locale) {
    if (!Object.hasOwn(dictionaries, locale)) {
      throw new RangeError(`Unsupported locale: ${locale}`);
    }

    state.patch({ locale }, "locale-change");
    events.emit("localization:changed", { locale });
  }

  function t(key, variables = {}) {
    const locale = state.get("locale");
    let output =
      dictionaries[locale]?.[key] ??
      dictionaries.en[key] ??
      key;

    for (const [name, value] of Object.entries(variables)) {
      output = output.replaceAll(`{${name}}`, String(value));
    }

    return output;
  }

  return Object.freeze({
    t,
    setLocale,
    getLocale: () => state.get("locale"),
    getSupportedLocales: () => Object.keys(dictionaries)
  });
}

/* ------------------------------------------------------------------ */
/* Shared service registry                                            */
/* ------------------------------------------------------------------ */

function createServiceRegistry(logger) {
  const services = new Map();

  return Object.freeze({
    register(name, service, options = {}) {
      if (typeof name !== "string" || !name.trim()) {
        throw new TypeError("Service name must be a non-empty string.");
      }

      if (!service || typeof service !== "object") {
        throw new TypeError(`Invalid service: ${name}`);
      }

      if (services.has(name) && !options.replace) {
        throw new Error(`Service "${name}" is already registered.`);
      }

      services.set(name, service);
      logger.debug(`Registered service: ${name}`);

      let active = true;

      return () => {
        if (!active) return;
        active = false;

        if (services.get(name) === service) {
          services.delete(name);
        }
      };
    },

    get(name) {
      return services.get(name) ?? null;
    },

    has(name) {
      return services.has(name);
    },

    names() {
      return [...services.keys()];
    },

    clear() {
      services.clear();
    }
  });
}

/* ------------------------------------------------------------------ */
/* Persistent entity registry                                         */
/* ------------------------------------------------------------------ */

function createEntityRegistry() {
  const entities = new Map();

  return Object.freeze({
    register(id, entity) {
      if (typeof id !== "string" || !id.trim()) {
        throw new TypeError("Entities require a stable string ID.");
      }

      if (!entity || typeof entity !== "object") {
        throw new TypeError("Entity must be an object.");
      }

      if (entities.has(id)) {
        throw new Error(`Duplicate entity ID: ${id}`);
      }

      entities.set(id, entity);

      return () => {
        if (entities.get(id) === entity) entities.delete(id);
      };
    },

    get(id) {
      return entities.get(id) ?? null;
    },

    has(id) {
      return entities.has(id);
    },

    unregister(id) {
      return entities.delete(id);
    },

    values() {
      return [...entities.values()];
    },

    ids() {
      return [...entities.keys()];
    },

    clear() {
      entities.clear();
    }
  });
}

/* ------------------------------------------------------------------ */
/* IndexedDB persistence                                               */
/* ------------------------------------------------------------------ */

function createPersistenceRepository(logger, events) {
  const DB_NAME = "leonida-open-world";
  const DB_VERSION = 1;
  const STORE_NAME = "saveSlots";

  let databasePromise = null;

  function open() {
    if (databasePromise) return databasePromise;

    if (!globalThis.indexedDB) {
      return Promise.reject(
        new Error("IndexedDB is not available in this browser context.")
      );
    }

    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;

        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "slot" });
        }
      };

      request.onsuccess = () => {
        const db = request.result;

        db.onversionchange = () => {
          db.close();
          databasePromise = null;
          logger.warn("Save database closed due to a version change.");
        };

        resolve(db);
      };

      request.onerror = () => {
        databasePromise = null;
        reject(request.error ?? new Error("Could not open save database."));
      };

      request.onblocked = () => {
        logger.warn("Save database upgrade is blocked by another tab.");
      };
    });

    return databasePromise;
  }

  async function save(slot, snapshot) {
    if (typeof slot !== "string" || !slot.trim()) {
      throw new TypeError("Save slot must be a non-empty string.");
    }

    const db = await open();

    const record = {
      slot,
      gameVersion: GAME_VERSION,
      savedAt: new Date().toISOString(),
      snapshot: structuredClone(snapshot)
    };

    await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const request = transaction.objectStore(STORE_NAME).put(record);

      request.onerror = () => reject(
        request.error ?? new Error("Could not write save record.")
      );

      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(
        transaction.error ?? new Error("Save transaction failed.")
      );

      transaction.onabort = () => reject(
        transaction.error ?? new Error("Save transaction aborted.")
      );
    });

    events.emit("save:completed", {
      slot,
      savedAt: record.savedAt,
      gameVersion: record.gameVersion
    });

    return record;
  }

  async function load(slot) {
    const db = await open();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readonly");
      const request = transaction.objectStore(STORE_NAME).get(slot);

      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(
        request.error ?? new Error("Could not read save record.")
      );
    });
  }

  async function remove(slot) {
    const db = await open();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).delete(slot);

      transaction.oncomplete = () => resolve(true);
      transaction.onerror = () => reject(
        transaction.error ?? new Error("Could not delete save record.")
      );
    });
  }

  return Object.freeze({ open, save, load, remove });
}

/* ------------------------------------------------------------------ */
/* Progress tracking                                                  */
/* ------------------------------------------------------------------ */

function createProgressTracker() {
  const tasks = new Map([
    ["runtime",   { weight: 1, complete: false }],
    ["graphics",  { weight: 6, complete: false }],
    ["phone",     { weight: 2, complete: false }],
    ["storage",   { weight: 1, complete: false }],
    ["modules",   { weight: 3, complete: false }]
  ]);

  function report(label, detail = "") {
    let total = 0;
    let completed = 0;

    for (const task of tasks.values()) {
      total += task.weight;
      if (task.complete) completed += task.weight;
    }

    const percentage = total === 0 ? 0 : completed / total * 100;

    window.__LEONIDA_BOOT_UI__?.progress(
      percentage,
      label,
      detail || "Completing core initialization tasks."
    );
  }

  function complete(id, label, detail = "") {
    const task = tasks.get(id);
    if (!task) throw new Error(`Unknown progress task: ${id}`);

    task.complete = true;
    report(label, detail);
  }

  return Object.freeze({ report, complete });
}

/* ------------------------------------------------------------------ */
/* Runtime construction                                                */
/* ------------------------------------------------------------------ */

function createGameRuntime() {
  const logger = createLogger();
  const events = createEventBus(logger);
  const state = createStateStore(INITIAL_STATE, events);
  const services = createServiceRegistry(logger);
  const entities = createEntityRegistry();
  const localization = createLocalizationManager(state, events);
  const persistence = createPersistenceRepository(logger, events);

  const runtime = {
    version: GAME_VERSION,
    logger,
    events,
    state,
    services,
    entities,
    localization,
    persistence,

    engine: null,
    scene: null,
    camera: null,
    graphics: null,

    modules: new Map(),
    moduleStatus: new Map(),
    capabilities: new Set(),
    disposers: new Set(),

    simulationTime: 0,
    gameTime: 0,
    overloadCount: 0,
    _accumulator: 0,
    _lastFrameTime: nowSeconds(),
    _started: false,
    _destroyed: false
  };

  runtime.addDisposer = disposer => {
    if (typeof disposer !== "function") {
      throw new TypeError("Disposer must be a function.");
    }

    runtime.disposers.add(disposer);
    return () => runtime.disposers.delete(disposer);
  };

  runtime.buildSnapshot = () => {
    const moduleSnapshots = {};

    for (const [id, module] of runtime.modules) {
      if (typeof module.snapshot !== "function") continue;

      try {
        moduleSnapshots[id] = module.snapshot();
      } catch (error) {
        logger.error(`Could not snapshot module "${id}".`, error);
      }
    }

    return {
      schemaVersion: 1,
      gameVersion: GAME_VERSION,
      createdAt: new Date().toISOString(),
      state: state.snapshot(),
      moduleSnapshots
    };
  };

  runtime.saveGame = async slot => {
    try {
      const snapshot = runtime.buildSnapshot();
      const record = await persistence.save(
        slot || state.get("saveSlot"),
        snapshot
      );

      runtime.notify(localization.t("saveSuccess"), "success");
      return { ok: true, record };
    } catch (error) {
      logger.error("Save operation failed.", error);
      events.emit("save:failed", {
        slot: slot || state.get("saveSlot"),
        message: error.message
      });

      runtime.notify(localization.t("saveError"), "error");
      return { ok: false, error };
    }
  };

  runtime.notify = (message, kind = "info") => {
    const region = document.getElementById("toast-region");
    const toast = document.createElement("div");

    toast.className = `toast ${kind === "error" ? "error" :
      kind === "success" ? "success" : ""}`;

    toast.textContent = String(message);
    toast.setAttribute("role", kind === "error" ? "alert" : "status");
    region.appendChild(toast);

    // Toast lifetime is UI-only; it does not use or alter simulation time.
    const token = window.setTimeout(() => toast.remove(), 4600);
    return () => {
      window.clearTimeout(token);
      toast.remove();
    };
  };

  runtime.registerModule = (id, instance) => {
    if (runtime.modules.has(id)) {
      throw new Error(`Module already registered: ${id}`);
    }

    if (!instance || typeof instance !== "object") {
      throw new TypeError(`Module "${id}" must return an object.`);
    }

    runtime.modules.set(id, instance);
    runtime.capabilities.add(id);
    runtime.events.emit("module:registered", { id });
  };

  runtime.hasModule = id => runtime.modules.has(id);

  runtime.getMissingSystems = () =>
    REQUIRED_SYSTEMS.filter(id => !runtime.modules.has(id));

  runtime.updateWorldReadiness = () => {
    const missing = runtime.getMissingSystems();
    const ready = missing.length === 0;

    state.patch({ worldReady: ready }, "world-readiness");

    const startButton = document.getElementById("start-game");
    const status = document.getElementById("world-status");
    const details = document.getElementById("missing-modules");

    startButton.disabled = !ready || runtime._started;

    status.textContent = ready
      ? localization.t("worldReady")
      : localization.t("missingSystems");

    details.textContent = ready
      ? "All required system factories have returned registered instances."
      : `Missing: ${missing.join(", ")}`;

    return ready;
  };

  runtime.advanceFrame = realDeltaSeconds => {
    if (runtime._destroyed) return;

    const realDt = clamp(Number(realDeltaSeconds) || 0, 0, 0.25);

    // Render frames can arrive late after tab switching or device pressure.
    // The fixed-step accumulator prevents arbitrary simulation time jumps.
    runtime._accumulator += realDt;
    let processedSteps = 0;

    const isRunning =
      runtime._started &&
      state.get("phase") === "playing" &&
      !state.get("isPaused");

    const timeScale = state.get("isPhoneOpen") ? 0.1 : 1;

    if (!isRunning) {
      runtime._accumulator = 0;
      return;
    }

    while (
      runtime._accumulator >= FIXED_STEP &&
      processedSteps < MAX_STEPS_PER_FRAME
    ) {
      const gameDt = FIXED_STEP * timeScale;

      const updateContext = Object.freeze({
        runtime,
        realDeltaSeconds: FIXED_STEP,
        simulationDeltaSeconds: FIXED_STEP,
        gameDeltaSeconds: gameDt,
        simulationTime: runtime.simulationTime,
        gameTime: runtime.gameTime
      });

      for (const [id, module] of runtime.modules) {
        if (!module || module._started !== true) continue;
        if (typeof module.update !== "function") continue;
        if (module._updatesDisabled === true) continue;

        try {
          module.update(updateContext);
        } catch (error) {
          module._updateFailures = (module._updateFailures ?? 0) + 1;

          logger.error(
            `Simulation update failed for "${id}".`,
            error
          );

          if (module._updateFailures >= 3) {
            module._updatesDisabled = true;
            logger.error(
              `Updates disabled for "${id}" after repeated failures.`
            );
          }
        }
      }

      runtime.simulationTime += FIXED_STEP;
      runtime.gameTime += gameDt;
      runtime._accumulator -= FIXED_STEP;
      processedSteps++;
    }

    if (runtime._accumulator >= FIXED_STEP) {
      // Drop excessive backlog rather than executing unbounded catch-up.
      runtime._accumulator %= FIXED_STEP;
      runtime.overloadCount++;
    }
  };

  runtime.startGame = async () => {
    if (runtime._started) return { ok: true };

    const missing = runtime.getMissingSystems();

    if (missing.length > 0) {
      runtime.notify(
        `World cannot start. Missing systems: ${missing.join(", ")}`,
        "error"
      );
      return { ok: false, missing };
    }

    const startedModules = [];

    try {
      for (const [id, module] of runtime.modules) {
        if (!module) continue;

        if (typeof module.start === "function") {
          await module.start();
        }

        module._started = true;
        startedModules.push([id, module]);
      }

      runtime._started = true;
      state.patch({
        phase: "playing",
        isPaused: false,
        isPhoneOpen: false
      }, "game-start");

      document.getElementById("main-menu").hidden = true;
      document.getElementById("pause-menu").hidden = true;
      document.getElementById("hud").hidden = false;

      events.emit("game:started", {
        gameVersion: GAME_VERSION,
        startedAt: new Date().toISOString()
      });

      logger.info("Simulation started.");
      return { ok: true };
    } catch (error) {
      logger.error("Game start failed.", error);

      for (const [id, module] of startedModules.reverse()) {
        try {
          await module.stop?.();
          module._started = false;
        } catch (stopError) {
          logger.error(`Rollback failed for "${id}".`, stopError);
        }
      }

      notify(`Could not start simulation: ${error.message}`, "error");
      return { ok: false, error };
    }
  };

  runtime.setPaused = value => {
    const paused = Boolean(value);

    if (state.get("phase") !== "playing") return false;
    if (state.get("isPaused") === paused) return true;

    state.patch({ isPaused: paused }, "pause-change");
    document.getElementById("pause-menu").hidden = !paused;

    events.emit(paused ? "game:paused" : "game:resumed", {
      simulationTime: runtime.simulationTime,
      gameTime: runtime.gameTime
    });

    return true;
  };

  runtime.returnToMenu = async () => {
    if (runtime._started) {
      for (const [id, module] of [...runtime.modules].reverse()) {
        try {
          await module.stop?.();
        } catch (error) {
          logger.error(`Could not stop "${id}".`, error);
        }
        module._started = false;
      }
    }

    runtime._started = false;

    state.patch({
      phase: "menu",
      isPaused: false,
      isPhoneOpen: false
    }, "return-to-menu");

    document.getElementById("hud").hidden = true;
    document.getElementById("pause-menu").hidden = true;
    document.getElementById("main-menu").hidden = false;

    runtime.updateWorldReadiness();
  };

  runtime.destroy = async () => {
    if (runtime._destroyed) return;
    runtime._destroyed = true;

    for (const disposer of [...runtime.disposers]) {
      try {
        disposer();
      } catch (error) {
        logger.error("Runtime disposer failed.", error);
      }
    }
    runtime.disposers.clear();

    for (const [id, module] of [...runtime.modules].reverse()) {
      try {
        await module.dispose?.();
      } catch (error) {
        logger.error(`Module disposal failed: ${id}`, error);
      }
    }

    services.clear();
    events.clear();
    entities.clear();
  };

  return runtime;
}

/* ------------------------------------------------------------------ */
/* Optional module loading                                             */
/* ------------------------------------------------------------------ */

async function loadOptionalModules(runtime) {
  for (const entry of MODULE_MANIFEST) {
    runtime.moduleStatus.set(entry.id, {
      status: "loading",
      file: entry.file
    });

    try {
      const imported = await import(entry.file);
      const factory = imported[entry.exportName];

      if (typeof factory !== "function") {
        throw new TypeError(
          `${entry.file} must export ${entry.exportName}().`
        );
      }

      const instance = await factory({
        runtime,
        engine: runtime.engine,
        scene: runtime.scene,
        camera: runtime.camera,
        events: runtime.events,
        state: runtime.state,
        services: runtime.services,
        entities: runtime.entities,
        logger: runtime.logger
      });

      if (!instance || typeof instance !== "object") {
        throw new TypeError(
          `${entry.exportName}() did not return a system object.`
        );
      }

      await instance.initialize?.();
      runtime.registerModule(entry.id, instance);

      runtime.moduleStatus.set(entry.id, {
        status: "registered",
        file: entry.file
      });

      runtime.logger.info(`Module initialized: ${entry.id}`);
    } catch (error) {
      // Missing future files are an expected state while the project is
      // being generated in separate batches. Other errors remain visible.
      const isLikelyMissingModule =
        error instanceof TypeError &&
        /failed to fetch dynamically imported module|importing a module script failed|cannot find module/i
          .test(error.message);

      runtime.moduleStatus.set(entry.id, {
        status: isLikelyMissingModule ? "missing" : "error",
        file: entry.file,
        message: error.message
      });

      if (isLikelyMissingModule) {
        runtime.logger.info(
          `Module not present yet: ${entry.file}`
        );
      } else {
        runtime.logger.error(
          `Could not initialize module ${entry.id}.`,
          error
        );
      }
    }

    runtime.updateWorldReadiness();
  }
}

/* ------------------------------------------------------------------ */
/* User input and core UI                                              */
/* ------------------------------------------------------------------ */

function isTextInput(target) {
  return target instanceof HTMLElement &&
    (target.isContentEditable ||
     ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}

function bindCoreUI(runtime) {
  const start = document.getElementById("start-game");
  const settings = document.getElementById("open-settings");
  const diagnostics = document.getElementById("open-debug");
  const resume = document.getElementById("resume-game");
  const save = document.getElementById("save-game");
  const returnMenu = document.getElementById("return-menu");
  const debugPanel = document.getElementById("debug-panel");

  start.addEventListener("click", () => {
    void runtime.startGame();
  });

  resume.addEventListener("click", () => {
    runtime.setPaused(false);
  });

  save.addEventListener("click", async () => {
    await runtime.saveGame();
  });

  returnMenu.addEventListener("click", () => {
    void runtime.returnToMenu();
  });

  settings.addEventListener("click", () => {
    const phone = runtime.services.get("phone");

    if (phone?.openApp) {
      phone.openApp("settings");
    } else {
      runtime.notify(
        "Smartphone settings are not registered.",
        "error"
      );
    }
  });

  diagnostics.addEventListener("click", () => {
    runtime.state.patch({
      isDebugOpen: !runtime.state.get("isDebugOpen")
    }, "debug-toggle");
  });

  document.getElementById("touch-phone-button")
    .addEventListener("click", () => {
      runtime.services.get("phone")?.toggle?.();
    });

  document.getElementById("touch-pause-button")
    .addEventListener("click", () => {
      runtime.setPaused(!runtime.state.get("isPaused"));
    });

  const moveButton = document.getElementById("touch-move");
  let activeMovePointer = null;
  let moveOrigin = null;

  moveButton.addEventListener("pointerdown", event => {
    event.preventDefault();
    activeMovePointer = event.pointerId;
    moveOrigin = { x: event.clientX, y: event.clientY };
    moveButton.setPointerCapture?.(event.pointerId);

    runtime.events.emit("input:touchMove", {
      phase: "start",
      pointerId: event.pointerId,
      x: 0,
      y: 0
    });
  });

  moveButton.addEventListener("pointermove", event => {
    if (event.pointerId !== activeMovePointer || !moveOrigin) return;
    event.preventDefault();

    const dx = event.clientX - moveOrigin.x;
    const dy = event.clientY - moveOrigin.y;
    const radius = Math.max(30, moveButton.clientWidth * 0.38);
    const length = Math.hypot(dx, dy) || 1;
    const scale = Math.min(1, radius / length);

    runtime.events.emit("input:touchMove", {
      phase: "move",
      pointerId: event.pointerId,
      x: clamp(dx * scale / radius, -1, 1),
      y: clamp(dy * scale / radius, -1, 1)
    });
  });

  const stopMove = event => {
    if (event.pointerId !== activeMovePointer) return;
    event.preventDefault();

    runtime.events.emit("input:touchMove", {
      phase: "end",
      pointerId: event.pointerId,
      x: 0,
      y: 0
    });

    activeMovePointer = null;
    moveOrigin = null;
  };

  moveButton.addEventListener("pointerup", stopMove);
  moveButton.addEventListener("pointercancel", stopMove);
  moveButton.addEventListener("lostpointercapture", stopMove);

  document.getElementById("touch-interact")
    .addEventListener("click", () => {
      runtime.events.emit("input:interactRequested", {
        source: "touch",
        timestamp: nowSeconds()
      });
    });

  const unsubscribeLogs = runtime.logger.subscribe(entry => {
    if (!runtime.state.get("isDebugOpen")) return;

    debugPanel.hidden = false;
    debugPanel.textContent = runtime.logger.getHistory()
      .slice(-70)
      .map(item =>
        `${item.time} [${item.level.toUpperCase()}] ${item.message}`
      )
      .join("\n");

    debugPanel.scrollTop = debugPanel.scrollHeight;
  });

  const unsubscribeState = runtime.state.subscribe(change => {
    debugPanel.hidden = !change.state.isDebugOpen;

    if (change.state.phase === "playing") {
      document.getElementById("pause-menu").hidden =
        !change.state.isPaused;
    }
  });

  const keydown = event => {
    if (isTextInput(event.target)) return;

    const phone = runtime.services.get("phone");

    if (event.key === "Escape") {
      if (runtime.state.get("isPhoneOpen")) {
        phone?.close?.();
      } else if (runtime.state.get("phase") === "playing") {
        runtime.setPaused(!runtime.state.get("isPaused"));
      } else if (runtime.state.get("isDebugOpen")) {
        runtime.state.patch({ isDebugOpen: false }, "debug-toggle");
      }
      return;
    }

    if (event.key.toLowerCase() === "m") {
      if (runtime.state.get("phase") === "playing") {
        phone?.toggle?.();
      }
      return;
    }

    if (event.key === "F9") {
      event.preventDefault();

      runtime.state.patch({
        isDebugOpen: !runtime.state.get("isDebugOpen")
      }, "debug-toggle");
    }
  };

  document.addEventListener("keydown", keydown);

  runtime.addDisposer(() => {
    unsubscribeLogs();
    unsubscribeState();
    document.removeEventListener("keydown", keydown);
  });
}

/* ------------------------------------------------------------------ */
/* HUD binding                                                         */
/* ------------------------------------------------------------------ */

function bindHud(runtime) {
  const elements = {
    money: document.getElementById("hud-money"),
    speed: document.getElementById("hud-speed"),
    speedUnit: document.getElementById("hud-speed-unit"),
    wanted: document.getElementById("hud-wanted"),
    clock: document.getElementById("hud-clock"),
    weather: document.getElementById("hud-weather"),
    minimapCaption: document.getElementById("minimap-caption"),
    gps: document.getElementById("hud-gps"),
    gpsText: document.getElementById("hud-gps-text")
  };

  const currency = cents => {
    const number = Number.isFinite(cents) ? cents / 100 : 0;

    return new Intl.NumberFormat(
      runtime.state.get("locale"),
      { style: "currency", currency: "USD" }
    ).format(number);
  };

  const refresh = () => {
    const state = runtime.state.get();

    elements.money.textContent = currency(state.moneyCents);

    const speed = Math.max(0, Number(state.vehicleSpeedMps) || 0);
    const displayedSpeed = state.speedUnit === "mph"
      ? speed * 2.2369362921
      : speed * 3.6;

    elements.speed.textContent = Math.round(displayedSpeed).toString();
    elements.speedUnit.textContent =
      state.speedUnit === "mph" ? "MPH" : "KM/H";

    const wanted = clamp(
      Math.floor(Number(state.wantedLevel) || 0), 0, 5
    );

    elements.wanted.textContent =
      "★".repeat(wanted) + "☆".repeat(5 - wanted);

    const minutes = Math.max(
      0,
      Math.floor(Number(state.timeOfDayMinutes) || 0) % 1440
    );

    elements.clock.textContent =
      `${String(Math.floor(minutes / 60)).padStart(2, "0")}:` +
      `${String(minutes % 60).padStart(2, "0")}`;

    elements.weather.textContent =
      String(state.weatherId || "Weather unavailable");

    if (state.activeRoute) {
      elements.gps.hidden = false;
      elements.gpsText.textContent =
        state.activeRoute.description || "Route active";
    } else {
      elements.gps.hidden = true;
    }
  };

  const unsubscribe = runtime.state.subscribe(refresh);
  refresh();

  runtime.addDisposer(unsubscribe);
}

/* ------------------------------------------------------------------ */
/* Boot sequence                                                       */
/* ------------------------------------------------------------------ */

async function main() {
  const progress = createProgressTracker();
  const runtime = createGameRuntime();

  bindCoreUI(runtime);
  bindHud(runtime);

  window.addEventListener("error", event => {
    runtime.logger.error("Unhandled browser error.", event.error ?? {
      message: event.message,
      source: event.filename,
      line: event.lineno
    });
  });

  window.addEventListener("unhandledrejection", event => {
    runtime.logger.error("Unhandled promise rejection.", event.reason);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden && runtime.state.get("phase") === "playing") {
      runtime.setPaused(true);
    }
  });

  try {
    progress.complete(
      "runtime",
      "Core runtime",
      "Shared state, events and service registry initialized."
    );

    const canvas = document.getElementById("render-canvas");

    progress.report(
      "Graphics runtime",
      "Creating rendering engine and shared 3D scene."
    );

    runtime.graphics = await createGraphicsRuntime({
      canvas,
      runtime
    });

    runtime.engine = runtime.graphics.engine;
    runtime.scene = runtime.graphics.scene;
    runtime.camera = runtime.graphics.camera;

    runtime.modules.set("graphics", runtime.graphics);
    runtime.capabilities.add("graphics");

    progress.complete(
      "graphics",
      "Graphics runtime",
      `Renderer initialized: ${runtime.graphics.getBackendName()}.`
    );

    progress.report(
      "Smartphone",
      "Registering interactive smartphone interface."
    );

    runtime.modules.set(
      "smartphone",
      createSmartphoneSystem({
        runtime,
        mount: document.getElementById("smartphone-mount")
      })
    );

    runtime.capabilities.add("smartphone");

    progress.complete(
      "phone",
      "Smartphone interface",
      "Phone UI and its action handlers are registered."
    );

    try {
      await runtime.persistence.open();
      runtime.logger.info("IndexedDB persistence initialized.");
    } catch (error) {
      runtime.logger.warn(
        "IndexedDB is unavailable; save operations will report failure.",
        error
      );
    }

    progress.complete(
      "storage",
      "Persistence",
      "Save-storage initialization checked."
    );

    progress.report(
      "Module registry",
      "Discovering and initializing registered world systems."
    );

    await loadOptionalModules(runtime);

    runtime.updateWorldReadiness();

    progress.complete(
      "modules",
      "Core initialization",
      runtime.getMissingSystems().length === 0
        ? "All required systems registered."
        : "Core is ready; remaining gameplay systems must be supplied."
    );

    document.getElementById("boot-screen").hidden = true;
    document.getElementById("main-menu").hidden = false;

    runtime.state.patch({ phase: "menu" }, "boot-complete");

    runtime.logger.info(
      "Core initialized. Full gameplay readiness is checked separately."
    );

    window.addEventListener("beforeunload", () => {
      // Browser teardown is best-effort. Save operations must be requested
      // explicitly before navigation rather than assumed successful here.
      void runtime.destroy();
    }, { once: true });

    // A documented development entry point for console diagnostics only.
    // Game modules receive the runtime through their factory arguments.
    window.LEONIDA_DIAGNOSTICS = Object.freeze({
      version: GAME_VERSION,
      getBackend: () => runtime.graphics?.getBackendName(),
      getState: () => runtime.state.snapshot(),
      getModules: () => [...runtime.modules.keys()],
      getMissingSystems: () => runtime.getMissingSystems(),
      getLog: () => runtime.logger.getHistory()
    });
  } catch (error) {
    runtime.logger.error("Fatal boot error.", error);

    document.getElementById("boot-screen").hidden = true;
    document.getElementById("fatal-error").hidden = false;
    document.getElementById("fatal-error-details").textContent =
      error instanceof Error
        ? `${error.name}: ${error.message}\n${error.stack ?? ""}`
        : String(error);

    window.__LEONIDA_BOOT_UI__?.fail(error);
  }
}

void main();
