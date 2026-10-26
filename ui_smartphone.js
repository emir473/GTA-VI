/*
 * Module: ui_smartphone.js
 * Responsibility: interactive in-game phone, application navigation,
 * service-backed actions, status reporting and mobile-friendly layout.
 * Dependencies: the shared runtime, state store, event bus and services.
 */

const PHONE_CSS = `
  #leonida-phone-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    justify-content: flex-end;
    align-items: flex-end;
    padding: 20px max(20px, env(safe-area-inset-right, 0px))
             max(20px, env(safe-area-inset-bottom, 0px));
    pointer-events: auto;
    background: rgba(0, 0, 0, .38);
    backdrop-filter: blur(3px);
    -webkit-backdrop-filter: blur(3px);
  }

  #leonida-phone-overlay[hidden] {
    display: none !important;
  }

  .leonida-phone-shell {
    width: min(365px, calc(100vw - 28px));
    height: min(700px, calc(100dvh - 35px));
    min-height: 410px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid rgba(255,255,255,.2);
    border-radius: 28px;
    background: #111820;
    color: #f4f7fa;
    box-shadow: 0 24px 90px rgba(0,0,0,.65);
    pointer-events: auto;
    font-family: Inter, system-ui, -apple-system, sans-serif;
  }

  .leonida-phone-hardware {
    flex: 0 0 auto;
    display: flex;
    justify-content: center;
    align-items: center;
    height: 14px;
    background: #111820;
  }

  .leonida-phone-speaker {
    width: 62px;
    height: 4px;
    border-radius: 6px;
    background: #39434d;
  }

  .leonida-phone-status {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    min-height: 35px;
    padding: 8px 16px;
    background: #111820;
    color: #cbd6df;
    font-size: 10px;
    font-weight: 800;
    font-variant-numeric: tabular-nums;
  }

  .leonida-phone-battery {
    color: #88e4cc;
    letter-spacing: .05em;
  }

  .leonida-phone-content {
    flex: 1 1 auto;
    min-height: 0;
    overflow-x: hidden;
    overflow-y: auto;
    background:
      radial-gradient(ellipse at 12% 0%, rgba(79,151,168,.14), transparent 43%),
      linear-gradient(180deg, #1b2732, #121820 75%);
    overscroll-behavior: contain;
  }

  .leonida-phone-content::-webkit-scrollbar {
    width: 4px;
  }

  .leonida-phone-content::-webkit-scrollbar-thumb {
    background: #3a4a57;
    border-radius: 5px;
  }

  .leonida-phone-home {
    padding: 20px 16px 24px;
  }

  .leonida-phone-home-heading {
    margin: 4px 0 5px;
    font-size: 24px;
    font-weight: 850;
    letter-spacing: -.05em;
  }

  .leonida-phone-muted {
    color: #9cabb8;
    font-size: 11px;
    line-height: 1.7;
  }

  .leonida-phone-app-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 17px 9px;
    margin-top: 25px;
  }

  .leonida-phone-app {
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 0 1px;
    border: 0;
    color: #eaf0f5;
    background: transparent;
    font-size: 10px;
    font-weight: 750;
    line-height: 1.35;
    text-align: center;
    overflow-wrap: anywhere;
  }

  .leonida-phone-app-icon {
    width: 60px;
    height: 60px;
    display: grid;
    place-items: center;
    border: 1px solid rgba(255,255,255,.13);
    border-radius: 17px;
    background: linear-gradient(145deg, #394b59, #1d2934);
    box-shadow: 0 6px 15px rgba(0,0,0,.19);
    font-size: 26px;
    transition: transform .12s ease, filter .12s ease;
  }

  .leonida-phone-app:active .leonida-phone-app-icon {
    transform: scale(.95);
    filter: brightness(1.15);
  }

  .leonida-phone-app-label {
    min-height: 27px;
  }

  .leonida-phone-app.is-unavailable .leonida-phone-app-icon {
    opacity: .62;
  }

  .leonida-phone-home-footer {
    margin-top: 25px;
    padding-top: 12px;
    border-top: 1px solid rgba(255,255,255,.1);
    color: #7f909d;
    font-size: 10px;
    line-height: 1.65;
  }

  .leonida-phone-page {
    min-height: 100%;
    display: flex;
    flex-direction: column;
  }

  .leonida-phone-toolbar {
    display: flex;
    align-items: center;
    gap: 11px;
    padding: 16px;
    border-bottom: 1px solid rgba(255,255,255,.09);
    background: rgba(7,12,17,.25);
  }

  .leonida-phone-back {
    flex: 0 0 auto;
    width: 38px;
    height: 38px;
    border: 1px solid rgba(255,255,255,.14);
    border-radius: 11px;
    background: rgba(255,255,255,.05);
    font-size: 17px;
  }

  .leonida-phone-page-title {
    margin: 0;
    font-size: 17px;
    font-weight: 850;
    letter-spacing: -.025em;
  }

  .leonida-phone-page-subtitle {
    margin-top: 3px;
    color: #9cabb8;
    font-size: 10px;
    line-height: 1.5;
  }

  .leonida-phone-page-body {
    display: flex;
    flex-direction: column;
    gap: 11px;
    padding: 16px;
  }

  .leonida-phone-section-title {
    margin: 2px 0;
    color: #8fa3b1;
    font-size: 9px;
    font-weight: 850;
    letter-spacing: .17em;
    text-transform: uppercase;
  }

  .leonida-phone-card {
    padding: 13px;
    border: 1px solid rgba(255,255,255,.105);
    border-radius: 13px;
    background: rgba(255,255,255,.045);
    overflow-wrap: anywhere;
  }

  .leonida-phone-card-title {
    margin: 0 0 5px;
    font-size: 12px;
    font-weight: 800;
    line-height: 1.45;
  }

  .leonida-phone-card-description {
    color: #aab7c2;
    font-size: 10px;
    line-height: 1.65;
  }

  .leonida-phone-value {
    margin: 8px 0 4px;
    font-size: 20px;
    font-weight: 850;
    font-variant-numeric: tabular-nums;
    overflow-wrap: anywhere;
  }

  .leonida-phone-actions {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 8px;
  }

  .leonida-phone-action {
    min-height: 43px;
    padding: 10px 12px;
    border: 1px solid rgba(105,227,232,.27);
    border-radius: 10px;
    background: rgba(105,227,232,.12);
    color: #dcffff;
    font-size: 11px;
    font-weight: 800;
    text-align: left;
    overflow-wrap: anywhere;
  }

  .leonida-phone-action.secondary {
    border-color: rgba(255,255,255,.12);
    background: rgba(255,255,255,.045);
    color: #e4ebf0;
  }

  .leonida-phone-action.danger {
    border-color: rgba(255,98,108,.3);
    background: rgba(255,98,108,.09);
    color: #ffc4c8;
  }

  .leonida-phone-action:disabled {
    opacity: .42;
    cursor: not-allowed;
  }

  .leonida-phone-field {
    width: 100%;
    min-height: 42px;
    padding: 10px 11px;
    border: 1px solid rgba(255,255,255,.15);
    border-radius: 9px;
    background: #17212b;
    color: #f4f7fa;
    font-size: 11px;
  }

  .leonida-phone-status-message {
    padding: 11px;
    border-left: 2px solid #668b9e;
    background: rgba(255,255,255,.035);
    color: #adbbc6;
    font-size: 10px;
    line-height: 1.7;
    overflow-wrap: anywhere;
  }

  .leonida-phone-status-message.error {
    border-left-color: #ff737d;
    color: #ffc3c7;
  }

  .leonida-phone-status-message.success {
    border-left-color: #7fdec9;
    color: #c9fff0;
  }

  .leonida-phone-list-row {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 11px;
    padding: 11px 0;
    border-bottom: 1px solid rgba(255,255,255,.075);
  }

  .leonida-phone-list-row:last-child {
    border-bottom: 0;
  }

  .leonida-phone-list-copy {
    flex: 1 1 auto;
    min-width: 0;
  }

  .leonida-phone-list-action {
    flex: 0 0 auto;
    padding: 8px 10px;
    border: 1px solid rgba(255,255,255,.15);
    border-radius: 8px;
    background: rgba(255,255,255,.06);
    color: #e6f9fa;
    font-size: 9px;
    font-weight: 800;
  }

  .leonida-phone-bottom {
    flex: 0 0 auto;
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 18px;
    min-height: 47px;
    border-top: 1px solid rgba(255,255,255,.1);
    background: #10171e;
  }

  .leonida-phone-bottom button {
    min-width: 65px;
    border: 0;
    background: transparent;
    color: #9fb0bc;
    font-size: 10px;
    font-weight: 800;
  }

  .leonida-phone-home-indicator {
    position: absolute;
    left: 50%;
    bottom: 7px;
    width: 90px;
    height: 4px;
    transform: translateX(-50%);
    border-radius: 6px;
    background: rgba(255,255,255,.5);
    pointer-events: none;
  }

  @media (max-width: 560px) {
    #leonida-phone-overlay {
      padding: 0;
      justify-content: center;
      align-items: stretch;
      background: rgba(0,0,0,.66);
    }

    .leonida-phone-shell {
      width: 100%;
      height: 100%;
      height: 100dvh;
      max-height: none;
      border-radius: 0;
      border: 0;
    }

    .leonida-phone-hardware {
      min-height: max(14px, env(safe-area-inset-top, 0px));
    }

    .leonida-phone-home-indicator {
      bottom: max(7px, env(safe-area-inset-bottom, 0px));
    }
  }
`;

const PHONE_TEXT = {
  en: {
    phone: "iFruit OS",
    home: "Home",
    back: "Back",
    unavailable: "Service unavailable",
    unavailableDescription:
      "The related game service has not been registered. No operation was performed.",
    loading: "Reading live game state…",
    empty: "No records are currently available.",
    dashboard: "Dashboard",
    cab: "Ride service",
    vehicles: "Vehicles",
    finance: "Finance",
    properties: "Properties",
    social: "Social feed",
    emergency: "911 Dispatch",
    radio: "Radio",
    map: "Navigation",
    access: "Access puzzle",
    settings: "Settings",
    open: "Open",
    refresh: "Refresh data",
    request: "Request pickup",
    deliver: "Request delivery",
    buy: "Buy one share",
    sell: "Sell one share",
    purchase: "Purchase",
    share: "Publish recorded event",
    police: "Police",
    ambulance: "Ambulance",
    fire: "Fire service",
    call: "Place call",
    destination: "Destination ID",
    setDestination: "Set destination",
    locale: "Language",
    quality: "Graphics quality",
    station: "Station",
    playRadio: "Toggle radio playback",
    status: "Connection status",
    noDestination: "Navigation service not registered.",
    settingsDescription:
      "Settings affect the registered game runtime, not an isolated mock interface.",
    accessDescription:
      "Any access puzzle requires a connected in-game target service before its outcome can change world state.",
    chooseDestination: "Choose destination on full map",
    mechanic: "Mechanic",
    tuning: "Tuning",
    requestRepair: "Request roadside repair",
    repairDescription: "Request in-game assistance for your currently occupied vehicle.",
    vehicleRequired: "Enter a vehicle before requesting a repair.",
    mechanicUnavailable: "Mechanic service is not registered.",
    noTuningOptions: "No tuning options are currently available.",
    tuningDescription: "These upgrades are a phone-based catalogue. World garages and workshops remain separate physical locations.",
    tuningApplied: "Tuning upgrade applied.",
    repairRequested: "Repair request accepted.",
    worldMapUnavailable: "The full-screen world map is not registered yet.",
    worldMapRequestSent: "Map request sent. Select a destination on the full map.",
    taxiDestinationUnavailable: "The taxi service cannot accept a destination right now.",
    homeButton: "HOME",
    backButton: "BACK",
    closeButton: "CLOSE",
    unknown: "Unknown",
    unnamedRecord: "Unnamed record",
    connected: "Connected",
    unavailableStatus: "Unavailable",
    pickupRequest: "Pickup request",
    pickupDescription: "A pickup is accepted only if the transport system confirms an available vehicle and a valid pickup location.",
    currentRideState: "Current ride state",
    vehicleManagement: "Vehicle management",
    financialServices: "Financial services",
    availableBalance: "Available balance",
    marketInstruments: "Market instruments",
    ownedPositions: "Owned positions",
    realEstate: "Real estate",
    leonidaSocial: "Leonida Social",
    emergencyDispatch: "Emergency dispatch",
    dispatchWarning: "This is an in-game dispatch system. It does not place real telephone calls or contact real-world emergency services.",
    availableUnits: "Available units",
    leonidaRadio: "Leonida Radio",
    fictionalAccessSystem: "Fictional access system",
    connectedGameTarget: "Connected game target",
    balanceDescription: "Values are read from the registered game economy.",
    currentNavigation: "Current navigation",
    destinations: "Destinations",
    noRoute: "No route snapshot.",
    languageChanged: "Language changed to",
    graphicsQualityChanged: "Graphics quality:",
    pickupAccepted: "Pickup request accepted.",
    vehicleDeliveryConfirmed: "Vehicle delivery confirmed.",
    stockPurchaseCompleted: "Stock purchase completed.",
    stockSaleCompleted: "Stock sale completed.",
    propertyPurchaseCompleted: "Property purchase completed.",
    dispatchRequestAccepted: "Dispatch request accepted.",
    radioStateUpdated: "Radio state updated.",
    stationChanged: "Station changed.",
    clipPublished: "Clip published.",
    accessChallengeStarted: "Access challenge started.",
    operationCompleted: "Operation completed.",
    homeFooter: "Local game interface • No real calls or external transactions"
  },

  de: {
    phone: "iFruit OS",
    home: "Start",
    back: "Zurück",
    unavailable: "Dienst nicht verfügbar",
    unavailableDescription:
      "Der zugehörige Spieldienst wurde nicht registriert. Es wurde nichts ausgeführt.",
    loading: "Lese aktuellen Spielzustand…",
    empty: "Momentan sind keine Datensätze verfügbar.",
    dashboard: "Übersicht",
    cab: "Fahrdienst",
    vehicles: "Fahrzeuge",
    finance: "Finanzen",
    properties: "Immobilien",
    social: "Social Feed",
    emergency: "Notruf 911",
    radio: "Radio",
    map: "Navigation",
    access: "Zugangsrätsel",
    settings: "Einstellungen",
    open: "Öffnen",
    refresh: "Daten aktualisieren",
    request: "Taxi anfordern",
    deliver: "Lieferung anfordern",
    buy: "Eine Aktie kaufen",
    sell: "Eine Aktie verkaufen",
    purchase: "Kaufen",
    share: "Aufnahme veröffentlichen",
    police: "Polizei",
    ambulance: "Krankenwagen",
    fire: "Feuerwehr",
    call: "Anruf auslösen",
    destination: "Ziel-ID",
    setDestination: "Ziel setzen",
    locale: "Sprache",
    quality: "Grafikqualität",
    station: "Sender",
    playRadio: "Radiowiedergabe umschalten",
    status: "Verbindungsstatus",
    noDestination: "Navigationsdienst nicht registriert.",
    settingsDescription:
      "Einstellungen wirken auf die registrierte Spielumgebung.",
    accessDescription:
      "Ein Rätsel darf die Spielwelt erst ändern, wenn ein passender In-Game-Dienst registriert ist.",
    chooseDestination: "Ziel auf der Vollbildkarte auswählen",
    mechanic: "Mechaniker",
    tuning: "Tuning",
    requestRepair: "Pannenhilfe anfordern",
    repairDescription: "Fordere spielinterne Hilfe für das aktuell genutzte Fahrzeug an.",
    vehicleRequired: "Steige zuerst in ein Fahrzeug, bevor du eine Reparatur anforderst.",
    mechanicUnavailable: "Der Mechanikerdienst ist nicht registriert.",
    noTuningOptions: "Momentan sind keine Tuningoptionen verfügbar.",
    tuningDescription: "Diese Upgrades sind ein zusätzlicher Handy-Katalog. Garagen und Werkstätten bleiben eigenständige Orte in der Spielwelt.",
    tuningApplied: "Tuning-Upgrade angewendet.",
    repairRequested: "Reparaturanfrage angenommen.",
    worldMapUnavailable: "Die zentrale Vollbildkarte ist noch nicht registriert.",
    worldMapRequestSent: "Kartenanfrage gesendet. Wähle das Ziel auf der Vollbildkarte.",
    taxiDestinationUnavailable: "Der Taxidienst kann momentan kein Ziel übernehmen.",
    homeButton: "START",
    backButton: "ZURÜCK",
    closeButton: "SCHLIESSEN",
    unknown: "Unbekannt",
    unnamedRecord: "Unbenannter Eintrag",
    connected: "Verbunden",
    unavailableStatus: "Nicht verfügbar",
    pickupRequest: "Abholanfrage",
    pickupDescription: "Eine Abholung wird erst angenommen, wenn ein verfügbares Fahrzeug und ein gültiger Abholort bestätigt wurden.",
    currentRideState: "Aktueller Fahrtstatus",
    vehicleManagement: "Fahrzeugverwaltung",
    financialServices: "Finanzdienste",
    availableBalance: "Verfügbares Guthaben",
    marketInstruments: "Börsenwerte",
    ownedPositions: "Eigene Positionen",
    realEstate: "Immobilien",
    leonidaSocial: "Leonida Social",
    emergencyDispatch: "Notrufzentrale",
    dispatchWarning: "Dies ist ein spielinternes Dispatch-System. Es tätigt keine echten Anrufe und kontaktiert keine realen Rettungsdienste.",
    availableUnits: "Verfügbare Einheiten",
    leonidaRadio: "Leonida Radio",
    fictionalAccessSystem: "Fiktives Zugangssystem",
    connectedGameTarget: "Verbundenes Spielziel",
    balanceDescription: "Die Werte stammen aus dem registrierten Wirtschaftssystem.",
    currentNavigation: "Aktuelle Navigation",
    destinations: "Ziele",
    noRoute: "Keine Routendaten vorhanden.",
    languageChanged: "Sprache geändert zu",
    graphicsQualityChanged: "Grafikqualität:",
    pickupAccepted: "Taxi-Abholung bestätigt.",
    vehicleDeliveryConfirmed: "Fahrzeuglieferung bestätigt.",
    stockPurchaseCompleted: "Aktienkauf abgeschlossen.",
    stockSaleCompleted: "Aktienverkauf abgeschlossen.",
    propertyPurchaseCompleted: "Immobilienkauf abgeschlossen.",
    dispatchRequestAccepted: "Notrufanfrage angenommen.",
    radioStateUpdated: "Radiostatus aktualisiert.",
    stationChanged: "Sender gewechselt.",
    clipPublished: "Clip veröffentlicht.",
    accessChallengeStarted: "Zugangsaufgabe gestartet.",
    operationCompleted: "Vorgang abgeschlossen.",
    homeFooter: "Lokale Spieloberfläche • Keine echten Anrufe oder Transaktionen"
  },

  es: {
    phone: "iFruit OS",
    home: "Inicio",
    back: "Volver",
    unavailable: "Servicio no disponible",
    unavailableDescription: "El servicio de juego no está registrado.",
    loading: "Leyendo el estado del juego…",
    empty: "No hay registros disponibles.",
    dashboard: "Resumen",
    cab: "Taxi",
    vehicles: "Vehículos",
    finance: "Finanzas",
    properties: "Propiedades",
    social: "Red social",
    emergency: "Emergencias 911",
    radio: "Radio",
    map: "Navegación",
    access: "Acceso",
    settings: "Configuración",
    open: "Abrir",
    refresh: "Actualizar",
    request: "Solicitar taxi",
    deliver: "Solicitar entrega",
    buy: "Comprar una acción",
    sell: "Vender una acción",
    purchase: "Comprar",
    share: "Publicar evento",
    police: "Policía",
    ambulance: "Ambulancia",
    fire: "Bomberos",
    call: "Solicitar ayuda",
    destination: "ID de destino",
    setDestination: "Establecer destino",
    locale: "Idioma",
    quality: "Calidad gráfica",
    station: "Emisora",
    playRadio: "Cambiar reproducción",
    status: "Estado",
    noDestination: "Servicio de navegación no registrado.",
    settingsDescription: "Configuración del entorno de juego.",
    accessDescription: "El acceso requiere un servicio de juego registrado.",
    chooseDestination: "Elegir destino en el mapa completo",
    mechanic: "Mecánico",
    tuning: "Tuning",
    requestRepair: "Solicitar reparación en carretera",
    repairDescription: "Solicita asistencia dentro del juego para el vehículo que estás usando.",
    vehicleRequired: "Entra en un vehículo antes de solicitar una reparación.",
    mechanicUnavailable: "El servicio mecánico no está registrado.",
    noTuningOptions: "No hay opciones de tuning disponibles ahora.",
    tuningDescription: "Este catálogo del teléfono es complementario. Los garajes y talleres siguen siendo lugares físicos del mundo.",
    tuningApplied: "Mejora de tuning aplicada.",
    repairRequested: "Solicitud de reparación aceptada.",
    worldMapUnavailable: "El mapa de pantalla completa aún no está registrado.",
    worldMapRequestSent: "Solicitud enviada. Elige un destino en el mapa completo.",
    taxiDestinationUnavailable: "El servicio de taxi no puede aceptar un destino ahora.",
    homeButton: "INICIO",
    backButton: "ATRÁS",
    closeButton: "CERRAR",
    unknown: "Desconocido",
    unnamedRecord: "Registro sin nombre",
    connected: "Conectado",
    unavailableStatus: "No disponible",
    pickupRequest: "Solicitud de recogida",
    pickupDescription: "La recogida solo se acepta si el sistema confirma un vehículo disponible y una ubicación válida.",
    currentRideState: "Estado del viaje",
    vehicleManagement: "Gestión de vehículos",
    financialServices: "Servicios financieros",
    availableBalance: "Saldo disponible",
    marketInstruments: "Instrumentos del mercado",
    ownedPositions: "Posiciones propias",
    realEstate: "Bienes inmuebles",
    leonidaSocial: "Leonida Social",
    emergencyDispatch: "Central de emergencias",
    dispatchWarning: "Este sistema es interno del juego. No realiza llamadas reales ni contacta con servicios de emergencia reales.",
    availableUnits: "Unidades disponibles",
    leonidaRadio: "Radio Leonida",
    fictionalAccessSystem: "Sistema de acceso ficticio",
    connectedGameTarget: "Objetivo conectado del juego",
    balanceDescription: "Los valores se leen de la economía registrada del juego.",
    currentNavigation: "Navegación actual",
    destinations: "Destinos",
    noRoute: "No hay datos de ruta.",
    languageChanged: "Idioma cambiado a",
    graphicsQualityChanged: "Calidad gráfica:",
    pickupAccepted: "Solicitud de recogida aceptada.",
    vehicleDeliveryConfirmed: "Entrega del vehículo confirmada.",
    stockPurchaseCompleted: "Compra de acciones completada.",
    stockSaleCompleted: "Venta de acciones completada.",
    propertyPurchaseCompleted: "Compra de propiedad completada.",
    dispatchRequestAccepted: "Solicitud de emergencia aceptada.",
    radioStateUpdated: "Estado de radio actualizado.",
    stationChanged: "Emisora cambiada.",
    clipPublished: "Clip publicado.",
    accessChallengeStarted: "Desafío de acceso iniciado.",
    operationCompleted: "Operación completada.",
    homeFooter: "Interfaz local del juego"
  },

  fr: {
    phone: "iFruit OS",
    home: "Accueil",
    back: "Retour",
    unavailable: "Service indisponible",
    unavailableDescription: "Le service de jeu n'est pas enregistré.",
    loading: "Lecture de l'état du jeu…",
    empty: "Aucun enregistrement disponible.",
    dashboard: "Tableau de bord",
    cab: "Taxi",
    vehicles: "Véhicules",
    finance: "Finances",
    properties: "Propriétés",
    social: "Fil social",
    emergency: "Urgences 911",
    radio: "Radio",
    map: "Navigation",
    access: "Accès",
    settings: "Paramètres",
    open: "Ouvrir",
    refresh: "Actualiser",
    request: "Demander un taxi",
    deliver: "Demander une livraison",
    buy: "Acheter une action",
    sell: "Vendre une action",
    purchase: "Acheter",
    share: "Publier l'événement",
    police: "Police",
    ambulance: "Ambulance",
    fire: "Pompiers",
    call: "Appeler",
    destination: "ID de destination",
    setDestination: "Définir la destination",
    locale: "Langue",
    quality: "Qualité graphique",
    station: "Station",
    playRadio: "Changer la lecture",
    status: "État de connexion",
    noDestination: "Service de navigation non enregistré.",
    settingsDescription: "Paramètres de l'environnement de jeu.",
    accessDescription: "L'accès nécessite un service de jeu enregistré.",
    chooseDestination: "Choisir une destination sur la carte plein écran",
    mechanic: "Mécanicien",
    tuning: "Tuning",
    requestRepair: "Demander une réparation sur place",
    repairDescription: "Demandez une assistance en jeu pour le véhicule que vous utilisez.",
    vehicleRequired: "Montez dans un véhicule avant de demander une réparation.",
    mechanicUnavailable: "Le service de mécanique n’est pas enregistré.",
    noTuningOptions: "Aucune option de tuning n’est actuellement disponible.",
    tuningDescription: "Ce catalogue téléphonique est complémentaire. Les garages et ateliers restent des lieux physiques du monde.",
    tuningApplied: "Amélioration de tuning appliquée.",
    repairRequested: "Demande de réparation acceptée.",
    worldMapUnavailable: "La carte plein écran n'est pas encore enregistrée.",
    worldMapRequestSent: "Demande envoyée. Choisissez une destination sur la carte plein écran.",
    taxiDestinationUnavailable: "Le service de taxi ne peut pas accepter de destination maintenant.",
    homeButton: "ACCUEIL",
    backButton: "RETOUR",
    closeButton: "FERMER",
    unknown: "Inconnu",
    unnamedRecord: "Entrée sans nom",
    connected: "Connecté",
    unavailableStatus: "Indisponible",
    pickupRequest: "Demande de prise en charge",
    pickupDescription: "La prise en charge est acceptée uniquement si un véhicule disponible et un point valide sont confirmés.",
    currentRideState: "État du trajet",
    vehicleManagement: "Gestion des véhicules",
    financialServices: "Services financiers",
    availableBalance: "Solde disponible",
    marketInstruments: "Instruments du marché",
    ownedPositions: "Positions détenues",
    realEstate: "Immobilier",
    leonidaSocial: "Leonida Social",
    emergencyDispatch: "Centre d'urgence",
    dispatchWarning: "Ce système est interne au jeu. Il ne passe aucun appel réel et ne contacte aucun service d'urgence réel.",
    availableUnits: "Unités disponibles",
    leonidaRadio: "Radio Leonida",
    fictionalAccessSystem: "Système d'accès fictif",
    connectedGameTarget: "Cible de jeu connectée",
    balanceDescription: "Les valeurs proviennent du système économique enregistré du jeu.",
    currentNavigation: "Navigation actuelle",
    destinations: "Destinations",
    noRoute: "Aucune donnée d'itinéraire.",
    languageChanged: "Langue modifiée :",
    graphicsQualityChanged: "Qualité graphique :",
    pickupAccepted: "Demande de prise en charge acceptée.",
    vehicleDeliveryConfirmed: "Livraison du véhicule confirmée.",
    stockPurchaseCompleted: "Achat d'actions terminé.",
    stockSaleCompleted: "Vente d'actions terminée.",
    propertyPurchaseCompleted: "Achat immobilier terminé.",
    dispatchRequestAccepted: "Demande d'intervention acceptée.",
    radioStateUpdated: "État de la radio actualisé.",
    stationChanged: "Station changée.",
    clipPublished: "Clip publié.",
    accessChallengeStarted: "Défi d'accès lancé.",
    operationCompleted: "Opération terminée.",
    homeFooter: "Interface de jeu locale"
  }
};

const APP_DEFINITIONS = [
  { id: "cab", icon: "🚕", key: "cab", service: "taxi" },
  { id: "vehicles", icon: "🚘", key: "vehicles", service: "vehicles" },
  { id: "mechanic", icon: "🛠️", key: "mechanic", service: "mechanic" },
  { id: "tuning", icon: "🔧", key: "tuning", service: "tuning" },
  { id: "finance", icon: "▤", key: "finance", service: "economy" },
  { id: "properties", icon: "⌂", key: "properties", service: "properties" },
  { id: "social", icon: "◎", key: "social", service: "social" },
  { id: "emergency", icon: "✚", key: "emergency", service: "dispatch" },
  { id: "radio", icon: "♫", key: "radio", service: "radio" },
  { id: "access", icon: "▦", key: "access", service: "hacking" },
  { id: "settings", icon: "⚙", key: "settings", service: "graphics" }
];

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

function formatMoney(cents, locale) {
  const number = Number.isFinite(cents) ? cents / 100 : 0;

  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD"
  }).format(number);
}

export function createSmartphoneSystem({ runtime, mount }) {
  if (!runtime || !mount) {
    throw new TypeError(
      "createSmartphoneSystem requires runtime and mount."
    );
  }

  const documentRef = mount.ownerDocument;
  const pageData = new Map();

  let isOpen = false;
  let currentApp = "home";
  let operationPending = false;
  let feedback = null;
  let destroyed = false;
  let previousFocus = null;
  const eventDisposers = [];

  const style = documentRef.createElement("style");
  style.textContent = PHONE_CSS;
  documentRef.head.appendChild(style);

  const overlay = documentRef.createElement("section");
  overlay.id = "leonida-phone-overlay";
  overlay.hidden = true;
  overlay.setAttribute("aria-label", "In-game smartphone");

  overlay.innerHTML = `
    <div class="leonida-phone-shell">
      <div class="leonida-phone-hardware">
        <div class="leonida-phone-speaker"></div>
      </div>

      <header class="leonida-phone-status">
        <span data-role="clock">--:--</span>
        <span data-role="status">${"iFruit OS"}</span>
        <span class="leonida-phone-battery">SIM ●</span>
      </header>

      <main class="leonida-phone-content" data-role="content"></main>

      <footer class="leonida-phone-bottom">
        <button type="button" data-action="home">${escapeHTML(t("homeButton"))}</button>
        <button type="button" data-action="back">${escapeHTML(t("backButton"))}</button>
        <button type="button" data-action="close">${escapeHTML(t("closeButton"))}</button>
      </footer>

      <div class="leonida-phone-home-indicator"></div>
    </div>
  `;

  mount.appendChild(overlay);

  const content = overlay.querySelector('[data-role="content"]');

  function t(key) {
    const locale = runtime.state.get("locale") || "en";
    return PHONE_TEXT[locale]?.[key] ?? PHONE_TEXT.en[key] ?? key;
  }

  function getService(name) {
    return runtime.services.get(name);
  }

  function isServiceAvailable(serviceName, methodName) {
    const service = getService(serviceName);

    return Boolean(
      service &&
      (!methodName || typeof service[methodName] === "function")
    );
  }

  function showFeedback(message, kind = "info") {
    feedback = { message: String(message), kind };

    runtime.notify(
      feedback.message,
      kind === "error" ? "error" :
      kind === "success" ? "success" : "info"
    );

    render();
  }

  function setOpen(value) {
    const nextValue = Boolean(value);

    if (nextValue === isOpen || destroyed) return;

    if (nextValue) {
      previousFocus = documentRef.activeElement instanceof HTMLElement
        ? documentRef.activeElement
        : null;
    }

    isOpen = nextValue;
    overlay.hidden = !isOpen;

    runtime.state.patch({ isPhoneOpen: isOpen }, "phone-toggle");

    runtime.events.emit(
      isOpen ? "phone:opened" : "phone:closed",
      { app: currentApp }
    );

    if (isOpen) {
      render();
      overlay.querySelector('[data-action="close"]')?.focus();
    } else if (previousFocus?.isConnected) {
      previousFocus.focus({ preventScroll: true });
      previousFocus = null;
    }
  }

  function open() {
    setOpen(true);
  }

  function close() {
    setOpen(false);
  }

  function toggle() {
    setOpen(!isOpen);
  }

  function openApp(appId) {
    currentApp = APP_DEFINITIONS.some(app => app.id === appId)
      ? appId
      : "home";

    feedback = null;
    pageData.delete(currentApp);
    open();

    if (currentApp !== "home") {
      void refreshAppData(currentApp);
    }
  }

  function renderFeedback() {
    if (!feedback) return "";

    const className =
      feedback.kind === "error" ? "error" :
      feedback.kind === "success" ? "success" : "";

    return `
      <div class="leonida-phone-status-message ${className}"
           role="status">
        ${escapeHTML(feedback.message)}
      </div>
    `;
  }

  function renderHome() {
    const state = runtime.state.get();
    const apps = APP_DEFINITIONS.map(app => {
      const label = t(app.key);
      const available = isServiceAvailable(app.service);

      return `
        <button type="button"
                class="leonida-phone-app ${available ? "" : "is-unavailable"}"
                data-action="open-app" data-app="${escapeHTML(app.id)}"
                aria-label="${escapeHTML(label)}">
          <span class="leonida-phone-app-icon">${app.icon}</span>
          <span class="leonida-phone-app-label">${escapeHTML(label)}</span>
        </button>
      `;
    }).join("");

    const minutes = Math.max(
      0,
      Math.floor(Number(state.timeOfDayMinutes) || 0) % 1440
    );

    const clock =
      `${String(Math.floor(minutes / 60)).padStart(2, "0")}:` +
      `${String(minutes % 60).padStart(2, "0")}`;

    return `
      <div class="leonida-phone-home">
        <div class="leonida-phone-muted">LEONIDA • PERSONAL DEVICE</div>
        <h1 class="leonida-phone-home-heading">iFruit OS</h1>
        <div class="leonida-phone-muted">
          ${escapeHTML(clock)} · ${escapeHTML(state.weatherId || t("unknown"))}
        </div>

        ${renderFeedback()}

        <div class="leonida-phone-app-grid">${apps}</div>

        <div class="leonida-phone-home-footer">
          ${escapeHTML(t("homeFooter"))}
        </div>
      </div>
    `;
  }

  function renderListRows(items, { action, buttonLabel } = {}) {
    if (!Array.isArray(items) || items.length === 0) {
      return `
        <div class="leonida-phone-muted">
          ${escapeHTML(t("empty"))}
        </div>
      `;
    }

    return items.map(item => {
      const rawId = item.id ?? item.symbol ?? item.vehicleId ??
        item.propertyId ?? item.stationId ?? item.destinationId ?? item.upgradeId ??
        item.targetId ?? "";
      const id = escapeHTML(rawId);
      const title = escapeHTML(
        item.name ?? item.title ?? item.symbol ?? item.id ?? t("unnamedRecord")
      );
      const description = escapeHTML(
        item.description ?? item.status ?? ""
      );

      const amount =
        Number.isFinite(item.priceCents)
          ? formatMoney(item.priceCents, runtime.state.get("locale"))
          : Number.isFinite(item.valueCents)
            ? formatMoney(item.valueCents, runtime.state.get("locale"))
            : "";

      const actionButton = action && id
        ? `<button class="leonida-phone-list-action"
                   data-action="${escapeHTML(action)}"
                   data-id="${id}"
                   ${operationPending ? "disabled" : ""}>
             ${escapeHTML(buttonLabel ?? t("open"))}
           </button>`
        : "";

      return `
        <div class="leonida-phone-list-row">
          <div class="leonida-phone-list-copy">
            <div class="leonida-phone-card-title">${title}</div>
            <div class="leonida-phone-card-description">${description}</div>
            ${amount
              ? `<div class="leonida-phone-value">${escapeHTML(amount)}</div>`
              : ""}
          </div>
          ${actionButton}
        </div>
      `;
    }).join("");
  }

  function unavailableMessage() {
    return `
      <section class="leonida-phone-card">
        <div class="leonida-phone-card-title">${escapeHTML(t("unavailable"))}</div>
        <div class="leonida-phone-card-description">
          ${escapeHTML(t("unavailableDescription"))}
        </div>
      </section>
    `;
  }

  function actionButton(action, label, serviceName, methodName, data = "") {
    const enabled = isServiceAvailable(serviceName, methodName);

    return `
      <button type="button"
              class="leonida-phone-action"
              data-action="${escapeHTML(action)}"
              ${data ? `data-id="${escapeHTML(data)}"` : ""}
              ${enabled && !operationPending ? "" : "disabled"}>
        ${escapeHTML(label)}
      </button>
    `;
  }

  function renderDataApp(appId) {
    const data = pageData.get(appId) ?? null;

    switch (appId) {
      case "cab": {
        const taxi = getService("taxi");

        return `
          <div class="leonida-phone-page-body">
            <h3 class="leonida-phone-section-title">DOWNTOWN CAB CO.</h3>
            <section class="leonida-phone-card">
              <div class="leonida-phone-card-title">${escapeHTML(t("pickupRequest"))}</div>
              <div class="leonida-phone-card-description">
                ${escapeHTML(t("pickupDescription"))}
              </div>
            </section>
            ${renderFeedback()}
            ${taxi
              ? actionButton("taxi-request", t("request"), "taxi", "requestPickup")
              : unavailableMessage()}
            ${taxi
              ? actionButton("refresh", t("refresh"), "taxi", "getStatus")
              : ""}
            <button type="button"
                    class="leonida-phone-action secondary"
                    data-action="taxi-destination"
                    ${runtime.events.listenerCount("worldMap:openRequested") > 0 && !operationPending ? "" : "disabled"}>
              ${escapeHTML(t("chooseDestination"))}
            </button>
            ${runtime.events.listenerCount("worldMap:openRequested") > 0
              ? ""
              : `<div class="leonida-phone-status-message">${escapeHTML(t("worldMapUnavailable"))}</div>`}
            ${data
              ? `<section class="leonida-phone-card">
                   <div class="leonida-phone-card-title">${escapeHTML(t("currentRideState"))}</div>
                   <div class="leonida-phone-card-description">${
                     escapeHTML(data.status ?? data.message ?? t("empty"))
                   }</div>
                 </section>`
              : ""}
          </div>
        `;
      }

      case "mechanic": {
        const service = getService("mechanic");
        const currentVehicleId = runtime.state.get("vehicleId");
        const status = typeof data === "string" ? data : data?.status ?? data?.message;

        return `
          <div class="leonida-phone-page-body">
            <h3 class="leonida-phone-section-title">${escapeHTML(t("mechanic"))}</h3>
            <section class="leonida-phone-card">
              <div class="leonida-phone-card-description">${escapeHTML(t("repairDescription"))}</div>
              <div class="leonida-phone-card-description">
                ${currentVehicleId ? `Vehicle: ${escapeHTML(currentVehicleId)}` : escapeHTML(t("vehicleRequired"))}
              </div>
              ${status ? `<div class="leonida-phone-status-message">${escapeHTML(status)}</div>` : ""}
            </section>
            ${renderFeedback()}
            ${service
              ? actionButton("refresh-mechanic", t("refresh"), "mechanic", "getStatus")
              : unavailableMessage()}
            <button type="button"
                    class="leonida-phone-action"
                    data-action="mechanic-request"
                    ${service && currentVehicleId && typeof service.requestRepair === "function" && !operationPending ? "" : "disabled"}>
              ${escapeHTML(t("requestRepair"))}
            </button>
            ${!service ? `<div class="leonida-phone-status-message">${escapeHTML(t("mechanicUnavailable"))}</div>` : ""}
          </div>
        `;
      }

      case "tuning": {
        const service = getService("tuning");
        const options = Array.isArray(data) ? data : data?.options;
        const currentVehicleId = runtime.state.get("vehicleId");

        return `
          <div class="leonida-phone-page-body">
            <h3 class="leonida-phone-section-title">${escapeHTML(t("tuning"))}</h3>
            <div class="leonida-phone-card-description">${escapeHTML(t("tuningDescription"))}</div>
            ${renderFeedback()}
            ${service
              ? actionButton("refresh-tuning", t("refresh"), "tuning", "getOptions")
              : unavailableMessage()}
            ${Array.isArray(options) && options.length && currentVehicleId
              ? `<section class="leonida-phone-card">
                   ${renderListRows(options, { action: "tuning-apply", buttonLabel: t("purchase") })}
                 </section>`
              : `<section class="leonida-phone-card"><div class="leonida-phone-card-description">${escapeHTML(currentVehicleId ? t("noTuningOptions") : t("vehicleRequired"))}</div></section>`}
          </div>
        `;
      }

      case "vehicles": {
        const service = getService("vehicles");
        const vehicles = Array.isArray(data) ? data : data?.vehicles;

        return `
          <div class="leonida-phone-page-body">
            <h3 class="leonida-phone-section-title">${escapeHTML(t("vehicleManagement"))}</h3>
            ${renderFeedback()}
            ${service
              ? actionButton(
                  "refresh-vehicles",
                  t("refresh"),
                  "vehicles",
                  "getOwnedVehicles"
                )
              : unavailableMessage()}
            ${vehicles
              ? `<section class="leonida-phone-card">
                   ${renderListRows(vehicles, {
                     action: "vehicle-deliver",
                     buttonLabel: t("deliver")
                   })}
                 </section>`
              : `<section class="leonida-phone-card">
                   <div class="leonida-phone-card-description">
                     ${escapeHTML(t("empty"))}
                   </div>
                 </section>`}
          </div>
        `;
      }

      case "finance": {
        const service = getService("economy");
        const summary = data?.summary ?? data;
        const stocks = data?.market ?? [];

        return `
          <div class="leonida-phone-page-body">
            <h3 class="leonida-phone-section-title">${escapeHTML(t("financialServices"))}</h3>
            ${service
              ? `<section class="leonida-phone-card">
                   <div class="leonida-phone-card-title">${escapeHTML(t("availableBalance"))}</div>
                   <div class="leonida-phone-value">
                     ${Number.isFinite(summary?.balanceCents)
                       ? escapeHTML(formatMoney(
                           summary.balanceCents,
                           runtime.state.get("locale")
                         ))
                       : "—"}
                   </div>
                   <div class="leonida-phone-card-description">
                     ${escapeHTML(t("balanceDescription"))}
                   </div>
                 </section>`
              : unavailableMessage()}
            ${renderFeedback()}
            ${service
              ? actionButton(
                  "refresh-finance", t("refresh"), "economy", "getSummary"
                )
              : ""}
            ${Array.isArray(stocks) && stocks.length
              ? `<section class="leonida-phone-card">
                   <div class="leonida-phone-card-title">${escapeHTML(t("marketInstruments"))}</div>
                   ${renderListRows(stocks, {
                     action: "stock-buy",
                     buttonLabel: t("buy")
                   })}
                 </section>`
              : ""}
            ${Array.isArray(summary?.positions) && summary.positions.length
              ? `<section class="leonida-phone-card">
                   <div class="leonida-phone-card-title">${escapeHTML(t("ownedPositions"))}</div>
                   ${renderListRows(summary.positions, {
                     action: "stock-sell",
                     buttonLabel: t("sell")
                   })}
                 </section>`
              : ""}
          </div>
        `;
      }

      case "properties": {
        const service = getService("properties");
        const listings = Array.isArray(data) ? data : data?.listings;

        return `
          <div class="leonida-phone-page-body">
            <h3 class="leonida-phone-section-title">${escapeHTML(t("realEstate"))}</h3>
            ${renderFeedback()}
            ${service
              ? actionButton(
                  "refresh-properties",
                  t("refresh"),
                  "properties",
                  "getListings"
                )
              : unavailableMessage()}
            ${listings
              ? `<section class="leonida-phone-card">
                   ${renderListRows(listings, {
                     action: "property-buy",
                     buttonLabel: t("purchase")
                   })}
                 </section>`
              : ""}
          </div>
        `;
      }

      case "social": {
        const service = getService("social");
        const posts = Array.isArray(data) ? data : data?.feed;

        return `
          <div class="leonida-phone-page-body">
            <h3 class="leonida-phone-section-title">${escapeHTML(t("leonidaSocial"))}</h3>
            ${renderFeedback()}
            ${service
              ? actionButton(
                  "refresh-social",
                  t("refresh"),
                  "social",
                  "getFeed"
                )
              : unavailableMessage()}
            ${service
              ? actionButton(
                  "publish-event",
                  t("share"),
                  "social",
                  "publishClip"
                )
              : ""}
            ${Array.isArray(posts) && posts.length
              ? `<section class="leonida-phone-card">
                   ${renderListRows(posts)}
                 </section>`
              : `<section class="leonida-phone-card">
                   <div class="leonida-phone-card-description">
                     ${escapeHTML(t("empty"))}
                   </div>
                 </section>`}
          </div>
        `;
      }

      case "emergency": {
        const service = getService("dispatch");
        const units = Array.isArray(data) ? data : data?.units;

        return `
          <div class="leonida-phone-page-body">
            <h3 class="leonida-phone-section-title">${escapeHTML(t("emergencyDispatch"))}</h3>
            <div class="leonida-phone-card-description">
              ${escapeHTML(t("dispatchWarning"))}
            </div>
            ${renderFeedback()}
            ${service
              ? actionButton(
                  "dispatch-call", t("police"), "dispatch", "call", "police"
                )
              : unavailableMessage()}
            ${service
              ? actionButton(
                  "dispatch-call", t("ambulance"), "dispatch", "call", "ambulance"
                )
              : ""}
            ${service
              ? actionButton(
                  "dispatch-call", t("fire"), "dispatch", "call", "fire"
                )
              : ""}
            ${units
              ? `<section class="leonida-phone-card">
                   <div class="leonida-phone-card-title">${escapeHTML(t("availableUnits"))}</div>
                   ${renderListRows(units)}
                 </section>`
              : ""}
          </div>
        `;
      }

      case "radio": {
        const service = getService("radio");
        const stations = Array.isArray(data) ? data : data?.stations;

        return `
          <div class="leonida-phone-page-body">
            <h3 class="leonida-phone-section-title">${escapeHTML(t("leonidaRadio"))}</h3>
            ${renderFeedback()}
            ${service
              ? actionButton(
                  "radio-toggle",
                  t("playRadio"),
                  "radio",
                  "togglePlayback"
                )
              : unavailableMessage()}
            ${stations
              ? `<section class="leonida-phone-card">
                   ${renderListRows(stations, {
                     action: "radio-station",
                     buttonLabel: t("open")
                   })}
                 </section>`
              : ""}
          </div>
        `;
      }

      case "access": {
        const service = getService("hacking");

        return `
          <div class="leonida-phone-page-body">
            <h3 class="leonida-phone-section-title">${escapeHTML(t("fictionalAccessSystem"))}</h3>
            <section class="leonida-phone-card">
              <div class="leonida-phone-card-title">${escapeHTML(t("connectedGameTarget"))}</div>
              <div class="leonida-phone-card-description">
                ${escapeHTML(t("accessDescription"))}
              </div>
            </section>
            ${renderFeedback()}
            ${service
              ? actionButton(
                  "hack-start",
                  t("open"),
                  "hacking",
                  "startMiniGame"
                )
              : unavailableMessage()}
          </div>
        `;
      }

      case "settings": {
        return `
          <div class="leonida-phone-page-body">
            <h3 class="leonida-phone-section-title">${escapeHTML(t("settings"))}</h3>
            <div class="leonida-phone-card-description">
              ${escapeHTML(t("settingsDescription"))}
            </div>
            ${renderFeedback()}

            <section class="leonida-phone-card">
              <div class="leonida-phone-card-title">${escapeHTML(t("locale"))}</div>
              ${["en", "de", "es", "fr"].map(locale => `
                <button type="button"
                        class="leonida-phone-action secondary"
                        data-action="set-locale" data-id="${locale}">
                  ${locale.toUpperCase()}${runtime.state.get("locale") === locale ? " ✓" : ""}
                </button>
              `).join("")}
            </section>

            <section class="leonida-phone-card">
              <div class="leonida-phone-card-title">${escapeHTML(t("quality"))}</div>
              ${["low", "medium", "high", "ultra"].map(profile => `
                <button type="button"
                        class="leonida-phone-action secondary"
                        data-action="set-quality" data-id="${profile}">
                  ${profile.toUpperCase()}
                </button>
              `).join("")}
            </section>
          </div>
        `;
      }

      default:
        return `
          <div class="leonida-phone-page-body">
            ${unavailableMessage()}
          </div>
        `;
    }
  }

  function render() {
    if (destroyed || !isOpen) return;

    const clock = overlay.querySelector('[data-role="clock"]');
    const title = overlay.querySelector('[data-role="status"]');

    const minutes = Math.max(
      0,
      Math.floor(Number(runtime.state.get("timeOfDayMinutes")) || 0) % 1440
    );

    clock.textContent =
      `${String(Math.floor(minutes / 60)).padStart(2, "0")}:` +
      `${String(minutes % 60).padStart(2, "0")}`;

    title.textContent = t("phone");

    if (currentApp === "home") {
      content.innerHTML = renderHome();
      return;
    }

    const app = APP_DEFINITIONS.find(item => item.id === currentApp);

    if (!app) {
      currentApp = "home";
      content.innerHTML = renderHome();
      return;
    }

    content.innerHTML = `
      <section class="leonida-phone-page">
        <header class="leonida-phone-toolbar">
          <button type="button" class="leonida-phone-back"
                  data-action="back" aria-label="${escapeHTML(t("back"))}">
            ‹
          </button>
          <div>
            <h2 class="leonida-phone-page-title">${escapeHTML(t(app.key))}</h2>
            <div class="leonida-phone-page-subtitle">
              ${escapeHTML(t("status"))}: ${
                isServiceAvailable(app.service) ? t("connected") : t("unavailableStatus")
              }
            </div>
          </div>
        </header>

        ${renderDataApp(currentApp)}
      </section>
    `;
  }

  async function refreshAppData(appId = currentApp) {
    const loaders = {
      cab: async service => service.getStatus?.(),
      vehicles: async service => service.getOwnedVehicles?.(),
      mechanic: async service => service.getStatus?.(),
      tuning: async service => service.getOptions?.(),
      finance: async service => {
        const [summary, market] = await Promise.all([
          service.getSummary?.(),
          service.getMarketListings?.()
        ]);

        return { summary, market };
      },
      properties: async service => service.getListings?.(),
      social: async service => service.getFeed?.(),
      emergency: async service => service.getAvailableUnits?.(),
      radio: async service => service.getStations?.(),
      access: async service => service.getTargets?.()
    };

    const app = APP_DEFINITIONS.find(item => item.id === appId);
    if (!app || !isServiceAvailable(app.service)) {
      pageData.delete(appId);
      render();
      return { ok: false, error: "service-unavailable" };
    }

    try {
      const service = getService(app.service);
      const loader = loaders[appId];

      if (typeof loader !== "function") {
        render();
        return { ok: true };
      }

      const result = await loader(service);
      pageData.set(appId, result ?? null);

      if (appId === currentApp) render();
      return { ok: true, data: result };
    } catch (error) {
      runtime.logger.error(`Phone refresh failed for ${appId}.`, error);

      if (appId === currentApp) {
        feedback = {
          message: error.message,
          kind: "error"
        };
        render();
      }

      return { ok: false, error };
    }
  }

  async function executeService(
    serviceName,
    methodName,
    args = [],
    successMessage = "Operation completed."
  ) {
    const service = getService(serviceName);
    const method = service?.[methodName];

    if (typeof method !== "function") {
      showFeedback(t("unavailableDescription"), "error");
      return { ok: false, error: "service-unavailable" };
    }

    if (operationPending) {
      return { ok: false, error: "operation-already-pending" };
    }

    operationPending = true;
    const originatingApp = currentApp;
    render();

    try {
      const result = await method.apply(service, args);

      /*
       * Action contract: the service must return {ok:true} to confirm
       * success. A resolved Promise by itself is not enough.
       */
      if (!result || result.ok !== true) {
        const message = result?.message ?? "The service rejected the operation.";
        showFeedback(message, "error");
        return { ok: false, result };
      }

      showFeedback(result.message ?? successMessage, "success");
      await refreshAppData(originatingApp);
      return { ok: true, result };
    } catch (error) {
      runtime.logger.error(
        `Smartphone operation failed: ${serviceName}.${methodName}`,
        error
      );

      showFeedback(error?.message ?? String(error), "error");
      return { ok: false, error };
    } finally {
      operationPending = false;
      render();
    }
  }

  async function handleAction(action, id) {
    switch (action) {
      case "home":
        currentApp = "home";
        feedback = null;
        render();
        return;

      case "back":
        currentApp = "home";
        feedback = null;
        render();
        return;

      case "close":
        close();
        return;

      case "open-app":
        openApp(id);
        return;

      case "refresh":
        await refreshAppData(currentApp);
        return;

      case "refresh-vehicles":
        await refreshAppData("vehicles");
        return;

      case "refresh-mechanic":
        await refreshAppData("mechanic");
        return;

      case "refresh-tuning":
        await refreshAppData("tuning");
        return;

      case "refresh-finance":
        await refreshAppData("finance");
        return;

      case "refresh-properties":
        await refreshAppData("properties");
        return;

      case "refresh-social":
        await refreshAppData("social");
        return;

      case "taxi-destination": {
        const request = {
          purpose: "taxi-destination",
          source: "smartphone",
          requestedAt: new Date().toISOString()
        };
        const listeners = runtime.events.listenerCount("worldMap:openRequested");
        if (listeners === 0) {
          showFeedback(t("worldMapUnavailable"), "error");
          return;
        }
        const handled = runtime.events.emit("worldMap:openRequested", request);
        if (handled > 0) {
          showFeedback(t("worldMapRequestSent"), "info");
        } else {
          showFeedback(t("worldMapUnavailable"), "error");
        }
        return;
      }

      case "taxi-request": {
        const position = runtime.state.get("playerPosition");

        await executeService(
          "taxi",
          "requestPickup",
          [{
            position,
            requestedAt: new Date().toISOString(),
            preferredVehicleClass: "sedan"
          }],
          t("pickupAccepted")
        );
        return;
      }

      case "vehicle-deliver":
        await executeService(
          "vehicles",
          "requestDelivery",
          [{ vehicleId: id }],
          t("vehicleDeliveryConfirmed")
        );
        return;

      case "mechanic-request": {
        const vehicleId = runtime.state.get("vehicleId");
        if (!vehicleId) {
          showFeedback(t("vehicleRequired"), "error");
          return;
        }
        await executeService(
          "mechanic",
          "requestRepair",
          [{
            vehicleId,
            position: runtime.state.get("playerPosition"),
            requestedAt: new Date().toISOString()
          }],
          t("repairRequested")
        );
        return;
      }

      case "tuning-apply":
        await executeService(
          "tuning",
          "applyUpgrade",
          [{ upgradeId: id, vehicleId: runtime.state.get("vehicleId") }],
          t("tuningApplied")
        );
        return;

      case "stock-buy":
        await executeService(
          "economy",
          "buyStock",
          [{ symbol: id, quantity: 1 }],
          t("stockPurchaseCompleted")
        );
        return;

      case "stock-sell":
        await executeService(
          "economy",
          "sellStock",
          [{ symbol: id, quantity: 1 }],
          t("stockSaleCompleted")
        );
        return;

      case "property-buy":
        await executeService(
          "properties",
          "purchase",
          [{ propertyId: id }],
          t("propertyPurchaseCompleted")
        );
        return;

      case "dispatch-call":
        await executeService(
          "dispatch",
          "call",
          [{
            kind: id,
            position: runtime.state.get("playerPosition"),
            requestedAt: new Date().toISOString()
          }],
          t("dispatchRequestAccepted")
        );
        return;

      case "radio-toggle":
        await executeService(
          "radio",
          "togglePlayback",
          [],
          t("radioStateUpdated")
        );
        return;

      case "radio-station":
        await executeService(
          "radio",
          "setStation",
          [{ stationId: id }],
          t("stationChanged")
        );
        return;

      case "publish-event":
        await executeService(
          "social",
          "publishClip",
          [{
            event: runtime.state.get("lastRecordedEvent"),
            createdAt: new Date().toISOString()
          }],
          t("clipPublished")
        );
        return;

      case "hack-start":
        await executeService(
          "hacking",
          "startMiniGame",
          [],
          t("accessChallengeStarted")
        );
        return;

      case "set-locale":
        try {
          runtime.localization.setLocale(id);
          feedback = { message: `${t("languageChanged")} ${id}.`, kind: "success" };
          render();
        } catch (error) {
          showFeedback(error.message, "error");
        }
        return;

      case "set-quality": {
        const graphics = getService("graphics");

        if (!graphics?.setQualityProfile) {
          showFeedback(t("unavailableDescription"), "error");
          return;
        }

        const result = await graphics.setQualityProfile(id);

        if (result?.ok === true) {
          runtime.state.patch({ qualityProfile: id }, "quality-change");
          showFeedback(`${t("graphicsQualityChanged")} ${id}.`, "success");
        } else {
          showFeedback(
            result?.message ?? "Graphics profile could not be changed.",
            "error"
          );
        }
        return;
      }

      default:
        runtime.logger.warn("Unknown smartphone action.", { action, id });
    }
  }

  overlay.addEventListener("click", event => {
    const button = event.target.closest("button[data-action]");
    if (!button || !overlay.contains(button)) return;

    const action = button.dataset.action;
    const id = button.dataset.id ?? button.dataset.app ?? "";

    runtime.events.emit("ui:action", {
      source: "smartphone",
      action,
      id,
      timestamp: new Date().toISOString()
    });

    void handleAction(action, id);
  });

  overlay.addEventListener("click", event => {
    if (event.target === overlay) close();
  });

  const unsubscribeState = runtime.state.subscribe(change => {
    if (change.changes.locale || change.changes.timeOfDayMinutes ||
        change.changes.weatherId) {
      render();
    }
  });

  const serviceDisposer = runtime.services.register("phone", {
    open,
    close,
    toggle,
    openApp,
    isOpen: () => isOpen
  });

  eventDisposers.push(runtime.events.on("taxi:arrived", () => {
    if (currentApp === "cab") {
      feedback = { message: "Taxi has reported arrival.", kind: "success" };
      render();
    }
  }));

  eventDisposers.push(runtime.events.on("taxi:tripCompleted", () => {
    if (currentApp === "cab") {
      feedback = { message: "Taxi trip completed.", kind: "success" };
      render();
    }
  }));

  eventDisposers.push(runtime.events.on("vehicle:damaged", () => {
    if (currentApp === "vehicles") void refreshAppData("vehicles");
  }));

  eventDisposers.push(runtime.events.on("vehicle:repaired", () => {
    if (currentApp === "mechanic") void refreshAppData("mechanic");
  }));

  eventDisposers.push(runtime.events.on("economy:transactionCompleted", () => {
    if (currentApp === "finance") void refreshAppData("finance");
  }));

  // Contract for the central map module: it emits this only after a valid
  // destination has been selected. Module 12 must expose taxi.setDestination.
  eventDisposers.push(runtime.events.on("worldMap:destinationSelected", payload => {
    if (payload?.purpose !== "taxi-destination") return;
    const taxi = getService("taxi");
    if (typeof taxi?.setDestination !== "function") {
      showFeedback(t("taxiDestinationUnavailable"), "error");
      return;
    }
    void executeService("taxi", "setDestination", [{
      destinationId: payload.destinationId,
      position: payload.position,
      displayName: payload.displayName
    }], t("operationCompleted"));
  }));

  render();

  return Object.freeze({
    open,
    close,
    toggle,
    openApp,
    isOpen: () => isOpen,

    async initialize() {
      return { ok: true };
    },

    dispose() {
      if (destroyed) return;
      destroyed = true;

      unsubscribeState();
      serviceDisposer();
      for (const unsubscribe of eventDisposers.splice(0)) {
        try {
          unsubscribe();
        } catch (error) {
          runtime.logger.warn("Could not remove smartphone event listener.", error);
        }
      }
      overlay.remove();
      style.remove();
    }
  });
}
