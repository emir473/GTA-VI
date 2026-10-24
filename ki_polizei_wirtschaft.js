/**
 * ================================================================
 * MODUL 12 – KI, POLIZEI, WIRTSCHAFT, AUDIO UND PERSISTENZ
 * Datei: ki_polizei_wirtschaft.js
 * ================================================================
 *
 * Zielarchitektur:
 * - Babylon.js-kompatible Weltkoordinaten
 * - NPC-Zustandsautomaten
 * - Crowd Simulation mit lokaler Kollisionsvermeidung
 * - Wahrnehmung, Sichtfelder und Geräuscherkennung
 * - Zeugen, Smartphone-Aufnahmen und Meldungen
 * - Mehrstufiges Wanted-Level
 * - Polizeidispatch, Suche, Verfolgung und Festnahme
 * - Forensische Spuren und Beweisbewertung
 * - A*-Routing auf einem Straßengraphen
 * - Audio-Occlusion über Raycasts
 * - Weltbegegnungen und dynamische Ereignisse
 * - Transaktionssichere Spielwirtschaft
 * - Aktienmarkt und Immobilienverwaltung
 * - Versionierte IndexedDB-Spielstände
 *
 * Voraussetzung:
 * Das zentrale Runtime-Objekt muss Babylon.js, eine Szene,
 * einen Event-Bus und – sofern verfügbar – die anderen Systeme
 * bereitstellen.
 *
 * Dieses Modul erzeugt keine eigene Engine und keinen Renderloop.
 * ================================================================
 */

const MODULE_12_VERSION = "12.0.0";

const MODULE_12_DEFAULTS = Object.freeze({
    fixedStep: 1 / 20,
    maxSubSteps: 4,

    npc: {
        maxActive: 180,
        maxDecisionDistance: 180,
        perceptionInterval: 0.25,
        decisionInterval: 0.35,
        avoidanceRadius: 1.1,
        defaultWalkSpeed: 1.35,
        defaultRunSpeed: 4.2,
        hearingRadius: 32,
        witnessRadius: 55
    },

    police: {
        maxUnits: 28,
        dispatchInterval: 1.2,
        searchDuration: 75,
        evidenceMemoryDuration: 180,
        responseBaseSpeed: 11,
        escalationCooldown: 14,
        maximumWantedLevel: 5
    },

    economy: {
        startingCashCents: 250000,
        startingBankCents: 1250000,
        maximumMoneyCents: 9000000000000,
        marketUpdateInterval: 5,
        marketHistoryLimit: 720,
        defaultTransactionFeeBasisPoints: 25
    },

    audio: {
        updateInterval: 0.15,
        maximumSources: 80,
        minimumTransmission: 0.08,
        maximumOcclusionChecksPerUpdate: 18
    },

    persistence: {
        databaseName: "LeonidaOpenWorld",
        databaseVersion: 1,
        saveKey: "primary",
        autosaveInterval: 60,
        maximumSnapshotBytes: 8 * 1024 * 1024
    }
});

const NPC_STATES = Object.freeze({
    IDLE: "idle",
    WANDER: "wander",
    TRAVEL: "travel",
    WORK: "work",
    WAIT: "wait",
    WEATHER: "weather",
    OBSERVE: "observe",
    FLEE: "flee",
    SEEK_HELP: "seek_help",
    FILM: "film",
    DRIVE: "drive",
    DIALOGUE: "dialogue",
    REST: "rest",
    INJURED: "injured",
    POLICE_RESPONSE: "police_response",
    ARRESTED: "arrested",
    DEAD: "dead"
});

const CRIME_TYPES = Object.freeze({
    ASSAULT: {
        id: "assault",
        severity: 1,
        evidenceWeight: 0.45,
        wantedBase: 1
    },
    ROBBERY: {
        id: "robbery",
        severity: 2,
        evidenceWeight: 0.72,
        wantedBase: 2
    },
    VEHICLE_THEFT: {
        id: "vehicle_theft",
        severity: 2,
        evidenceWeight: 0.55,
        wantedBase: 1
    },
    WEAPON_DISCHARGE: {
        id: "weapon_discharge",
        severity: 2,
        evidenceWeight: 0.65,
        wantedBase: 1
    },
    MURDER: {
        id: "murder",
        severity: 5,
        evidenceWeight: 0.95,
        wantedBase: 3
    },
    TRESPASS: {
        id: "trespass",
        severity: 1,
        evidenceWeight: 0.4,
        wantedBase: 1
    },
    RESTRICTED_AIRSPACE: {
        id: "restricted_airspace",
        severity: 3,
        evidenceWeight: 0.85,
        wantedBase: 2
    },
    PROPERTY_DAMAGE: {
        id: "property_damage",
        severity: 1,
        evidenceWeight: 0.4,
        wantedBase: 1
    }
});

const POLICE_STATES = Object.freeze({
    AVAILABLE: "available",
    DISPATCHED: "dispatched",
    RESPONDING: "responding",
    INVESTIGATING: "investigating",
    PURSUIT: "pursuit",
    SEARCHING: "searching",
    ARRESTING: "arresting",
    RETURNING: "returning",
    UNAVAILABLE: "unavailable"
});

const WORLD_INCIDENT_TYPES = Object.freeze({
    TRAFFIC_ACCIDENT: "traffic_accident",
    MEDICAL_EMERGENCY: "medical_emergency",
    STREET_ARGUMENT: "street_argument",
    LOST_TOURIST: "lost_tourist",
    PUBLIC_PERFORMANCE: "public_performance",
    POWER_OUTAGE: "power_outage",
    STORM_DAMAGE: "storm_damage",
    POLICE_CHECKPOINT: "police_checkpoint",
    VEHICLE_BREAKDOWN: "vehicle_breakdown"
});

/* ================================================================
   HILFSFUNKTIONEN
   ================================================================ */

function m12Clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function m12Lerp(a, b, t) {
    return a + (b - a) * m12Clamp(t, 0, 1);
}

function m12Finite(value, fallback = 0) {
    return Number.isFinite(value) ? value : fallback;
}

function m12Random(min, max) {
    return min + Math.random() * (max - min);
}

function m12RandomInt(min, max) {
    return Math.floor(m12Random(min, max + 1));
}

function m12Choose(values) {
    return values[Math.floor(Math.random() * values.length)];
}

function m12DistanceSquared(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;

    return dx * dx + dy * dy + dz * dz;
}

function m12Distance(a, b) {
    return Math.sqrt(m12DistanceSquared(a, b));
}

function m12NormalizeAngle(angle) {
    while (angle > Math.PI) angle -= Math.PI * 2;
    while (angle < -Math.PI) angle += Math.PI * 2;
    return angle;
}

function m12CreateId(prefix = "entity") {
    if (
        typeof crypto !== "undefined" &&
        typeof crypto.randomUUID === "function"
    ) {
        return `${prefix}_${crypto.randomUUID()}`;
    }

    return `${prefix}_${Date.now().toString(36)}_${Math.random()
        .toString(36)
        .slice(2, 12)}`;
}

function m12ClonePlain(value) {
    if (value === null || value === undefined) {
        return value;
    }

    if (typeof value !== "object") {
        return value;
    }

    if (Array.isArray(value)) {
        return value.map(m12ClonePlain);
    }

    const result = {};

    for (const [key, item] of Object.entries(value)) {
        if (typeof item !== "function") {
            result[key] = m12ClonePlain(item);
        }
    }

    return result;
}

function m12ValidPosition(position) {
    return Boolean(
        position &&
        Number.isFinite(position.x) &&
        Number.isFinite(position.y) &&
        Number.isFinite(position.z)
    );
}

function m12Money(value, maximum) {
    if (!Number.isSafeInteger(value)) {
        throw new TypeError("Geldwerte müssen sichere Ganzzahlen sein.");
    }

    if (Math.abs(value) > maximum) {
        throw new RangeError("Geldwert überschreitet das konfigurierte Limit.");
    }

    return value;
}

/* ================================================================
   HAUPTSYSTEM
   ================================================================ */

export function createAIPoliceEconomySystem(runtime, options = {}) {
    if (!runtime || typeof runtime !== "object") {
        throw new TypeError("Modul 12 benötigt ein Runtime-Objekt.");
    }

    const BABYLON = runtime.BABYLON ?? globalThis.BABYLON;

    if (!BABYLON?.Vector3) {
        throw new Error(
            "Babylon.js Vector3 fehlt. Prüfe die Engine-Initialisierung."
        );
    }

    const config = {
        ...MODULE_12_DEFAULTS,
        ...options,

        npc: {
            ...MODULE_12_DEFAULTS.npc,
            ...(options.npc ?? {})
        },

        police: {
            ...MODULE_12_DEFAULTS.police,
            ...(options.police ?? {})
        },

        economy: {
            ...MODULE_12_DEFAULTS.economy,
            ...(options.economy ?? {})
        },

        audio: {
            ...MODULE_12_DEFAULTS.audio,
            ...(options.audio ?? {})
        },

        persistence: {
            ...MODULE_12_DEFAULTS.persistence,
            ...(options.persistence ?? {})
        }
    };

    const scene = runtime.scene;

    const eventBus =
        runtime.eventBus ??
        runtime.events ??
        null;

    const entities = runtime.entities ?? null;

    const world = runtime.world ?? null;

    const vehicles = runtime.vehicles ?? null;

    const logger = runtime.logger ?? console;

    let started = false;
    let disposed = false;

    let simulationAccumulator = 0;
    let lastFrameTime = null;

    let elapsedSimulation = 0;
    let elapsedGameTime = 0;

    let npcDecisionAccumulator = 0;
    let perceptionAccumulator = 0;
    let policeDispatchAccumulator = 0;
    let marketAccumulator = 0;
    let audioAccumulator = 0;
    let autosaveAccumulator = 0;

    let nextOcclusionIndex = 0;

    const subscriptions = [];

    const npcs = new Map();
    const policeUnits = new Map();
    const activeIncidents = new Map();
    const crimeRecords = new Map();
    const evidenceRecords = new Map();
    const worldEncounters = new Map();
    const audioSources = new Map();

    const roadNodes = new Map();
    const roadEdges = new Map();

    const activePlayers = new Map();
    const marketInstruments = new Map();
    const marketPositions = new Map();
    const propertyRecords = new Map();

    const activeHeists = new Map();

    const spatialGrid = new Map();

    const NPC_TRANSITIONS = {
        [NPC_STATES.IDLE]: [
            NPC_STATES.WANDER,
            NPC_STATES.TRAVEL,
            NPC_STATES.WORK,
            NPC_STATES.WAIT,
            NPC_STATES.OBSERVE,
            NPC_STATES.REST,
            NPC_STATES.FLEE,
            NPC_STATES.SEEK_HELP
        ],

        [NPC_STATES.WANDER]: [
            NPC_STATES.IDLE,
            NPC_STATES.TRAVEL,
            NPC_STATES.OBSERVE,
            NPC_STATES.FLEE,
            NPC_STATES.WEATHER
        ],

        [NPC_STATES.TRAVEL]: [
            NPC_STATES.IDLE,
            NPC_STATES.WANDER,
            NPC_STATES.WORK,
            NPC_STATES.FLEE,
            NPC_STATES.WEATHER,
            NPC_STATES.SEEK_HELP
        ],

        [NPC_STATES.WORK]: [
            NPC_STATES.IDLE,
            NPC_STATES.WAIT,
            NPC_STATES.FLEE,
            NPC_STATES.OBSERVE,
            NPC_STATES.WEATHER
        ],

        [NPC_STATES.WAIT]: [
            NPC_STATES.IDLE,
            NPC_STATES.TRAVEL,
            NPC_STATES.WORK,
            NPC_STATES.FLEE
        ],

        [NPC_STATES.WEATHER]: [
            NPC_STATES.IDLE,
            NPC_STATES.TRAVEL,
            NPC_STATES.REST,
            NPC_STATES.FLEE
        ],

        [NPC_STATES.OBSERVE]: [
            NPC_STATES.IDLE,
            NPC_STATES.FILM,
            NPC_STATES.FLEE,
            NPC_STATES.SEEK_HELP
        ],

        [NPC_STATES.FLEE]: [
            NPC_STATES.TRAVEL,
            NPC_STATES.SEEK_HELP,
            NPC_STATES.IDLE
        ],

        [NPC_STATES.SEEK_HELP]: [
            NPC_STATES.TRAVEL,
            NPC_STATES.IDLE,
            NPC_STATES.INJURED
        ],

        [NPC_STATES.FILM]: [
            NPC_STATES.OBSERVE,
            NPC_STATES.FLEE,
            NPC_STATES.SEEK_HELP
        ],

        [NPC_STATES.DRIVE]: [
            NPC_STATES.IDLE,
            NPC_STATES.FLEE,
            NPC_STATES.POLICE_RESPONSE
        ],

        [NPC_STATES.DIALOGUE]: [
            NPC_STATES.IDLE,
            NPC_STATES.TRAVEL
        ],

        [NPC_STATES.REST]: [
            NPC_STATES.IDLE,
            NPC_STATES.TRAVEL,
            NPC_STATES.FLEE
        ],

        [NPC_STATES.INJURED]: [
            NPC_STATES.SEEK_HELP,
            NPC_STATES.REST
        ],

        [NPC_STATES.POLICE_RESPONSE]: [
            NPC_STATES.TRAVEL,
            NPC_STATES.INJURED,
            NPC_STATES.ARRESTED
        ],

        [NPC_STATES.ARRESTED]: [],
        [NPC_STATES.DEAD]: []
    };

    /* ============================================================
       EVENT-BUS-ADAPTER
       ============================================================ */

    function emit(type, payload = {}) {
        if (disposed) return;

        const event = {
            type,
            timestamp: elapsedSimulation,
            gameTime: elapsedGameTime,
            moduleVersion: MODULE_12_VERSION,
            ...payload
        };

        try {
            if (typeof eventBus?.emit === "function") {
                eventBus.emit(type, event);
            } else if (typeof eventBus?.dispatch === "function") {
                eventBus.dispatch(type, event);
            } else if (typeof runtime.onGameEvent === "function") {
                runtime.onGameEvent(type, event);
            }
        } catch (error) {
            logger.error?.(`[Modul 12] Eventfehler: ${type}`, error);
        }

        return event;
    }

    function on(type, handler) {
        if (!eventBus || typeof handler !== "function") {
            return () => {};
        }

        let unsubscribe = null;

        try {
            if (typeof eventBus.on === "function") {
                const result = eventBus.on(type, handler);

                if (typeof result === "function") {
                    unsubscribe = result;
                }
            } else if (typeof eventBus.subscribe === "function") {
                const result = eventBus.subscribe(type, handler);

                if (typeof result === "function") {
                    unsubscribe = result;
                }
            } else if (typeof eventBus.addEventListener === "function") {
                const wrapped = event => handler(event?.detail ?? event);

                eventBus.addEventListener(type, wrapped);

                unsubscribe = () => {
                    eventBus.removeEventListener?.(type, wrapped);
                };
            }
        } catch (error) {
            logger.error?.(`[Modul 12] Listenerfehler: ${type}`, error);
        }

        if (unsubscribe) {
            subscriptions.push(unsubscribe);
        }

        return unsubscribe ?? (() => {});
    }

    /* ============================================================
       RUNTIME-ADAPTERS
       ============================================================ */

    function getActivePlayerId() {
        return runtime.player?.activeCharacterId ??
            runtime.player?.activeId ??
            runtime.activePlayerId ??
            null;
    }

    function getEntityPosition(id) {
        if (!id) return null;

        try {
            const entity = entities?.get?.(id) ??
                entities?.getEntity?.(id) ??
                runtime.getEntity?.(id);

            const position =
                entity?.position ??
                entity?.root?.position ??
                entity?.mesh?.position ??
                null;

            if (m12ValidPosition(position)) {
                return position;
            }
        } catch (error) {
            logger.warn?.("[Modul 12] Entityposition nicht verfügbar.", error);
        }

        const player = activePlayers.get(id);

        if (player && m12ValidPosition(player.position)) {
            return player.position;
        }

        const npc = npcs.get(id);

        if (npc && m12ValidPosition(npc.position)) {
            return npc.position;
        }

        const unit = policeUnits.get(id);

        if (unit && m12ValidPosition(unit.position)) {
            return unit.position;
        }

        return null;
    }

    function getPlayerPosition() {
        const id = getActivePlayerId();

        if (id) {
            const position = getEntityPosition(id);

            if (position) return position;
        }

        const playerPosition =
            runtime.player?.position ??
            runtime.activeCharacter?.position ??
            runtime.getPlayerPosition?.();

        return m12ValidPosition(playerPosition)
            ? playerPosition
            : null;
    }

    function getWeatherState() {
        const weather = runtime.weather?.getState?.() ??
            runtime.weather?.state ??
            runtime.world?.weather ??
            world?.weather ??
            null;

        return typeof weather === "string"
            ? { type: weather, intensity: 0 }
            : {
                type: weather?.type ?? "sunny",
                intensity: m12Clamp(
                    m12Finite(weather?.intensity, 0),
                    0,
                    1
                ),
                windSpeed: Math.max(
                    0,
                    m12Finite(weather?.windSpeed, 0)
                )
            };
    }

    function getEntityById(id) {
        return entities?.get?.(id) ??
            entities?.getEntity?.(id) ??
            runtime.getEntity?.(id) ??
            null;
    }

    function getRoadGraphAdapter() {
        return runtime.roadGraph ??
            runtime.world?.roadGraph ??
            world?.roadGraph ??
            null;
    }

    function registerEntity(id, entity) {
        if (!entities) return false;

        try {
            if (typeof entities.register === "function") {
                entities.register(id, entity);
                return true;
            }

            if (typeof entities.add === "function") {
                entities.add(id, entity);
                return true;
            }
        } catch (error) {
            logger.warn?.(`[Modul 12] Registrierung fehlgeschlagen: ${id}`, error);
        }

        return false;
    }

    function unregisterEntity(id) {
        if (!entities) return;

        try {
            if (typeof entities.unregister === "function") {
                entities.unregister(id);
            } else if (typeof entities.remove === "function") {
                entities.remove(id);
            }
        } catch (error) {
            logger.warn?.(`[Modul 12] Entfernung fehlgeschlagen: ${id}`, error);
        }
    }

    /* ============================================================
       RÄUMLICHES GRID
       ============================================================ */

    const GRID_CELL_SIZE = 24;

    function gridKey(x, z) {
        const gx = Math.floor(x / GRID_CELL_SIZE);
        const gz = Math.floor(z / GRID_CELL_SIZE);

        return `${gx}:${gz}`;
    }

    function gridInsert(id, position) {
        if (!m12ValidPosition(position)) return;

        const key = gridKey(position.x, position.z);

        let cell = spatialGrid.get(key);

        if (!cell) {
            cell = new Set();
            spatialGrid.set(key, cell);
        }

        cell.add(id);
    }

    function gridRemove(id, position) {
        if (!m12ValidPosition(position)) return;

        const key = gridKey(position.x, position.z);
        const cell = spatialGrid.get(key);

        if (!cell) return;

        cell.delete(id);

        if (cell.size === 0) {
            spatialGrid.delete(key);
        }
    }

    function gridUpdate(id, previousPosition, currentPosition) {
        if (!m12ValidPosition(currentPosition)) return;

        if (
            !m12ValidPosition(previousPosition) ||
            gridKey(previousPosition.x, previousPosition.z) !==
            gridKey(currentPosition.x, currentPosition.z)
        ) {
            if (m12ValidPosition(previousPosition)) {
                gridRemove(id, previousPosition);
            }

            gridInsert(id, currentPosition);
        }
    }

    function querySpatial(position, radius) {
        if (!m12ValidPosition(position) || radius < 0) {
            return [];
        }

        const minX = Math.floor((position.x - radius) / GRID_CELL_SIZE);
        const maxX = Math.floor((position.x + radius) / GRID_CELL_SIZE);
        const minZ = Math.floor((position.z - radius) / GRID_CELL_SIZE);
        const maxZ = Math.floor((position.z + radius) / GRID_CELL_SIZE);

        const results = [];
        const radiusSquared = radius * radius;

        for (let x = minX; x <= maxX; x++) {
            for (let z = minZ; z <= maxZ; z++) {
                const cell = spatialGrid.get(`${x}:${z}`);

                if (!cell) continue;

                for (const id of cell) {
                    const positionOfEntity = getEntityPosition(id);

                    if (
                        positionOfEntity &&
                        m12DistanceSquared(position, positionOfEntity) <=
                        radiusSquared
                    ) {
                        results.push(id);
                    }
                }
            }
        }

        return results;
    }

    /* ============================================================
       NPC-BASISSYSTEM
       ============================================================ */

    function createNPC(options = {}) {
        if (npcs.size >= config.npc.maxActive) {
            return {
                ok: false,
                reason: "npc_capacity_reached"
            };
        }

        const id = options.id ?? m12CreateId("npc");

        if (npcs.has(id) || getEntityById(id)) {
            return {
                ok: false,
                reason: "duplicate_entity_id"
            };
        }

        const initialPosition = options.position ??
            new BABYLON.Vector3(0, 0, 0);

        if (!m12ValidPosition(initialPosition)) {
            return {
                ok: false,
                reason: "invalid_position"
            };
        }

        const npc = {
            id,
            type: options.type ?? "pedestrian",
            role: options.role ?? "civilian",

            position: initialPosition.clone
                ? initialPosition.clone()
                : new BABYLON.Vector3(
                    initialPosition.x,
                    initialPosition.y,
                    initialPosition.z
                ),

            heading: m12Finite(options.heading, m12Random(-Math.PI, Math.PI)),

            velocity: new BABYLON.Vector3(0, 0, 0),
            desiredVelocity: new BABYLON.Vector3(0, 0, 0),

            state: options.state ?? NPC_STATES.IDLE,
            previousState: null,

            targetPosition: null,
            currentTask: null,
            homePosition: initialPosition.clone
                ? initialPosition.clone()
                : new BABYLON.Vector3(
                    initialPosition.x,
                    initialPosition.y,
                    initialPosition.z
                ),

            workPosition: options.workPosition ?? null,

            walkSpeed: Math.max(
                0.1,
                m12Finite(options.walkSpeed, config.npc.defaultWalkSpeed)
            ),

            runSpeed: Math.max(
                0.5,
                m12Finite(options.runSpeed, config.npc.defaultRunSpeed)
            ),

            radius: Math.max(0.2, m12Finite(options.radius, 0.38)),

            health: m12Clamp(
                m12Finite(options.health, 100),
                0,
                100
            ),

            fear: 0,
            stress: 0,
            trust: m12Clamp(m12Finite(options.trust, 0.5), 0, 1),

            perceptionRange: Math.max(
                2,
                m12Finite(options.perceptionRange, 26)
            ),

            visionRange: Math.max(
                2,
                m12Finite(options.visionRange, 24)
            ),

            visionFov: m12Clamp(
                m12Finite(options.visionFov, Math.PI * 0.7),
                0.1,
                Math.PI * 2
            ),

            hearingRange: Math.max(
                2,
                m12Finite(options.hearingRange, config.npc.hearingRadius)
            ),

            lastKnownThreatPosition: null,
            lastThreatTime: -Infinity,

            lastPerceptionTime: 0,
            nextDecisionTime: 0,
            stateTime: 0,

            destinationNodeId: null,
            route: [],
            routeIndex: 0,

            witnessMemory: [],
            inventory: Array.isArray(options.inventory)
                ? options.inventory.slice()
                : [],

            phoneBattery: m12Clamp(
                m12Finite(options.phoneBattery, 100),
                0,
                100
            ),

            hasPhone: options.hasPhone !== false,
            canFilm: options.canFilm !== false,

            groupId: options.groupId ?? null,
            schedule: options.schedule ?? null,

            vehicleId: null,
            dialogueTargetId: null,

            cooldowns: new Map(),

            persistent: options.persistent !== false,
            active: true,

            mesh: options.mesh ?? null,
            metadata: m12ClonePlain(options.metadata ?? {}),

            createdAt: elapsedSimulation,
            updatedAt: elapsedSimulation
        };

        npc.state = NPC_STATES[npc.state?.toUpperCase?.()] ??
            npc.state;

        if (!Object.values(NPC_STATES).includes(npc.state)) {
            npc.state = NPC_STATES.IDLE;
        }

        npcs.set(id, npc);

        gridInsert(id, npc.position);

        registerEntity(id, npc);

        emit("npc:created", {
            npcId: id,
            npcType: npc.type,
            position: npc.position.clone()
        });

        return {
            ok: true,
            npc
        };
    }

    function removeNPC(id, reason = "removed") {
        const npc = npcs.get(id);

        if (!npc) return false;

        gridRemove(id, npc.position);

        npcs.delete(id);

        unregisterEntity(id);

        if (npc.mesh && !npc.mesh.isDisposed?.()) {
            npc.mesh.dispose?.();
        }

        emit("npc:removed", {
            npcId: id,
            reason
        });

        return true;
    }

    function transitionNPC(npc, nextState, context = {}) {
        if (!npc || !Object.values(NPC_STATES).includes(nextState)) {
            return false;
        }

        if (npc.state === nextState) return true;

        const allowed = NPC_TRANSITIONS[npc.state] ?? [];

        if (!allowed.includes(nextState)) {
            return false;
        }

        const previous = npc.state;

        if (previous === NPC_STATES.FILM) {
            npc.metadata.filmStartedAt = null;
        }

        if (previous === NPC_STATES.TRAVEL ||
            previous === NPC_STATES.WANDER ||
            previous === NPC_STATES.FLEE) {
            npc.desiredVelocity.set(0, 0, 0);
        }

        npc.previousState = previous;
        npc.state = nextState;
        npc.stateTime = 0;

        if (nextState === NPC_STATES.FLEE) {
            npc.fear = Math.max(npc.fear, 0.65);
        }

        if (nextState === NPC_STATES.OBSERVE) {
            npc.stress = m12Clamp(npc.stress + 0.12, 0, 1);
        }

        if (nextState === NPC_STATES.SEEK_HELP) {
            npc.currentTask = {
                type: "seek_help",
                createdAt: elapsedSimulation
            };
        }

        if (nextState === NPC_STATES.FILM) {
            npc.metadata.filmStartedAt = elapsedSimulation;
        }

        emit("npc:stateChanged", {
            npcId: npc.id,
            previousState: previous,
            nextState,
            context
        });

        return true;
    }

    function setNPCDestination(npcId, position, options = {}) {
        const npc = npcs.get(npcId);

        if (!npc || !m12ValidPosition(position)) {
            return false;
        }

        npc.targetPosition = position.clone
            ? position.clone()
            : new BABYLON.Vector3(position.x, position.y, position.z);

        npc.currentTask = {
            type: options.taskType ?? "travel",
            destination: {
                x: position.x,
                y: position.y,
                z: position.z
            },
            priority: options.priority ?? 1,
            createdAt: elapsedSimulation
        };

        npc.route = [];
        npc.routeIndex = 0;

        if (options.useRoads !== false) {
            const route = findRoute(npc.position, npc.targetPosition, {
                mode: options.mode ?? "pedestrian"
            });

            if (route.ok) {
                npc.route = route.nodes;
                npc.routeIndex = 0;
            }
        }

        return transitionNPC(
            npc,
            options.state ?? NPC_STATES.TRAVEL,
            { destination: npc.targetPosition }
        );
    }

    function getNPCDestination(npc) {
        if (npc.route.length > 0 && npc.routeIndex < npc.route.length) {
            const node = roadNodes.get(npc.route[npc.routeIndex]);

            if (node) return node.position;
        }

        return npc.targetPosition;
    }

    function updateNPCMovement(npc, dt) {
        if (!npc.active || npc.health <= 0) return;

        const movingStates = [
            NPC_STATES.WANDER,
            NPC_STATES.TRAVEL,
            NPC_STATES.FLEE,
            NPC_STATES.SEEK_HELP,
            NPC_STATES.POLICE_RESPONSE
        ];

        if (!movingStates.includes(npc.state)) {
            npc.velocity.scaleInPlace(Math.max(0, 1 - dt * 5));
            return;
        }

        const target = getNPCDestination(npc);

        if (!m12ValidPosition(target)) {
            if (npc.state === NPC_STATES.WANDER) {
                chooseWanderTarget(npc);
            } else {
                transitionNPC(npc, NPC_STATES.IDLE);
            }

            return;
        }

        const delta = target.subtract(npc.position);
        delta.y = 0;

        const distance = delta.length();

        if (distance < 0.65) {
            if (npc.route.length > 0 &&
                npc.routeIndex < npc.route.length - 1) {
                npc.routeIndex++;
            } else if (npc.state === NPC_STATES.FLEE) {
                npc.lastKnownThreatPosition = null;
                transitionNPC(npc, NPC_STATES.OBSERVE);
            } else {
                npc.targetPosition = null;

                if (npc.state === NPC_STATES.TRAVEL) {
                    transitionNPC(npc, NPC_STATES.IDLE);
                }
            }

            return;
        }

        delta.normalize();

        const desiredSpeed =
            npc.state === NPC_STATES.FLEE
                ? npc.runSpeed
                : npc.walkSpeed;

        const avoidance = calculateCrowdAvoidance(npc);

        delta.addInPlace(avoidance.scale(0.8));

        if (delta.lengthSquared() > 0.0001) {
            delta.normalize();
        }

        npc.desiredVelocity.copyFrom(delta.scale(desiredSpeed));

        const acceleration = npc.state === NPC_STATES.FLEE ? 9 : 4.5;

        npc.velocity = BABYLON.Vector3.Lerp(
            npc.velocity,
            npc.desiredVelocity,
            m12Clamp(dt * acceleration, 0, 1)
        );

        const previousPosition = npc.position.clone();

        npc.position.addInPlace(npc.velocity.scale(dt));

        npc.heading = Math.atan2(
            npc.velocity.x,
            npc.velocity.z
        );

        npc.updatedAt = elapsedSimulation;

        gridUpdate(npc.id, previousPosition, npc.position);

        if (npc.mesh?.position) {
            npc.mesh.position.copyFrom(npc.position);
            npc.mesh.rotation ??= new BABYLON.Vector3(0, 0, 0);
            npc.mesh.rotation.y = npc.heading;
        }
    }

    function calculateCrowdAvoidance(npc) {
        const neighbours = querySpatial(
            npc.position,
            config.npc.avoidanceRadius * 3
        );

        const result = new BABYLON.Vector3(0, 0, 0);

        for (const otherId of neighbours) {
            if (otherId === npc.id) continue;

            const other = npcs.get(otherId);

            if (!other || !other.active) continue;

            const separation = npc.position.subtract(other.position);
            separation.y = 0;

            const distanceSquared = separation.lengthSquared();

            if (distanceSquared < 0.0001) {
                separation.x = m12Random(-1, 1);
                separation.z = m12Random(-1, 1);
            } else {
                const distance = Math.sqrt(distanceSquared);

                if (distance < config.npc.avoidanceRadius * 2.5) {
                    separation.scaleInPlace(1 / distanceSquared);
                } else {
                    continue;
                }
            }

            result.addInPlace(separation);
        }

        const lengthSquared = result.lengthSquared();

        if (lengthSquared > 1) {
            result.normalize();
        }

        return result;
    }

    function chooseWanderTarget(npc) {
        const angle = m12Random(-Math.PI, Math.PI);
        const distance = m12Random(4, 18);

        const target = new BABYLON.Vector3(
            npc.position.x + Math.sin(angle) * distance,
            npc.position.y,
            npc.position.z + Math.cos(angle) * distance
        );

        npc.targetPosition = target;
        npc.route = [];
        npc.routeIndex = 0;

        transitionNPC(npc, NPC_STATES.WANDER);
    }

    function updateNPCDecision(npc) {
        if (elapsedSimulation < npc.nextDecisionTime) return;

        npc.nextDecisionTime =
            elapsedSimulation + config.npc.decisionInterval *
            m12Random(0.7, 1.4);

        npc.fear = Math.max(0, npc.fear - 0.008);
        npc.stress = Math.max(0, npc.stress - 0.003);

        if (npc.health <= 0) {
            transitionNPC(npc, NPC_STATES.DEAD);
            return;
        }

        if (npc.state === NPC_STATES.DEAD ||
            npc.state === NPC_STATES.ARRESTED) {
            return;
        }

        const weather = getWeatherState();

        if (
            weather.intensity > 0.6 &&
            npc.state !== NPC_STATES.FLEE &&
            npc.state !== NPC_STATES.INJURED
        ) {
            transitionNPC(npc, NPC_STATES.WEATHER, {
                weather: weather.type
            });

            return;
        }

        if (
            npc.lastKnownThreatPosition &&
            elapsedSimulation - npc.lastThreatTime <
                config.police.searchDuration &&
            npc.fear > 0.35
        ) {
            if (npc.state !== NPC_STATES.FLEE) {
                npc.targetPosition = null;

                const away = npc.position.subtract(
                    npc.lastKnownThreatPosition
                );

                away.y = 0;

                if (away.lengthSquared() < 0.001) {
                    away.x = 1;
                    away.z = 0;
                }

                away.normalize();

                const fleeTarget = npc.position.add(
                    away.scale(m12Random(18, 38))
                );

                setNPCDestination(npc.id, fleeTarget, {
                    state: NPC_STATES.FLEE,
                    useRoads: false,
                    taskType: "flee"
                });
            }

            return;
        }

        if (npc.state === NPC_STATES.IDLE && Math.random() < 0.22) {
            chooseWanderTarget(npc);
        }
    }

    /* ============================================================
       WAHRNEHMUNG UND SICHTFELDER
       ============================================================ */

    function isVisibleToNPC(npc, position) {
        if (!npc || !m12ValidPosition(position)) return false;

        const direction = position.subtract(npc.position);
        direction.y = 0;

        const distance = direction.length();

        if (distance > npc.visionRange || distance < 0.001) {
            return false;
        }

        direction.normalize();

        const forward = new BABYLON.Vector3(
            Math.sin(npc.heading),
            0,
            Math.cos(npc.heading)
        );

        const dot = BABYLON.Vector3.Dot(forward, direction);

        const angle = Math.acos(m12Clamp(dot, -1, 1));

        if (angle > npc.visionFov / 2) {
            return false;
        }

        if (scene && typeof scene.pickWithRay === "function") {
            try {
                const ray = new BABYLON.Ray(
                    npc.position.add(
                        new BABYLON.Vector3(0, 1.6, 0)
                    ),
                    direction,
                    Math.max(0.1, distance - 0.4)
                );

                const hit = scene.pickWithRay(
                    ray,
                    mesh => {
                        if (!mesh || mesh.isDisposed?.()) return false;

                        if (mesh === npc.mesh) return false;

                        return mesh.isPickable !== false &&
                            mesh.metadata?.blocksVision !== false;
                    }
                );

                if (hit?.hit && hit.distance < distance - 0.4) {
                    return false;
                }
            } catch (error) {
                logger.warn?.("[Modul 12] Sichtlinienprüfung fehlgeschlagen.", error);
            }
        }

        return true;
    }

    function hearSound(npc, sound) {
        if (!npc || !sound || !m12ValidPosition(sound.position)) {
            return false;
        }

        const distance = m12Distance(npc.position, sound.position);

        const loudness = m12Clamp(
            m12Finite(sound.loudness, 0.5),
            0,
            1
        );

        const effectiveRange = Math.min(
            npc.hearingRange,
            config.npc.hearingRadius * (0.25 + loudness * 1.8)
        );

        if (distance > effectiveRange) return false;

        const strength = loudness * (1 - distance / effectiveRange);

        npc.stress = m12Clamp(npc.stress + strength * 0.25, 0, 1);

        if (strength > 0.2) {
            npc.lastKnownThreatPosition = sound.position.clone
                ? sound.position.clone()
                : new BABYLON.Vector3(
                    sound.position.x,
                    sound.position.y,
                    sound.position.z
                );

            npc.lastThreatTime = elapsedSimulation;
        }

        emit("npc:heardSound", {
            npcId: npc.id,
            soundId: sound.id ?? null,
            soundType: sound.type ?? "unknown",
            strength,
            position: sound.position
        });

        return true;
    }

    function updatePerception() {
        const playerPosition = getPlayerPosition();

        if (!playerPosition) return;

        const nearbyNpcIds = querySpatial(
            playerPosition,
            config.npc.witnessRadius
        );

        for (const id of nearbyNpcIds) {
            const npc = npcs.get(id);

            if (!npc || !npc.active) continue;

            npc.lastPerceptionTime = elapsedSimulation;

            if (isVisibleToNPC(npc, playerPosition)) {
                npc.metadata.lastSeenPlayerPosition = {
                    x: playerPosition.x,
                    y: playerPosition.y,
                    z: playerPosition.z
                };

                npc.metadata.lastSeenPlayerAt = elapsedSimulation;
            }
        }
    }

    /* ============================================================
       CRIME- UND ZEUGENSYSTEM
       ============================================================ */

    function normalizeCrimeType(type) {
        const key = String(type ?? "").toUpperCase();

        return CRIME_TYPES[key] ??
            Object.values(CRIME_TYPES).find(
                crime => crime.id === String(type).toLowerCase()
            ) ??
            CRIME_TYPES.ASSAULT;
    }

    function recordCrime(payload = {}) {
        const actorId =
            payload.actorId ??
            payload.attackerId ??
            payload.playerId ??
            null;

        const position =
            payload.position ??
            payload.muzzlePosition ??
            getEntityPosition(actorId) ??
            getPlayerPosition();

        if (!m12ValidPosition(position)) {
            return {
                ok: false,
                reason: "crime_position_unavailable"
            };
        }

        const crimeType = normalizeCrimeType(
            payload.crimeType ??
            payload.type ??
            payload.weaponType ??
            "assault"
        );

        const recordId = m12CreateId("crime");

        const record = {
            id: recordId,
            actorId,
            type: crimeType.id,
            severity: crimeType.severity,
            baseWanted: crimeType.wantedBase,

            position: new BABYLON.Vector3(
                position.x,
                position.y,
                position.z
            ),

            createdAt: elapsedSimulation,

            description: String(
                payload.description ?? crimeType.id
            ).slice(0, 240),

            weaponId: payload.weaponId ?? null,
            victimId: payload.targetId ?? payload.victimId ?? null,

            witnessIds: [],
            evidenceIds: [],

            reported: false,
            confidence: 0,

            resolved: false,

            metadata: m12ClonePlain(payload.metadata ?? {})
        };

        crimeRecords.set(recordId, record);

        const witnesses = detectWitnesses(record);

        record.witnessIds = witnesses.map(witness => witness.id);

        const evidence = createCrimeEvidence(record);

        record.evidenceIds.push(...evidence.map(item => item.id));

        record.confidence = calculateCrimeConfidence(record);

        emit("police:crimeRecorded", {
            crimeId: record.id,
            actorId: record.actorId,
            crimeType: record.type,
            severity: record.severity,
            position: record.position.clone(),
            witnessCount: record.witnessIds.length,
            evidenceCount: record.evidenceIds.length,
            confidence: record.confidence
        });

        if (record.witnessIds.length > 0) {
            record.reported = true;

            emit("police:crimeReported", {
                crimeId: record.id,
                actorId: record.actorId,
                crimeType: record.type,
                position: record.position.clone(),
                witnessIds: record.witnessIds.slice()
            });

            updateWantedFromCrime(record);
        }

        return {
            ok: true,
            record
        };
    }

    function detectWitnesses(crime) {
        const candidates = querySpatial(
            crime.position,
            config.npc.witnessRadius
        );

        const witnesses = [];

        for (const id of candidates) {
            const npc = npcs.get(id);

            if (!npc || !npc.active || npc.health <= 0) continue;

            if (npc.id === crime.actorId || npc.id === crime.victimId) {
                continue;
            }

            const distance = m12Distance(npc.position, crime.position);

            if (distance > npc.visionRange &&
                distance > npc.hearingRange) {
                continue;
            }

            const visual = isVisibleToNPC(npc, crime.position);

            const audible = distance <= npc.hearingRange &&
                crime.severity >= 2;

            if (!visual && !audible) continue;

            const visualQuality = visual
                ? 1 - distance / Math.max(1, npc.visionRange)
                : 0;

            const audioQuality = audible
                ? 1 - distance / Math.max(1, npc.hearingRange)
                : 0;

            const quality = m12Clamp(
                Math.max(visualQuality, audioQuality) *
                m12Random(0.75, 1.05),
                0,
                1
            );

            const witness = {
                id: npc.id,
                quality,
                visual,
                audible
            };

            witnesses.push(witness);

            npc.witnessMemory.push({
                crimeId: crime.id,
                actorId: crime.actorId,
                position: crime.position.clone(),
                observedAt: elapsedSimulation,
                quality,
                visual,
                audible
            });

            if (npc.witnessMemory.length > 24) {
                npc.witnessMemory.shift();
            }

            npc.lastKnownThreatPosition = crime.position.clone();
            npc.lastThreatTime = elapsedSimulation;

            npc.fear = m12Clamp(
                npc.fear + crime.severity * 0.1,
                0,
                1
            );

            if (
                crime.severity >= 2 &&
                npc.canFilm &&
                npc.hasPhone &&
                npc.phoneBattery > 2 &&
                visual &&
                quality > 0.35 &&
                Math.random() < 0.4
            ) {
                transitionNPC(npc, NPC_STATES.FILM, {
                    crimeId: crime.id
                });

                startPhoneRecording(npc, crime);
            } else if (npc.fear > 0.45) {
                transitionNPC(npc, NPC_STATES.FLEE, {
                    crimeId: crime.id
                });
            } else {
                transitionNPC(npc, NPC_STATES.OBSERVE, {
                    crimeId: crime.id
                });
            }
        }

        return witnesses;
    }

    function startPhoneRecording(npc, crime) {
        if (!npc || !crime || !npc.hasPhone || npc.phoneBattery <= 0) {
            return false;
        }

        const clipId = m12CreateId("clip");

        npc.metadata.activeRecording = {
            clipId,
            crimeId: crime.id,
            startedAt: elapsedSimulation,
            quality: m12Clamp(
                m12Random(0.35, 0.95) *
                (1 - m12Distance(npc.position, crime.position) /
                    Math.max(1, npc.visionRange)),
                0.05,
                1
            )
        };

        emit("social:recordingStarted", {
            npcId: npc.id,
            clipId,
            crimeId: crime.id
        });

        return true;
    }

    function finishPhoneRecording(npc, reason = "completed") {
        const recording = npc?.metadata?.activeRecording;

        if (!npc || !recording) return false;

        const duration = elapsedSimulation - recording.startedAt;

        delete npc.metadata.activeRecording;

        if (duration < 1.2) {
            return false;
        }

        npc.phoneBattery = Math.max(
            0,
            npc.phoneBattery - duration * 0.025
        );

        const clip = {
            id: recording.clipId,
            npcId: npc.id,
            crimeId: recording.crimeId,
            quality: recording.quality,
            duration,
            createdAt: elapsedSimulation,
            reason,
            published: false
        };

        emit("social:clipRecorded", clip);

        if (recording.quality >= 0.45) {
            emit("social:clipPublished", {
                ...clip,
                published: true,
                reach: Math.floor(
                    recording.quality * m12Random(30, 1200)
                )
            });
        }

        return true;
    }

    function createCrimeEvidence(crime) {
        const evidence = [];

        const baseQuality = crime.severity >= 4 ? 0.8 : 0.45;

        const kinds = [];

        if (crime.type === CRIME_TYPES.WEAPON_DISCHARGE.id ||
            crime.type === CRIME_TYPES.MURDER.id) {
            kinds.push("ballistic_trace");
        }

        if (crime.type === CRIME_TYPES.VEHICLE_THEFT.id) {
            kinds.push("vehicle_trace");
        }

        if (crime.witnessIds.length > 0) {
            kinds.push("witness_statement");
        }

        if (crime.type === CRIME_TYPES.PROPERTY_DAMAGE.id) {
            kinds.push("property_trace");
        }

        if (kinds.length === 0) {
            kinds.push("scene_trace");
        }

        for (const kind of kinds) {
            const item = {
                id: m12CreateId("evidence"),
                crimeId: crime.id,
                type: kind,
                position: crime.position.clone(),
                actorId: crime.actorId,
                quality: m12Clamp(
                    baseQuality * m12Random(0.65, 1.15),
                    0.05,
                    1
                ),
                createdAt: elapsedSimulation,
                discovered: false,
                contaminated: false,
                metadata: {}
            };

            evidenceRecords.set(item.id, item);
            evidence.push(item);
        }

        return evidence;
    }

    function calculateCrimeConfidence(crime) {
        const witnessQuality = crime.witnessIds.reduce((total, id) => {
            const npc = npcs.get(id);

            if (!npc) return total;

            const memory = npc.witnessMemory.find(
                entry => entry.crimeId === crime.id
            );

            return total + (memory?.quality ?? 0);
        }, 0);

        const averageWitnessQuality = crime.witnessIds.length > 0
            ? witnessQuality / crime.witnessIds.length
            : 0;

        const evidenceQuality = crime.evidenceIds.reduce((total, id) => {
            return total + (evidenceRecords.get(id)?.quality ?? 0);
        }, 0);

        const normalizedEvidence = Math.min(1, evidenceQuality / 3);

        return m12Clamp(
            averageWitnessQuality * 0.55 +
            normalizedEvidence * 0.45,
            0,
            1
        );
    }

    /* ============================================================
       WANTED-LEVEL
       ============================================================ */

    const wantedState = {
        level: 0,
        heat: 0,
        lastCrimeAt: -Infinity,
        lastSeenPosition: null,
        lastSeenActorId: null,
        searchUntil: 0,
        escapeProgress: 0,
        activePursuit: false,
        cooldownUntil: 0,
        history: []
    };

    function updateWantedFromCrime(crime) {
        const actorId = crime.actorId;

        if (!actorId || actorId !== getActivePlayerId()) {
            return;
        }

        wantedState.lastCrimeAt = elapsedSimulation;
        wantedState.lastSeenActorId = actorId;
        wantedState.lastSeenPosition = crime.position.clone();

        wantedState.heat = m12Clamp(
            wantedState.heat +
                crime.severity * 0.22 +
                crime.confidence * 0.3,
            0,
            1
        );

        const desiredLevel = Math.max(
            crime.baseWanted,
            Math.ceil(wantedState.heat * config.police.maximumWantedLevel)
        );

        setWantedLevel(
            Math.min(config.police.maximumWantedLevel, desiredLevel),
            {
                reason: "confirmed_crime",
                crimeId: crime.id
            }
        );

        wantedState.activePursuit = true;

        dispatchPoliceForCrime(crime);
    }

    function setWantedLevel(level, metadata = {}) {
        const next = Math.round(
            m12Clamp(level, 0, config.police.maximumWantedLevel)
        );

        if (wantedState.level === next) return false;

        const previous = wantedState.level;

        wantedState.level = next;

        wantedState.history.push({
            previous,
            next,
            at: elapsedSimulation,
            metadata: m12ClonePlain(metadata)
        });

        if (wantedState.history.length > 100) {
            wantedState.history.shift();
        }

        if (next > 0) {
            wantedState.searchUntil = Math.max(
                wantedState.searchUntil,
                elapsedSimulation + config.police.searchDuration
            );
        } else {
            wantedState.activePursuit = false;
            wantedState.lastSeenActorId = null;
            wantedState.lastSeenPosition = null;
            wantedState.escapeProgress = 0;
        }

        runtime.state?.patch?.({
            wantedLevel: next
        });

        emit("police:wantedChanged", {
            previousLevel: previous,
            level: next,
            heat: wantedState.heat,
            metadata
        });

        return true;
    }

    function updateWantedHeat(dt) {
        if (wantedState.level <= 0) {
            wantedState.heat = Math.max(
                0,
                wantedState.heat - dt * 0.002
            );

            return;
        }

        const playerPosition = getPlayerPosition();

        if (!playerPosition) return;

        const activePolice = [...policeUnits.values()].filter(unit =>
            unit.state === POLICE_STATES.PURSUIT ||
            unit.state === POLICE_STATES.RESPONDING ||
            unit.state === POLICE_STATES.INVESTIGATING
        );

        const closePolice = activePolice.some(unit =>
            m12Distance(unit.position, playerPosition) < 38
        );

        if (closePolice) {
            wantedState.escapeProgress = Math.max(
                0,
                wantedState.escapeProgress - dt * 0.4
            );

            wantedState.searchUntil = Math.max(
                wantedState.searchUntil,
                elapsedSimulation + 3
            );

            return;
        }

        wantedState.escapeProgress += dt;

        if (wantedState.escapeProgress >= 8) {
            wantedState.heat = Math.max(
                0,
                wantedState.heat - dt * 0.012
            );
        }

        if (
            wantedState.heat < 0.18 &&
            elapsedSimulation > wantedState.searchUntil &&
            elapsedSimulation > wantedState.lastCrimeAt +
                config.police.escalationCooldown
        ) {
            setWantedLevel(
                Math.max(0, wantedState.level - 1),
                { reason: "search_cooling_down" }
            );

            wantedState.searchUntil =
                elapsedSimulation + config.police.searchDuration * 0.3;
        }
    }

    /* ============================================================
       POLIZEI-DISPATCH
       ============================================================ */

    function createPoliceUnit(options = {}) {
        if (policeUnits.size >= config.police.maxUnits) {
            return {
                ok: false,
                reason: "police_capacity_reached"
            };
        }

        const id = options.id ?? m12CreateId("police");

        if (policeUnits.has(id) || getEntityById(id)) {
            return {
                ok: false,
                reason: "duplicate_entity_id"
            };
        }

        if (!m12ValidPosition(options.position)) {
            return {
                ok: false,
                reason: "invalid_position"
            };
        }

        const unit = {
            id,
            type: options.type ?? "patrol_officer",
            position: new BABYLON.Vector3(
                options.position.x,
                options.position.y,
                options.position.z
            ),

            velocity: new BABYLON.Vector3(0, 0, 0),

            state: POLICE_STATES.AVAILABLE,

            targetId: null,
            targetPosition: null,
            assignedCrimeId: null,

            responseSpeed: Math.max(
                2,
                m12Finite(
                    options.responseSpeed,
                    config.police.responseBaseSpeed
                )
            ),

            awareness: m12Clamp(
                m12Finite(options.awareness, 0.7),
                0,
                1
            ),

            pursuitSkill: m12Clamp(
                m12Finite(options.pursuitSkill, 0.65),
                0,
                1
            ),

            lastContactAt: -Infinity,
            searchStartedAt: null,

            vehicleId: options.vehicleId ?? null,
            active: true,

            metadata: m12ClonePlain(options.metadata ?? {})
        };

        policeUnits.set(id, unit);

        gridInsert(id, unit.position);

        registerEntity(id, unit);

        emit("police:unitCreated", {
            unitId: id,
            unitType: unit.type,
            position: unit.position.clone()
        });

        return {
            ok: true,
            unit
        };
    }

    function removePoliceUnit(id) {
        const unit = policeUnits.get(id);

        if (!unit) return false;

        gridRemove(id, unit.position);

        policeUnits.delete(id);

        unregisterEntity(id);

        emit("police:unitRemoved", {
            unitId: id
        });

        return true;
    }

    function dispatchPoliceForCrime(crime) {
        if (!crime || crime.resolved) return [];

        const candidates = [...policeUnits.values()]
            .filter(unit =>
                unit.active &&
                unit.state === POLICE_STATES.AVAILABLE
            )
            .sort((a, b) =>
                m12DistanceSquared(a.position, crime.position) -
                m12DistanceSquared(b.position, crime.position)
            );

        const wantedCount = Math.min(
            candidates.length,
            Math.max(1, wantedState.level)
        );

        const dispatched = [];

        for (let i = 0; i < wantedCount; i++) {
            const unit = candidates[i];

            unit.state = POLICE_STATES.DISPATCHED;
            unit.assignedCrimeId = crime.id;
            unit.targetId = crime.actorId;
            unit.targetPosition = crime.position.clone();

            dispatched.push(unit.id);

            emit("police:unitDispatched", {
                unitId: unit.id,
                crimeId: crime.id,
                targetId: crime.actorId,
                targetPosition: crime.position.clone()
            });
        }

        if (dispatched.length === 0) {
            emit("police:dispatchUnavailable", {
                crimeId: crime.id,
                reason: "no_available_units"
            });
        }

        return dispatched;
    }

    function updatePoliceUnit(unit, dt) {
        if (!unit.active) return;

        if (unit.state === POLICE_STATES.AVAILABLE ||
            unit.state === POLICE_STATES.UNAVAILABLE) {
            return;
        }

        const targetPosition =
            getEntityPosition(unit.targetId) ??
            unit.targetPosition;

        if (!m12ValidPosition(targetPosition)) {
            if (unit.state === POLICE_STATES.PURSUIT) {
                unit.state = POLICE_STATES.SEARCHING;
                unit.searchStartedAt = elapsedSimulation;
            }

            if (
                unit.state === POLICE_STATES.SEARCHING &&
                elapsedSimulation - (unit.searchStartedAt ?? elapsedSimulation) >
                    config.police.searchDuration
            ) {
                unit.state = POLICE_STATES.RETURNING;
            }

            return;
        }

        unit.targetPosition = targetPosition.clone
            ? targetPosition.clone()
            : new BABYLON.Vector3(
                targetPosition.x,
                targetPosition.y,
                targetPosition.z
            );

        const direction = targetPosition.subtract(unit.position);
        direction.y = 0;

        const distance = direction.length();

        if (distance < 3.5) {
            unit.state = POLICE_STATES.INVESTIGATING;

            if (unit.targetId === getActivePlayerId()) {
                wantedState.lastContactAt = elapsedSimulation;

                if (wantedState.level >= 2) {
                    emit("police:playerConfronted", {
                        unitId: unit.id,
                        playerId: unit.targetId,
                        distance
                    });
                }
            }

            return;
        }

        if (distance > 0.001) {
            direction.normalize();

            const previousPosition = unit.position.clone();

            const speed =
                unit.state === POLICE_STATES.PURSUIT
                    ? unit.responseSpeed * (1 + unit.pursuitSkill * 0.25)
                    : unit.responseSpeed;

            unit.velocity = BABYLON.Vector3.Lerp(
                unit.velocity,
                direction.scale(speed),
                m12Clamp(dt * 2.5, 0, 1)
            );

            unit.position.addInPlace(unit.velocity.scale(dt));

            gridUpdate(unit.id, previousPosition, unit.position);
        }

        const target = getEntityById(unit.targetId);

        if (
            target &&
            unit.state !== POLICE_STATES.PURSUIT &&
            wantedState.level >= 2
        ) {
            unit.state = POLICE_STATES.PURSUIT;

            emit("police:pursuitStarted", {
                unitId: unit.id,
                targetId: unit.targetId
            });
        }
    }

    function arrestPlayer(unitId, playerId = getActivePlayerId()) {
        const unit = policeUnits.get(unitId);

        if (!unit || !playerId) {
            return {
                ok: false,
                reason: "invalid_arrest_target"
            };
        }

        if (wantedState.level <= 0) {
            return {
                ok: false,
                reason: "no_active_wanted_level"
            };
        }

        const playerPosition = getEntityPosition(playerId) ??
            getPlayerPosition();

        if (
            playerPosition &&
            m12Distance(unit.position, playerPosition) > 4.5
        ) {
            return {
                ok: false,
                reason: "target_out_of_reach"
            };
        }

        unit.state = POLICE_STATES.ARRESTING;

        const fineCents = Math.round(
            1500 * wantedState.level * 100
        );

        const transaction = transferMoney({
            accountId: "player_bank",
            amountCents: Math.min(
                fineCents,
                economy.bankCents
            ),
            type: "arrest_fine",
            metadata: {
                wantedLevel: wantedState.level,
                policeUnitId: unitId
            }
        });

        if (!transaction.ok) {
            unit.state = POLICE_STATES.INVESTIGATING;

            return {
                ok: false,
                reason: "fine_transaction_failed"
            };
        }

        emit("player:arrested", {
            playerId,
            policeUnitId: unitId,
            wantedLevel: wantedState.level,
            fineCents: transaction.transaction.amountCents
        });

        setWantedLevel(0, {
            reason: "player_arrested",
            policeUnitId: unitId
        });

        unit.state = POLICE_STATES.RETURNING;

        return {
            ok: true,
            fineCents: transaction.transaction.amountCents
        };
    }

    /* ============================================================
       A*-ROUTING AUF EINEM STRASSENGRAPHEN
       ============================================================ */

    function addRoadNode(options = {}) {
        if (!options.id || !m12ValidPosition(options.position)) {
            return {
                ok: false,
                reason: "invalid_node"
            };
        }

        if (roadNodes.has(options.id)) {
            return {
                ok: false,
                reason: "duplicate_node"
            };
        }

        const node = {
            id: options.id,
            position: new BABYLON.Vector3(
                options.position.x,
                options.position.y,
                options.position.z
            ),
            type: options.type ?? "street",
            connections: new Set(),
            metadata: m12ClonePlain(options.metadata ?? {})
        };

        roadNodes.set(node.id, node);

        return {
            ok: true,
            node
        };
    }

    function addRoadEdge(options = {}) {
        const from = roadNodes.get(options.from);
        const to = roadNodes.get(options.to);

        if (!from || !to || from.id === to.id) {
            return {
                ok: false,
                reason: "invalid_edge_endpoints"
            };
        }

        const id = options.id ?? `${from.id}->${to.id}`;

        if (roadEdges.has(id)) {
            return {
                ok: false,
                reason: "duplicate_edge"
            };
        }

        const length = Math.max(
            0.1,
            m12Finite(
                options.length,
                m12Distance(from.position, to.position)
            )
        );

        const edge = {
            id,
            from: from.id,
            to: to.id,
            length,

            speedLimit: Math.max(
                0.5,
                m12Finite(options.speedLimit, 13.9)
            ),

            roadType: options.roadType ?? "street",

            oneWay: options.oneWay === true,

            blocked: options.blocked === true,

            pedestrianAllowed: options.pedestrianAllowed !== false,

            vehicleAllowed: options.vehicleAllowed !== false,

            costFactor: Math.max(
                0.1,
                m12Finite(options.costFactor, 1)
            ),

            metadata: m12ClonePlain(options.metadata ?? {})
        };

        roadEdges.set(id, edge);

        from.connections.add(id);

        if (!edge.oneWay) {
            const reverseId = `${to.id}->${from.id}`;

            if (!roadEdges.has(reverseId)) {
                const reverse = {
                    ...edge,
                    id: reverseId,
                    from: to.id,
                    to: from.id,
                    oneWay: false,
                    metadata: {
                        ...edge.metadata,
                        reverseOf: id
                    }
                };

                roadEdges.set(reverseId, reverse);

                to.connections.add(reverseId);
            }
        }

        return {
            ok: true,
            edge
        };
    }

    function nearestRoadNode(position, mode = "pedestrian") {
        if (!m12ValidPosition(position)) return null;

        let nearest = null;
        let nearestDistance = Infinity;

        for (const node of roadNodes.values()) {
            const distance = m12DistanceSquared(
                node.position,
                position
            );

            if (distance >= nearestDistance) continue;

            const hasValidConnection = [...node.connections].some(edgeId => {
                const edge = roadEdges.get(edgeId);

                if (!edge || edge.blocked) return false;

                return mode === "vehicle"
                    ? edge.vehicleAllowed
                    : edge.pedestrianAllowed;
            });

            if (!hasValidConnection) continue;

            nearest = node;
            nearestDistance = distance;
        }

        return nearest;
    }

    function findRoute(startPosition, endPosition, options = {}) {
        if (
            !m12ValidPosition(startPosition) ||
            !m12ValidPosition(endPosition)
        ) {
            return {
                ok: false,
                reason: "invalid_route_positions",
                nodes: [],
                edges: [],
                cost: Infinity
            };
        }

        const mode = options.mode ?? "pedestrian";

        const externalGraph = getRoadGraphAdapter();

        if (externalGraph && typeof externalGraph.findPath === "function") {
            try {
                const externalResult = externalGraph.findPath(
                    startPosition,
                    endPosition,
                    { mode }
                );

                if (
                    externalResult &&
                    externalResult.ok &&
                    Array.isArray(externalResult.nodes)
                ) {
                    return externalResult;
                }
            } catch (error) {
                logger.warn?.(
                    "[Modul 12] Externes Routing fehlgeschlagen; lokales Routing wird verwendet.",
                    error
                );
            }
        }

        const startNode = nearestRoadNode(startPosition, mode);
        const endNode = nearestRoadNode(endPosition, mode);

        if (!startNode || !endNode) {
            return {
                ok: false,
                reason: "road_graph_unavailable",
                nodes: [],
                edges: [],
                cost: Infinity
            };
        }

        if (startNode.id === endNode.id) {
            return {
                ok: true,
                nodes: [startNode.id],
                edges: [],
                cost: m12Distance(startPosition, endPosition)
            };
        }

        const openSet = new Set([startNode.id]);

        const cameFrom = new Map();
        const cameFromEdge = new Map();

        const gScore = new Map([[startNode.id, 0]]);

        const fScore = new Map([[
            startNode.id,
            m12Distance(startNode.position, endNode.position)
        ]]);

        const closedSet = new Set();

        let iterations = 0;

        const maximumIterations = Math.max(
            100,
            roadNodes.size * 2
        );

        while (openSet.size > 0 && iterations++ < maximumIterations) {
            let currentId = null;
            let bestScore = Infinity;

            for (const id of openSet) {
                const score = fScore.get(id) ?? Infinity;

                if (score < bestScore) {
                    bestScore = score;
                    currentId = id;
                }
            }

            if (currentId === endNode.id) {
                const pathNodes = [currentId];
                const pathEdges = [];

                while (cameFrom.has(currentId)) {
                    pathEdges.unshift(cameFromEdge.get(currentId));

                    currentId = cameFrom.get(currentId);

                    pathNodes.unshift(currentId);
                }

                return {
                    ok: true,
                    nodes: pathNodes,
                    edges: pathEdges,
                    cost: gScore.get(endNode.id) ?? 0
                };
            }

            openSet.delete(currentId);
            closedSet.add(currentId);

            const current = roadNodes.get(currentId);

            if (!current) continue;

            for (const edgeId of current.connections) {
                const edge = roadEdges.get(edgeId);

                if (!edge || edge.blocked) continue;

                if (
                    mode === "vehicle" &&
                    !edge.vehicleAllowed
                ) {
                    continue;
                }

                if (
                    mode !== "vehicle" &&
                    !edge.pedestrianAllowed
                ) {
                    continue;
                }

                const neighbour = roadNodes.get(edge.to);

                if (!neighbour || closedSet.has(neighbour.id)) {
                    continue;
                }

                const weather = getWeatherState();

                const weatherPenalty =
                    weather.type === "hurricane"
                        ? 1.35
                        : weather.type === "rain"
                            ? 1.1
                            : 1;

                const edgeCost =
                    edge.length *
                    edge.costFactor *
                    weatherPenalty;

                const tentativeG =
                    (gScore.get(currentId) ?? Infinity) + edgeCost;

                if (tentativeG >= (gScore.get(neighbour.id) ?? Infinity)) {
                    continue;
                }

                cameFrom.set(neighbour.id, currentId);
                cameFromEdge.set(neighbour.id, edgeId);

                gScore.set(neighbour.id, tentativeG);

                fScore.set(
                    neighbour.id,
                    tentativeG +
                    m12Distance(neighbour.position, endNode.position)
                );

                openSet.add(neighbour.id);
            }
        }

        return {
            ok: false,
            reason: "no_route_found",
            nodes: [],
            edges: [],
            cost: Infinity
        };
    }

    function setRoadBlocked(edgeId, blocked) {
        const edge = roadEdges.get(edgeId);

        if (!edge) return false;

        edge.blocked = Boolean(blocked);

        emit("world:roadStateChanged", {
            edgeId,
            blocked: edge.blocked
        });

        return true;
    }

    function importRoadGraph(graph) {
        if (!graph || !Array.isArray(graph.nodes) ||
            !Array.isArray(graph.edges)) {
            return {
                ok: false,
                reason: "invalid_graph"
            };
        }

        const addedNodes = [];
        const addedEdges = [];

        for (const node of graph.nodes) {
            const result = addRoadNode(node);

            if (result.ok) {
                addedNodes.push(node.id);
            }
        }

        for (const edge of graph.edges) {
            const result = addRoadEdge(edge);

            if (result.ok) {
                addedEdges.push(result.edge.id);
            }
        }

        return {
            ok: true,
            addedNodes,
            addedEdges
        };
    }

    /* ============================================================
       AUDIO-OCCLUSION
       ============================================================ */

    function registerAudioSource(options = {}) {
        if (!options.id || !m12ValidPosition(options.position)) {
            return {
                ok: false,
                reason: "invalid_audio_source"
            };
        }

        if (audioSources.has(options.id)) {
            return {
                ok: false,
                reason: "duplicate_audio_source"
            };
        }

        const source = {
            id: options.id,

            position: new BABYLON.Vector3(
                options.position.x,
                options.position.y,
                options.position.z
            ),

            loudness: m12Clamp(
                m12Finite(options.loudness, 0.5),
                0,
                1
            ),

            radius: Math.max(
                1,
                m12Finite(options.radius, 35)
            ),

            type: options.type ?? "ambient",

            baseTransmission: m12Clamp(
                m12Finite(options.baseTransmission, 1),
                0,
                1
            ),

            currentTransmission: 1,

            active: options.active !== false,

            mesh: options.mesh ?? null,

            metadata: m12ClonePlain(options.metadata ?? {})
        };

        audioSources.set(source.id, source);

        return {
            ok: true,
            source
        };
    }

    function unregisterAudioSource(id) {
        return audioSources.delete(id);
    }

    function estimateAudioTransmission(source, listenerPosition) {
        if (!source || !m12ValidPosition(listenerPosition)) {
            return 0;
        }

        const distance = m12Distance(
            source.position,
            listenerPosition
        );

        if (distance >= source.radius) {
            return 0;
        }

        const distanceFactor = Math.pow(
            1 - distance / source.radius,
            1.25
        );

        let occlusion = 0;

        if (
            scene &&
            typeof scene.pickWithRay === "function" &&
            distance > 1
        ) {
            const direction = listenerPosition.subtract(source.position);

            direction.normalize();

            try {
                const ray = new BABYLON.Ray(
                    source.position.clone(),
                    direction,
                    distance
                );

                const hit = scene.pickWithRay(
                    ray,
                    mesh => {
                        if (!mesh || mesh.isDisposed?.()) return false;

                        if (mesh === source.mesh) return false;

                        return mesh.isPickable !== false &&
                            mesh.metadata?.blocksAudio !== false;
                    }
                );

                if (hit?.hit) {
                    const metadata = hit.pickedMesh?.metadata ?? {};

                    occlusion = m12Clamp(
                        m12Finite(metadata.audioAbsorption, 0.55),
                        0,
                        0.95
                    );
                }
            } catch (error) {
                logger.warn?.("[Modul 12] Audio-Raycast fehlgeschlagen.", error);
            }
        }

        return m12Clamp(
            distanceFactor *
            source.baseTransmission *
            (1 - occlusion),
            0,
            1
        );
    }

    function updateAudioOcclusion() {
        const listenerPosition = getPlayerPosition();

        if (!listenerPosition || audioSources.size === 0) return;

        const sources = [...audioSources.values()]
            .filter(source => source.active);

        const budget = Math.min(
            sources.length,
            config.audio.maximumOcclusionChecksPerUpdate
        );

        for (let i = 0; i < budget; i++) {
            if (sources.length === 0) break;

            nextOcclusionIndex %= sources.length;

            const source = sources[nextOcclusionIndex++];

            source.currentTransmission = estimateAudioTransmission(
                source,
                listenerPosition
            );

            emit("audio:occlusionUpdated", {
                sourceId: source.id,
                transmission: source.currentTransmission
            });
        }
    }

    /* ============================================================
       WELTBEGEGNUNGEN
       ============================================================ */

    function createIncident(options = {}) {
        const type = options.type ??
            WORLD_INCIDENT_TYPES.TRAFFIC_ACCIDENT;

        if (!Object.values(WORLD_INCIDENT_TYPES).includes(type)) {
            return {
                ok: false,
                reason: "unknown_incident_type"
            };
        }

        if (!m12ValidPosition(options.position)) {
            return {
                ok: false,
                reason: "invalid_incident_position"
            };
        }

        const id = options.id ?? m12CreateId("incident");

        if (activeIncidents.has(id)) {
            return {
                ok: false,
                reason: "duplicate_incident_id"
            };
        }

        const incident = {
            id,
            type,

            position: new BABYLON.Vector3(
                options.position.x,
                options.position.y,
                options.position.z
            ),

            state: "active",

            severity: m12Clamp(
                m12Finite(options.severity, 1),
                0,
                5
            ),

            createdAt: elapsedSimulation,

            expiresAt: options.expiresAt ??
                elapsedSimulation + m12Random(30, 180),

            assignedUnits: [],

            participants: Array.isArray(options.participants)
                ? options.participants.slice()
                : [],

            rewardCents: Math.max(
                0,
                Math.round(m12Finite(options.rewardCents, 0))
            ),

            metadata: m12ClonePlain(options.metadata ?? {})
        };

        activeIncidents.set(id, incident);

        emit("world:incidentCreated", {
            incidentId: id,
            incidentType: type,
            position: incident.position.clone(),
            severity: incident.severity
        });

        return {
            ok: true,
            incident
        };
    }

    function resolveIncident(id, resolution = {}) {
        const incident = activeIncidents.get(id);

        if (!incident || incident.state !== "active") {
            return false;
        }

        incident.state = "resolved";
        incident.resolvedAt = elapsedSimulation;
        incident.resolution = m12ClonePlain(resolution);

        emit("world:incidentResolved", {
            incidentId: id,
            resolution
        });

        activeIncidents.delete(id);

        return true;
    }

    function generateAmbientIncident(position) {
        if (!m12ValidPosition(position)) {
            return {
                ok: false,
                reason: "invalid_position"
            };
        }

        const weather = getWeatherState();

        const weightedTypes = [
            WORLD_INCIDENT_TYPES.TRAFFIC_ACCIDENT,
            WORLD_INCIDENT_TYPES.STREET_ARGUMENT,
            WORLD_INCIDENT_TYPES.LOST_TOURIST,
            WORLD_INCIDENT_TYPES.PUBLIC_PERFORMANCE,
            WORLD_INCIDENT_TYPES.VEHICLE_BREAKDOWN
        ];

        if (weather.intensity > 0.65) {
            weightedTypes.push(
                WORLD_INCIDENT_TYPES.STORM_DAMAGE,
                WORLD_INCIDENT_TYPES.POWER_OUTAGE
            );
        }

        return createIncident({
            type: m12Choose(weightedTypes),
            position,
            severity: m12Random(0.2, 2.4)
        });
    }

    function updateWorldIncidents() {
        for (const incident of activeIncidents.values()) {
            if (
                incident.state === "active" &&
                elapsedSimulation >= incident.expiresAt
            ) {
                resolveIncident(incident.id, {
                    reason: "timeout"
                });
            }
        }
    }

    /* ============================================================
       WIRTSCHAFT UND TRANSAKTIONEN
       ============================================================ */

    const economy = {
        cashCents: config.economy.startingCashCents,
        bankCents: config.economy.startingBankCents,

        transactionHistory: [],

        totalIncomeCents: 0,
        totalExpenseCents: 0,

        lastTransactionAt: null
    };

    const moneyAccounts = new Map();

    moneyAccounts.set("player_cash", {
        id: "player_cash",
        balanceCents: economy.cashCents,
        kind: "cash"
    });

    moneyAccounts.set("player_bank", {
        id: "player_bank",
        balanceCents: economy.bankCents,
        kind: "bank"
    });

    function getAccountBalance(accountId) {
        const account = moneyAccounts.get(accountId);

        if (!account) return null;

        return account.balanceCents;
    }

    function transferMoney(options = {}) {
        const {
            accountId,
            amountCents,
            type = "transfer",
            metadata = {}
        } = options;

        if (!accountId || !moneyAccounts.has(accountId)) {
            return {
                ok: false,
                reason: "account_not_found"
            };
        }

        if (
            !Number.isSafeInteger(amountCents) ||
            amountCents < 0
        ) {
            return {
                ok: false,
                reason: "invalid_amount"
            };
        }

        if (
            amountCents > config.economy.maximumMoneyCents
        ) {
            return {
                ok: false,
                reason: "amount_exceeds_limit"
            };
        }

        const account = moneyAccounts.get(accountId);

        if (account.balanceCents < amountCents) {
            return {
                ok: false,
                reason: "insufficient_funds"
            };
        }

        const previousBalance = account.balanceCents;

        const nextBalance = previousBalance - amountCents;

        if (!Number.isSafeInteger(nextBalance) || nextBalance < 0) {
            return {
                ok: false,
                reason: "invalid_resulting_balance"
            };
        }

        account.balanceCents = nextBalance;

        if (accountId === "player_cash") {
            economy.cashCents = nextBalance;
        }

        if (accountId === "player_bank") {
            economy.bankCents = nextBalance;
        }

        const transaction = {
            id: m12CreateId("transaction"),
            type,
            accountId,
            amountCents,
            previousBalanceCents: previousBalance,
            resultingBalanceCents: nextBalance,
            timestamp: elapsedSimulation,
            metadata: m12ClonePlain(metadata)
        };

        economy.transactionHistory.push(transaction);

        economy.totalExpenseCents += amountCents;
        economy.lastTransactionAt = elapsedSimulation;

        emit("economy:transactionCompleted", {
            transaction: m12ClonePlain(transaction)
        });

        return {
            ok: true,
            transaction
        };
    }

    function depositCash(amountCents) {
        if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
            return {
                ok: false,
                reason: "invalid_amount"
            };
        }

        const cash = moneyAccounts.get("player_cash");
        const bank = moneyAccounts.get("player_bank");

        if (!cash || !bank) {
            return {
                ok: false,
                reason: "missing_account"
            };
        }

        if (cash.balanceCents < amountCents) {
            return {
                ok: false,
                reason: "insufficient_cash"
            };
        }

        const oldCash = cash.balanceCents;
        const oldBank = bank.balanceCents;

        try {
            cash.balanceCents -= amountCents;
            bank.balanceCents += amountCents;

            if (
                !Number.isSafeInteger(cash.balanceCents) ||
                !Number.isSafeInteger(bank.balanceCents) ||
                bank.balanceCents > config.economy.maximumMoneyCents
            ) {
                throw new Error("Ungültiger Kontostand nach Einzahlung.");
            }

            economy.cashCents = cash.balanceCents;
            economy.bankCents = bank.balanceCents;

            const transaction = {
                id: m12CreateId("transaction"),
                type: "cash_deposit",
                amountCents,
                timestamp: elapsedSimulation,
                cashAfterCents: cash.balanceCents,
                bankAfterCents: bank.balanceCents
            };

            economy.transactionHistory.push(transaction);

            emit("economy:transactionCompleted", {
                transaction: m12ClonePlain(transaction)
            });

            return {
                ok: true,
                transaction
            };
        } catch (error) {
            cash.balanceCents = oldCash;
            bank.balanceCents = oldBank;

            economy.cashCents = oldCash;
            economy.bankCents = oldBank;

            return {
                ok: false,
                reason: "transaction_rolled_back",
                error: String(error)
            };
        }
    }

    function registerProperty(options = {}) {
        if (!options.id || !Number.isSafeInteger(options.priceCents)) {
            return {
                ok: false,
                reason: "invalid_property"
            };
        }

        if (options.priceCents < 0) {
            return {
                ok: false,
                reason: "negative_property_price"
            };
        }

        if (propertyRecords.has(options.id)) {
            return {
                ok: false,
                reason: "duplicate_property"
            };
        }

        const property = {
            id: options.id,
            name: options.name ?? options.id,
            priceCents: options.priceCents,

            ownerId: options.ownerId ?? null,

            position: m12ValidPosition(options.position)
                ? {
                    x: options.position.x,
                    y: options.position.y,
                    z: options.position.z
                }
                : null,

            type: options.type ?? "property",

            available: options.available !== false,

            metadata: m12ClonePlain(options.metadata ?? {})
        };

        propertyRecords.set(property.id, property);

        return {
            ok: true,
            property
        };
    }

    function purchaseProperty(propertyId, playerId = getActivePlayerId()) {
        const property = propertyRecords.get(propertyId);

        if (!property) {
            return {
                ok: false,
                reason: "property_not_found"
            };
        }

        if (!property.available) {
            return {
                ok: false,
                reason: "property_unavailable"
            };
        }

        if (property.ownerId) {
            return {
                ok: false,
                reason: "property_already_owned"
            };
        }

        if (!playerId) {
            return {
                ok: false,
                reason: "player_not_available"
            };
        }

        const account = moneyAccounts.get("player_bank");

        if (!account || account.balanceCents < property.priceCents) {
            return {
                ok: false,
                reason: "insufficient_funds"
            };
        }

        const previousOwner = property.ownerId;

        const payment = transferMoney({
            accountId: "player_bank",
            amountCents: property.priceCents,
            type: "property_purchase",
            metadata: {
                propertyId,
                playerId
            }
        });

        if (!payment.ok) {
            return payment;
        }

        try {
            property.ownerId = playerId;

            emit("property:purchased", {
                propertyId,
                ownerId: playerId,
                priceCents: property.priceCents
            });

            return {
                ok: true,
                property,
                transaction: payment.transaction
            };
        } catch (error) {
            property.ownerId = previousOwner;

            const bank = moneyAccounts.get("player_bank");

            bank.balanceCents += property.priceCents;

            economy.bankCents = bank.balanceCents;

            return {
                ok: false,
                reason: "property_transaction_rolled_back",
                error: String(error)
            };
        }
    }

    /* ============================================================
       AKTIENMARKT
       ============================================================ */

    function registerMarketInstrument(options = {}) {
        if (!options.id || !Number.isFinite(options.price)) {
            return {
                ok: false,
                reason: "invalid_instrument"
            };
        }

        if (marketInstruments.has(options.id)) {
            return {
                ok: false,
                reason: "duplicate_instrument"
            };
        }

        const instrument = {
            id: options.id,
            name: options.name ?? options.id,

            price: Math.max(0.01, options.price),

            volatility: m12Clamp(
                m12Finite(options.volatility, 0.025),
                0.001,
                0.5
            ),

            trend: m12Clamp(
                m12Finite(options.trend, 0),
                -0.1,
                0.1
            ),

            sentiment: m12Clamp(
                m12Finite(options.sentiment, 0),
                -1,
                1
            ),

            sector: options.sector ?? "general",

            history: [],

            metadata: m12ClonePlain(options.metadata ?? {})
        };

        instrument.history.push({
            time: elapsedGameTime,
            price: instrument.price
        });

        marketInstruments.set(instrument.id, instrument);

        marketPositions.set(instrument.id, {
            quantity: 0,
            averageCost: 0
        });

        return {
            ok: true,
            instrument
        };
    }

    function calculateTransactionFee(amountCents) {
        return Math.max(
            0,
            Math.round(
                amountCents *
                config.economy.defaultTransactionFeeBasisPoints /
                10000
            )
        );
    }

    function buyShares(instrumentId, quantity) {
        const instrument = marketInstruments.get(instrumentId);
        const position = marketPositions.get(instrumentId);

        if (!instrument || !position) {
            return {
                ok: false,
                reason: "instrument_not_found"
            };
        }

        if (!Number.isSafeInteger(quantity) || quantity <= 0) {
            return {
                ok: false,
                reason: "invalid_quantity"
            };
        }

        const amountCents = Math.round(
            instrument.price * 100 * quantity
        );

        const feeCents = calculateTransactionFee(amountCents);

        const totalCents = amountCents + feeCents;

        const account = moneyAccounts.get("player_bank");

        if (!account || account.balanceCents < totalCents) {
            return {
                ok: false,
                reason: "insufficient_funds"
            };
        }

        const payment = transferMoney({
            accountId: "player_bank",
            amountCents: totalCents,
            type: "stock_purchase",
            metadata: {
                instrumentId,
                quantity,
                feeCents
            }
        });

        if (!payment.ok) return payment;

        const previousQuantity = position.quantity;
        const previousCost = position.averageCost;

        const nextQuantity = previousQuantity + quantity;

        position.averageCost =
            (
                previousQuantity * previousCost +
                quantity * instrument.price
            ) / nextQuantity;

        position.quantity = nextQuantity;

        emit("economy:stockPurchased", {
            instrumentId,
            quantity,
            unitPrice: instrument.price,
            totalCents,
            feeCents
        });

        return {
            ok: true,
            quantity,
            totalCents,
            feeCents,
            position: m12ClonePlain(position)
        };
    }

    function sellShares(instrumentId, quantity) {
        const instrument = marketInstruments.get(instrumentId);
        const position = marketPositions.get(instrumentId);

        if (!instrument || !position) {
            return {
                ok: false,
                reason: "instrument_not_found"
            };
        }

        if (!Number.isSafeInteger(quantity) || quantity <= 0) {
            return {
                ok: false,
                reason: "invalid_quantity"
            };
        }

        if (position.quantity < quantity) {
            return {
                ok: false,
                reason: "insufficient_shares"
            };
        }

        const grossCents = Math.round(
            instrument.price * 100 * quantity
        );

        const feeCents = calculateTransactionFee(grossCents);

        const netCents = Math.max(0, grossCents - feeCents);

        const account = moneyAccounts.get("player_bank");

        if (
            !account ||
            account.balanceCents + netCents >
                config.economy.maximumMoneyCents
        ) {
            return {
                ok: false,
                reason: "balance_limit_exceeded"
            };
        }

        const previousQuantity = position.quantity;
        const previousCost = position.averageCost;

        position.quantity -= quantity;

        if (position.quantity === 0) {
            position.averageCost = 0;
        }

        account.balanceCents += netCents;
        economy.bankCents = account.balanceCents;
        economy.totalIncomeCents += netCents;

        const transaction = {
            id: m12CreateId("transaction"),
            type: "stock_sale",
            instrumentId,
            quantity,
            grossCents,
            feeCents,
            netCents,
            timestamp: elapsedSimulation
        };

        economy.transactionHistory.push(transaction);

        emit("economy:transactionCompleted", {
            transaction: m12ClonePlain(transaction)
        });

        emit("economy:stockSold", {
            instrumentId,
            quantity,
            grossCents,
            feeCents,
            netCents,
            realizedProfitCents: Math.round(
                (instrument.price - previousCost) * 100 * quantity
            )
        });

        return {
            ok: true,
            quantity,
            grossCents,
            feeCents,
            netCents,
            position: m12ClonePlain(position)
        };
    }

    function updateMarket(dt) {
        for (const instrument of marketInstruments.values()) {
            const volatility = instrument.volatility;

            const randomShock = m12Random(-1, 1) *
                volatility *
                Math.sqrt(Math.max(0.001, dt));

            const meanReversion = -instrument.sentiment * 0.018 * dt;

            const trendComponent = instrument.trend * dt;

            const sentimentComponent =
                instrument.sentiment * volatility * 0.08 * dt;

            const logReturn =
                randomShock +
                meanReversion +
                trendComponent +
                sentimentComponent;

            instrument.price = Math.max(
                0.01,
                instrument.price * Math.exp(logReturn)
            );

            instrument.sentiment = m12Clamp(
                instrument.sentiment * 0.997 +
                    m12Random(-0.005, 0.005),
                -1,
                1
            );

            instrument.history.push({
                time: elapsedGameTime,
                price: instrument.price
            });

            if (
                instrument.history.length >
                config.economy.marketHistoryLimit
            ) {
                instrument.history.shift();
            }
        }
    }

    function applyMarketEvent(options = {}) {
        const sector = options.sector ?? null;

        const sentimentDelta = m12Clamp(
            m12Finite(options.sentimentDelta, 0),
            -1,
            1
        );

        const affected = [];

        for (const instrument of marketInstruments.values()) {
            if (sector && instrument.sector !== sector) continue;

            instrument.sentiment = m12Clamp(
                instrument.sentiment + sentimentDelta,
                -1,
                1
            );

            instrument.trend = m12Clamp(
                instrument.trend +
                    sentimentDelta * 0.002,
                -0.1,
                0.1
            );

            affected.push(instrument.id);
        }

        emit("economy:marketEvent", {
            sector,
            sentimentDelta,
            affectedInstrumentIds: affected,
            reason: options.reason ?? "world_event"
        });

        return affected;
    }

    /* ============================================================
       HEIST- UND HACKING-VERKNÜPFUNG
       ============================================================ */

    function registerHeist(options = {}) {
        if (!options.id) {
            return {
                ok: false,
                reason: "missing_heist_id"
            };
        }

        if (activeHeists.has(options.id)) {
            return {
                ok: false,
                reason: "duplicate_heist"
            };
        }

        const heist = {
            id: options.id,

            state: "available",

            hackingRequired: options.hackingRequired === true,

            hackingComplete: false,

            requiredObjectives: Array.isArray(options.requiredObjectives)
                ? options.requiredObjectives.map(objective => ({
                    id: objective.id,
                    complete: false
                }))
                : [],

            rewardCents: Math.max(
                0,
                Math.round(m12Finite(options.rewardCents, 0))
            ),

            startedAt: null,
            completedAt: null,

            metadata: m12ClonePlain(options.metadata ?? {})
        };

        activeHeists.set(heist.id, heist);

        return {
            ok: true,
            heist
        };
    }

    function startHeist(id) {
        const heist = activeHeists.get(id);

        if (!heist || heist.state !== "available") {
            return {
                ok: false,
                reason: "heist_unavailable"
            };
        }

        heist.state = "active";
        heist.startedAt = elapsedSimulation;

        emit("mission:started", {
            missionId: id,
            missionType: "heist"
        });

        return {
            ok: true,
            heist
        };
    }

    function completeHeistObjective(heistId, objectiveId) {
        const heist = activeHeists.get(heistId);

        if (!heist || heist.state !== "active") {
            return false;
        }

        const objective = heist.requiredObjectives.find(
            item => item.id === objectiveId
        );

        if (!objective) return false;

        objective.complete = true;

        emit("mission:objectiveCompleted", {
            missionId: heistId,
            objectiveId
        });

        return true;
    }

    function resolveHackingSession(payload = {}) {
        const heistId = payload.heistId;

        if (!heistId) return false;

        const heist = activeHeists.get(heistId);

        if (!heist || heist.state !== "active") {
            return false;
        }

        if (payload.success !== true) {
            emit("heist:hackingFailed", {
                heistId,
                reason: payload.reason ?? "failed"
            });

            if (payload.alarmTriggered === true) {
                const position = payload.position ??
                    getPlayerPosition();

                if (m12ValidPosition(position)) {
                    recordCrime({
                        actorId: getActivePlayerId(),
                        crimeType: "robbery",
                        position,
                        description: "Failed heist hacking alarm"
                    });
                }
            }

            return true;
        }

        heist.hackingComplete = true;

        emit("heist:hackingCompleted", {
            heistId
        });

        return true;
    }

    function finishHeist(id) {
        const heist = activeHeists.get(id);

        if (!heist || heist.state !== "active") {
            return {
                ok: false,
                reason: "heist_not_active"
            };
        }

        if (heist.hackingRequired && !heist.hackingComplete) {
            return {
                ok: false,
                reason: "hacking_not_completed"
            };
        }

        if (heist.requiredObjectives.some(objective => !objective.complete)) {
            return {
                ok: false,
                reason: "objectives_incomplete"
            };
        }

        const payment = transferMoney({
            accountId: "player_cash",
            amountCents: 0,
            type: "heist_completion",
            metadata: {
                heistId: id
            }
        });

        if (!payment.ok) {
            return payment;
        }

        const cash = moneyAccounts.get("player_cash");

        if (
            !cash ||
            cash.balanceCents + heist.rewardCents >
                config.economy.maximumMoneyCents
        ) {
            return {
                ok: false,
                reason: "reward_balance_limit"
            };
        }

        cash.balanceCents += heist.rewardCents;
        economy.cashCents = cash.balanceCents;
        economy.totalIncomeCents += heist.rewardCents;

        heist.state = "completed";
        heist.completedAt = elapsedSimulation;

        emit("mission:completed", {
            missionId: id,
            rewardCents: heist.rewardCents
        });

        return {
            ok: true,
            rewardCents: heist.rewardCents
        };
    }

    /* ============================================================
       PERSISTENZ – INDEXEDDB
       ============================================================ */

    let databasePromise = null;
    let saveInProgress = false;
    let pendingSave = false;

    function openDatabase() {
        if (databasePromise) return databasePromise;

        if (typeof indexedDB === "undefined") {
            return Promise.reject(
                new Error("IndexedDB ist in dieser Umgebung nicht verfügbar.")
            );
        }

        databasePromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(
                config.persistence.databaseName,
                config.persistence.databaseVersion
            );

            request.onupgradeneeded = () => {
                const db = request.result;

                if (!db.objectStoreNames.contains("saves")) {
                    db.createObjectStore("saves", {
                        keyPath: "id"
                    });
                }

                if (!db.objectStoreNames.contains("metadata")) {
                    db.createObjectStore("metadata", {
                        keyPath: "id"
                    });
                }
            };

            request.onsuccess = () => resolve(request.result);

            request.onerror = () => reject(
                request.error ??
                new Error("IndexedDB konnte nicht geöffnet werden.")
            );

            request.onblocked = () => {
                logger.warn?.(
                    "[Modul 12] Datenbanköffnung blockiert; möglicherweise ist ein anderer Tab aktiv."
                );
            };
        });

        return databasePromise;
    }

    function serializeVector(value) {
        return {
            __type: "Vector3",
            x: value.x,
            y: value.y,
            z: value.z
        };
    }

    function safeSerialize(value, seen = new WeakSet()) {
        if (
            value === null ||
            value === undefined ||
            typeof value === "string" ||
            typeof value === "boolean"
        ) {
            return value;
        }

        if (typeof value === "number") {
            if (!Number.isFinite(value)) {
                throw new TypeError("Nicht endlicher Zahlenwert im Spielstand.");
            }

            return value;
        }

        if (typeof value === "bigint") {
            return {
                __type: "BigInt",
                value: value.toString()
            };
        }

        if (typeof value === "function" || typeof value === "symbol") {
            return undefined;
        }

        if (value instanceof BABYLON.Vector3) {
            return serializeVector(value);
        }

        if (value instanceof Map) {
            return {
                __type: "Map",
                entries: [...value.entries()].map(([key, item]) => [
                    safeSerialize(key, seen),
                    safeSerialize(item, seen)
                ])
            };
        }

        if (value instanceof Set) {
            return {
                __type: "Set",
                values: [...value].map(item => safeSerialize(item, seen))
            };
        }

        if (seen.has(value)) {
            throw new TypeError("Zyklische Referenz im Speicherstand.");
        }

        seen.add(value);

        let result;

        if (Array.isArray(value)) {
            result = value.map(item => safeSerialize(item, seen));
        } else {
            result = {};

            for (const [key, item] of Object.entries(value)) {
                if (
                    key === "mesh" ||
                    key === "root" ||
                    key === "scene" ||
                    key === "engine" ||
                    key === "observable" ||
                    key === "metadataRuntime"
                ) {
                    continue;
                }

                const serialized = safeSerialize(item, seen);

                if (serialized !== undefined) {
                    result[key] = serialized;
                }
            }
        }

        seen.delete(value);

        return result;
    }

    function reviveSaveValue(value) {
        if (value === null || typeof value !== "object") {
            return value;
        }

        if (Array.isArray(value)) {
            return value.map(reviveSaveValue);
        }

        if (value.__type === "Vector3") {
            return new BABYLON.Vector3(
                value.x,
                value.y,
                value.z
            );
        }

        if (value.__type === "BigInt") {
            return BigInt(value.value);
        }

        if (value.__type === "Map") {
            return new Map(
                value.entries.map(([key, item]) => [
                    reviveSaveValue(key),
                    reviveSaveValue(item)
                ])
            );
        }

        if (value.__type === "Set") {
            return new Set(value.values.map(reviveSaveValue));
        }

        const result = {};

        for (const [key, item] of Object.entries(value)) {
            result[key] = reviveSaveValue(item);
        }

        return result;
    }

    function buildSnapshot() {
        const snapshot = {
            schemaVersion: 1,
            moduleVersion: MODULE_12_VERSION,

            savedAt: Date.now(),

            simulationTime: elapsedSimulation,
            gameTime: elapsedGameTime,

            wantedState: safeSerialize(wantedState),

            economy: safeSerialize(economy),

            moneyAccounts: safeSerialize(moneyAccounts),

            npcs: safeSerialize(
                [...npcs.values()].filter(npc => npc.persistent)
            ),

            policeUnits: safeSerialize([...policeUnits.values()]),

            crimeRecords: safeSerialize([...crimeRecords.values()]),

            evidenceRecords: safeSerialize([...evidenceRecords.values()]),

            activeIncidents: safeSerialize([...activeIncidents.values()]),

            worldEncounters: safeSerialize([...worldEncounters.values()]),

            marketInstruments: safeSerialize([...marketInstruments.values()]),

            marketPositions: safeSerialize(marketPositions),

            propertyRecords: safeSerialize([...propertyRecords.values()]),

            activeHeists: safeSerialize([...activeHeists.values()]),

            roadNodes: safeSerialize([...roadNodes.values()]),

            roadEdges: safeSerialize([...roadEdges.values()])
        };

        const json = JSON.stringify(snapshot);

        if (
            json.length >
            config.persistence.maximumSnapshotBytes
        ) {
            throw new RangeError(
                "Der Spielstand überschreitet das erlaubte Größenlimit."
            );
        }

        return snapshot;
    }

    function validateSnapshot(snapshot) {
        if (!snapshot || typeof snapshot !== "object") {
            throw new TypeError("Ungültiger Spielstand.");
        }

        if (snapshot.schemaVersion !== 1) {
            throw new Error(
                `Nicht unterstützte Save-Version: ${snapshot.schemaVersion}`
            );
        }

        if (!snapshot.economy ||
            !Number.isSafeInteger(snapshot.economy.cashCents) ||
            !Number.isSafeInteger(snapshot.economy.bankCents)) {
            throw new TypeError("Ungültige Finanzdaten im Spielstand.");
        }

        if (
            snapshot.economy.cashCents < 0 ||
            snapshot.economy.bankCents < 0
        ) {
            throw new RangeError(
                "Negative Kontostände im Spielstand sind nicht zulässig."
            );
        }

        if (!Array.isArray(snapshot.npcs) ||
            !Array.isArray(snapshot.policeUnits)) {
            throw new TypeError(
                "NPC- oder Polizeidaten fehlen im Spielstand."
            );
        }

        return true;
    }

    async function saveGame(options = {}) {
        if (saveInProgress) {
            pendingSave = true;

            return {
                ok: false,
                reason: "save_already_in_progress"
            };
        }

        saveInProgress = true;

        try {
            const snapshot = buildSnapshot();

            validateSnapshot(snapshot);

            const db = await openDatabase();

            await new Promise((resolve, reject) => {
                const transaction = db.transaction(
                    ["saves"],
                    "readwrite"
                );

                const store = transaction.objectStore("saves");

                store.put({
                    id: config.persistence.saveKey,
                    snapshot,
                    updatedAt: Date.now()
                });

                transaction.oncomplete = () => resolve();

                transaction.onerror = () => reject(
                    transaction.error ??
                    new Error("Speichern fehlgeschlagen.")
                );

                transaction.onabort = () => reject(
                    transaction.error ??
                    new Error("Speichervorgang wurde abgebrochen.")
                );
            });

            emit("save:completed", {
                saveId: config.persistence.saveKey,
                savedAt: snapshot.savedAt,
                automatic: options.automatic === true
            });

            return {
                ok: true,
                savedAt: snapshot.savedAt
            };
        } catch (error) {
            emit("save:failed", {
                message: String(error?.message ?? error)
            });

            return {
                ok: false,
                reason: "save_failed",
                error: String(error?.message ?? error)
            };
        } finally {
            saveInProgress = false;

            if (pendingSave) {
                pendingSave = false;

                queueMicrotask(() => {
                    if (!disposed) {
                        saveGame({ automatic: true }).catch(error => {
                            logger.error?.(
                                "[Modul 12] Wartender Speicherauftrag fehlgeschlagen.",
                                error
                            );
                        });
                    }
                });
            }
        }
    }

    async function loadGame() {
        try {
            const db = await openDatabase();

            const record = await new Promise((resolve, reject) => {
                const transaction = db.transaction(
                    ["saves"],
                    "readonly"
                );

                const request = transaction
                    .objectStore("saves")
                    .get(config.persistence.saveKey);

                request.onsuccess = () => resolve(request.result ?? null);

                request.onerror = () => reject(
                    request.error ??
                    new Error("Spielstand konnte nicht gelesen werden.")
                );
            });

            if (!record?.snapshot) {
                return {
                    ok: false,
                    reason: "save_not_found"
                };
            }

            const snapshot = record.snapshot;

            validateSnapshot(snapshot);

            /*
             * Zuerst werden die gespeicherten Daten validiert.
             * Laufzeitentitäten werden danach kontrolliert ersetzt.
             */

            const revived = reviveSaveValue(snapshot);

            for (const id of [...npcs.keys()]) {
                removeNPC(id, "save_restore");
            }

            for (const id of [...policeUnits.keys()]) {
                removePoliceUnit(id);
            }

            npcs.clear();
            policeUnits.clear();
            crimeRecords.clear();
            evidenceRecords.clear();
            activeIncidents.clear();
            worldEncounters.clear();
            marketInstruments.clear();
            marketPositions.clear();
            propertyRecords.clear();
            activeHeists.clear();
            roadNodes.clear();
            roadEdges.clear();
            spatialGrid.clear();

            elapsedSimulation = revived.simulationTime ?? 0;
            elapsedGameTime = revived.gameTime ?? 0;

            Object.assign(wantedState, revived.wantedState);

            Object.assign(economy, revived.economy);

            moneyAccounts.clear();

            for (const [id, account] of revived.moneyAccounts ?? []) {
                moneyAccounts.set(id, account);
            }

            for (const rawNPC of revived.npcs ?? []) {
                const result = createNPC({
                    ...rawNPC,
                    id: rawNPC.id,
                    position: rawNPC.position
                });

                if (result.ok) {
                    Object.assign(result.npc, rawNPC);

                    if (!result.npc.velocity) {
                        result.npc.velocity =
                            new BABYLON.Vector3(0, 0, 0);
                    }

                    if (!result.npc.desiredVelocity) {
                        result.npc.desiredVelocity =
                            new BABYLON.Vector3(0, 0, 0);
                    }

                    if (!(result.npc.cooldowns instanceof Map)) {
                        result.npc.cooldowns = new Map();
                    }

                    gridInsert(result.npc.id, result.npc.position);
                }
            }

            for (const rawUnit of revived.policeUnits ?? []) {
                const result = createPoliceUnit({
                    ...rawUnit,
                    id: rawUnit.id,
                    position: rawUnit.position
                });

                if (result.ok) {
                    Object.assign(result.unit, rawUnit);
                }
            }

            for (const record of revived.crimeRecords ?? []) {
                crimeRecords.set(record.id, record);
            }

            for (const record of revived.evidenceRecords ?? []) {
                evidenceRecords.set(record.id, record);
            }

            for (const incident of revived.activeIncidents ?? []) {
                activeIncidents.set(incident.id, incident);
            }

            for (const encounter of revived.worldEncounters ?? []) {
                worldEncounters.set(encounter.id, encounter);
            }

            for (const instrument of revived.marketInstruments ?? []) {
                marketInstruments.set(instrument.id, instrument);
            }

            for (const [id, position] of revived.marketPositions ?? []) {
                marketPositions.set(id, position);
            }

            for (const property of revived.propertyRecords ?? []) {
                propertyRecords.set(property.id, property);
            }

            for (const heist of revived.activeHeists ?? []) {
                activeHeists.set(heist.id, heist);
            }

            for (const node of revived.roadNodes ?? []) {
                roadNodes.set(node.id, node);

                if (!(node.connections instanceof Set)) {
                    node.connections = new Set(node.connections ?? []);
                }
            }

            for (const edge of revived.roadEdges ?? []) {
                roadEdges.set(edge.id, edge);
            }

            emit("save:restored", {
                savedAt: snapshot.savedAt,
                npcCount: npcs.size,
                policeCount: policeUnits.size
            });

            emit("save:restoreRequested", {
                savedAt: snapshot.savedAt,
                schemaVersion: snapshot.schemaVersion
            });

            return {
                ok: true,
                savedAt: snapshot.savedAt,
                npcCount: npcs.size,
                policeCount: policeUnits.size
            };
        } catch (error) {
            emit("save:failed", {
                operation: "load",
                message: String(error?.message ?? error)
            });

            return {
                ok: false,
                reason: "load_failed",
                error: String(error?.message ?? error)
            };
        }
    }

    /* ============================================================
       EREIGNISVERKNÜPFUNG MIT DEN ANDEREN MODULEN
       ============================================================ */

    on("weapon:fired", payload => {
        recordCrime({
            ...payload,
            crimeType: "weapon_discharge",
            actorId: payload.actorId ?? payload.playerId
        });
    });

    on("crime:shotFired", payload => {
        recordCrime({
            ...payload,
            crimeType: "weapon_discharge",
            actorId: payload.actorId ?? payload.playerId
        });
    });

    on("combat:hit", payload => {
        const target = getEntityById(
            payload.targetId ?? payload.victimId
        );

        const targetType =
            target?.type ??
            target?.role ??
            payload.targetType ??
            "unknown";

        const crimeType =
            targetType === "civilian" ||
            targetType === "pedestrian"
                ? "assault"
                : "assault";

        recordCrime({
            ...payload,
            crimeType,
            actorId: payload.actorId ?? payload.attackerId,
            targetId: payload.targetId ?? payload.victimId
        });
    });

    on("vehicle:stolen", payload => {
        recordCrime({
            ...payload,
            crimeType: "vehicle_theft",
            actorId: payload.actorId ?? payload.playerId,
            position: payload.position ?? getPlayerPosition()
        });
    });

    on("world:restrictedZoneEntered", payload => {
        recordCrime({
            ...payload,
            crimeType: "trespass",
            actorId: payload.actorId ?? payload.playerId,
            position: payload.position ?? getPlayerPosition()
        });
    });

    on("vehicle:damaged", payload => {
        if (payload.causedByPlayer !== true) return;

        recordCrime({
            ...payload,
            crimeType: "property_damage",
            actorId: payload.actorId ?? getActivePlayerId(),
            position: payload.position ?? getPlayerPosition()
        });
    });

    on("world:weatherChanged", payload => {
        if (
            payload.type === "hurricane" ||
            payload.type === "tropical_storm"
        ) {
            applyMarketEvent({
                sector: "tourism",
                sentimentDelta: -0.12,
                reason: "severe_weather"
            });
        }
    });

    on("phone:hackingCompleted", payload => {
        resolveHackingSession({
            ...payload,
            success: true
        });
    });

    on("phone:hackingFailed", payload => {
        resolveHackingSession({
            ...payload,
            success: false,
            alarmTriggered: payload.alarmTriggered === true
        });
    });

    on("player:characterChanged", payload => {
        const playerId = payload.characterId ??
            payload.playerId;

        if (!playerId) return;

        if (!activePlayers.has(playerId)) {
            const position = getEntityPosition(playerId);

            if (position) {
                activePlayers.set(playerId, {
                    id: playerId,
                    position
                });
            }
        }
    });

    on("player:died", payload => {
        const playerId = payload.playerId ?? getActivePlayerId();

        if (playerId && wantedState.level > 0) {
            emit("police:wantedSuspended", {
                playerId,
                wantedLevel: wantedState.level
            });
        }
    });

    /* ============================================================
       HAUPT-UPDATE
       ============================================================ */

    function fixedUpdate(dt) {
        elapsedSimulation += dt;
        elapsedGameTime += dt * m12Finite(runtime.timeScale, 1);

        for (const npc of npcs.values()) {
            npc.stateTime += dt;

            updateNPCMovement(npc, dt);
        }

        for (const unit of policeUnits.values()) {
            updatePoliceUnit(unit, dt);
        }

        updateWantedHeat(dt);
        updateWorldIncidents();

        npcDecisionAccumulator += dt;
        perceptionAccumulator += dt;
        policeDispatchAccumulator += dt;
        marketAccumulator += dt;
        audioAccumulator += dt;
        autosaveAccumulator += dt;

        if (npcDecisionAccumulator >= config.npc.decisionInterval) {
            npcDecisionAccumulator = 0;

            for (const npc of npcs.values()) {
                updateNPCDecision(npc);
            }
        }

        if (perceptionAccumulator >= config.npc.perceptionInterval) {
            perceptionAccumulator = 0;

            updatePerception();
        }

        if (policeDispatchAccumulator >= config.police.dispatchInterval) {
            policeDispatchAccumulator = 0;

            if (wantedState.level > 0) {
                const hasAssignedUnit = [...policeUnits.values()].some(
                    unit =>
                        unit.targetId === getActivePlayerId() &&
                        unit.state !== POLICE_STATES.AVAILABLE &&
                        unit.state !== POLICE_STATES.UNAVAILABLE
                );

                if (!hasAssignedUnit && wantedState.lastSeenPosition) {
                    const syntheticCrime = {
                        id: m12CreateId("dispatch"),
                        actorId: getActivePlayerId(),
                        position: wantedState.lastSeenPosition,
                        resolved: false
                    };

                    dispatchPoliceForCrime(syntheticCrime);
                }
            }
        }

        if (marketAccumulator >= config.economy.marketUpdateInterval) {
            const marketDt = marketAccumulator;

            marketAccumulator = 0;

            updateMarket(marketDt);
        }

        if (audioAccumulator >= config.audio.updateInterval) {
            audioAccumulator = 0;

            updateAudioOcclusion();
        }

        if (autosaveAccumulator >= config.persistence.autosaveInterval) {
            autosaveAccumulator = 0;

            if (runtime.settings?.autosave !== false) {
                saveGame({ automatic: true }).catch(error => {
                    logger.error?.(
                        "[Modul 12] Automatisches Speichern fehlgeschlagen.",
                        error
                    );
                });
            }
        }

        for (const [id, record] of crimeRecords) {
            if (
                elapsedSimulation - record.createdAt >
                config.police.evidenceMemoryDuration * 10
            ) {
                crimeRecords.delete(id);
            }
        }

        for (const [id, evidence] of evidenceRecords) {
            if (
                elapsedSimulation - evidence.createdAt >
                config.police.evidenceMemoryDuration * 20
            ) {
                evidenceRecords.delete(id);
            }
        }
    }

    function update(deltaSeconds) {
        if (!started || disposed) return;

        const dt = m12Clamp(
            m12Finite(deltaSeconds, 0),
            0,
            0.25
        );

        simulationAccumulator += dt;

        let steps = 0;

        while (
            simulationAccumulator >= config.fixedStep &&
            steps < config.maxSubSteps
        ) {
            fixedUpdate(config.fixedStep);

            simulationAccumulator -= config.fixedStep;
            steps++;
        }

        if (
            steps >= config.maxSubSteps &&
            simulationAccumulator > config.fixedStep * 4
        ) {
            simulationAccumulator = config.fixedStep * 4;

            emit("performance:simulationOverload", {
                module: "ki_polizei_wirtschaft",
                accumulator: simulationAccumulator
            });
        }
    }

    function updateFromAnimationFrame(timestampMs) {
        if (!started || disposed) return;

        const now = timestampMs / 1000;

        if (lastFrameTime === null) {
            lastFrameTime = now;
            return;
        }

        const dt = now - lastFrameTime;

        lastFrameTime = now;

        update(dt);
    }

    /* ============================================================
       INITIALISIERUNG UND LEBENSZYKLUS
       ============================================================ */

    async function initialize() {
        if (disposed) {
            throw new Error("Modul 12 wurde bereits beendet.");
        }

        if (started) {
            return {
                ok: true,
                alreadyStarted: true
            };
        }

        /*
         * Der Straßengraph kann bereits vom Weltarchitektur-Modul
         * bereitgestellt werden. Ein fehlender Graph verhindert
         * nicht die NPC-Simulation, deaktiviert aber lokales A*-Routing.
         */

        const externalGraph = getRoadGraphAdapter();

        if (externalGraph?.nodes && externalGraph?.edges) {
            const result = importRoadGraph({
                nodes: externalGraph.nodes,
                edges: externalGraph.edges
            });

            if (!result.ok) {
                logger.warn?.(
                    "[Modul 12] Externer Straßengraph konnte nicht importiert werden."
                );
            }
        }

        if (typeof runtime.getPlayerPosition === "function") {
            const position = runtime.getPlayerPosition();

            if (m12ValidPosition(position)) {
                emit("ai:playerPositionAvailable", {
                    position: position.clone
                        ? position.clone()
                        : position
                });
            }
        }

        started = true;

        emit("game:moduleInitialized", {
            module: "ki_polizei_wirtschaft",
            version: MODULE_12_VERSION
        });

        return {
            ok: true,
            version: MODULE_12_VERSION
        };
    }

    function stop() {
        if (!started) return;

        started = false;
        lastFrameTime = null;
        simulationAccumulator = 0;

        emit("game:moduleStopped", {
            module: "ki_polizei_wirtschaft"
        });
    }

    function dispose() {
        if (disposed) return;

        stop();

        disposed = true;

        for (const unsubscribe of subscriptions.splice(0)) {
            try {
                unsubscribe();
            } catch (error) {
                logger.warn?.(
                    "[Modul 12] Event-Abonnement konnte nicht entfernt werden.",
                    error
                );
            }
        }

        for (const npc of npcs.values()) {
            if (npc.mesh && !npc.mesh.isDisposed?.()) {
                npc.mesh.dispose?.();
            }
        }

        npcs.clear();
        policeUnits.clear();
        activeIncidents.clear();
        crimeRecords.clear();
        evidenceRecords.clear();
        worldEncounters.clear();
        audioSources.clear();
        spatialGrid.clear();

        databasePromise?.then(db => db.close()).catch(() => {});

        emit("game:moduleDisposed", {
            module: "ki_polizei_wirtschaft"
        });
    }

    /* ============================================================
       ÖFFENTLICHE SCHNITTSTELLE
       ============================================================ */

    return {
        version: MODULE_12_VERSION,

        initialize,
        update,
        updateFromAnimationFrame,
        stop,
        dispose,

        events: {
            emit,
            on
        },

        npc: {
            create: createNPC,
            remove: removeNPC,
            get: id => npcs.get(id) ?? null,
            getAll: () => [...npcs.values()],
            setDestination: setNPCDestination,
            transition: transitionNPC,
            hearSound,
            isVisible: isVisibleToNPC,
            startPhoneRecording,
            finishPhoneRecording,
            getNearby: querySpatial
        },

        police: {
            createUnit: createPoliceUnit,
            removeUnit: removePoliceUnit,
            getUnits: () => [...policeUnits.values()],
            dispatch: dispatchPoliceForCrime,
            arrestPlayer,
            setWantedLevel,
            getWantedState: () => m12ClonePlain(wantedState)
        },

        crime: {
            record: recordCrime,
            getRecords: () => [...crimeRecords.values()],
            getEvidence: () => [...evidenceRecords.values()],
            get: id => crimeRecords.get(id) ?? null
        },

        routing: {
            addNode: addRoadNode,
            addEdge: addRoadEdge,
            importGraph: importRoadGraph,
            findRoute,
            nearestNode: nearestRoadNode,
            setEdgeBlocked: setRoadBlocked,
            getNodes: () => [...roadNodes.values()],
            getEdges: () => [...roadEdges.values()]
        },

        audio: {
            registerSource: registerAudioSource,
            unregisterSource: unregisterAudioSource,
            estimateTransmission: estimateAudioTransmission,
            getSources: () => [...audioSources.values()]
        },

        incidents: {
            create: createIncident,
            resolve: resolveIncident,
            generateAmbient: generateAmbientIncident,
            getAll: () => [...activeIncidents.values()]
        },

        economy: {
            getState: () => ({
                cashCents: economy.cashCents,
                bankCents: economy.bankCents,
                totalIncomeCents: economy.totalIncomeCents,
                totalExpenseCents: economy.totalExpenseCents
            }),

            getAccountBalance,
            transferMoney,
            depositCash,

            registerProperty,
            purchaseProperty,
            getProperties: () => [...propertyRecords.values()],

            registerInstrument: registerMarketInstrument,
            buyShares,
            sellShares,
            getInstruments: () => [...marketInstruments.values()],
            getPosition: id => marketPositions.get(id) ?? null,
            applyMarketEvent
        },

        heists: {
            register: registerHeist,
            start: startHeist,
            completeObjective: completeHeistObjective,
            resolveHackingSession,
            finish: finishHeist,
            getAll: () => [...activeHeists.values()]
        },

        persistence: {
            save: saveGame,
            load: loadGame,
            buildSnapshot,
            validateSnapshot
        },

        diagnostics: {
            getState: () => ({
                started,
                disposed,

                elapsedSimulation,
                elapsedGameTime,

                npcCount: npcs.size,
                policeUnitCount: policeUnits.size,

                activeIncidentCount: activeIncidents.size,
                crimeRecordCount: crimeRecords.size,
                evidenceCount: evidenceRecords.size,

                roadNodeCount: roadNodes.size,
                roadEdgeCount: roadEdges.size,

                audioSourceCount: audioSources.size,
                marketInstrumentCount: marketInstruments.size,

                wantedLevel: wantedState.level,
                wantedHeat: wantedState.heat,

                saveInProgress
            })
        }
    };
}

export default createAIPoliceEconomySystem;
