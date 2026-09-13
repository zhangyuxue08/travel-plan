(() => {
  "use strict";

  const STORAGE_VERSION = 2;
  const CATEGORIES = Object.freeze(["餐饮", "交通", "住宿", "预订", "活动", "购物", "其他"]);
  const PERSON_GROUPS = Object.freeze([
    ["", "全部人员"],
    ["food", "🍽️"],
    ["snow", "❄️"],
    ["mountain", "⛰️"],
    ["music", "🎓"]
  ]);
  const CURRENCIES = Object.freeze([
    ["CNY", "人民币"], ["NZD", "新西兰元"], ["SGD", "新加坡元"],
    ["HKD", "港币"], ["USD", "美元"], ["AUD", "澳元"]
  ]);

  let root = null;
  let tripId = "default-trip";
  let data = defaultData();
  let editingId = "";
  let notice = "";

  function defaultData() {
    return { version: STORAGE_VERSION, bills: [], lastCurrency: "NZD", updatedAt: new Date().toISOString() };
  }

  function escapeHtml(value = "") {
    return String(value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
    })[character]);
  }

  function makeId() {
    if (crypto?.randomUUID) return `bill-${crypto.randomUUID()}`;
    return `bill-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  function toCents(value) {
    const normalized = String(value || "").trim().replace(/,/g, "");
    if (!/^(?:\d+|\d*\.\d{1,2})$/.test(normalized)) return null;
    const [whole = "0", fraction = ""] = normalized.split(".");
    const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
    return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
  }

  function centsToInput(cents) {
    return Number.isSafeInteger(cents) ? (cents / 100).toFixed(2) : "";
  }

  function formatMoney(cents, currency) {
    try {
      return new Intl.NumberFormat("zh-CN", {
        style: "currency",
        currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      }).format((cents || 0) / 100);
    } catch {
      return `${currency} ${((cents || 0) / 100).toFixed(2)}`;
    }
  }

  function formatDate(value) {
    if (!value) return "未填写日期";
    const parsed = new Date(`${value}T12:00:00`);
    if (Number.isNaN(parsed.getTime())) return value;
    return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(parsed);
  }

  function storageKey() {
    return `travel-ledger-simple:v2:${encodeURIComponent(tripId)}`;
  }

  function normalizePersonGroups(value, legacyValue = "") {
    const allowed = new Set(PERSON_GROUPS.map(([id]) => id).filter(Boolean));
    const rawValues = [
      ...(Array.isArray(value) ? value : []),
      ...(legacyValue ? [legacyValue] : [])
    ];
    return [...new Set(rawValues.map((item) => String(item || "").trim()).filter((item) => allowed.has(item)))];
  }

  function normalize(raw) {
    const fallback = defaultData();
    if (!raw || typeof raw !== "object") return fallback;
    const bills = (Array.isArray(raw.bills) ? raw.bills : []).flatMap((bill) => {
      const amountCents = Number(bill?.amountCents ?? bill?.originalAmountCents);
      const currency = String(bill?.currency || raw.lastCurrency || "NZD").toUpperCase();
      if (!Number.isSafeInteger(amountCents) || amountCents <= 0) return [];
      return [{
        id: String(bill.id || makeId()),
        amountCents,
        currency,
        category: CATEGORIES.includes(bill.category) ? bill.category : "其他",
        personGroups: normalizePersonGroups(bill.personGroups, bill.personGroup),
        title: String(bill.title || bill.note || "").trim().slice(0, 80) || "未命名花费",
        date: String(bill.date || bill.orderedAt || "").slice(0, 10),
        source: String(bill.source || "").trim(),
        sourceId: String(bill.sourceId || "").trim(),
        createdAt: typeof bill.createdAt === "string" ? bill.createdAt : new Date().toISOString(),
        updatedAt: typeof bill.updatedAt === "string" ? bill.updatedAt : new Date().toISOString()
      }];
    });
    return {
      version: STORAGE_VERSION,
      bills,
      lastCurrency: String(raw.lastCurrency || fallback.lastCurrency).toUpperCase(),
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : fallback.updatedAt
    };
  }

  function load() {
    try {
      data = normalize(JSON.parse(localStorage.getItem(storageKey()) || "null"));
    } catch {
      data = defaultData();
    }
  }

  function save() {
    data.updatedAt = new Date().toISOString();
    try {
      localStorage.setItem(storageKey(), JSON.stringify(data));
    } catch (error) {
      console.warn("Ledger could not be saved", error);
    }
  }

  function normalizeSyncedBill(bill) {
    const amountCents = Number(bill?.amountCents);
    const currency = String(bill?.currency || "").toUpperCase();
    if (!String(bill?.id || "").trim()) return null;
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) return null;
    if (!CURRENCIES.some(([code]) => code === currency)) return null;
    return {
      id: String(bill.id),
      amountCents,
      currency,
      category: CATEGORIES.includes(bill.category) ? bill.category : "其他",
      personGroups: [],
      title: String(bill.title || "").trim().slice(0, 80) || "未命名花费",
      date: String(bill.date || "").slice(0, 10),
      source: "schedule",
      sourceId: String(bill.sourceId || "").trim()
    };
  }

  function syncScheduleBills(scheduleBills = []) {
    load();
    const now = new Date().toISOString();
    const normalizedBills = scheduleBills.map(normalizeSyncedBill).filter(Boolean);
    const existingScheduleBills = new Map(data.bills.filter((bill) => bill.source === "schedule").map((bill) => [bill.id, bill]));
    const manualBills = data.bills.filter((bill) => bill.source !== "schedule");
    const nextScheduleBills = normalizedBills.map((bill) => {
      const existing = existingScheduleBills.get(bill.id);
      return {
        ...bill,
        personGroups: normalizePersonGroups(existing?.personGroups, existing?.personGroup),
        createdAt: existing?.createdAt || now,
        updatedAt: now
      };
    });
    data.bills = [...manualBills, ...nextScheduleBills];
    save();
    if (root) render();
  }

  function totalsByCurrency() {
    const totals = new Map();
    data.bills.forEach((bill) => totals.set(bill.currency, (totals.get(bill.currency) || 0) + bill.amountCents));
    return [...totals.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }

  function currentBill() {
    return data.bills.find((bill) => bill.id === editingId) || null;
  }

  function renderCurrencyOptions(selected) {
    return CURRENCIES.map(([code, label]) => `<option value="${code}" ${code === selected ? "selected" : ""}>${code} · ${label}</option>`).join("");
  }

  function personGroupLabels(groupIds = []) {
    const selected = normalizePersonGroups(groupIds);
    if (!selected.length) return ["全部人员"];
    return selected.map((groupId) => PERSON_GROUPS.find(([id]) => id === groupId)?.[1]).filter(Boolean);
  }

  function renderBillMeta(bill) {
    return `
      <span class="ledger-meta-chip ledger-category-chip">${escapeHtml(bill.category)}</span>
      ${personGroupLabels(bill.personGroups).map((label) => `<span class="ledger-meta-chip ledger-person-chip">${escapeHtml(label)}</span>`).join("")}
      <span class="ledger-meta-chip ledger-date-chip">${escapeHtml(formatDate(bill.date))}</span>`;
  }

  function renderTotalAmounts(totals) {
    if (!totals.length) return `<div class="ledger-total-amounts"><span class="ledger-total-amount ledger-total-empty"><strong>0.00</strong></span></div>`;
    return `<div class="ledger-total-amounts">${totals.map(([currency, cents]) => `
      <span class="ledger-total-amount">
        <strong>${escapeHtml(formatMoney(cents, currency))}</strong>
        <em>${escapeHtml(currency)}</em>
      </span>`).join("")}</div>`;
  }

  function renderBillForm({ bill = null, mode = "add", formId = "ledger-form-title", submitLabel = "保存花费" } = {}) {
    const currency = bill?.currency || data.lastCurrency || "NZD";
    const selectedPersonGroups = normalizePersonGroups(bill?.personGroups, bill?.personGroup);
    const isAllPeople = selectedPersonGroups.length === 0;
    return `
      <section class="ledger-entry-card" aria-labelledby="${escapeHtml(formId)}">
        <div class="ledger-section-heading">
          <div>
            <p class="ledger-section-kicker">${mode === "edit" ? "EDIT" : "ADD"}</p>
            <h2 id="${escapeHtml(formId)}">${mode === "edit" ? "修改这笔花费" : "记一笔花费"}</h2>
          </div>
        </div>
        <form class="ledger-bill-form ledger-simple-form" data-ledger-form data-ledger-mode="${escapeHtml(mode)}">
          <div class="ledger-simple-amount">
            <label class="ledger-field">
              <span class="ledger-field-label">金额</span>
              <input class="ledger-amount-input" name="amount" inputmode="decimal" autocomplete="off" placeholder="0.00" value="${escapeHtml(centsToInput(bill?.amountCents))}" required>
            </label>
            <label class="ledger-field">
              <span class="ledger-field-label">币种</span>
              <select class="ledger-select" name="currency">${renderCurrencyOptions(currency)}</select>
            </label>
          </div>
          <fieldset class="ledger-fieldset">
            <legend class="ledger-field-label">分类</legend>
            <div class="ledger-category-grid">
              ${CATEGORIES.map((category) => `
                <label class="ledger-category-choice">
                  <input class="ledger-category-input" type="radio" name="category" value="${escapeHtml(category)}" ${category === (bill?.category || "餐饮") ? "checked" : ""}>
                  <span>${escapeHtml(category)}</span>
                </label>`).join("")}
            </div>
          </fieldset>
          <fieldset class="ledger-fieldset ledger-person-group-fieldset">
            <legend class="ledger-field-label">人员分类 <small>不选则为全部人员，可多选</small></legend>
            <div class="ledger-person-group-grid" role="group" aria-label="人员分类">
              ${PERSON_GROUPS.map(([id, label]) => `
                <label class="ledger-person-group-choice">
                  <input class="ledger-person-group-input" type="checkbox" name="${id ? "personGroups" : "personGroupAll"}" value="${escapeHtml(id)}" ${id ? (selectedPersonGroups.includes(id) ? "checked" : "") : (isAllPeople ? "checked" : "")}>
                  <span>${escapeHtml(label)}</span>
                </label>`).join("")}
            </div>
          </fieldset>
          <label class="ledger-field ledger-note-field">
            <span class="ledger-field-label">事项</span>
            <input class="ledger-input" name="title" maxlength="80" autocomplete="off" placeholder="例如：Queenstown 晚餐" value="${escapeHtml(bill?.title || "")}" required>
          </label>
          <label class="ledger-field ledger-date-field">
            <span class="ledger-field-label">日期</span>
            <input class="ledger-input" name="date" type="date" value="${escapeHtml(bill?.date || "")}">
          </label>
          <p class="ledger-form-error" data-ledger-error role="alert"></p>
          <button class="ledger-primary-button" type="submit">${escapeHtml(submitLabel)}</button>
        </form>
      </section>`;
  }

  function renderForm() {
    return renderBillForm();
  }

  function renderEditDialog() {
    const bill = currentBill();
    return `
      <dialog class="ledger-dialog ledger-edit-dialog" id="ledger-edit-dialog" aria-labelledby="ledger-edit-dialog-title">
        <div class="ledger-dialog-header">
          <div>
            <p class="ledger-section-kicker">EDIT</p>
            <h2 id="ledger-edit-dialog-title">修改这笔花费</h2>
          </div>
          <button type="button" class="ledger-dialog-close" data-ledger-action="cancel-edit" aria-label="关闭编辑弹窗">×</button>
        </div>
        <div class="ledger-dialog-body">
          ${bill ? renderBillForm({ bill, mode: "edit", formId: "ledger-edit-form-title", submitLabel: "保存修改" }) : `<p class="ledger-dialog-empty">没有找到这笔花费。</p>`}
        </div>
      </dialog>`;
  }

  function renderTotals() {
    const totals = totalsByCurrency();
    return `
      <section class="ledger-stats-overview ledger-simple-totals" aria-label="花费汇总">
        <div>
          <strong>${data.bills.length}</strong>
          <span>已记录事项</span>
        </div>
        <div class="ledger-simple-total-wide">
          ${renderTotalAmounts(totals)}
          <span>按币种合计</span>
        </div>
      </section>`;
  }

  function renderBillList() {
    const rows = [...data.bills].sort((a, b) => String(b.date || b.createdAt).localeCompare(String(a.date || a.createdAt)));
    return `
      <section class="ledger-list-section">
        <div class="ledger-section-heading ledger-list-heading">
          <div>
            <p class="ledger-section-kicker">LIST</p>
            <h2>花费清单</h2>
          </div>
          <span class="ledger-soft-count">${rows.length} 项</span>
        </div>
        ${rows.length ? rows.map((bill) => `
          <article class="ledger-bill-row" data-ledger-id="${escapeHtml(bill.id)}">
            <div class="ledger-bill-main">
              <div class="ledger-bill-title-row">
                <span class="ledger-category-mark" data-ledger-category="${escapeHtml(bill.category)}"></span>
                <div>
                  <h3>${escapeHtml(bill.title)}</h3>
                  <p>${renderBillMeta(bill)}</p>
                </div>
              </div>
              <div class="ledger-bill-amount">
                <strong>${escapeHtml(formatMoney(bill.amountCents, bill.currency))}</strong>
                <span>${escapeHtml(bill.currency)}</span>
              </div>
            </div>
            <div class="ledger-simple-actions">
              <button type="button" class="ledger-text-button" data-ledger-action="edit" data-ledger-id="${escapeHtml(bill.id)}">编辑</button>
              <button type="button" class="ledger-text-button ledger-danger-button" data-ledger-action="delete" data-ledger-id="${escapeHtml(bill.id)}">删除</button>
            </div>
          </article>`).join("") : `<p class="ledger-empty">还没有记录花费。</p>`}
      </section>`;
  }

  function render() {
    root.innerHTML = `
      <div class="ledger-app">
        <header class="ledger-page-header">
          <div>
            <p class="ledger-section-kicker">TRIP LEDGER</p>
            <h1>旅行记账</h1>
          </div>
          <div class="ledger-header-actions">
            <button class="ledger-icon-button ledger-danger-button" type="button" data-ledger-action="clear">清空</button>
          </div>
        </header>
        <p class="ledger-live" aria-live="polite">${escapeHtml(notice)}</p>
        ${renderTotals()}
        ${renderForm()}
        ${renderBillList()}
        ${renderEditDialog()}
      </div>`;
    notice = "";
  }

  function handleSubmit(event) {
    event.preventDefault();
    const form = event.target;
    const error = form.querySelector("[data-ledger-error]");
    const formData = new FormData(form);
    const mode = form.dataset.ledgerMode || "add";
    const amountCents = toCents(formData.get("amount"));
    const title = String(formData.get("title") || "").trim();
    if (!amountCents) {
      error.textContent = "请填写有效金额。";
      return;
    }
    if (!title) {
      error.textContent = "请填写事项。";
      return;
    }
    const currency = String(formData.get("currency") || "NZD").toUpperCase();
    const category = CATEGORIES.includes(formData.get("category")) ? formData.get("category") : "其他";
    const personGroups = normalizePersonGroups(formData.getAll("personGroups"));
    const now = new Date().toISOString();
    const existing = mode === "edit" ? currentBill() : null;
    const next = {
      id: existing?.id || makeId(),
      amountCents,
      currency,
      category,
      personGroups,
      title: title.slice(0, 80),
      date: String(formData.get("date") || ""),
      source: existing?.source || "",
      sourceId: existing?.sourceId || "",
      createdAt: existing?.createdAt || now,
      updatedAt: now
    };
    data.lastCurrency = currency;
    if (mode === "edit" && editingId) data.bills = data.bills.map((bill) => bill.id === editingId ? next : bill);
    else data.bills.unshift(next);
    editingId = "";
    notice = "已保存";
    save();
    render();
  }

  function handleClick(event) {
    const editDialog = event.target.closest("#ledger-edit-dialog");
    if (event.target === editDialog) {
      editingId = "";
      render();
      return;
    }
    const button = event.target.closest("[data-ledger-action]");
    if (!button) return;
    const action = button.dataset.ledgerAction;
    const id = button.dataset.ledgerId;
    if (action === "edit") {
      editingId = id;
      render();
      const dialog = root.querySelector("#ledger-edit-dialog");
      if (dialog && typeof dialog.showModal === "function") dialog.showModal();
      else dialog?.setAttribute("open", "");
    } else if (action === "delete") {
      if (!confirm("删除这笔花费？")) return;
      data.bills = data.bills.filter((bill) => bill.id !== id);
      notice = "已删除";
      save();
      render();
    } else if (action === "cancel-edit") {
      editingId = "";
      render();
    } else if (action === "clear") {
      if (!data.bills.length || !confirm("清空所有记账记录？")) return;
      data.bills = [];
      editingId = "";
      notice = "已清空";
      save();
      render();
    }
  }

  function handleChange(event) {
    const input = event.target.closest(".ledger-person-group-input");
    if (!input) return;
    const group = input.closest(".ledger-person-group-grid");
    const allInput = group?.querySelector("input[name='personGroupAll']");
    const personInputs = group ? [...group.querySelectorAll("input[name='personGroups']")] : [];
    if (!allInput) return;
    if (input.name === "personGroupAll") {
      if (input.checked) personInputs.forEach((checkbox) => { checkbox.checked = false; });
      if (!input.checked && !personInputs.some((checkbox) => checkbox.checked)) input.checked = true;
      return;
    }
    if (input.checked) allInput.checked = false;
    if (!personInputs.some((checkbox) => checkbox.checked)) allInput.checked = true;
  }

  async function init(options = {}) {
    root = document.getElementById("ledger-root");
    if (!root) return;
    tripId = String(options.tripId || window.TRAVEL_PLAN_DATA?.metadata?.tripId || "default-trip");
    load();
    render();
    root.addEventListener("submit", (event) => {
      if (event.target.matches("[data-ledger-form]")) handleSubmit(event);
    });
    root.addEventListener("click", handleClick);
    root.addEventListener("change", handleChange);
  }

  window.TravelLedger = { init, syncScheduleBills };
})();
