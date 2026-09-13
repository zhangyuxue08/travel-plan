const state = {
  data: null,
  config: null,
  runtimeAdapters: {},
  expandedDay: null,
  countdownTimer: null,
  purchasedTickets: new Set(),
  todos: [],
  tripEdits: { days: {}, schedule: {}, rental: {}, driveLists: {} },
  activeTodoGroup: "",
  activeDrivePanel: "checklist",
  scheduleDialogOpener: null,
  dayDialogOpener: null,
  rentalDialogOpener: null
};

const SCHEDULE_CATEGORIES = Object.freeze([
  { id: "traffic", label: "交通", icon: "✈️", types: ["flight", "transfer", "drive"] },
  { id: "dining", label: "餐饮", icon: "🍽️", types: ["restaurant"] },
  { id: "activity", label: "游玩", icon: "🎯", types: ["attraction", "walk"] },
  { id: "lodging", label: "住宿", icon: "🛏", types: ["check-in", "check-out"] },
  { id: "parking", label: "停车", icon: "🅿️", types: ["parking"] },
  { id: "other", label: "其他", icon: "📌", types: ["note"] }
]);

const SCHEDULE_ICON_CHOICES = Object.freeze(["✈️", "🚗", "🍽️", "☕", "🎯", "⛰️", "🚶", "🛏", "🅿️", "📌"]);

const MODULE_NAMES = Object.freeze(["flights", "overview", "itinerary", "todo", "driving", "ledger"]);
const SHARED_COLLECTIONS = Object.freeze(["todos", "tickets", "ledger"]);
const TODO_ALL_GROUP_ID = "all";
const COST_CURRENCIES = Object.freeze([
  { key: "cny", code: "CNY", label: "RMB ¥" },
  { key: "nzd", code: "NZD", label: "NZD $" },
  { key: "usd", code: "USD", label: "USD $" }
]);

function normalizeTripConfig(raw = {}) {
  if (!raw || typeof raw !== "object" || raw.schemaVersion !== "1.0.0") throw new Error("trip-data.json config.schemaVersion must be 1.0.0");
  if (!raw.modules || typeof raw.modules !== "object") throw new Error("trip-data.json config must contain confirmed module switches");
  const modules = Object.fromEntries(MODULE_NAMES.map((name) => {
    if (typeof raw.modules[name] !== "boolean") throw new Error(`trip-data.json config.modules.${name} must be boolean`);
    return [name, raw.modules[name]];
  }));
  const mode = raw?.persistence?.mode;
  if (mode !== "local" && mode !== "d1") throw new Error("trip-data.json config.persistence.mode must be local or d1");
  const sharedCollections = mode === "d1" ? [...new Set(raw.persistence.sharedCollections || [])] : [];
  if (mode === "d1" && (!sharedCollections.length || sharedCollections.some((name) => !SHARED_COLLECTIONS.includes(name)))) {
    throw new Error("D1 mode requires an explicit sharedCollections allowlist");
  }
  const apiBase = raw.persistence.apiBase || "/api/trip";
  if (mode === "d1" && (!/^\/(?!\/)/.test(apiBase) || apiBase.includes("\\") || /[?#]/.test(apiBase))) {
    throw new Error("D1 apiBase must be a same-origin path");
  }
  return {
    ...raw,
    modules,
    persistence: {
      ...(raw.persistence || {}),
      mode,
      ...(mode === "d1" ? { apiBase, sharedCollections } : {})
    }
  };
}

function moduleEnabled(name) {
  return Boolean(state.config && state.config.modules?.[name] === true);
}

function applyModuleConfig() {
  document.querySelectorAll("[data-module]").forEach((element) => {
    element.hidden = !moduleEnabled(element.dataset.module);
  });
  const visibleTravelLinks = [...document.querySelectorAll(".travel-navigation-menu [data-module]")].filter((link) => !link.hidden);
  const travelNavigation = $("#travel-navigation");
  if (travelNavigation) travelNavigation.hidden = visibleTravelLinks.length === 0;
  document.documentElement.dataset.persistence = state.config.persistence.mode;

  const hashModules = {
    "#flights": "flights", "#route": "overview", "#itinerary": "itinerary",
    "#drive": "driving", "#prep": "todo", "#ledger": "ledger", "#ledger-stats": "ledger"
  };
  const requestedModule = hashModules[location.hash];
  if (requestedModule && !moduleEnabled(requestedModule)) {
    const firstVisible = visibleTravelLinks[0]?.getAttribute("href") || "#top";
    history.replaceState({ view: "travel" }, "", firstVisible);
  }
  window.dispatchEvent(new CustomEvent("travel-config:ready", { detail: { config: state.config } }));
}

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, (character) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "'": "&#39;",
  '"': "&quot;"
})[character]);

const airportCity = (airport) => airport.city || airport.airportCode;

function localDateTime(date, time, _airportCode, utcOffset = "") {
  return new Date(`${date}T${time}:00${utcOffset || "+00:00"}`);
}

function countdownParts(target, now = new Date()) {
  const difference = target.getTime() - now.getTime();
  if (difference <= 0) return { difference, days: 0, hours: 0, minutes: 0 };
  const totalMinutes = Math.floor(difference / 60000);
  return {
    difference,
    days: Math.floor(totalMinutes / 1440),
    hours: Math.floor((totalMinutes % 1440) / 60),
    minutes: totalMinutes % 60
  };
}

function countdownText(target, completionText = "已出发") {
  const value = countdownParts(target);
  if (value.difference <= 0) return completionText;
  if (value.days > 0) return `${value.days}天 ${String(value.hours).padStart(2, "0")}小时`;
  if (value.hours > 0) return `${value.hours}小时 ${String(value.minutes).padStart(2, "0")}分`;
  return `${Math.max(1, value.minutes)}分钟`;
}

function preciseCountdownText(target, completionText = "已出发") {
  const difference = target.getTime() - Date.now();
  if (difference <= 0) return completionText;
  const totalSeconds = Math.floor(difference / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const clock = [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
  return days > 0 ? `${days}天 ${clock}` : clock;
}

function formatDate(dateString, includeYear = false) {
  const date = new Date(`${dateString}T12:00:00`);
  const options = includeYear
    ? { year: "numeric", month: "long", day: "numeric" }
    : { month: "long", day: "numeric" };
  return new Intl.DateTimeFormat("zh-CN", options).format(date);
}

function formatCompactDate(dateString) {
  const [, month, day] = dateString.split("-");
  return `${Number(month)}月${Number(day)}日`;
}

function todayForTrip() {
  const timeZone = state.data?.metadata?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(new Date());
  } catch {
    return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  }
}

function mapsSearch(query) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

function localTripEditKey() {
  return `travel-plan:local-edits:v1:${encodeURIComponent(state.data?.metadata?.tripId || "default-trip")}`;
}

function loadLocalTripEdits() {
  try {
    const parsed = JSON.parse(localStorage.getItem(localTripEditKey()) || "{}");
    state.tripEdits = {
      days: parsed && typeof parsed.days === "object" ? parsed.days : {},
      schedule: parsed && typeof parsed.schedule === "object" ? parsed.schedule : {},
      rental: parsed && typeof parsed.rental === "object" ? parsed.rental : {},
      driveLists: parsed && typeof parsed.driveLists === "object" ? parsed.driveLists : {}
    };
  } catch {
    state.tripEdits = { days: {}, schedule: {}, rental: {}, driveLists: {} };
  }
}

function saveLocalTripEdits() {
  try {
    localStorage.setItem(localTripEditKey(), JSON.stringify(state.tripEdits));
  } catch (error) {
    console.warn("Local trip edits could not be saved", error);
  }
}

function setDeepValue(target, path, value) {
  const keys = path.split(".");
  let cursor = target;
  keys.slice(0, -1).forEach((key) => {
    if (!cursor[key] || typeof cursor[key] !== "object") cursor[key] = {};
    cursor = cursor[key];
  });
  cursor[keys.at(-1)] = value;
}

function applyLocalTripEdits() {
  (state.data?.days || []).forEach((day) => {
    day.schedule = (day.schedule || []).map((item, index) => normalizeScheduleItem(item, day, index));
    const sourceScheduleById = new Map(day.schedule.map((item) => [item.id, item]));
    const dayEdit = state.tripEdits.days?.[dayEditKey(day)];
    if (dayEdit && typeof dayEdit.title === "string") day.title = dayEdit.title;
    const authored = dayEdit?.schedule;
    if (Array.isArray(authored)) {
      day.schedule = authored.map((item, index) => {
        const normalized = normalizeScheduleItem(item, day, index);
        const source = sourceScheduleById.get(normalized.id);
        if (source && !normalized.costsEdited && !hasCostValue(normalized.costs) && hasCostValue(source.costs)) {
          normalized.costs = normalizeCosts(source.costs);
        }
        if (source && normalized.navigationQuery && !normalized.navigationSource && !source.navigationQuery) {
          normalized.navigationQuery = "";
          normalized.navigationLabel = "";
        } else if (source && normalized.navigationQuery && !normalized.navigationSource && source.navigationQuery) {
          normalized.navigationSource = source.navigationSource || "excel";
        }
        return normalized;
      });
    }
  });
  Object.entries(state.tripEdits.schedule || {}).forEach(([id, edit]) => {
    const item = findScheduleItem(id);
    if (item && edit && typeof edit === "object") {
      if (typeof edit.time === "string") item.time = edit.time;
      if (typeof edit.text === "string") item.text = edit.text;
      if (typeof edit.text === "string" && !item.title) item.title = scheduleTitleFromText(edit.text);
      const day = findScheduleContext(id)?.day;
      if (day) persistDaySchedule(day, { save: false });
    }
  });
  const rental = state.data?.groundTransport?.rentalCar;
  if (rental) {
    Object.entries(state.tripEdits.rental || {}).forEach(([path, value]) => {
      setDeepValue(rental, path, value);
    });
  }
  const transport = state.data?.groundTransport;
  if (transport) {
    Object.entries(state.tripEdits.driveLists || {}).forEach(([key, value]) => {
      if (Array.isArray(value) && ["rentalChecklist", "insurance", "drivingNotes"].includes(key)) {
        if (key === "insurance" && rental) rental.insurance = value;
        else transport[key] = value;
      }
    });
  }
}

function dayEditKey(day) {
  return day?.id || `day-${String(day?.day || "").padStart(2, "0")}`;
}

function scheduleCategoryFor(item = {}) {
  const explicit = String(item.displayCategory || "").trim();
  if (SCHEDULE_CATEGORIES.some((category) => category.id === explicit)) return explicit;
  const type = String(item.type || "");
  return SCHEDULE_CATEGORIES.find((category) => category.types.includes(type))?.id || "other";
}

function scheduleTypeForCategory(categoryId) {
  return ({
    traffic: "transfer",
    dining: "restaurant",
    activity: "attraction",
    lodging: "check-in",
    parking: "drive",
    other: "note"
  })[categoryId] || "note";
}

function scheduleCategoryMeta(itemOrCategory) {
  const id = typeof itemOrCategory === "string" ? itemOrCategory : scheduleCategoryFor(itemOrCategory);
  return SCHEDULE_CATEGORIES.find((category) => category.id === id) || SCHEDULE_CATEGORIES.at(-1);
}

function scheduleIconFor(item = {}) {
  return String(item.icon || "").trim() || scheduleCategoryMeta(item).icon;
}

function scheduleTitleFromText(text = "") {
  const raw = String(text || "").split(/[；;]/)[0] || "";
  const title = raw.split("｜")[0] || raw;
  return title.trim() || "待确认事项";
}

function normalizeCosts(costs = {}) {
  return {
    cny: String(costs.cny ?? costs.rmb ?? "").trim(),
    nzd: String(costs.nzd ?? "").trim(),
    usd: String(costs.usd ?? "").trim()
  };
}

function costValueToCents(value) {
  const text = String(value || "").trim().replace(/,/g, "");
  if (!text) return 0;
  const match = text.match(/\d+(?:\.\d{1,2})?|\.\d{1,2}/);
  if (!match) return 0;
  const [whole = "0", fraction = ""] = match[0].split(".");
  const cents = Number(whole || 0) * 100 + Number((fraction || "").padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents > 0 ? cents : 0;
}

function formatCostAmount(cents) {
  const amount = (cents || 0) / 100;
  return new Intl.NumberFormat("zh-CN", {
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2
  }).format(amount);
}

function costEntries(costs = {}) {
  const normalized = normalizeCosts(costs);
  return COST_CURRENCIES.flatMap((currency) => {
    const cents = costValueToCents(normalized[currency.key]);
    return cents ? [{ ...currency, cents }] : [];
  });
}

function hasCostValue(costs = {}) {
  return costEntries(costs).length > 0;
}

function sumCostEntries(items = []) {
  const totals = Object.fromEntries(COST_CURRENCIES.map((currency) => [currency.key, 0]));
  items.forEach((item) => {
    costEntries(item.costs).forEach((entry) => {
      totals[entry.key] += entry.cents;
    });
  });
  return COST_CURRENCIES.flatMap((currency) => {
    const cents = totals[currency.key] || 0;
    return cents ? [{ ...currency, cents }] : [];
  });
}

function costSummaryMarkup(entries, className = "cost-summary") {
  if (!entries.length) return "";
  return `<div class="${className}" aria-label="费用合计">${entries.map((entry) => `
    <span>${escapeHtml(entry.label)}${escapeHtml(formatCostAmount(entry.cents))}</span>
  `).join("")}</div>`;
}

function allScheduleItems() {
  return (state.data?.days || []).flatMap((day) => (day.schedule || []).map((item) => ({ day, item })));
}

function ledgerCategoryForSchedule(item = {}) {
  return ({
    restaurant: "餐饮",
    "check-in": "住宿",
    "check-out": "住宿",
    flight: "交通",
    transfer: "交通",
    drive: "交通",
    parking: "交通",
    attraction: "活动",
    walk: "活动",
    hike: "活动"
  })[item.type] || "其他";
}

function syncScheduleCostsToLedger() {
  if (!moduleEnabled("ledger") || !window.TravelLedger?.syncScheduleBills) return;
  const bills = allScheduleItems().flatMap(({ day, item }) => costEntries(item.costs).map((entry) => ({
    id: `schedule-${item.id}-${entry.code}`,
    source: "schedule",
    sourceId: item.id,
    amountCents: entry.cents,
    currency: entry.code,
    category: ledgerCategoryForSchedule(item),
    title: `${item.title || scheduleTitleFromText(item.text)}${item.subtitle ? ` · ${item.subtitle}` : ""}`,
    date: day.date
  })));
  window.TravelLedger.syncScheduleBills(bills);
}

function normalizeScheduleItem(item = {}, day = {}, index = 0) {
  const title = String(item.title || scheduleTitleFromText(item.text)).trim() || "待确认事项";
  const category = scheduleCategoryFor(item);
  const normalized = {
    ...item,
    id: String(item.id || `d${String(day.day || "x").padStart(2, "0")}-${Date.now()}-${index}`),
    time: String(item.time || "待定").trim() || "待定",
    type: item.type || scheduleTypeForCategory(category),
    title,
    subtitle: String(item.subtitle || "").trim(),
    icon: scheduleIconFor(item),
    displayCategory: category,
    routeDuration: String(item.routeDuration || "").trim(),
    itemDuration: String(item.itemDuration || "").trim(),
    navigationQuery: String(item.navigationQuery || item.navigation?.query || "").trim(),
    navigationLabel: String(item.navigationLabel || item.navigation?.label || item.navigationQuery || item.navigation?.query || "").trim(),
    navigationSource: String(item.navigationSource || item.navigation?.source || "").trim(),
    costs: normalizeCosts(item.costs),
    costsEdited: Boolean(item.costsEdited),
    note: String(item.note || "").trim(),
    reserved: Boolean(item.reserved),
    text: String(item.text || "").trim()
  };
  if (!normalized.text) normalized.text = scheduleTextFromFields(normalized);
  return normalized;
}

function scheduleTextFromFields(item) {
  return [
    item.title,
    item.subtitle,
    item.routeDuration,
    item.itemDuration,
    item.note
  ].filter(Boolean).join("；");
}

function serializeScheduleItem(item) {
  return {
    id: item.id,
    time: item.time,
    type: item.type,
    title: item.title,
    subtitle: item.subtitle || "",
    icon: item.icon || scheduleIconFor(item),
    displayCategory: item.displayCategory,
    routeDuration: item.routeDuration || "",
    itemDuration: item.itemDuration || "",
    navigationQuery: item.navigationQuery || "",
    navigationLabel: item.navigationLabel || item.navigationQuery || "",
    ...(item.navigationSource ? { navigationSource: item.navigationSource } : {}),
    costs: normalizeCosts(item.costs),
    ...(item.costsEdited ? { costsEdited: true } : {}),
    note: item.note || "",
    reserved: Boolean(item.reserved),
    text: item.text || scheduleTextFromFields(item),
    ...(item.placeId ? { placeId: item.placeId } : {}),
    ...(Array.isArray(item.placeIds) ? { placeIds: item.placeIds } : {}),
    ...(Array.isArray(item.ticketIds) ? { ticketIds: item.ticketIds } : {})
  };
}

function persistDaySchedule(day, options = {}) {
  const existing = state.tripEdits.days[dayEditKey(day)] || {};
  state.tripEdits.days[dayEditKey(day)] = {
    ...existing,
    schedule: (day.schedule || []).map(serializeScheduleItem)
  };
  if (options.save !== false) saveLocalTripEdits();
}

function persistDayMeta(day, options = {}) {
  const existing = state.tripEdits.days[dayEditKey(day)] || {};
  state.tripEdits.days[dayEditKey(day)] = {
    ...existing,
    title: day.title
  };
  if (options.save !== false) saveLocalTripEdits();
}

function findScheduleItem(itemId) {
  return findScheduleContext(itemId)?.item || null;
}

function findScheduleContext(itemId) {
  for (const day of state.data?.days || []) {
    const index = (day.schedule || []).findIndex((entry) => entry.id === itemId);
    if (index >= 0) return { day, item: day.schedule[index], index };
  }
  return null;
}

function heroDestinationFor(trip) {
  const destinations = (trip.countries || []).filter((country) => (trip.primaryDestinationCountries || []).includes(country.code));
  const isDomestic = destinations.length > 0 && destinations.every((country) => country.code === "CN");
  const customTitle = String(trip.heroTitle || "").trim();
  if (customTitle) {
    return { title: customTitle, eyebrow: String(trip.heroEyebrow || "").trim(), destinations, isDomestic };
  }
  if (isDomestic) {
    const destination = String(trip.primaryDestinationName || trip.primaryDestinationCity || trip.citiesAndAreas?.[0] || "目的地待补充").trim();
    return {
      title: destination,
      eyebrow: String(trip.primaryDestinationNameEn || trip.primaryDestinationCityEn || "DOMESTIC JOURNEY").trim(),
      destinations,
      isDomestic
    };
  }
  return {
    title: destinations.map((country) => country.nameZh || country.name).join(" × ") || "目的地待补充",
    eyebrow: destinations.map((country) => country.nameEn || country.name).filter(Boolean).join(" × "),
    destinations,
    isDomestic
  };
}

function renderHero() {
  const { trip } = state.data;
  if (trip.status === "uninitialized") {
    document.title = state.data.metadata.title;
    $("#trip-title").textContent = "旅行计划待生成";
    $("#trip-eyebrow").textContent = "READY FOR YOUR JOURNEY";
    $("#wordmark").innerHTML = "TRIP <span>· READY</span>";
    $("#footer-mark").textContent = "TRIP · READY";
    $("#route-day-count").textContent = "0 DAYS";
    $("#trip-date").textContent = "等待旅行资料";
    return;
  }
  const hero = heroDestinationFor(trip);
  const { destinations } = hero;
  const shortMark = destinations.map((country) => country.code).join(" / ");
  const year = trip.startDate.slice(0, 4);
  document.title = state.data.metadata.title;
  $("#trip-title").textContent = hero.title;
  $("#trip-eyebrow").textContent = hero.eyebrow;
  $("#wordmark").innerHTML = `${escapeHtml(shortMark)} <span>· ${escapeHtml(year)}</span>`;
  $("#footer-mark").textContent = `${shortMark} · ${year}`;
  $("#route-day-count").textContent = `${trip.dayCount} DAYS`;
  $("#trip-date").textContent = `${formatCompactDate(trip.startDate)} — ${formatCompactDate(trip.endDate)} · ${trip.dayCount}天`;
}

function journeyFlights(journeyId) {
  return state.data.flights
    .filter((flight) => flight.journeyId === journeyId)
    .sort((first, second) => first.sequence - second.sequence);
}

function journeyStatusAndTarget(flights) {
  const now = new Date();
  for (const flight of flights) {
    const departure = localDateTime(flight.departure.date, flight.departure.time, flight.departure.airportCode, flight.departure.utcOffset);
    const arrival = localDateTime(flight.arrival.date, flight.arrival.time, flight.arrival.airportCode, flight.arrival.utcOffset);
    if (now < departure) return { target: departure, label: flight === flights[0] ? "距离起飞还剩" : "距离下一程起飞还剩", complete: false };
    if (now < arrival) return { target: arrival, label: "飞行中 · 距抵达", complete: false };
  }
  return { target: null, label: "已抵达", complete: true };
}

function relativeFlightDate(date, journeyStartDate) {
  if (date === journeyStartDate) return formatCompactDate(date);
  const difference = Math.round((new Date(`${date}T12:00:00`) - new Date(`${journeyStartDate}T12:00:00`)) / 86400000);
  return difference === 1 ? "次日" : formatCompactDate(date);
}

function flightStopMarkup(stop, position, journeyStartDate) {
  let timing;
  if (position === 0) {
    timing = `<span>${escapeHtml(relativeFlightDate(stop.departure.date, journeyStartDate))}</span><b>${escapeHtml(stop.departure.time)} 出发</b>`;
  } else if (position === stop.totalStops - 1) {
    timing = `<span>${escapeHtml(relativeFlightDate(stop.arrival.date, journeyStartDate))}</span><b>${escapeHtml(stop.arrival.time)} 抵达</b>`;
  } else {
    const nextFlight = stop.nextFlight;
    const connection = nextFlight.connectionFromPrevious || {};
    const duration = connection.calculatedFromSchedule || connection.durationUsingTicketTimes || connection.plannedDurationText || "中转";
    timing = `
      <span>${escapeHtml(stop.arrival.time)} 抵达</span>
      <em>${escapeHtml(duration)}</em>
      <b>${escapeHtml(relativeFlightDate(nextFlight.departure.date, journeyStartDate))} ${escapeHtml(nextFlight.departure.time)}</b>
      <span>起飞</span>
    `;
  }
  return `
    <div class="flight-stop${position > 0 && position < stop.totalStops - 1 ? " is-transfer" : ""}">
      <span class="flight-stop__code">${escapeHtml(stop.airport.airportCode)}</span>
      <span class="flight-stop__city">${escapeHtml(airportCity(stop.airport))}</span>
      <span class="flight-stop__dot" aria-hidden="true"></span>
      <div class="flight-stop__timing">${timing}</div>
    </div>
  `;
}

function flightMissingFieldLabel(field) {
  return ({
    carrierId: "航空公司",
    flightNumber: "航班号",
    departure: "起飞信息",
    arrival: "抵达信息",
    departurePlace: "出发机场",
    arrivalPlace: "抵达机场",
    departureTime: "起飞时间",
    arrivalTime: "抵达时间",
    timeZone: "当地时区"
  })[field] || String(field || "待补充信息");
}

function flightPlaceholderCard(journey, index) {
  const missingFields = [...new Set(journey.missingFields || [])].map(flightMissingFieldLabel);
  return `
    <article class="flight-card flight-card--placeholder" data-journey="${escapeHtml(journey.id)}">
      <div class="flight-card__top">
        <span>FLIGHT ${String(index + 1).padStart(2, "0")} / ${String(state.data.flightJourneys.length).padStart(2, "0")}</span>
      </div>
      <div class="flight-placeholder">
        <span class="flight-placeholder__eyebrow">资料待补充</span>
        <h3>${escapeHtml(journey.title || "航班信息待补充")}</h3>
        <p>已按第二轮确认继续生成标准预览；系统没有猜测或伪造缺失的航班事实。</p>
        ${missingFields.length ? `<ul>${missingFields.map((field) => `<li>${escapeHtml(field)}</li>`).join("")}</ul>` : ""}
      </div>
      <div class="flight-card__countdown-row">
        <div class="flight-countdown" data-countdown-journey="${escapeHtml(journey.id)}" data-placeholder="true">
          <span>当前状态</span>
          <strong>待补充</strong>
        </div>
      </div>
    </article>
  `;
}

function flightCard(journey, index) {
  const flights = journeyFlights(journey.id);
  if (journey.placeholder || journey.status === "missing" || journey.status === "pending" || !flights.length || flights.some((flight) => flight.placeholder)) {
    return flightPlaceholderCard(journey, index);
  }
  const first = flights[0];
  const last = flights[flights.length - 1];
  const status = journeyStatusAndTarget(flights);
  const countdown = status.complete ? "已完成" : preciseCountdownText(status.target, "即将出发");
  const stops = [
    { airport: first.departure, departure: first.departure },
    ...flights.map((flight, flightIndex) => ({
      airport: flight.arrival,
      arrival: flight.arrival,
      nextFlight: flights[flightIndex + 1]
    }))
  ];
  const routeItems = [];
  stops.forEach((stop, stopIndex) => {
    routeItems.push(flightStopMarkup({ ...stop, totalStops: stops.length }, stopIndex, first.departure.date));
    if (stopIndex < flights.length) {
      const flight = flights[stopIndex];
      routeItems.push(`
        <div class="flight-segment">
          <span>${escapeHtml(flight.flightNumber)}</span>
          <i aria-hidden="true">→</i>
        </div>
      `);
    }
  });
  return `
    <article class="flight-card" data-journey="${escapeHtml(journey.id)}">
      <div class="flight-card__top">
        <span>FLIGHT ${String(index + 1).padStart(2, "0")} / ${String(state.data.flightJourneys.length).padStart(2, "0")}</span>
      </div>
      <div class="flight-card__airlines">${escapeHtml([...new Set(flights.map((flight) => flight.airline.nameZh || flight.airline.name))].join(" · "))}</div>
      <div class="flight-flow" style="--route-columns: ${stops.map((_, stopIndex) => stopIndex < stops.length - 1 ? "minmax(0,1fr) minmax(34px,.5fr)" : "minmax(0,1fr)").join(" ")}">
        ${routeItems.join("")}
      </div>
      <div class="flight-card__countdown-row">
        <div class="flight-countdown" data-countdown-journey="${escapeHtml(journey.id)}">
          <span>${escapeHtml(status.label)}</span>
          <strong>${escapeHtml(countdown)}</strong>
        </div>
      </div>
    </article>
  `;
}

function renderFlights() {
  const journeys = state.data.flightJourneys;
  $("#flight-carousel").innerHTML = journeys.map(flightCard).join("");
  $("#flight-dots").innerHTML = journeys.map((_, index) => `<span class="carousel-dot${index === 0 ? " is-active" : ""}"></span>`).join("");
  $("#flight-index").textContent = `1 / ${journeys.length}`;
  renderTripCostSummary();

  const carousel = $("#flight-carousel");
  let scheduled = false;
  carousel.addEventListener("scroll", () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      const cards = $$(".flight-card", carousel);
      const center = carousel.scrollLeft + carousel.clientWidth / 2;
      let activeIndex = 0;
      let distance = Infinity;
      cards.forEach((card, index) => {
        const cardCenter = card.offsetLeft + card.offsetWidth / 2;
        if (Math.abs(cardCenter - center) < distance) {
          distance = Math.abs(cardCenter - center);
          activeIndex = index;
        }
      });
      $$(".carousel-dot", $("#flight-dots")).forEach((dot, index) => dot.classList.toggle("is-active", index === activeIndex));
      $("#flight-index").textContent = `${activeIndex + 1} / ${journeys.length}`;
      scheduled = false;
    });
  }, { passive: true });
}

function renderTripCostSummary() {
  const target = $("#trip-cost-summary");
  if (!target) return;
  const totals = sumCostEntries(allScheduleItems().map(({ item }) => item));
  target.hidden = !totals.length;
  target.innerHTML = totals.length
    ? `<span>行程费用总和</span>${costSummaryMarkup(totals, "trip-cost-summary__amounts")}`
    : "";
}

function updateFlightCountdowns() {
  state.data.flightJourneys.forEach((journey) => {
    const target = $(`[data-countdown-journey="${journey.id}"]`);
    if (!target || target.dataset.placeholder === "true" || journey.placeholder) return;
    const status = journeyStatusAndTarget(journeyFlights(journey.id));
    $("strong", target).textContent = status.complete ? "已完成" : preciseCountdownText(status.target, "即将出发");
    $("span", target).textContent = status.label;
  });
}

function ticketsForDay(day) {
  if (!moduleEnabled("itinerary")) return [];
  return (state.data.ticketPlanning?.items || []).filter((ticket) =>
    ticket.dayId ? ticket.dayId === day.id : ticket.day === day.day
  );
}

function ticketsForSchedule(day, item) {
  if (!moduleEnabled("itinerary")) return [];
  const tickets = ticketsForDay(day);
  if (Array.isArray(item.ticketIds)) return tickets.filter((ticket) => item.ticketIds.includes(ticket.id));
  if (item.id) {
    const explicit = tickets.filter((ticket) => (ticket.scheduleItemIds || ticket.itemIds || []).includes(item.id));
    if (explicit.length) return explicit;
  }
  const lowerText = String(item.text || item.title || "").toLocaleLowerCase();
  return tickets.filter((ticket) => (ticket.scheduleMatchTerms || []).some((term) => lowerText.includes(term.toLocaleLowerCase())));
}

function isTicketPurchased(ticket) {
  return ticket.purchaseStatus === "purchased" || state.purchasedTickets.has(ticket.id);
}

function ticketKind(ticket) {
  return String(ticket.category || ticket.kind || ticket.type || "ticket");
}

function isRestaurantBooking(ticket) {
  return ticketKind(ticket).includes("restaurant");
}

function isBooking(ticket) {
  return ticketKind(ticket).includes("booking");
}

function ticketRequirement(ticket) {
  const labels = isRestaurantBooking(ticket)
    ? {
        "advance-required": "需提前订位",
        "advance-recommended": "建议订位",
        "needs-confirmation": "预订方式待确认"
      }
    : isBooking(ticket)
      ? {
          "advance-required": "需提前预约",
          "advance-recommended": "建议预约",
          "needs-confirmation": "预约方式待确认"
        }
      : {
          "advance-required": "需提前购票",
          "advance-recommended": "建议预约",
          "needs-confirmation": "购票方式待确认"
        };
  return labels[ticket.requirement] || (isBooking(ticket) ? "预订信息" : "门票信息");
}

function ticketDoneLabel(ticket) {
  if (isRestaurantBooking(ticket)) return "已订位";
  if (isBooking(ticket)) return "已预约";
  return "已购票";
}

function ticketTitle(ticket) {
  return ticket.name || ticket.attraction?.nameZh || ticket.attraction?.name || "门票详情";
}

function ticketGuidance(ticket) {
  const guidance = ticket.guidance || ticket.notes || [];
  return Array.isArray(guidance) ? guidance.join("·") : String(guidance || "");
}

function ticketDocument(ticket) {
  const document = ticket.document || ticket.booking?.document;
  if (document && typeof document === "object") {
    return { url: document.url || document.path || "", type: document.type || "", label: document.label || "查看票据" };
  }
  const url = ticket.documentUrl || ticket.booking?.documentUrl || "";
  return url ? { url, type: "", label: ticket.documentLabel || "查看票据" } : null;
}

function scheduleDurationTag(label, value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.startsWith(label) ? text : `${label} ${text}`;
}

function scheduleStatusButtons(item) {
  const reserved = Boolean(item.reserved);
  return `<button type="button" class="schedule-status-badge ${reserved ? "is-reserved" : "is-pending"}" data-toggle-schedule-reserved="${escapeHtml(item.id)}">${reserved ? "已预订 ✅" : "待预订"}</button>`;
}

function scheduleCard(day, item, index, total) {
  const destinations = navigationDestinations(item);
  const mapLinks = destinations.map((destination) => `
    <button type="button" class="schedule-map-link" data-map-query="${escapeHtml(destination.query)}" data-map-url="${escapeHtml(destination.url || "")}" data-map-label="${escapeHtml(destination.label)}" aria-haspopup="dialog" aria-controls="place-map" aria-label="查看 ${escapeHtml(destination.label)} 的地图">📍 ${escapeHtml(destination.label)}</button>
  `).join("");
  const statusButtons = scheduleStatusButtons(item);
  const details = [
    scheduleDurationTag("路程", item.routeDuration),
    scheduleDurationTag("停留", item.itemDuration)
  ].filter(Boolean);
  const itemCosts = costEntries(item.costs);
  const note = item.note || "";
  const longNote = note.length > 78 || note.includes("\n");
  return `
    <li class="schedule-item schedule-card-item" data-schedule-id="${escapeHtml(item.id)}">
      <span class="schedule-time">${escapeHtml(item.time || "待定")}</span>
      <article class="schedule-card">
        <header class="schedule-card__head">
          <div class="schedule-card__title">
            <span class="schedule-card__icon" aria-hidden="true">${escapeHtml(scheduleIconFor(item))}</span>
            <span class="schedule-card__title-text">
              <strong>${escapeHtml(item.title || scheduleTitleFromText(item.text))}</strong>
              ${item.subtitle ? `<em>${escapeHtml(item.subtitle)}</em>` : ""}
            </span>
          </div>
          <div class="schedule-card__topline">
            ${statusButtons}
            <div class="schedule-card__actions" aria-label="行程项目操作">
              <button type="button" data-edit-schedule="${escapeHtml(item.id)}">编辑</button>
              <button type="button" class="is-danger" data-delete-schedule="${escapeHtml(item.id)}">删除</button>
              <button type="button" data-move-schedule="${escapeHtml(item.id)}" data-direction="-1" ${index === 0 ? "disabled" : ""} aria-label="上移 ${escapeHtml(item.title)}">↑</button>
              <button type="button" data-move-schedule="${escapeHtml(item.id)}" data-direction="1" ${index === total - 1 ? "disabled" : ""} aria-label="下移 ${escapeHtml(item.title)}">↓</button>
            </div>
          </div>
        </header>
        ${details.length ? `<div class="schedule-card__meta">${details.map((detail) => `<span>${escapeHtml(detail)}</span>`).join("")}</div>` : ""}
        ${costSummaryMarkup(itemCosts, "schedule-costs")}
        ${note ? `<div class="schedule-card__note${longNote ? " is-collapsed" : ""}"><p>${escapeHtml(note).replace(/\n/g, "<br>")}</p>${longNote ? `<button type="button" data-expand-note>展开全部 ▼</button>` : ""}</div>` : ""}
        ${mapLinks ? `<div class="schedule-map-links">${mapLinks}</div>` : ""}
      </article>
    </li>`;
}

function dayCard(day) {
  const today = todayForTrip();
  const isToday = day.date === today;
  const expanded = state.expandedDay === day.day;
  const schedule = day.schedule.map((item, index) => scheduleCard(day, item, index, day.schedule.length)).join("");
  const dayCosts = costSummaryMarkup(sumCostEntries(day.schedule), "day-cost-summary");
  const notes = [...(day.notes || []), ...(day.sourceDateLabelConflict ? [day.sourceDateLabelConflict] : [])];
  return `
    <article class="day-card${isToday ? " is-today" : ""}" data-day="${day.day}">
      <span class="day-dot" aria-hidden="true"></span>
      <div class="day-row">
        <button class="day-toggle" type="button" aria-expanded="${expanded}" aria-controls="day-detail-${day.day}">
          <span>
            <span class="day-meta">DAY ${String(day.day).padStart(2, "0")} · ${escapeHtml(formatCompactDate(day.date))}${isToday ? " · 今天" : ""}</span>
            <span class="day-title">${escapeHtml(day.title)}</span>
            <span class="day-locations">${escapeHtml(day.locations.join(" → "))}</span>
            ${dayCosts}
          </span>
          <span class="day-chevron" aria-hidden="true">+</span>
        </button>
        <button type="button" class="day-edit-button" data-edit-day="${day.day}" aria-label="编辑 Day ${String(day.day).padStart(2, "0")} 标题">编辑</button>
      </div>
      <div class="day-detail" id="day-detail-${day.day}" ${expanded ? "" : "hidden"}>
        <div class="day-detail-actions"><button type="button" data-add-schedule="${day.day}">新增行程项目</button></div>
        <ol class="schedule">${schedule}</ol>
        ${notes.map((note) => `<p class="detail-note">${escapeHtml(note)}</p>`).join("")}
      </div>
    </article>
  `;
}

function navigationDestinations(item) {
  if (String(item.navigationQuery || "").trim()) {
    const label = item.navigationLabel || item.navigationQuery;
    return [{
      id: `${item.id}-navigation`,
      label,
      query: item.navigationQuery,
      directUrl: false,
      url: ""
    }];
  }
  return [];
}

function currentTripDay() {
  const today = todayForTrip();
  return state.data.days.find((day) => day.date === today)?.day || null;
}

function scrollDayIntoView(card) {
  if (!card) return;
  requestAnimationFrame(() => {
    card.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

function renderTimeline() {
  const today = currentTripDay();
  if (state.expandedDay === null || state.expandedDay === undefined) state.expandedDay = today;
  $("#day-count").textContent = `${state.data.days.length} DAYS`;
  $("#timeline").innerHTML = state.data.days.map(dayCard).join("");
  renderTripCostSummary();
  $("#timeline").onclick = (event) => {
    const dayEditButton = event.target.closest("[data-edit-day]");
    if (dayEditButton) {
      openDayEditor(Number(dayEditButton.dataset.editDay), dayEditButton);
      return;
    }
    const addButton = event.target.closest("[data-add-schedule]");
    if (addButton) {
      openScheduleEditor(Number(addButton.dataset.addSchedule));
      return;
    }
    const editButton = event.target.closest("[data-edit-schedule]");
    if (editButton) {
      openScheduleEditor(Number(editButton.closest(".day-card")?.dataset.day), editButton.dataset.editSchedule, editButton);
      return;
    }
    const deleteButton = event.target.closest("[data-delete-schedule]");
    if (deleteButton) {
      deleteScheduleItem(deleteButton.dataset.deleteSchedule);
      return;
    }
    const moveButton = event.target.closest("[data-move-schedule]");
    if (moveButton) {
      moveScheduleItem(moveButton.dataset.moveSchedule, Number(moveButton.dataset.direction));
      return;
    }
    const noteButton = event.target.closest("[data-expand-note]");
    if (noteButton) {
      const note = noteButton.closest(".schedule-card__note");
      note.classList.remove("is-collapsed");
      noteButton.remove();
      return;
    }
    const reservedButton = event.target.closest("[data-toggle-schedule-reserved]");
    if (reservedButton) {
      toggleScheduleReserved(reservedButton.dataset.toggleScheduleReserved);
      return;
    }
    const toggle = event.target.closest(".day-toggle");
    if (!toggle) return;
    const card = toggle.closest(".day-card");
    const dayNumber = Number(card.dataset.day);
    const wasExpanded = toggle.getAttribute("aria-expanded") === "true";
    $$(".day-toggle", $("#timeline")).forEach((button) => button.setAttribute("aria-expanded", "false"));
    $$(".day-detail", $("#timeline")).forEach((detail) => { detail.hidden = true; });
    if (!wasExpanded) {
      toggle.setAttribute("aria-expanded", "true");
      $(`#day-detail-${dayNumber}`).hidden = false;
      state.expandedDay = dayNumber;
      scrollDayIntoView(card);
    } else {
      state.expandedDay = null;
    }
  };
}

function dayByNumber(dayNumber) {
  return state.data.days.find((day) => day.day === Number(dayNumber));
}

function openDayEditor(dayNumber, opener = null) {
  const day = dayByNumber(dayNumber);
  const dialog = $("#day-editor-dialog");
  if (!day || !dialog) return;
  state.dayDialogOpener = opener || null;
  $("#day-editor-title").textContent = `编辑 Day ${String(day.day).padStart(2, "0")} 标题`;
  $("#day-editor-body").innerHTML = `
    <form class="simple-editor-form" id="day-editor-form" data-day="${day.day}">
      <label class="schedule-editor-field">
        <span>标题 *</span>
        <input name="title" value="${escapeHtml(day.title)}" required autocomplete="off">
      </label>
      <p class="schedule-editor-error" id="day-editor-error" role="alert"></p>
      <footer>
        <button type="button" class="schedule-editor-cancel" data-close-day-editor>取消</button>
        <button type="submit" class="schedule-editor-save">保存</button>
      </footer>
    </form>`;
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
  $("#day-editor-form input[name='title']").focus();
}

function saveDayEditor(form) {
  const day = dayByNumber(Number(form.dataset.day));
  if (!day) return;
  const title = String(new FormData(form).get("title") || "").trim();
  if (!title) {
    $("#day-editor-error").textContent = "请填写标题。";
    return;
  }
  day.title = title;
  persistDayMeta(day);
  closeDayEditor();
  renderTimeline();
}

function closeDayEditor() {
  const dialog = $("#day-editor-dialog");
  if (!dialog) return;
  if (typeof dialog.close === "function" && dialog.open) dialog.close();
  else dialog.removeAttribute("open");
}

function scheduleFormValues(item = {}) {
  return {
    time: item.time || "",
    title: item.title || scheduleTitleFromText(item.text),
    subtitle: item.subtitle || "",
    icon: scheduleIconFor(item),
    displayCategory: scheduleCategoryFor(item),
    routeDuration: item.routeDuration || "",
    itemDuration: item.itemDuration || "",
    navigationQuery: item.navigationQuery || "",
    costs: normalizeCosts(item.costs),
    note: item.note || "",
    reserved: Boolean(item.reserved)
  };
}

function openScheduleEditor(dayNumber, itemId = "", opener = null) {
  const day = dayByNumber(dayNumber);
  const item = itemId ? findScheduleItem(itemId) : null;
  if (!day || (itemId && !item)) return;
  const values = scheduleFormValues(item || {});
  const dialog = $("#schedule-editor-dialog");
  state.scheduleDialogOpener = opener || null;
  $("#schedule-editor-title").textContent = item ? "编辑行程项目" : "新增行程项目";
  $("#schedule-editor-body").innerHTML = `
    <form class="schedule-editor-form" id="schedule-editor-form" data-day="${day.day}" data-schedule-id="${escapeHtml(item?.id || "")}">
      <label class="schedule-editor-field">
        <span>时间 <small>可选</small></span>
        <input name="time" value="${escapeHtml(values.time)}" placeholder="如：09:30" autocomplete="off">
        <small>用于左侧时间显示，顺序可用上移/下移调整</small>
      </label>
      <label class="schedule-editor-field">
        <span>关键地点 / 标题 *</span>
        <input name="title" value="${escapeHtml(values.title)}" placeholder="如：抵达机场" required autocomplete="off">
      </label>
      <label class="schedule-editor-field">
        <span>项目 / 副标题</span>
        <input name="subtitle" value="${escapeHtml(values.subtitle)}" placeholder="如：午餐 / 参观 / 停车场" autocomplete="off">
      </label>
      <fieldset class="schedule-editor-fieldset">
        <legend>标题图案</legend>
        <div class="schedule-icon-picker">
          ${SCHEDULE_ICON_CHOICES.map((icon) => `
            <label>
              <input type="radio" name="iconChoice" value="${escapeHtml(icon)}" ${icon === values.icon ? "checked" : ""}>
              <span>${escapeHtml(icon)}</span>
            </label>`).join("")}
        </div>
        <label class="schedule-editor-field schedule-icon-custom">
          <span>自定义图案</span>
          <input name="icon" value="${escapeHtml(values.icon)}" placeholder="如：🛫 / Lake" autocomplete="off" maxlength="8">
        </label>
      </fieldset>
      <div class="schedule-editor-grid">
        <label class="schedule-editor-field">
          <span>路程耗时</span>
          <input name="routeDuration" value="${escapeHtml(values.routeDuration)}" placeholder="如：约 30min" autocomplete="off">
        </label>
        <label class="schedule-editor-field">
          <span>项目耗时</span>
          <input name="itemDuration" value="${escapeHtml(values.itemDuration)}" placeholder="如：停留 1H" autocomplete="off">
        </label>
      </div>
      <label class="schedule-editor-field">
        <span>导航地址</span>
        <input name="navigationQuery" value="${escapeHtml(values.navigationQuery)}" placeholder="导航地址或关键词" autocomplete="off">
      </label>
      <fieldset class="schedule-editor-fieldset">
        <legend>实际花销</legend>
        <div class="schedule-cost-editor-grid">
          <label class="schedule-editor-field">
            <span>RMB ¥</span>
            <input name="costCny" inputmode="decimal" value="${escapeHtml(values.costs.cny)}" placeholder="人民币" autocomplete="off">
          </label>
          <label class="schedule-editor-field">
            <span>NZD $</span>
            <input name="costNzd" inputmode="decimal" value="${escapeHtml(values.costs.nzd)}" placeholder="新西兰元" autocomplete="off">
          </label>
          <label class="schedule-editor-field">
            <span>USD $</span>
            <input name="costUsd" inputmode="decimal" value="${escapeHtml(values.costs.usd)}" placeholder="美元" autocomplete="off">
          </label>
        </div>
      </fieldset>
      <label class="schedule-editor-field">
        <span>备注</span>
        <textarea name="note" rows="4" placeholder="补充说明">${escapeHtml(values.note)}</textarea>
      </label>
      <label class="schedule-reserved-toggle">
        <input type="checkbox" name="reserved" ${values.reserved ? "checked" : ""}>
        <span>已预订</span>
      </label>
      <p class="schedule-editor-error" id="schedule-editor-error" role="alert"></p>
      <footer>
        <button type="button" class="schedule-editor-cancel" data-close-schedule-editor>取消</button>
        <button type="submit" class="schedule-editor-save">保存</button>
      </footer>
    </form>`;
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
  $("#schedule-editor-form input[name='time']").focus();
}

function scheduleItemFromForm(form, existing = null) {
  const formData = new FormData(form);
  const category = scheduleCategoryFor(existing || {});
  const title = String(formData.get("title") || "").trim();
  const navigationQuery = String(formData.get("navigationQuery") || "").trim();
  const next = normalizeScheduleItem({
    ...(existing || {}),
    id: existing?.id || `schedule-${form.dataset.day}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    time: String(formData.get("time") || "").trim() || "待定",
    title,
    subtitle: String(formData.get("subtitle") || "").trim(),
    icon: String(formData.get("icon") || formData.get("iconChoice") || "").trim(),
    displayCategory: category,
    type: existing?.type || scheduleTypeForCategory(category),
    routeDuration: String(formData.get("routeDuration") || "").trim(),
    itemDuration: String(formData.get("itemDuration") || "").trim(),
    navigationQuery,
    navigationLabel: navigationQuery,
    navigationSource: navigationQuery ? "user" : "",
    costs: normalizeCosts({
      cny: formData.get("costCny"),
      nzd: formData.get("costNzd"),
      usd: formData.get("costUsd")
    }),
    costsEdited: true,
    note: String(formData.get("note") || "").trim(),
    reserved: formData.get("reserved") === "on"
  }, dayByNumber(Number(form.dataset.day)));
  next.text = scheduleTextFromFields(next);
  return next;
}

function saveScheduleEditor(form) {
  const day = dayByNumber(Number(form.dataset.day));
  if (!day) return;
  const title = String(new FormData(form).get("title") || "").trim();
  if (!title) {
    $("#schedule-editor-error").textContent = "请填写标题。";
    return;
  }
  const existingId = form.dataset.scheduleId;
  const context = existingId ? findScheduleContext(existingId) : null;
  const next = scheduleItemFromForm(form, context?.item || null);
  if (context && context.day.day === day.day) day.schedule[context.index] = next;
  else day.schedule.push(next);
  state.expandedDay = day.day;
  persistDaySchedule(day);
  syncScheduleCostsToLedger();
  closeScheduleEditor();
  renderTimeline();
}

function closeScheduleEditor() {
  const dialog = $("#schedule-editor-dialog");
  if (!dialog) return;
  if (typeof dialog.close === "function" && dialog.open) dialog.close();
  else dialog.removeAttribute("open");
}

function deleteScheduleItem(itemId) {
  const context = findScheduleContext(itemId);
  if (!context) return;
  if (!confirm(`删除「${context.item.title || scheduleTitleFromText(context.item.text)}」？`)) return;
  context.day.schedule.splice(context.index, 1);
  state.expandedDay = context.day.day;
  persistDaySchedule(context.day);
  syncScheduleCostsToLedger();
  renderTimeline();
}

function moveScheduleItem(itemId, direction) {
  const context = findScheduleContext(itemId);
  if (!context) return;
  const nextIndex = context.index + direction;
  if (nextIndex < 0 || nextIndex >= context.day.schedule.length) return;
  const [item] = context.day.schedule.splice(context.index, 1);
  context.day.schedule.splice(nextIndex, 0, item);
  state.expandedDay = context.day.day;
  persistDaySchedule(context.day);
  renderTimeline();
}

function toggleScheduleReserved(itemId) {
  const context = findScheduleContext(itemId);
  if (!context) return;
  context.item.reserved = !context.item.reserved;
  state.expandedDay = context.day.day;
  persistDaySchedule(context.day);
  renderTimeline();
}

async function loadTicketState() {
  state.purchasedTickets = new Set();
}

function saveTicketState(ticketId, completed) {
  return saveSharedChange("tickets", { id: ticketId, completed }, completed ? "upsert" : "delete").catch(console.error);
}

function rentalStatus(rental) {
  const pickup = new Date(`${rental.pickup.date}T${rental.pickup.time}:00${rental.pickup.utcOffset || "+00:00"}`);
  const dropoff = new Date(`${rental.dropoff.date}T${rental.dropoff.time}:00${rental.dropoff.utcOffset || "+00:00"}`);
  const now = new Date();
  if (now < pickup) return { label: "距取车", target: pickup, complete: false };
  if (now < dropoff) return { label: "距还车", target: dropoff, complete: false };
  return { label: "已超过预约还车时间", target: dropoff, complete: true };
}

function renderRental() {
  const transport = state.data.groundTransport;
  const rental = transport.rentalCar;
  $("#rental-provider-label").textContent = rental.company;
  const status = rentalStatus(rental);
  const vehicle = rental.vehicle || {};
  $("#rental-card").innerHTML = `
    <article class="rental-panel">
      <div class="return-deadline">
        <span class="return-deadline__label">重要 · 还车截止时间</span>
        <strong>${escapeHtml(formatCompactDate(rental.dropoff.date))} <time>${escapeHtml(rental.dropoff.time)}</time> 前</strong>
        <span>${escapeHtml(rental.dropoff.timeZoneLabel)}</span>
        <p>${escapeHtml(rental.dropoff.vehicleReturnPoint)}</p>
        <div class="return-deadline__timer" id="return-deadline-timer"></div>
        <p class="return-deadline__warning">${escapeHtml(rental.dropoff.deadlineWarning)}</p>
        <small>建议 ${escapeHtml(rental.dropoff.recommendedArrivalTime)} 抵达机场区域，预留还车及值机时间。</small>
      </div>
      <div class="rental-countdown" id="rental-countdown">
        <span>${escapeHtml(status.label)}</span>
        <strong>${status.complete ? `请立即联系 ${escapeHtml(rental.company)}` : escapeHtml(countdownText(status.target))}</strong>
        <small>${formatCompactDate(rental.dropoff.date)} ${escapeHtml(rental.dropoff.time)} 前 · ${escapeHtml(rental.dropoff.vehicleReturnPoint)}</small>
      </div>
      <div class="rental-details">
        <div class="rental-car">${escapeHtml(rental.company)} · ${escapeHtml(vehicle.example)}</div>
        <div class="rental-sub">${escapeHtml(vehicle.class)} · ${rental.unlimitedKilometers ? "无限里程" : "里程条款见订单"}</div>
        <div class="rental-stops">
          <div class="rental-stop">
            <span class="rental-stop__label">PICK UP</span>
            <div><b>${formatCompactDate(rental.pickup.date)} ${escapeHtml(rental.pickup.time)}</b><span>${escapeHtml(rental.pickup.location)}<br>${escapeHtml(rental.pickup.address)}</span></div>
          </div>
          <div class="rental-stop">
            <span class="rental-stop__label">RETURN</span>
            <div><b>${formatCompactDate(rental.dropoff.date)} ${escapeHtml(rental.dropoff.time)}</b><span>${escapeHtml(rental.dropoff.vehicleReturnPoint)}<br>建议 ${escapeHtml(rental.dropoff.recommendedArrivalTime)} 抵达机场区域</span></div>
          </div>
        </div>
        <button type="button" class="rental-edit-button" data-edit-rental-summary>编辑自驾信息</button>
      </div>
    </article>
  `;
  const notes = $("#drive-notes");
  const activePanel = ["checklist", "insurance", "driving"].includes(state.activeDrivePanel) ? state.activeDrivePanel : "checklist";
  notes.innerHTML = `
    <div class="drive-note-tabs" role="group" aria-label="自驾注意事项">
      <button type="button" aria-expanded="${activePanel === "checklist"}" aria-controls="drive-note-content" data-drive-note="checklist">取还车检查</button>
      <button type="button" aria-expanded="${activePanel === "insurance"}" aria-controls="drive-note-content" data-drive-note="insurance">订单保障</button>
      <button type="button" aria-expanded="${activePanel === "driving"}" aria-controls="drive-note-content" data-drive-note="driving">驾驶提醒</button>
    </div>
    <form class="drive-note-form" data-drive-add="${activePanel}">
      <input name="note" placeholder="添加一条自驾事项" maxlength="160" autocomplete="off">
      <button type="submit">添加事项</button>
    </form>
    <div class="drive-note-panel" id="drive-note-content">${drivePanelMarkup(activePanel)}</div>`;
  $("#rental-card").onclick = (event) => {
    if (!event.target.closest("[data-edit-rental-summary]")) return;
    openRentalEditor(event.target.closest("[data-edit-rental-summary]"));
  };
  notes.onclick = (event) => {
    const deleteButton = event.target.closest("[data-delete-drive-note]");
    if (deleteButton) {
      deleteDriveListItem(deleteButton.dataset.deleteDriveNote, Number(deleteButton.dataset.noteIndex));
      return;
    }
    const button = event.target.closest("button[data-drive-note]");
    if (!button) return;
    state.activeDrivePanel = button.dataset.driveNote;
    renderRental();
  };
  notes.onsubmit = (event) => {
    const form = event.target.closest("[data-drive-add]");
    if (!form) return;
    event.preventDefault();
    addDriveListItem(form.dataset.driveAdd, new FormData(form).get("note"));
    form.reset();
  };
}

function rentalFieldValue(path) {
  const rental = state.data.groundTransport.rentalCar;
  return path.split(".").reduce((cursor, key) => cursor?.[key], rental);
}

function rentalEditorFields() {
  return [
    ["company", "租车公司"],
    ["vehicle.example", "车型"],
    ["vehicle.class", "车型级别"],
    ["pickup.date", "取车日期"],
    ["pickup.time", "取车时间"],
    ["pickup.location", "取车地点"],
    ["pickup.address", "取车地址"],
    ["dropoff.date", "还车日期"],
    ["dropoff.time", "还车时间"],
    ["dropoff.timeZoneLabel", "还车时区"],
    ["dropoff.vehicleReturnPoint", "还车地点"],
    ["dropoff.recommendedArrivalTime", "建议抵达时间"],
    ["dropoff.deadlineWarning", "还车提醒"]
  ];
}

function openRentalEditor(opener = null) {
  const dialog = $("#rental-editor-dialog");
  if (!dialog) return;
  state.rentalDialogOpener = opener || null;
  $("#rental-editor-body").innerHTML = `
    <form class="rental-editor-form" id="rental-editor-form">
      <div class="rental-editor-grid">
        ${rentalEditorFields().map(([path, label]) => `
          <label class="schedule-editor-field">
            <span>${escapeHtml(label)}</span>
            <input name="${escapeHtml(path)}" value="${escapeHtml(rentalFieldValue(path) || "")}" autocomplete="off">
          </label>`).join("")}
      </div>
      <p class="schedule-editor-error" id="rental-editor-error" role="alert"></p>
      <footer>
        <button type="button" class="schedule-editor-cancel" data-close-rental-editor>取消</button>
        <button type="submit" class="schedule-editor-save">保存</button>
      </footer>
    </form>`;
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
  $("#rental-editor-form input")?.focus();
}

function saveRentalEditor(form) {
  const formData = new FormData(form);
  rentalEditorFields().forEach(([path]) => {
    const value = String(formData.get(path) || "").trim();
    state.tripEdits.rental[path] = value;
    setDeepValue(state.data.groundTransport.rentalCar, path, value);
  });
  saveLocalTripEdits();
  closeRentalEditor();
  renderRental();
  updateRentalCountdown();
}

function closeRentalEditor() {
  const dialog = $("#rental-editor-dialog");
  if (!dialog) return;
  if (typeof dialog.close === "function" && dialog.open) dialog.close();
  else dialog.removeAttribute("open");
}

function driveListKey(panelName) {
  return ({ checklist: "rentalChecklist", insurance: "insurance", driving: "drivingNotes" })[panelName] || "rentalChecklist";
}

function driveListItems(panelName) {
  const key = driveListKey(panelName);
  if (key === "insurance") return state.data.groundTransport.rentalCar.insurance || [];
  return state.data.groundTransport[key] || [];
}

function setDriveListItems(panelName, items) {
  const key = driveListKey(panelName);
  state.tripEdits.driveLists[key] = items;
  if (key === "insurance") state.data.groundTransport.rentalCar.insurance = items;
  else state.data.groundTransport[key] = items;
  saveLocalTripEdits();
}

function drivePanelMarkup(panelName) {
  const items = driveListItems(panelName);
  const links = panelName === "driving" ? (state.data.groundTransport.drivingReferenceLinks || []) : [];
  const itemMarkup = items.map((item, index) => `
    <li>
      <span>${escapeHtml(item)}</span>
      <button type="button" data-delete-drive-note="${escapeHtml(panelName)}" data-note-index="${index}" aria-label="删除：${escapeHtml(item)}">删除</button>
    </li>`).join("");
  const linkMarkup = links.map((link) => `<li class="is-reference"><a href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.label)} ↗</a></li>`).join("");
  return itemMarkup || linkMarkup
    ? `<ul>${itemMarkup}${linkMarkup}</ul>`
    : `<p class="drive-note-empty">这一栏还没有事项。</p>`;
}

function addDriveListItem(panelName, value) {
  const text = String(value || "").trim();
  if (!text) return;
  setDriveListItems(panelName, [...driveListItems(panelName), text]);
  state.activeDrivePanel = panelName;
  renderRental();
}

function deleteDriveListItem(panelName, index) {
  const items = driveListItems(panelName);
  if (index < 0 || index >= items.length) return;
  setDriveListItems(panelName, items.filter((_, itemIndex) => itemIndex !== index));
  state.activeDrivePanel = panelName;
  renderRental();
}

function updateRentalCountdown() {
  const dropoff = state.data.groundTransport.rentalCar.dropoff;
  const deadline = new Date(`${dropoff.date}T${dropoff.time}:00${dropoff.utcOffset}`);
  const remaining = deadline.getTime() - Date.now();
  $("#return-deadline-timer").textContent = remaining > 0
    ? `距还车截止 ${preciseCountdownText(deadline)}`
    : "预约还车时间已过 · 如尚未还车，请立即联系租车公司";
  $(".return-deadline").classList.toggle("is-urgent", remaining <= 86400000);
  const panel = $("#rental-countdown");
  if (!panel) return;
  const status = rentalStatus(state.data.groundTransport.rentalCar);
  $("span", panel).textContent = status.label;
  $("strong", panel).textContent = status.complete ? `请立即联系 ${state.data.groundTransport.rentalCar.company}` : countdownText(status.target);
}

function loadTodoState() { state.todos = []; }

function baseTodoGroups() {
  const groups = state.data.preTrip?.todoGroups;
  if (Array.isArray(groups) && groups.length) return groups;
  return [
    { id: TODO_ALL_GROUP_ID, label: "ALL", name: "共同准备" },
    { id: "snow", label: "🍽️ & ❄️", name: "餐饮与雪线准备" },
    { id: "mountain", label: "⛰️", name: "山路自驾" },
    { id: "music", label: "🎓", name: "朋友补充" }
  ];
}

function todoGroups() {
  return baseTodoGroups();
}

function defaultTodoGroupId(index = 0) {
  const groups = baseTodoGroups();
  return groups[index % groups.length]?.id || TODO_ALL_GROUP_ID;
}

function activeTodoWriteGroupId() {
  return state.activeTodoGroup || defaultTodoGroupId();
}

function normalizeTodoEntry(item, index = 0) {
  return {
    id: String(item.id || `todo-initial-${index + 1}`),
    groupId: String(item.groupId || item.category || defaultTodoGroupId(index)),
    text: String(item.text || item.title || "").trim(),
    completed: Boolean(item.completed)
  };
}

function migrateCommonTodoEntries(todos, authoredTodos = []) {
  const authoredCommonTodos = authoredTodos.map(normalizeTodoEntry).filter((todo) => todo.groupId === TODO_ALL_GROUP_ID);
  if (!authoredCommonTodos.length) {
    return { todos, changed: false };
  }
  const commonIds = new Set(authoredCommonTodos.map((todo) => todo.id));
  const commonTexts = new Set(authoredCommonTodos.map((todo) => todo.text));
  let changed = false;
  const migrated = todos.map((todo) => {
    if (!commonIds.has(todo.id) && !commonTexts.has(todo.text)) return todo;
    if (todo.groupId === TODO_ALL_GROUP_ID) return todo;
    changed = true;
    return { ...todo, groupId: TODO_ALL_GROUP_ID };
  });
  return { todos: migrated, changed };
}

function createRuntimeAdapters() {
  const storage = window.TravelRuntimeStorage;
  if (!storage?.createAdapter) throw new Error("runtime-storage.js is required");
  const persistence = state.config.persistence || { mode: "local" };
  const sharedCollections = new Set(Array.isArray(persistence.sharedCollections)
    ? persistence.sharedCollections
    : ["todos", "tickets", "ledger"]);
  const tripId = state.data.metadata.tripId;
  const enabledCollections = [
    ...(moduleEnabled("todo") ? ["todos"] : []),
    ...(moduleEnabled("itinerary") ? ["tickets"] : [])
  ];
  const localCollections = enabledCollections.filter((collection) => persistence.mode !== "d1" || !sharedCollections.has(collection));
  const d1Collections = enabledCollections.filter((collection) => persistence.mode === "d1" && sharedCollections.has(collection));
  const localAdapter = localCollections.length ? storage.createAdapter({ mode: "local", tripId, collections: localCollections }) : null;
  const d1Adapter = d1Collections.length ? storage.createAdapter({
    mode: "d1",
    tripId,
    apiBase: persistence.apiBase || "/api/trip",
    collections: d1Collections
  }) : null;
  state.runtimeAdapters = {};
  localCollections.forEach((collection) => { state.runtimeAdapters[collection] = localAdapter; });
  d1Collections.forEach((collection) => { state.runtimeAdapters[collection] = d1Adapter; });
}

async function loadSharedState() {
  const adapters = [...new Set(Object.values(state.runtimeAdapters).filter(Boolean))];
  const todoAdapter = state.runtimeAdapters.todos;
  const authoredTodos = state.data.preTrip?.todoItems || state.data.preTrip?.packingItems || [];
  let hasLocalTodoSnapshot = true;
  if (todoAdapter?.mode === "local" && todoAdapter.storageKey) {
    try { hasLocalTodoSnapshot = localStorage.getItem(todoAdapter.storageKey) !== null; }
    catch { hasLocalTodoSnapshot = false; }
  }
  const snapshots = await Promise.all(adapters.map(async (adapter) => [adapter, await adapter.load()]));
  const snapshotFor = (collection) => snapshots.find(([adapter]) => adapter === state.runtimeAdapters[collection])?.[1] || {};
  const todoSnapshot = snapshotFor("todos");
  const ticketSnapshot = snapshotFor("tickets");
  state.todos = Array.isArray(todoSnapshot.todos)
    ? todoSnapshot.todos.map(normalizeTodoEntry).filter((item) => item.text)
    : [];
  const migratedTodos = migrateCommonTodoEntries(state.todos, authoredTodos);
  state.todos = migratedTodos.todos;
  if (migratedTodos.changed) {
    await Promise.all(state.todos.map((todo) => saveSharedChange("todos", todo)));
  }
  state.purchasedTickets = new Set((Array.isArray(ticketSnapshot.tickets) ? ticketSnapshot.tickets : []).filter((item) => item.completed).map((item) => item.id));
  if (todoAdapter?.mode === "local" && !hasLocalTodoSnapshot && !state.todos.length && authoredTodos.length) {
    state.todos = authoredTodos.map(normalizeTodoEntry).filter((item) => item.text);
    await Promise.all(state.todos.map((todo) => todoAdapter.applyChange("todos", todo, "upsert")));
  }
  state.activeTodoGroup = state.activeTodoGroup || defaultTodoGroupId();
}

async function saveSharedChange(collection, value, op = "upsert") {
  const adapter = state.runtimeAdapters[collection];
  if (!adapter) return null;
  return adapter.applyChange(collection, value, op);
}

function saveTodoState() { return Promise.all(state.todos.map((todo) => saveSharedChange("todos", todo))); }

function renderTodoList() {
  const completed = state.todos.filter((todo) => todo.completed).length;
  $("#todo-progress").textContent = `${completed} / ${state.todos.length}`;
  const visibleTodos = state.todos.filter((todo) => todo.groupId === state.activeTodoGroup);
  $("#todo-list").innerHTML = visibleTodos.length ? visibleTodos.map((todo) => `
    <div class="todo-item${todo.completed ? " is-complete" : ""}" data-todo-id="${escapeHtml(todo.id)}">
      <label>
        <input type="checkbox" ${todo.completed ? "checked" : ""} aria-label="完成：${escapeHtml(todo.text)}">
        <span class="todo-check" aria-hidden="true">✓</span>
        <span class="todo-text">${escapeHtml(todo.text)}</span>
      </label>
      <button type="button" class="todo-delete" aria-label="删除：${escapeHtml(todo.text)}">删除</button>
    </div>`).join("") : `<p class="todo-empty">这个 tab 还没有准备事项，添加第一项吧。</p>`;
}

function renderTodoTabs() {
  const tabs = $("#todo-tabs");
  if (!tabs) return;
  const groups = todoGroups();
  if (!state.activeTodoGroup || !groups.some((group) => group.id === state.activeTodoGroup)) {
    state.activeTodoGroup = groups[0]?.id || "";
  }
  tabs.innerHTML = groups.map((group) => {
    const count = state.todos.filter((todo) => todo.groupId === group.id).length;
    return `<button type="button" class="todo-tab${group.id === TODO_ALL_GROUP_ID ? " is-all" : ""}" data-todo-group="${escapeHtml(group.id)}" aria-pressed="${group.id === state.activeTodoGroup}">
      <span>${escapeHtml(group.label || group.name || group.id)}</span><small>${count}</small>
    </button>`;
  }).join("");
}

function renderTravelPrep() {
  renderTodoTabs();
  renderTodoList();
  $("#todo-tabs").onclick = (event) => {
    const button = event.target.closest("[data-todo-group]");
    if (!button) return;
    state.activeTodoGroup = button.dataset.todoGroup;
    renderTodoTabs();
    renderTodoList();
  };
  $("#todo-form").onsubmit = (event) => {
    event.preventDefault();
    const input = $("#todo-input");
    const text = input.value.trim();
    if (!text) return;
    state.todos.push({ id: `todo-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, groupId: activeTodoWriteGroupId(), text, completed: false });
    input.value = "";
    saveSharedChange("todos", state.todos.at(-1)).catch(console.error);
    renderTodoTabs();
    renderTodoList();
  };
  $("#todo-list").onchange = (event) => {
    const item = event.target.closest("[data-todo-id]");
    if (!item || !event.target.matches("input[type='checkbox']")) return;
    const todo = state.todos.find((entry) => entry.id === item.dataset.todoId);
    todo.completed = event.target.checked;
    saveSharedChange("todos", todo).catch(console.error);
    renderTodoTabs();
    renderTodoList();
  };
  $("#todo-list").onclick = (event) => {
    const button = event.target.closest(".todo-delete");
    if (!button) return;
    const item = button.closest("[data-todo-id]");
    state.todos = state.todos.filter((todo) => todo.id !== item.dataset.todoId);
    saveSharedChange("todos", { id: item.dataset.todoId }, "delete").catch(console.error);
    renderTodoTabs();
    renderTodoList();
  };
}

function safeExternalUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw, location.href);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function localAssetUrl(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return "";
  try {
    const url = new URL(raw, location.href);
    return url.origin === location.origin ? url.href : "";
  } catch {
    return "";
  }
}

let ticketDialogOpener = null;

function openTicketDialog(ticketId, opener) {
  const ticket = state.data.ticketPlanning?.items?.find((item) => item.id === ticketId);
  const dialog = $("#ticket-dialog");
  if (!ticket || !dialog) return;
  ticketDialogOpener = opener || null;
  $("#ticket-dialog-title").textContent = ticketTitle(ticket);
  const document = ticketDocument(ticket);
  const localDocument = localAssetUrl(document?.url);
  const externalDocument = !localDocument ? safeExternalUrl(document?.url) : "";
  const officialUrl = safeExternalUrl(ticket.officialUrl || ticket.booking?.officialUrl || ticket.booking?.purchaseUrl);
  const extension = localDocument.split(/[?#]/)[0].split(".").at(-1)?.toLocaleLowerCase();
  let preview = "";
  if (localDocument && ["png", "jpg", "jpeg", "webp", "gif", "svg"].includes(extension)) {
    preview = `<img class="ticket-dialog__preview" src="${escapeHtml(localDocument)}" alt="${escapeHtml(ticketTitle(ticket))}">`;
  } else if (localDocument) {
    preview = `<iframe class="ticket-dialog__preview" src="${escapeHtml(localDocument)}" title="${escapeHtml(ticketTitle(ticket))}" sandbox="allow-same-origin" referrerpolicy="no-referrer"></iframe>`;
  }
  const links = [
    localDocument ? `<a href="${escapeHtml(localDocument)}" target="_blank" rel="noopener noreferrer">在新窗口打开票据 ↗</a>` : "",
    externalDocument ? `<a href="${escapeHtml(externalDocument)}" target="_blank" rel="noopener noreferrer">${escapeHtml(document?.label || "查看票据")} ↗</a>` : "",
    officialUrl ? `<a href="${escapeHtml(officialUrl)}" target="_blank" rel="noopener noreferrer">打开官方页面 ↗</a>` : ""
  ].filter(Boolean).join("");
  $("#ticket-dialog-body").innerHTML = `
    <p class="ticket-dialog__status">${escapeHtml(isTicketPurchased(ticket) ? ticketDoneLabel(ticket) : ticketRequirement(ticket))}</p>
    ${ticketGuidance(ticket) ? `<p class="ticket-dialog__guidance">${escapeHtml(ticketGuidance(ticket))}</p>` : ""}
    ${preview || (!links ? `<p class="ticket-dialog__empty">当前没有可预览的票据文件或官方链接。</p>` : "")}
    ${links ? `<div class="ticket-dialog__links">${links}</div>` : ""}`;
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
  $("#ticket-dialog-close").focus();
}

function setupTicketDialog() {
  const dialog = $("#ticket-dialog");
  if (!dialog) return;
  const close = () => {
    if (typeof dialog.close === "function" && dialog.open) dialog.close();
    else dialog.removeAttribute("open");
  };
  $("#ticket-dialog-close").onclick = close;
  dialog.addEventListener("click", (event) => { if (event.target === dialog) close(); });
  dialog.addEventListener("close", () => {
    const body = $("#ticket-dialog-body");
    if (!body.querySelector(".ticket-dialog__preview--pdf")) body.replaceChildren();
    ticketDialogOpener?.focus({ preventScroll: true });
    ticketDialogOpener = null;
  });
}

function setupScheduleEditorDialog() {
  const dialog = $("#schedule-editor-dialog");
  if (!dialog) return;
  dialog.addEventListener("submit", (event) => {
    if (!event.target.matches("#schedule-editor-form")) return;
    event.preventDefault();
    saveScheduleEditor(event.target);
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog || event.target.closest("[data-close-schedule-editor]")) closeScheduleEditor();
  });
  dialog.addEventListener("change", (event) => {
    if (event.target.name !== "iconChoice") return;
    const iconInput = dialog.querySelector("input[name='icon']");
    if (iconInput) iconInput.value = event.target.value;
  });
  dialog.addEventListener("input", (event) => {
    if (event.target.name !== "icon") return;
    dialog.querySelectorAll("input[name='iconChoice']").forEach((input) => {
      input.checked = input.value === event.target.value;
    });
  });
  dialog.addEventListener("close", () => {
    $("#schedule-editor-body").replaceChildren();
    state.scheduleDialogOpener?.focus({ preventScroll: true });
    state.scheduleDialogOpener = null;
  });
}

function setupDayEditorDialog() {
  const dialog = $("#day-editor-dialog");
  if (!dialog) return;
  dialog.addEventListener("submit", (event) => {
    if (!event.target.matches("#day-editor-form")) return;
    event.preventDefault();
    saveDayEditor(event.target);
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog || event.target.closest("[data-close-day-editor]")) closeDayEditor();
  });
  dialog.addEventListener("close", () => {
    $("#day-editor-body").replaceChildren();
    state.dayDialogOpener?.focus({ preventScroll: true });
    state.dayDialogOpener = null;
  });
}

function setupRentalEditorDialog() {
  const dialog = $("#rental-editor-dialog");
  if (!dialog) return;
  dialog.addEventListener("submit", (event) => {
    if (!event.target.matches("#rental-editor-form")) return;
    event.preventDefault();
    saveRentalEditor(event.target);
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog || event.target.closest("[data-close-rental-editor]")) closeRentalEditor();
  });
  dialog.addEventListener("close", () => {
    $("#rental-editor-body").replaceChildren();
    state.rentalDialogOpener?.focus({ preventScroll: true });
    state.rentalDialogOpener = null;
  });
}

function setupPlaceMap() {
  const panel = $("#place-map");
  const frame = $("#place-map-frame");
  let opener;
  let previousOverflow = "";
  const close = () => {
    panel.hidden = true;
    frame.src = "about:blank";
    document.body.style.overflow = previousOverflow;
    opener?.focus();
  };
  document.addEventListener("click", (event) => {
    const link = event.target.closest("button[data-map-query]");
    if (!link) return;
    event.preventDefault();
    opener = link;
    $("#place-map-title").textContent = link.dataset.mapLabel;
    $("#place-map-external").href = safeExternalUrl(link.dataset.mapUrl) || mapsSearch(link.dataset.mapQuery);
    frame.title = `${link.dataset.mapLabel} Google Maps`;
    frame.src = `https://maps.google.com/maps?q=${encodeURIComponent(link.dataset.mapQuery)}&output=embed`;
    previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.hidden = false;
    $("#place-map-close").focus();
  });
  $("#place-map-close").onclick = close;
  panel.addEventListener("click", (event) => { if (event.target === panel) close(); });
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
    if (event.key === "Tab") {
      const first = $("#place-map-close");
      const last = $("#place-map-external");
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
}

function startCountdowns() {
  if (moduleEnabled("flights")) updateFlightCountdowns();
  if (moduleEnabled("driving")) updateRentalCountdown();
  if (!moduleEnabled("flights") && !moduleEnabled("driving")) return;
  state.countdownTimer = window.setInterval(() => {
    if (moduleEnabled("flights")) updateFlightCountdowns();
    if (moduleEnabled("driving")) updateRentalCountdown();
  }, 1000);
}

function preloadDefaultRouteMap() {
  const routeMap = state.data?.routeMap;
  const source = travelMapSource(routeMap, routeMap?.defaultRegionId);
  if (!source?.baseImage) return;
  const image = new Image();
  image.decoding = "async";
  image.fetchPriority = "high";
  image.src = source.baseImage;
  state.routeMapPreload = image;
}

async function init() {
  try {
    const response = await fetch("trip-data.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.data = await response.json();
    state.config = normalizeTripConfig(state.data.config);
    loadLocalTripEdits();
    applyLocalTripEdits();
    window.TRAVEL_PLAN_CONFIG = state.config;
    window.TRAVEL_PLAN_DATA = state.data;
    document.dispatchEvent(new CustomEvent("travel-data-ready", { detail: state.data }));
    applyModuleConfig();
    if (moduleEnabled("overview")) preloadDefaultRouteMap();
    renderHero();
    if (moduleEnabled("flights")) renderFlights();
    if (moduleEnabled("overview")) setupRouteExplorer();
    if (moduleEnabled("itinerary")) {
      setupPlaceMap();
      setupTicketDialog();
      setupScheduleEditorDialog();
      setupDayEditorDialog();
    }
    if (moduleEnabled("todo") || moduleEnabled("itinerary")) {
      createRuntimeAdapters();
      try {
        await loadSharedState();
      } catch (error) {
        console.error(`${state.config.persistence.mode === "d1" ? "Shared" : "Local"} runtime data could not be loaded`, error);
        state.todos = [];
        state.purchasedTickets = new Set();
      }
    }
    syncScheduleCostsToLedger();
    if (moduleEnabled("itinerary")) renderTimeline();
    if (moduleEnabled("driving")) {
      setupRentalEditorDialog();
      renderRental();
    }
    if (moduleEnabled("todo")) renderTravelPrep();
    if (moduleEnabled("ledger")) {
      await window.TravelLedger?.init?.({ tripId: state.data.metadata.tripId, config: state.config });
      syncScheduleCostsToLedger();
    }
    startCountdowns();
  } catch (error) {
    console.error("Travel data could not be loaded", error);
    $("#loading-error").hidden = false;
  }
}

document.addEventListener("DOMContentLoaded", init);
